import { readFile, realpath, stat } from "node:fs/promises";
import { relative } from "node:path";
import type { Location, LocationLink, PositionEncoding, Range } from "./types.js";
import { serverToPublicPosition } from "./positions.js";
import { isContained, uriToFilePath } from "../workspace/boundary.js";

export interface PublicLocationRange { start: { line: number; character?: number }; end: { line: number; character?: number } }
/** Why public columns are unavailable; preserves the raw range instead of inventing coordinates. */
export type UnresolvedRangeReason = "text-unavailable" | "out-of-range";
export interface NormalizedLocation {
  uri: string;
  path?: string;
  external: boolean;
  range: PublicLocationRange;
  selectionRange?: PublicLocationRange;
  originSelectionRange?: PublicLocationRange;
  positionEncoding: PositionEncoding;
  rangeUnresolved?: UnresolvedRangeReason;
  selectionRangeUnresolved?: UnresolvedRangeReason;
  originSelectionRangeUnresolved?: UnresolvedRangeReason;
  rawRange?: Range;
  rawSelectionRange?: Range;
  rawOriginSelectionRange?: Range;
}

export interface NormalizedLocations { locations: NormalizedLocation[]; total: number; truncated: boolean; rejected: number }

export async function normalizeLocations(value: unknown, root: string, boundary: string, encoding: PositionEncoding, limit: number, originText?: string): Promise<NormalizedLocations> {
  const items = value == null ? [] : Array.isArray(value) ? value : [value];
  const selected = items.slice(0, limit);
  const entries: Array<{ uri: string; range: Range; link?: LocationLink }> = [];
  for (const item of selected) {
    if (isLocationLink(item)) entries.push({ uri: item.targetUri, range: item.targetRange, link: item });
    else if (isLocation(item)) entries.push({ uri: item.uri, range: item.range });
  }
  // Report unconvertible entries so callers can distinguish loss from truncation.
  const rejected = selected.length - entries.length;
  // Group by target to read each file once; final sorting determines output order.
  entries.sort((a, b) => a.uri.localeCompare(b.uri));
  const result: NormalizedLocation[] = [];
  const texts = new BoundedTextCache();
  for (const { uri, range, link } of entries) {
    const file = uriToFilePath(uri);
    const localTarget = file ? await resolveLocalTarget(file, boundary) : undefined;
    const local = Boolean(localTarget);
    const targetText = localTarget ? await texts.get(localTarget) : undefined;
    // A stale range invalidates only itself; preserve its raw value and convert siblings.
    const target = resolvePart(targetText, range, encoding);
    const selection = resolvePart(targetText, link?.targetSelectionRange, encoding);
    const origin = resolvePart(originText, link?.originSelectionRange, encoding);
    result.push({
      uri,
      ...(file && local && isContained(root, file) ? { path: relative(root, file) || "." } : {}),
      external: !local,
      range: target.range ?? lineOnlyRange(range),
      ...(selection.range ? { selectionRange: selection.range } : {}),
      ...(origin.range ? { originSelectionRange: origin.range } : {}),
      positionEncoding: encoding,
      ...(target.unresolved ? { rangeUnresolved: target.unresolved, rawRange: range } : {}),
      ...(selection.unresolved ? { selectionRangeUnresolved: selection.unresolved, rawSelectionRange: link!.targetSelectionRange } : {}),
      ...(origin.unresolved ? { originSelectionRangeUnresolved: origin.unresolved, rawOriginSelectionRange: link!.originSelectionRange! } : {}),
    });
  }
  result.sort((a, b) => (a.path ?? a.uri).localeCompare(b.path ?? b.uri) || a.range.start.line - b.range.start.line || (a.range.start.character ?? 0) - (b.range.start.character ?? 0));
  return { locations: result, total: items.length, truncated: items.length > selected.length, rejected };
}

/** True when any of a location's ranges was dropped because it did not fit the text we can read. */
export function hasStaleRange(item: NormalizedLocation): boolean {
  return item.rangeUnresolved === "out-of-range" || item.selectionRangeUnresolved === "out-of-range" || item.originSelectionRangeUnresolved === "out-of-range";
}

/** Convert one optional server range, reporting why it could not be converted rather than dropping it. */
function resolvePart(text: string | undefined, range: Range | undefined, encoding: PositionEncoding): { range?: PublicLocationRange; unresolved?: UnresolvedRangeReason } {
  if (!range) return {};
  if (text === undefined) return { unresolved: "text-unavailable" };
  const converted = tryConvertRange(text, range, encoding);
  return converted ? { range: converted } : { unresolved: "out-of-range" };
}

export function convertRange(text: string, range: Range, encoding: PositionEncoding): PublicLocationRange {
  return { start: serverToPublicPosition(text, range.start, encoding), end: serverToPublicPosition(text, range.end, encoding) };
}

/** `convertRange`, but reports an unconvertible server range instead of throwing. */
export function tryConvertRange(text: string, range: Range, encoding: PositionEncoding): PublicLocationRange | undefined {
  try { return convertRange(text, range, encoding); } catch { return undefined; }
}

/** Per-call bounded LRU of target contents; repeated references often share files. */
class BoundedTextCache {
  private readonly entries = new Map<string, string | undefined>();
  private chars = 0;
  constructor(private readonly maxEntries = 8, private readonly maxChars = 8 * 1024 * 1024) {}
  async get(path: string): Promise<string | undefined> {
    if (this.entries.has(path)) {
      const hit = this.entries.get(path);
      this.entries.delete(path);
      this.entries.set(path, hit);
      return hit;
    }
    const text = await readBoundedText(path);
    this.entries.set(path, text);
    this.chars += text?.length ?? 0;
    while (this.entries.size > this.maxEntries || (this.chars > this.maxChars && this.entries.size > 1)) {
      const oldest = this.entries.keys().next().value as string;
      this.chars -= this.entries.get(oldest)?.length ?? 0;
      this.entries.delete(oldest);
    }
    return text;
  }
}
/** 1-based lines with no column, for a range whose columns could not be derived from text. */
export function lineOnlyRange(range: Range): PublicLocationRange { return { start: { line: range.start.line + 1 }, end: { line: range.end.line + 1 } }; }
async function resolveLocalTarget(path: string, boundary: string): Promise<string | undefined> {
  if (!isContained(boundary, path)) return undefined;
  try { const canonical = await realpath(path); return isContained(boundary, canonical) ? canonical : undefined; }
  catch { return undefined; }
}
async function readBoundedText(path: string): Promise<string | undefined> {
  try { const info = await stat(path); if (!info.isFile() || info.size > 2 * 1024 * 1024) return undefined; return await readFile(path, "utf8"); }
  catch { return undefined; }
}
function isLocation(value: unknown): value is Location { return Boolean(value) && typeof value === "object" && typeof (value as Location).uri === "string" && Boolean((value as Location).range); }
function isLocationLink(value: unknown): value is LocationLink { return Boolean(value) && typeof value === "object" && typeof (value as LocationLink).targetUri === "string" && Boolean((value as LocationLink).targetRange); }
