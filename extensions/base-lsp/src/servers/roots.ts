import { opendir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { RootMarker, ServerDefinition } from "../config/schema.js";
import { isContained } from "../workspace/boundary.js";

export interface RootResolution { root?: string; marker?: string; fallback?: "workspace" | "file-directory" | "none"; distance: number; markerPriority: number }

/** Cache markerless searches briefly; expire fallback roots because unseen markers can change routing. */
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
        // Remove only this search; invalidation may have installed a newer one.
        entry = { promise: undefined as unknown as Promise<RootResolution>, invalidated: false };
        entry.promise = this.search(server, start, boundary).finally(() => { if (this.inflight.get(key) === entry) this.inflight.delete(key); });
        this.inflight.set(key, entry);
      }
      const result = await entry.promise;
      // Retry searches starting under the new marker; unrelated walks are unaffected.
      if (entry.invalidated) continue;
      this.cache.set(key, result.fallback ? { result, expiresAt: this.now() + NEGATIVE_TTL_MS } : { result });
      return result;
    }
  }

  /** Invalidates searches from this directory or below without clearing unrelated walks. */
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
