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
  const lines = lineInfos(text);
  return { start: offsetPosition(lines, start, encoding), end: offsetPosition(lines, end, encoding) };
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
  const lines = lineInfos(text);
  const line = lines[index];
  if (!line) throw new Error(`Line ${index + 1} exceeds document length`);
  return line;
}
function lineInfos(text: string): LineInfo[] {
  const result: LineInfo[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charCodeAt(index);
    if (char === 10 || char === 13) {
      result.push({ start, text: text.slice(start, index) });
      if (char === 13 && text.charCodeAt(index + 1) === 10) index += 1;
      start = index + 1;
    }
  }
  result.push({ start, text: text.slice(start) });
  return result;
}
function offsetPosition(lines: LineInfo[], offset: number, encoding: PositionEncoding): Position {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (offset >= line.start) {
      const local = offset - line.start;
      if (local > line.text.length) throw new Error("Offset points inside a newline sequence");
      return { line: index, character: utf16ToEncoded(line.text, local, encoding) };
    }
  }
  throw new Error("Invalid offset");
}
