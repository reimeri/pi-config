import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { stripLeadingAt } from "../util/text.js";

export interface SessionBoundary { cwd: string; root: string; vcsRoot?: string }

export async function deriveBoundary(cwd: string): Promise<SessionBoundary> {
  const canonicalCwd = await realpath(resolve(cwd));
  const home = await realpath(homedir()).catch(() => resolve(homedir()));
  let current = canonicalCwd;
  let vcsRoot: string | undefined;
  while (true) {
    const parent = dirname(current);
    if (current === home || parent === current) break;
    if (await exists(joinPath(current, ".git"))) { vcsRoot = current; break; }
    current = parent;
  }
  return { cwd: canonicalCwd, root: vcsRoot ?? canonicalCwd, ...(vcsRoot ? { vcsRoot } : {}) };
}

export function isContained(boundary: string, candidate: string): boolean {
  const rel = relative(boundary, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export interface ResolvedInputPath { canonical: string; lexical: string; lexicalDirectory?: string }

export async function resolveInputPathDetails(input: string, cwd: string, boundary: string, requireFile = true): Promise<ResolvedInputPath> {
  const lexical = resolve(cwd, stripLeadingAt(input));
  if (!isContained(boundary, lexical)) throw new Error(`Path is outside the session boundary: ${input}`);
  const canonical = await realpath(lexical);
  if (!isContained(boundary, canonical)) throw new Error(`Path resolves outside the session boundary: ${input}`);
  if (requireFile && !(await stat(canonical)).isFile()) throw new Error(`Path is not a regular file: ${input}`);
  const directory = await realpath(dirname(lexical));
  return { canonical, lexical, ...(isContained(boundary, directory) ? { lexicalDirectory: directory } : {}) };
}

export async function resolveInputPath(input: string, cwd: string, boundary: string, requireFile = true): Promise<string> {
  return (await resolveInputPathDetails(input, cwd, boundary, requireFile)).canonical;
}

export async function resolveExplicitRoot(input: string, cwd: string, boundary: string): Promise<string> {
  const lexical = resolve(cwd, stripLeadingAt(input));
  if (!isContained(boundary, lexical)) throw new Error(`Root is outside the session boundary: ${input}`);
  const canonical = await realpath(lexical);
  if (!isContained(boundary, canonical)) throw new Error(`Root resolves outside the session boundary: ${input}`);
  if (!(await stat(canonical)).isDirectory()) throw new Error(`Root is not a directory: ${input}`);
  return canonical;
}

export async function assertSafeExistingFile(path: string, boundary: string): Promise<string> {
  const lexical = resolve(path);
  if (!isContained(boundary, lexical)) throw new Error(`Mutation target is outside the session boundary: ${path}`);
  const info = await lstat(lexical);
  if (!info.isFile() && !info.isSymbolicLink()) throw new Error(`Mutation target is not a regular file: ${path}`);
  const canonical = await realpath(lexical);
  if (!isContained(boundary, canonical)) throw new Error(`Mutation target resolves outside the session boundary: ${path}`);
  if (!(await stat(canonical)).isFile()) throw new Error(`Mutation target is not a regular file: ${path}`);
  return canonical;
}

export function uriToFilePath(uri: string): string | undefined {
  try { const url = new URL(uri); return url.protocol === "file:" ? fileURLToPath(url) : undefined; } catch { return undefined; }
}
export function filePathToUri(path: string): string { return pathToFileURL(path).href; }

async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
function joinPath(left: string, right: string): string { return resolve(left, right); }
