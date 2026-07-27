import { opendir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { RootMarker, ServerDefinition } from "../config/schema.js";
import { isContained } from "../workspace/boundary.js";

export interface RootResolution { root?: string; marker?: string; fallback?: "workspace" | "file-directory" | "none"; distance: number; markerPriority: number }

/**
 * How long an answer that found no marker is trusted. Such an answer used to be discarded entirely,
 * so every file under a directory with no marker re-walked the whole ancestor chain, `stat`ing every
 * marker at every level — around a millisecond each time, against a microsecond for a cached answer.
 * It is not cached outright because the answer legitimately changes when a marker is created
 * mid-session, and the detector lives for the whole session: nothing rebuilds it between
 * `session_start` events, so retaining a markerless answer hides the new marker until the session
 * ends. `invalidateUnder` covers markers this agent writes itself; the window is what covers the
 * ones it does not see, and it still collapses the bursts that matter (a diagnostics sweep, a run of
 * navigation requests).
 *
 * Expiry keys off `fallback`, not off a missing `root`: the `workspace` and `file-directory`
 * fallbacks both name a root without having matched anything, so keying off `root` would pin them
 * for the session and leave those servers rooted above a marker created later.
 */
const NEGATIVE_TTL_MS = 5_000;

interface CacheEntry { result: RootResolution; expiresAt?: number }
interface InflightEntry { promise: Promise<RootResolution>; invalidated: boolean }
type MarkerProbe = (directory: string, marker: RootMarker) => Promise<boolean>;

export class RootDetector {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, InflightEntry>();
  constructor(private generation: number, private readonly now: () => number = Date.now, private readonly markerProbe: MarkerProbe = markerExists) {}

  async find(server: ServerDefinition, filePath: string, boundary: string): Promise<RootResolution> {
    const start = dirname(resolve(filePath));
    while (true) {
      const key = `${this.generation}\0${server.id}\0${start}\0${boundary}`;
      const cached = this.cache.get(key);
      if (cached && (cached.expiresAt === undefined || cached.expiresAt > this.now())) return cached.result;
      let entry = this.inflight.get(key);
      if (!entry) {
        // Deletes only its own entry: an invalidation can drop this search from the map and a later
        // one take its place, and settling must not evict that newer search.
        entry = { promise: undefined as unknown as Promise<RootResolution>, invalidated: false };
        entry.promise = this.search(server, start, boundary).finally(() => { if (this.inflight.get(key) === entry) this.inflight.delete(key); });
        this.inflight.set(key, entry);
      }
      const result = await entry.promise;
      // The search may have walked past a directory immediately before a marker was written there.
      // Retry only entries whose own start lies under that marker; unrelated searches continue.
      if (entry.invalidated) continue;
      this.cache.set(key, result.fallback ? { result, expiresAt: this.now() + NEGATIVE_TTL_MS } : { result });
      return result;
    }
  }

  /**
   * Drops every answer that a marker appearing in `directory` could change — that is, every answer
   * resolved from `directory` or below it, since the walk only ever climbs. Cheaper and far less
   * destructive than clearing: callers invoke it on writes, and a write of a non-marker file must
   * not cost the whole cache.
   */
  invalidateUnder(directory: string): void {
    const target = resolve(directory);
    for (const key of this.cache.keys()) if (isContained(target, startOf(key))) this.cache.delete(key);
    for (const [key, entry] of this.inflight) {
      if (!isContained(target, startOf(key))) continue;
      entry.invalidated = true;
      this.inflight.delete(key);
    }
  }

  clear(generation = this.generation + 1): void {
    this.generation = generation;
    this.cache.clear();
    for (const entry of this.inflight.values()) entry.invalidated = true;
    this.inflight.clear();
  }

  private async search(server: ServerDefinition, start: string, boundary: string): Promise<RootResolution> {
    let current = start;
    let distance = 0;
    while (isContained(boundary, current)) {
      for (let index = 0; index < server.rootMarkers.length; index += 1) {
        const marker = server.rootMarkers[index]!;
        if (await this.markerProbe(current, marker)) return { root: current, marker: markerName(marker), distance, markerPriority: index };
      }
      if (current === boundary) break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
      distance += 1;
    }
    if (server.rootFallback === "workspace") return { root: boundary, fallback: "workspace", distance: Number.MAX_SAFE_INTEGER, markerPriority: Number.MAX_SAFE_INTEGER };
    if (server.rootFallback === "file-directory") return { root: start, fallback: "file-directory", distance: Number.MAX_SAFE_INTEGER, markerPriority: Number.MAX_SAFE_INTEGER };
    return { fallback: "none", distance: Number.MAX_SAFE_INTEGER, markerPriority: Number.MAX_SAFE_INTEGER };
  }
}

async function markerExists(directory: string, marker: RootMarker): Promise<boolean> {
  if (typeof marker === "string") { try { await stat(resolve(directory, marker)); return true; } catch { return false; } }
  const expression = globRegex(marker.glob);
  try { const handle = await opendir(directory); for await (const entry of handle) if (expression.test(entry.name)) return true; } catch { /* inaccessible */ }
  return false;
}
function markerName(marker: RootMarker): string { return typeof marker === "string" ? marker : marker.glob; }

/** The `start` field of a cache key, which is the third of the four NUL-separated components. */
function startOf(key: string): string { return key.split("\0")[2] ?? ""; }

/** Whether creating a file called `name` could give some server a new root. */
export function isRootMarkerName(servers: ServerDefinition[], name: string): boolean {
  return servers.some((server) => server.rootMarkers.some((marker) => (typeof marker === "string" ? marker === name : globRegex(marker.glob).test(name))));
}

/** Compiled glob markers, keyed by pattern; the set of patterns comes from config and is tiny. */
const globPatterns = new Map<string, RegExp>();
function globRegex(glob: string): RegExp {
  let expression = globPatterns.get(glob);
  if (!expression) {
    expression = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`);
    globPatterns.set(glob, expression);
  }
  return expression;
}
