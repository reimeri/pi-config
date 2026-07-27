import { readFile, realpath, stat } from "node:fs/promises";
import { relative } from "node:path";
import type { Location, LocationLink, PositionEncoding, Range } from "./types.js";
import { serverToPublicPosition } from "./positions.js";
import { isContained, uriToFilePath } from "../workspace/boundary.js";

export interface PublicLocationRange { start: { line: number; character?: number }; end: { line: number; character?: number } }
export interface NormalizedLocation {
  uri: string;
  path?: string;
  external: boolean;
  range: PublicLocationRange;
  selectionRange?: PublicLocationRange;
  originSelectionRange?: PublicLocationRange;
  positionEncoding: PositionEncoding;
  rawRange?: Range;
  rawSelectionRange?: Range;
}

export async function normalizeLocations(value: unknown, root: string, boundary: string, encoding: PositionEncoding, limit: number, originText?: string): Promise<{ locations: NormalizedLocation[]; total: number; truncated: boolean }> {
  const items = value == null ? [] : Array.isArray(value) ? value : [value];
  const result: NormalizedLocation[] = [];
  for (const item of items.slice(0, limit)) {
    if (!isLocation(item) && !isLocationLink(item)) continue;
    const link = isLocationLink(item) ? item : undefined;
    const location = !link && isLocation(item) ? item : undefined;
    if (!link && !location) continue;
    const uri = link ? link.targetUri : location!.uri;
    const range = link ? link.targetRange : location!.range;
    const file = uriToFilePath(uri);
    const localTarget = file ? await resolveLocalTarget(file, boundary) : undefined;
    const local = Boolean(localTarget);
    let targetText: string | undefined;
    if (localTarget) targetText = await readBoundedText(localTarget);
    const convertedRange = targetText ? convertRange(targetText, range, encoding) : lineOnlyRange(range);
    const selectionRange = link?.targetSelectionRange && targetText ? convertRange(targetText, link.targetSelectionRange, encoding) : undefined;
    const originSelectionRange = link?.originSelectionRange && originText ? convertRange(originText, link.originSelectionRange, encoding) : undefined;
    result.push({
      uri,
      ...(file && local && isContained(root, file) ? { path: relative(root, file) || "." } : {}),
      external: !local,
      range: convertedRange,
      ...(selectionRange ? { selectionRange } : {}),
      ...(originSelectionRange ? { originSelectionRange } : {}),
      positionEncoding: encoding,
      ...(!targetText ? { rawRange: range, ...(link?.targetSelectionRange ? { rawSelectionRange: link.targetSelectionRange } : {}) } : {}),
    });
  }
  result.sort((a, b) => (a.path ?? a.uri).localeCompare(b.path ?? b.uri) || a.range.start.line - b.range.start.line || (a.range.start.character ?? 0) - (b.range.start.character ?? 0));
  return { locations: result, total: items.length, truncated: items.length > result.length };
}

export function convertRange(text: string, range: Range, encoding: PositionEncoding): PublicLocationRange {
  return { start: serverToPublicPosition(text, range.start, encoding), end: serverToPublicPosition(text, range.end, encoding) };
}
function lineOnlyRange(range: Range): PublicLocationRange { return { start: { line: range.start.line + 1 }, end: { line: range.end.line + 1 } }; }
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
