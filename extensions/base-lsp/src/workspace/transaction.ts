import { chmod, lstat, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { EditManifest, StagedFile } from "./edits.js";
import { AsyncMutex, throwIfAborted } from "../util/async.js";
import { stableHash } from "../util/text.js";

const transactionMutex = new AsyncMutex();

export async function applyManifest(manifest: EditManifest, signal?: AbortSignal): Promise<string[]> {
  if (!manifest.applicable) throw new Error(`Workspace edit is not applicable: ${manifest.reasons.join("; ")}`);
  const paths = [...new Set(manifest.files.map((file) => file.path))].sort();
  return transactionMutex.run(() => withAllQueues(paths, 0, async () => {
    throwIfAborted(signal);
    for (const file of manifest.files) await revalidate(file);
    throwIfAborted(signal);
    const published: StagedFile[] = [];
    const temporaries = new Set<string>();
    try {
      for (const file of manifest.files) {
        throwIfAborted(signal);
        await atomicReplace(file, file.updated, temporaries, true);
        published.push(file);
      }
      return published.map((file) => file.path);
    } catch (error) {
      const failed: string[] = [];
      for (const file of [...published].reverse()) {
        try { await atomicReplace(file, file.original, temporaries, false); }
        catch { failed.push(file.path); }
      }
      if (failed.length) throw new Error(`Transaction failed and rollback failed for: ${failed.join(", ")}. Original error: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      await Promise.all([...temporaries].map((path) => rm(path, { force: true }).catch(() => undefined)));
    }
  }));
}

async function revalidate(file: StagedFile): Promise<void> {
  const lexical = await lstat(file.path);
  if (!lexical.isFile()) throw new Error(`Mutation target changed type since preview: ${file.path}`);
  const canonical = await realpath(file.path);
  if (canonical !== file.path) throw new Error(`Mutation target path changed since preview: ${file.path}`);
  const info = await stat(file.path);
  await validateParent(file);
  if (file.dev !== undefined && info.dev !== file.dev) throw new Error(`Mutation target device changed since preview: ${file.path}`);
  if (file.ino !== undefined && info.ino !== file.ino) throw new Error(`Mutation target inode changed since preview: ${file.path}`);
  if (stableHash(await readFile(file.path, "utf8")) !== file.hash) throw new Error(`File changed since LSP response: ${file.path}`);
}

async function atomicReplace(file: StagedFile, text: string, temporaries: Set<string>, validateTarget: boolean): Promise<void> {
  const directory = dirname(file.path);
  await validateParent(file);
  const temporary = join(directory, `.${basename(file.path)}.base-lsp-${process.pid}-${randomBytes(6).toString("hex")}`);
  temporaries.add(temporary);
  await writeFile(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const handle = await open(temporary, "r");
  try { await handle.sync(); } finally { await handle.close(); }
  await validateParent(file);
  if (validateTarget) await revalidate(file);
  await chmod(temporary, file.mode & 0o777);
  await rename(temporary, file.path);
  temporaries.delete(temporary);
  const directoryHandle = await open(directory, "r").catch(() => undefined);
  if (directoryHandle) {
    try { await directoryHandle.sync().catch(() => undefined); } finally { await directoryHandle.close(); }
  }
}

async function validateParent(file: StagedFile): Promise<void> {
  const directory = dirname(file.path);
  const canonical = await realpath(directory);
  if (canonical !== directory) throw new Error(`Mutation target directory changed since preview: ${directory}`);
  const info = await stat(directory);
  if (!info.isDirectory()) throw new Error(`Mutation target parent is not a directory: ${directory}`);
  if (file.parentDev !== undefined && info.dev !== file.parentDev) throw new Error(`Mutation target parent device changed since preview: ${directory}`);
  if (file.parentIno !== undefined && info.ino !== file.parentIno) throw new Error(`Mutation target parent inode changed since preview: ${directory}`);
}

function withAllQueues<T>(paths: string[], index: number, fn: () => Promise<T>): Promise<T> {
  if (index === paths.length) return fn();
  return withFileMutationQueue(paths[index]!, () => withAllQueues(paths, index + 1, fn));
}
