import { opendir, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { ServerDefinition } from "../config/schema.js";
import { throwIfAborted } from "../util/async.js";
import { isContained } from "./boundary.js";

export interface DiscoveryResult { files: string[]; entries: number; ignored: number; oversized: number; omitted: number; capped: boolean }

export async function discoverFiles(root: string, boundary: string, servers: ServerDefinition[], patterns: string[], maxEntries: number, maxFiles: number, maxFileBytes: number, signal?: AbortSignal): Promise<DiscoveryResult> {
  const matcher = ignore().add(patterns).add(".git/");
  const result: DiscoveryResult = { files: [], entries: 0, ignored: 0, oversized: 0, omitted: 0, capped: false };
  const seen = new Set<string>();
  await walk(resolve(root), root, boundary, servers, matcher, maxEntries, maxFiles, maxFileBytes, seen, result, signal);
  result.files.sort();
  return result;
}

async function walk(directory: string, root: string, boundary: string, servers: ServerDefinition[], matcher: Ignore, maxEntries: number, maxFiles: number, maxFileBytes: number, seen: Set<string>, result: DiscoveryResult, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (result.entries >= maxEntries) { result.capped = true; return; }
  const canonical = await realpath(directory).catch(() => undefined);
  if (!canonical || !isContained(boundary, canonical) || seen.has(canonical)) return;
  seen.add(canonical);
  const handle = await opendir(directory).catch(() => undefined);
  if (!handle) return;
  const entries = [];
  let exhausted = false;
  try {
    const capacity = Math.max(0, maxEntries - result.entries);
    for (let index = 0; index < capacity; index += 1) {
      throwIfAborted(signal);
      const entry = await handle.read();
      if (!entry) { exhausted = true; break; }
      entries.push(entry);
      result.entries += 1;
    }
  } finally { await handle.close().catch(() => undefined); }
  if (!exhausted) result.capped = true;
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    throwIfAborted(signal);
    const path = resolve(directory, entry.name);
    const rel = relative(root, path).split(sep).join("/");
    const ignored = matcher.ignores(entry.isDirectory() ? `${rel}/` : rel);
    if (ignored) { result.ignored += 1; continue; }
    if (entry.isDirectory()) {
      if (result.entries >= maxEntries) { result.capped = true; continue; }
      await walk(path, root, boundary, servers, matcher, maxEntries, maxFiles, maxFileBytes, seen, result, signal);
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!servers.some((server) => matchesServerFile(server, path))) continue;
    const canonicalFile = await realpath(path).catch(() => undefined);
    if (!canonicalFile || !isContained(boundary, canonicalFile)) continue;
    const info = await stat(canonicalFile).catch(() => undefined);
    if (!info?.isFile()) continue;
    if (info.size > maxFileBytes) { result.oversized += 1; continue; }
    if (result.files.length >= maxFiles) { result.omitted += 1; result.capped = true; continue; }
    result.files.push(canonicalFile);
  }
}

export function matchesServerFile(server: ServerDefinition, filePath: string): boolean {
  const name = filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1);
  if (server.filenames?.includes(name)) return true;
  return [...server.extensions].sort((a, b) => b.length - a.length).some((extension) => name.endsWith(extension));
}

export function languageIdFor(server: ServerDefinition, filePath: string): string | undefined {
  const name = filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1);
  if (server.filenames?.includes(name)) return server.languageIds[name];
  const extension = [...server.extensions].sort((a, b) => b.length - a.length).find((item) => name.endsWith(item));
  return extension ? server.languageIds[extension] : undefined;
}
