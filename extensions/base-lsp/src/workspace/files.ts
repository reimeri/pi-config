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
    // `entry.name` is already the base name `matchesServerFile` would recover from `path`, and this
    // runs once per server per entry, so pass it straight through.
    if (!servers.some((server) => matchesServerName(server, entry.name))) continue;
    const canonicalFile = await realpath(path).catch(() => undefined);
    if (!canonicalFile || !isContained(boundary, canonicalFile)) continue;
    const info = await stat(canonicalFile).catch(() => undefined);
    if (!info?.isFile()) continue;
    if (info.size > maxFileBytes) { result.oversized += 1; continue; }
    if (result.files.length >= maxFiles) { result.omitted += 1; result.capped = true; continue; }
    result.files.push(canonicalFile);
  }
}

/**
 * Extensions ordered longest-first, cached per definition. Sorting matters only where the *most
 * specific* match is wanted (`.d.ts` ahead of `.ts`), and a discovery sweep asks that of every
 * server for every path, so the order is derived once. Definitions are replaced wholesale on a
 * config reload, and the weak keying lets the cached copies go with them.
 */
const extensionOrder = new WeakMap<ServerDefinition, string[]>();

function extensionsByLength(server: ServerDefinition): string[] {
  let ordered = extensionOrder.get(server);
  if (!ordered) {
    ordered = [...server.extensions].sort((a, b) => b.length - a.length);
    extensionOrder.set(server, ordered);
  }
  return ordered;
}

/** The final segment of `filePath`, accepting either separator. */
export function fileNameOf(filePath: string): string {
  return filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1);
}

/** The longest extension of `server` that `name` ends with, if any. */
export function matchedExtension(server: ServerDefinition, name: string): string | undefined {
  return extensionsByLength(server).find((extension) => name.endsWith(extension));
}

/**
 * Whether this server handles `name` — a bare file name rather than a path. Callers testing one
 * name against many servers should derive it once with `fileNameOf` instead of per server.
 */
export function matchesServerName(server: ServerDefinition, name: string): boolean {
  if (server.filenames?.includes(name)) return true;
  // Unordered on purpose: any match settles a yes/no question, so this skips the length ordering
  // that `matchedExtension` needs.
  return server.extensions.some((extension) => name.endsWith(extension));
}

export function matchesServerFile(server: ServerDefinition, filePath: string): boolean {
  return matchesServerName(server, fileNameOf(filePath));
}

export function languageIdFor(server: ServerDefinition, filePath: string): string | undefined {
  const name = fileNameOf(filePath);
  if (server.filenames?.includes(name)) return server.languageIds[name];
  const extension = matchedExtension(server, name);
  return extension ? server.languageIds[extension] : undefined;
}
