import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { stableHash } from "../util/text.js";
import { AsyncMutex, KeyedMutex, throwIfAborted, withDeadline } from "../util/async.js";
import { filePathToUri } from "../workspace/boundary.js";
import { languageIdFor } from "../workspace/files.js";
import type { ServerDefinition } from "../config/schema.js";
import type { NormalizedCapabilities } from "../protocol/types.js";
import { offsetsToServerRange } from "../protocol/positions.js";

export interface OpenDocument {
  uri: string;
  canonicalPath: string;
  languageId: string;
  version: number;
  contentHash: string;
  text: string;
  mtimeMs: number;
  size: number;
  /** When the read behind `text` began; see `isUnchangedOnDisk`. */
  readAtMs: number;
  lastUse: number;
}
export interface DocumentSnapshot extends OpenDocument { syncState: "opened" | "changed" | "unchanged" }
export type Notify = (method: string, params?: unknown) => Promise<void>;

export class DocumentStore {
  private readonly documents = new Map<string, OpenDocument>();
  private readonly queues = new KeyedMutex();
  private readonly registryMutex = new AsyncMutex();
  private readonly pins = new Map<string, number>();
  private readonly pinWaiters = new Set<() => void>();
  /**
   * Highest version ever assigned per path, retained across close/reopen. Versions must never be
   * reused for a document whose content differs, because consumers such as the diagnostic service
   * treat a matching (uri, version) pair as proof that a server publication describes this exact
   * snapshot. Restarting at version 1 after an LRU close would break that invariant.
   */
  private readonly versionFloor = new Map<string, number>();
  /**
   * Content last handed to the server per path, retained across close/reopen so that reopening an
   * untouched document is not mistaken for an edit. Consumers that cache cross-file results need to
   * know when the server's view of the workspace actually changed, which an LRU reopen does not.
   */
  private readonly syncedHashes = new Map<string, string>();
  constructor(private readonly server: ServerDefinition, private readonly capabilities: NormalizedCapabilities, private readonly notify: Notify, private readonly maxOpen: number, private readonly maxFileBytes: number, private readonly onContentChanged: (path: string) => void = () => undefined) {}

  list(): OpenDocument[] { return [...this.documents.values()].map((document) => ({ ...document })); }
  get(path: string): OpenDocument | undefined { const document = this.documents.get(path); return document ? { ...document } : undefined; }
  getByUri(uri: string): OpenDocument | undefined { const document = [...this.documents.values()].find((item) => item.uri === uri); return document ? { ...document } : undefined; }

  sync(path: string, signal?: AbortSignal): Promise<DocumentSnapshot> {
    return this.withPins([path], () => this.queues.run(path, () => this.syncUnlocked(path, signal)));
  }

  syncAndSave(path: string, signal?: AbortSignal): Promise<DocumentSnapshot> {
    return this.withPins([path], () => this.queues.run(path, async () => {
      const snapshot = await this.syncUnlocked(path, signal);
      throwIfAborted(signal);
      await this.notifySave(snapshot);
      return snapshot;
    }));
  }

  withSynchronizedDocument<T>(path: string, signal: AbortSignal | undefined, fn: (snapshot: DocumentSnapshot) => Promise<T>): Promise<T> {
    return this.withPins([path], () => this.queues.run(path, async () => fn(await this.syncUnlocked(path, signal))));
  }

  withSynchronizedDocuments<T>(paths: string[], signal: AbortSignal | undefined, fn: (snapshots: DocumentSnapshot[]) => Promise<T>): Promise<T> {
    const unique = [...new Set(paths)].sort();
    if (unique.length > this.maxOpen) return Promise.reject(new Error(`Operation requires ${unique.length} open documents, exceeding the ${this.maxOpen} document limit`));
    return this.withPins(unique, () => {
      const snapshots: DocumentSnapshot[] = [];
      const acquire = (index: number): Promise<T> => {
        if (index === unique.length) return fn(snapshots);
        const path = unique[index]!;
        return this.queues.run(path, async () => { snapshots.push(await this.syncUnlocked(path, signal)); return acquire(index + 1); });
      };
      return acquire(0);
    });
  }

  async didSave(paths: string[]): Promise<void> {
    for (const path of paths) {
      await this.withPins([path], () => this.queues.run(path, async () => {
        const document = this.documents.get(path);
        if (document) await this.notifySave(document);
      }));
    }
  }

  async close(path: string): Promise<void> {
    const document = this.documents.get(path);
    if (!document) return;
    this.documents.delete(path);
    if (this.capabilities.openClose) await this.notify("textDocument/didClose", { textDocument: { uri: document.uri } }).catch(() => undefined);
  }
  async closeAll(): Promise<void> { for (const path of [...this.documents.keys()]) await this.close(path); }

  private async syncUnlocked(path: string, signal?: AbortSignal): Promise<DocumentSnapshot> {
    throwIfAborted(signal);
    let info;
    try { info = await stat(path); }
    catch (error) { await this.close(path); throw error; }
    if (!info.isFile()) throw new Error(`Not a regular file: ${path}`);
    if (info.size > this.maxFileBytes) throw new Error(`File exceeds synchronization limit (${this.maxFileBytes} bytes): ${path}`);
    const existing = this.documents.get(path);
    // A diagnostics sweep re-synchronizes every open document, and almost all of them are untouched
    // since the last one. Recognising that from the stat alone skips reading and hashing the file.
    if (existing && this.isUnchangedOnDisk(existing, info)) { existing.lastUse = Date.now(); return { ...existing, syncState: "unchanged" }; }
    const readAtMs = Date.now();
    const text = await readFile(path, "utf8");
    throwIfAborted(signal);
    const hash = stableHash(text);
    if (existing && existing.contentHash === hash) { Object.assign(existing, { mtimeMs: info.mtimeMs, size: info.size, readAtMs, lastUse: Date.now() }); return { ...existing, syncState: "unchanged" }; }
    if (this.capabilities.syncKind === 0) throw new Error(`Server ${this.server.id} does not support document synchronization`);
    const uri = filePathToUri(path);
    const languageId = languageIdFor(this.server, path) ?? "plaintext";
    if (!existing) {
      const openVersion = (this.versionFloor.get(path) ?? 0) + 1;
      const document: OpenDocument = { uri, canonicalPath: path, languageId, version: openVersion, contentHash: hash, text, mtimeMs: info.mtimeMs, size: info.size, readAtMs, lastUse: Date.now() };
      await this.registryMutex.run(async () => {
        await this.evictIfNeeded(signal);
        this.documents.set(path, document);
        this.versionFloor.set(path, openVersion);
        try { if (this.capabilities.openClose) await this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: openVersion, text } }); }
        catch (error) { this.documents.delete(path); throw error; }
      });
      this.recordSynced(path, hash);
      return { ...document, syncState: "opened" };
    }
    const version = existing.version + 1;
    const contentChanges = this.capabilities.syncKind === 2
      ? [{ range: offsetsToServerRange(existing.text, 0, existing.text.length, this.capabilities.positionEncoding), text }]
      : [{ text }];
    await this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges });
    this.versionFloor.set(path, version);
    Object.assign(existing, { version, contentHash: hash, text, mtimeMs: info.mtimeMs, size: info.size, readAtMs, lastUse: Date.now() });
    this.recordSynced(path, hash);
    return { ...existing, syncState: "changed" };
  }
  /**
   * Whether `document` still matches the file `info` describes, without reading it back.
   *
   * Size and modification time alone would not be enough. Same-length edits are ordinary here — an
   * agent flipping a digit or a boolean leaves the byte count untouched — so a write landing in the
   * same clock tick as the time already recorded would be invisible, and the server would keep
   * answering from content that no longer exists on disk. Requiring the recorded time to be
   * strictly older than the moment its read began closes that window: it establishes that the
   * modification behind the cached text completed before the read, so any write after the read must
   * carry a later time and will be noticed. Git applies the same rule to its index and calls the
   * entries this excludes racily clean.
   *
   * A file whose timestamp sits in the future, or one whose mtime is not updated on write at all,
   * simply never takes this path and is re-read as before.
   */
  private isUnchangedOnDisk(document: OpenDocument, info: Stats): boolean {
    return info.size === document.size && info.mtimeMs === document.mtimeMs && info.mtimeMs < document.readAtMs;
  }
  /**
   * Announce content the server has not seen before. A first sync is not announced: the server has
   * no prior view of that path to invalidate, and treating every cold open as an edit would discard
   * cached cross-file results on each LRU reopen during a sweep.
   */
  private recordSynced(path: string, hash: string): void {
    const previous = this.syncedHashes.get(path);
    this.syncedHashes.set(path, hash);
    if (previous !== undefined && previous !== hash) this.onContentChanged(path);
  }
  private async notifySave(document: OpenDocument): Promise<void> {
    if (!this.capabilities.save) return;
    await this.notify("textDocument/didSave", { textDocument: { uri: document.uri }, ...(this.capabilities.save.includeText ? { text: document.text } : {}) });
  }
  private async evictIfNeeded(signal?: AbortSignal): Promise<void> {
    while (this.documents.size >= this.maxOpen) {
      const oldest = [...this.documents.values()].filter((document) => !this.pins.has(document.canonicalPath)).sort((a, b) => a.lastUse - b.lastUse)[0];
      if (oldest) { await this.close(oldest.canonicalPath); return; }
      let wake!: () => void;
      const released = new Promise<void>((resolve) => { wake = resolve; this.pinWaiters.add(wake); });
      try { await withDeadline(released, 5_000, signal, "open-document eviction wait"); }
      finally { this.pinWaiters.delete(wake); }
    }
  }
  private async withPins<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
    for (const path of paths) this.pins.set(path, (this.pins.get(path) ?? 0) + 1);
    try { return await fn(); }
    finally {
      for (const path of paths) {
        const count = (this.pins.get(path) ?? 1) - 1;
        if (count <= 0) this.pins.delete(path); else this.pins.set(path, count);
      }
      const waiters = [...this.pinWaiters]; this.pinWaiters.clear(); for (const waiter of waiters) waiter();
    }
  }
}
