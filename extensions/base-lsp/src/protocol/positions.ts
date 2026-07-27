import type { Position, PositionEncoding, Range } from "./types.js";

export interface PublicPosition { line: number; character: number }
export interface PublicRange { start: PublicPosition; end: PublicPosition }

interface LineInfo { start: number; text: string }

export function publicToServerPosition(text: string, line: number, character: number, encoding: PositionEncoding): Position {
  if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(character) || character < 1) throw new Error("line and character must be positive integers");
  const info = getLine(text, line - 1);
  const utf16 = character - 1;
  assertUtf16Boundary(info.text, utf16);
  return { line: line - 1, character: utf16ToEncoded(info.text, utf16, encoding) };
}

export function serverToPublicPosition(text: string, position: Position, encoding: PositionEncoding): PublicPosition {
  const info = getLine(text, position.line);
  return { line: position.line + 1, character: encodedToUtf16(info.text, position.character, encoding) + 1 };
}

export function serverRangeToOffsets(text: string, range: Range, encoding: PositionEncoding): { start: number; end: number } {
  const startLine = getLine(text, range.start.line);
  const endLine = getLine(text, range.end.line);
  const start = startLine.start + encodedToUtf16(startLine.text, range.start.character, encoding);
  const end = endLine.start + encodedToUtf16(endLine.text, range.end.character, encoding);
  if (start > end) throw new Error("Invalid range: start is after end");
  return { start, end };
}

export function offsetsToServerRange(text: string, start: number, end: number, encoding: PositionEncoding): Range {
  if (start < 0 || end < start || end > text.length) throw new Error("Invalid offsets");
  const table = lineTable(text);
  return { start: offsetPosition(text, table, start, encoding), end: offsetPosition(text, table, end, encoding) };
}

export function resolveSymbolPosition(text: string, publicLine: number, locator: string): { character: number; candidates: number[] } {
  if (!Number.isSafeInteger(publicLine) || publicLine < 1) throw new Error("line must be a positive integer");
  const match = locator.match(/^(.*?)(?:#([1-9][0-9]*))?$/);
  const name = match?.[1] ?? locator;
  const occurrence = match?.[2] ? Number(match[2]) : undefined;
  if (!name) throw new Error("symbol must not be empty");
  const line = getLine(text, publicLine - 1).text;
  const candidates: number[] = [];
  let offset = 0;
  while (offset <= line.length) {
    const found = line.indexOf(name, offset);
    if (found < 0) break;
    assertUtf16Boundary(line, found);
    assertUtf16Boundary(line, found + name.length);
    candidates.push(found + 1);
    offset = found + Math.max(1, name.length);
  }
  if (!candidates.length) throw new Error(`Symbol ${JSON.stringify(name)} was not found on line ${publicLine}`);
  if (occurrence !== undefined) {
    const selected = candidates[occurrence - 1];
    if (selected === undefined) throw new Error(`Symbol occurrence ${occurrence} does not exist; found ${candidates.length}`);
    return { character: selected, candidates };
  }
  if (candidates.length !== 1) throw Object.assign(new Error(`Symbol ${JSON.stringify(name)} is ambiguous on line ${publicLine}`), { candidates });
  return { character: candidates[0]!, candidates };
}

export function encodedToUtf16(line: string, character: number, encoding: PositionEncoding): number {
  if (!Number.isSafeInteger(character) || character < 0) throw new Error("Invalid server character offset");
  if (encoding === "utf-16") { assertUtf16Boundary(line, character); return character; }
  if (encoding === "utf-32") {
    let codepoints = 0;
    let utf16 = 0;
    for (const symbol of line) {
      if (codepoints === character) return utf16;
      codepoints += 1; utf16 += symbol.length;
    }
    if (codepoints === character) return utf16;
    throw new Error("UTF-32 character exceeds line length");
  }
  let bytes = 0;
  let utf16 = 0;
  for (const symbol of line) {
    if (bytes === character) return utf16;
    const size = Buffer.byteLength(symbol);
    if (bytes + size > character) throw new Error("UTF-8 character points inside a code point");
    bytes += size; utf16 += symbol.length;
  }
  if (bytes === character) return utf16;
  throw new Error("UTF-8 character exceeds line length");
}

export function utf16ToEncoded(line: string, utf16: number, encoding: PositionEncoding): number {
  assertUtf16Boundary(line, utf16);
  if (encoding === "utf-16") return utf16;
  const prefix = line.slice(0, utf16);
  return encoding === "utf-8" ? Buffer.byteLength(prefix) : [...prefix].length;
}

function assertUtf16Boundary(line: string, offset: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > line.length) throw new Error("UTF-16 character exceeds line length");
  if (offset > 0 && offset < line.length) {
    const previous = line.charCodeAt(offset - 1);
    const next = line.charCodeAt(offset);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) throw new Error("Character points inside a surrogate pair");
  }
}
function getLine(text: string, index: number): LineInfo {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Invalid line");
  const table = lineTable(text);
  const start = table.starts[index];
  const end = table.ends[index];
  if (start === undefined || end === undefined) throw new Error(`Line ${index + 1} exceeds document length`);
  return { start, text: text.slice(start, end) };
}

/** Half-open bounds of every line, excluding its newline sequence. */
interface LineTable { starts: number[]; ends: number[] }

/**
 * Content-addressed memo of line tables. Callers convert many positions against the same document
 * text — one per symbol, per edit, or per diagnostic — and rebuilding the table each time made
 * conversion O(document) instead of O(1). Keying on the text itself keeps the memo correct by
 * construction: differing content can never share a table.
 *
 * The budget is charged in estimated bytes, not characters: a file of many short lines costs far
 * more in line offsets than in text, so counting only `text.length` would understate what the
 * cache retains by several times. Entries are capped too, since many small documents cost mostly
 * per-entry overhead that no size estimate captures.
 */
interface CacheEntry { table: LineTable; cost: number }
const tableCache = new Map<string, CacheEntry>();
let cachedCost = 0;
let builds = 0;
const MAX_CACHED_COST = 16 * 1024 * 1024;
const MAX_CACHED_ENTRIES = 64;

/** Observability hook: how many tables were built, and what the memo currently retains. */
export function lineTableStats(): { builds: number; entries: number; cost: number } {
  return { builds, entries: tableCache.size, cost: cachedCost };
}

function lineTable(text: string): LineTable {
  const cached = tableCache.get(text);
  if (cached) {
    tableCache.delete(text);
    tableCache.set(text, cached);
    return cached.table;
  }
  const table = buildLineTable(text);
  builds += 1;
  const cost = text.length * 2 + (table.starts.length + table.ends.length) * 8;
  tableCache.set(text, { table, cost });
  cachedCost += cost;
  while (tableCache.size > 1 && (cachedCost > MAX_CACHED_COST || tableCache.size > MAX_CACHED_ENTRIES)) {
    const oldest = tableCache.keys().next().value as string;
    cachedCost -= tableCache.get(oldest)!.cost;
    tableCache.delete(oldest);
  }
  return table;
}

function buildLineTable(text: string): LineTable {
  const starts: number[] = [0];
  const ends: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charCodeAt(index);
    if (char === 10 || char === 13) {
      ends.push(index);
      if (char === 13 && text.charCodeAt(index + 1) === 10) index += 1;
      starts.push(index + 1);
    }
  }
  ends.push(text.length);
  return { starts, ends };
}

function offsetPosition(text: string, table: LineTable, offset: number, encoding: PositionEncoding): Position {
  let low = 0;
  let high = table.starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (table.starts[mid]! <= offset) low = mid; else high = mid - 1;
  }
  const start = table.starts[low]!;
  const end = table.ends[low]!;
  if (offset > end) throw new Error("Offset points inside a newline sequence");
  return { line: low, character: utf16ToEncoded(text.slice(start, end), offset - start, encoding) };
}
