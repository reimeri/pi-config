import { createHash } from "node:crypto";

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;

export function sanitizeText(value: unknown, maxChars = 8_192): string {
  const text = String(value ?? "").replace(ANSI, "").replace(CONTROL, "�");
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex");
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortValue(item)]));
  }
  return value;
}

export function stripLeadingAt(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

export function compareStrings(a: string, b: string): number {
  return a.localeCompare(b, "en");
}
