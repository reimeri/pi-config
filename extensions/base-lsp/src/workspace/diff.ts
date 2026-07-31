import { relative } from "node:path";
import type { EditManifest, StagedFile } from "./edits.js";

export function renderManifest(manifest: EditManifest, maxChars = 40_000, root?: string): { text: string; truncated: boolean } {
  const displayPath = (path: string): string => root ? relative(root, path) || "." : path;
  let text = `Workspace edit: ${manifest.files.length} file(s), ${manifest.totalEdits} text edit(s), ${manifest.resourceOperations.length} resource operation(s)\n`;
  for (const file of manifest.files) text += `  ${displayPath(file.path)}: ${file.edits} edit(s)\n`;
  let truncated = false;
  for (const file of manifest.files) {
    const diff = renderFileDiff(file, displayPath(file.path));
    if (text.length + diff.length <= maxChars) text += diff;
    else { text += `[diff omitted for ${displayPath(file.path)}: output limit reached]\n`; truncated = true; }
  }
  for (const resource of manifest.resourceOperations) {
    const line = `[preview-only resource operation] ${JSON.stringify(resource)}\n`;
    if (text.length + line.length <= maxChars) text += line; else truncated = true;
  }
  if (manifest.reasons.length) text += `Not applicable: ${manifest.reasons.join("; ")}\n`;
  if (text.length > maxChars) { text = `${text.slice(0, Math.max(0, maxChars - 18))}\n[diff truncated]\n`; truncated = true; }
  return { text: text || "No text edits.", truncated };
}

function renderFileDiff(file: StagedFile, path: string): string {
  const before = splitLines(file.original);
  const after = splitLines(file.updated);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && sameLine(before[prefix]!, after[prefix]!)) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && sameLine(before[before.length - 1 - suffix]!, after[after.length - 1 - suffix]!)) suffix += 1;
  const oldStart = Math.max(0, prefix - 3);
  const newStart = Math.max(0, prefix - 3);
  const oldChangeEnd = before.length - suffix;
  const newChangeEnd = after.length - suffix;
  const oldEnd = Math.min(before.length, oldChangeEnd + 3);
  const newEnd = Math.min(after.length, newChangeEnd + 3);
  let diff = `--- a/${path}\n+++ b/${path}\n@@ -${oldStart + 1},${Math.max(0, oldEnd - oldStart)} +${newStart + 1},${Math.max(0, newEnd - newStart)} @@\n`;
  for (let index = oldStart; index < prefix; index += 1) diff += renderLine(" ", before[index]!);
  for (let index = prefix; index < oldChangeEnd; index += 1) diff += renderLine("-", before[index]!);
  for (let index = prefix; index < newChangeEnd; index += 1) diff += renderLine("+", after[index]!);
  for (let offset = 0; offset < Math.min(3, suffix); offset += 1) diff += renderLine(" ", before[oldChangeEnd + offset]!);
  return diff;
}

/** A line and whether it ends without a newline; that flag participates in diffing. */
interface DiffLine { text: string; endsWithoutNewline: boolean }
function sameLine(left: DiffLine, right: DiffLine): boolean { return left.text === right.text && left.endsWithoutNewline === right.endsWithoutNewline; }
function renderLine(marker: string, line: DiffLine): string { return `${marker}${line.text}\n${line.endsWithoutNewline ? "\\ No newline at end of file\n" : ""}`; }
function splitLines(text: string): DiffLine[] {
  const lines = text.split(/\r?\n/);
  const terminated = lines.at(-1) === "";
  if (terminated) lines.pop();
  return lines.map((line, index) => ({ text: line, endsWithoutNewline: !terminated && index === lines.length - 1 }));
}
