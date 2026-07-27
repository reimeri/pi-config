import { opendir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { RootMarker, ServerDefinition } from "../config/schema.js";
import { isContained } from "../workspace/boundary.js";

export interface RootResolution { root?: string; marker?: string; fallback?: "workspace" | "file-directory" | "none"; distance: number; markerPriority: number }

export class RootDetector {
  private readonly cache = new Map<string, RootResolution>();
  private readonly inflight = new Map<string, Promise<RootResolution>>();
  constructor(private generation: number) {}

  async find(server: ServerDefinition, filePath: string, boundary: string): Promise<RootResolution> {
    const start = dirname(resolve(filePath));
    const key = `${this.generation}\0${server.id}\0${start}\0${boundary}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const running = this.inflight.get(key);
    if (running) return running;
    const promise = this.search(server, start, boundary).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    const result = await promise;
    if (result.root) this.cache.set(key, result);
    return result;
  }

  clear(generation = this.generation + 1): void { this.generation = generation; this.cache.clear(); this.inflight.clear(); }

  private async search(server: ServerDefinition, start: string, boundary: string): Promise<RootResolution> {
    let current = start;
    let distance = 0;
    while (isContained(boundary, current)) {
      for (let index = 0; index < server.rootMarkers.length; index += 1) {
        const marker = server.rootMarkers[index]!;
        if (await markerExists(current, marker)) return { root: current, marker: markerName(marker), distance, markerPriority: index };
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
function globRegex(glob: string): RegExp { return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`); }
