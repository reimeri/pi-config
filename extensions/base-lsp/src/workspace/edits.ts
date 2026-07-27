import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { DocumentChange, TextDocumentEdit, TextEdit, WorkspaceEdit } from "../protocol/types.js";
import type { PositionEncoding } from "../protocol/types.js";
import { serverRangeToOffsets } from "../protocol/positions.js";
import { assertSafeExistingFile, uriToFilePath } from "./boundary.js";
import { stableHash } from "../util/text.js";

export interface StagedFile { path: string; uri: string; original: string; updated: string; hash: string; mode: number; mtimeMs: number; dev?: number; ino?: number; parentDev?: number; parentIno?: number; version?: number | null; edits: number }
export interface EditManifest { files: StagedFile[]; totalEdits: number; resourceOperations: DocumentChange[]; applicable: boolean; reasons: string[]; fingerprint: string }
export interface WorkspaceEditSnapshot { uri: string; canonicalPath: string; version: number; text: string; contentHash: string }

export async function normalizeWorkspaceEdit(edit: WorkspaceEdit | null | undefined, boundary: string, encoding: PositionEncoding, limits: { maxEditsPerFile: number; maxTotalEdits: number; maxTransactionFiles: number; maxTransactionBytes: number }, documentVersions?: ReadonlyMap<string, number>, documentSnapshots?: ReadonlyMap<string, WorkspaceEditSnapshot>): Promise<EditManifest> {
  if (!edit) return finalize([], [], ["Server returned no workspace edit"]);
  const byUri = new Map<string, { edits: TextEdit[]; version?: number | null }>();
  const resources: DocumentChange[] = [];
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) add(byUri, uri, edits);
  for (const change of edit.documentChanges ?? []) {
    if (isTextDocumentEdit(change)) add(byUri, change.textDocument.uri, change.edits, change.textDocument.version);
    else resources.push(change);
  }
  const reasons: string[] = [];
  if (resources.length) reasons.push("Resource operations are preview-only in v1");
  if (byUri.size > limits.maxTransactionFiles) reasons.push(`Workspace edit exceeds ${limits.maxTransactionFiles} files`);
  const files: StagedFile[] = [];
  let totalEdits = 0;
  let totalInputBytes = 0;
  let totalOutputBytes = 0;
  for (const [uri, entry] of [...byUri].sort(([a], [b]) => a.localeCompare(b))) {
    const rawPath = uriToFilePath(uri);
    if (!rawPath) { reasons.push(`Non-file URI cannot be mutated: ${uri}`); continue; }
    let path: string;
    try { path = await assertSafeExistingFile(rawPath, boundary); } catch (error) { reasons.push(error instanceof Error ? error.message : String(error)); continue; }
    if (entry.version !== undefined && entry.version !== null) {
      const synchronizedVersion = documentVersions?.get(uri);
      if (synchronizedVersion === undefined) { reasons.push(`${path} has server version ${entry.version}, but no synchronized client snapshot is available`); continue; }
      if (synchronizedVersion !== entry.version) { reasons.push(`${path} version mismatch: server=${entry.version}, client=${synchronizedVersion}`); continue; }
    }
    if (entry.edits.length > limits.maxEditsPerFile) { reasons.push(`${path} exceeds per-file edit limit`); continue; }
    totalEdits += entry.edits.length;
    if (totalEdits > limits.maxTotalEdits) { reasons.push("Workspace edit exceeds total edit limit"); continue; }
    const snapshot = documentSnapshots?.get(uri);
    if (snapshot && snapshot.canonicalPath !== path) { reasons.push(`${path} does not match the synchronized snapshot path`); continue; }
    if (snapshot && entry.version !== undefined && entry.version !== null && snapshot.version !== entry.version) { reasons.push(`${path} snapshot version mismatch: server=${entry.version}, snapshot=${snapshot.version}`); continue; }
    const original = snapshot?.text ?? await readFile(path, "utf8");
    if (snapshot && stableHash(original) !== snapshot.contentHash) { reasons.push(`${path} synchronized snapshot hash is inconsistent`); continue; }
    const info = await stat(path);
    const parentInfo = await stat(dirname(path));
    totalInputBytes += Buffer.byteLength(original);
    if (totalInputBytes > limits.maxTransactionBytes) { reasons.push("Workspace edit exceeds transaction input byte limit"); continue; }
    const normalized = entry.edits.map((item, index) => ({ ...serverRangeToOffsets(original, item.range, encoding), text: item.newText, index }));
    normalized.sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);
    for (let index = 1; index < normalized.length; index += 1) if (normalized[index]!.start < normalized[index - 1]!.end) throw new Error(`Overlapping edits for ${path}`);
    let updated = original;
    for (const item of [...normalized].sort((a, b) => b.start - a.start || b.end - a.end || b.index - a.index)) updated = updated.slice(0, item.start) + item.text + updated.slice(item.end);
    totalOutputBytes += Buffer.byteLength(updated);
    if (totalOutputBytes > limits.maxTransactionBytes) { reasons.push("Workspace edit exceeds transaction output byte limit"); continue; }
    files.push({ path, uri, original, updated, hash: stableHash(original), mode: info.mode, mtimeMs: info.mtimeMs, ...(Number.isSafeInteger(info.dev) ? { dev: info.dev } : {}), ...(Number.isSafeInteger(info.ino) ? { ino: info.ino } : {}), ...(Number.isSafeInteger(parentInfo.dev) ? { parentDev: parentInfo.dev } : {}), ...(Number.isSafeInteger(parentInfo.ino) ? { parentIno: parentInfo.ino } : {}), ...(entry.version !== undefined ? { version: entry.version } : {}), edits: entry.edits.length });
  }
  return finalize(files, resources, reasons, totalEdits);
}
function add(map: Map<string, { edits: TextEdit[]; version?: number | null }>, uri: string, edits: TextEdit[], version?: number | null): void {
  const existing = map.get(uri);
  if (existing) {
    if (existing.version !== undefined && version !== undefined && existing.version !== version) throw new Error(`Conflicting document versions for ${uri}`);
    existing.edits.push(...edits);
    if (existing.version === undefined && version !== undefined) existing.version = version;
  } else map.set(uri, { edits: [...edits], ...(version !== undefined ? { version } : {}) });
}
function isTextDocumentEdit(change: DocumentChange): change is TextDocumentEdit { return "textDocument" in change; }
function finalize(files: StagedFile[], resources: DocumentChange[], reasons: string[], totalEdits = 0): EditManifest {
  const fingerprint = stableHash({ files: files.map((file) => ({ path: file.path, hash: file.hash, updated: stableHash(file.updated), version: file.version, edits: file.edits })), resources });
  return { files, totalEdits, resourceOperations: resources, applicable: reasons.length === 0 && files.length > 0, reasons, fingerprint };
}
