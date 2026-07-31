import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { sanitizeText } from "../util/text.js";

export type ToolStatus = "ok" | "partial" | "no_results" | "unsupported" | "unavailable" | "ambiguous" | "untrusted" | "timed_out" | "cancelled" | "error";

export interface ServerRunStatus {
  server: string;
  root?: string;
  status: string;
  durationMs: number;
}

export interface BaseDetails {
  operation: string;
  status: ToolStatus;
  server?: string;
  root?: string;
  servers?: ServerRunStatus[];
  durationMs: number;
  truncated: boolean;
  warnings: string[];
  [key: string]: unknown;
}

export interface ToolEnvelope<T extends BaseDetails = BaseDetails> {
  content: Array<{ type: "text"; text: string }>;
  details: T;
}

export function envelope<T extends BaseDetails>(text: string, details: T): ToolEnvelope<T> {
  const clean = sanitizeText(text, 250_000);
  const truncation = truncateHead(clean, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  details.truncated ||= truncation.truncated;
  const bounded = boundStructuredDetails(details);
  return { content: [{ type: "text", text: truncation.content }], details: bounded as T };
}

export function baseDetails(operation: string, status: ToolStatus, startedAt: number): BaseDetails {
  return { operation, status, durationMs: Date.now() - startedAt, truncated: false, warnings: [] };
}

export function statusFromError(error: unknown): ToolStatus {
  const name = error instanceof Error ? error.name : "";
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (name === "CancelledError" || name === "AbortError") return "cancelled";
  if (name === "TimeoutError") return "timed_out";
  if (code === "UNAVAILABLE") return "unavailable";
  if (code === "AMBIGUOUS") return "ambiguous";
  if (code === "UNTRUSTED") return "untrusted";
  return "error";
}

export function rethrowUnexpected(error: unknown): void {
  if (statusFromError(error) === "error") throw error;
}

function boundStructuredDetails(details: BaseDetails): BaseDetails {
  const first = cloneBounded(details, { maxDepth: 14, maxNodes: 5_000, maxArray: 500, maxString: 4_096 });
  const firstMarked = markBounded(first.value, first.truncated);
  if (jsonBytes(firstMarked) <= DEFAULT_MAX_BYTES) return firstMarked;
  const second = cloneBounded(details, { maxDepth: 10, maxNodes: 2_000, maxArray: 100, maxString: 1_024 });
  const secondMarked = markBounded(second.value, true);
  if (jsonBytes(secondMarked) <= DEFAULT_MAX_BYTES) return secondMarked;
  const fallback: BaseDetails = {
    operation: details.operation,
    status: details.status,
    ...(details.server ? { server: sanitizeText(details.server, 300) } : {}),
    ...(details.root ? { root: sanitizeText(details.root, 1_000) } : {}),
    ...(details.servers ? { servers: details.servers.slice(0, 10).map((server) => ({ server: sanitizeText(server.server, 300), ...(server.root ? { root: sanitizeText(server.root, 1_000) } : {}), status: sanitizeText(server.status, 100), durationMs: server.durationMs })) } : {}),
    durationMs: details.durationMs,
    truncated: true,
    warnings: [...details.warnings.slice(0, 10).map((warning) => sanitizeText(warning, 500)), "Structured details exceeded 50 KiB and operation-specific data was omitted."],
    detailsOmitted: true,
  };
  if (jsonBytes(fallback) <= DEFAULT_MAX_BYTES) return fallback;
  return { operation: sanitizeText(details.operation, 200), status: details.status, durationMs: details.durationMs, truncated: true, warnings: ["Structured details exceeded 50 KiB and were omitted."], detailsOmitted: true };
}

interface CloneLimits { maxDepth: number; maxNodes: number; maxArray: number; maxString: number }
function cloneBounded(input: unknown, limits: CloneLimits): { value: BaseDetails; truncated: boolean } {
  let nodes = 0;
  let truncated = false;
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > limits.maxNodes || depth > limits.maxDepth) { truncated = true; return "[omitted: structured limit]"; }
    if (typeof value === "string") { const clean = sanitizeText(value, limits.maxString); truncated ||= clean.length !== value.length; return clean; }
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") { truncated = true; return value.toString(); }
    if (value === undefined) return undefined;
    if (Array.isArray(value)) {
      if (seen.has(value)) { truncated = true; return "[omitted: circular value]"; }
      if (value.length > limits.maxArray) truncated = true;
      // Track only the current path: clone shared references instead of mislabeling them as cycles.
      seen.add(value);
      const output = value.slice(0, limits.maxArray).map((item) => visit(item, depth + 1));
      seen.delete(value);
      return output;
    }
    if (typeof value === "object") {
      if (seen.has(value)) { truncated = true; return "[omitted: circular value]"; }
      seen.add(value);
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length > 200) truncated = true;
      const output: Record<string, unknown> = {};
      for (const [key, item] of entries.slice(0, 200)) {
        const visited = visit(item, depth + 1);
        if (visited !== undefined) output[key] = visited;
      }
      seen.delete(value);
      return output;
    }
    truncated = true;
    return String(value);
  };
  return { value: visit(input, 0) as BaseDetails, truncated };
}
function markBounded(details: BaseDetails, truncated: boolean): BaseDetails {
  if (!truncated) return details;
  details.truncated = true;
  details.warnings = [...(Array.isArray(details.warnings) ? details.warnings : []), "Structured details were truncated by hard limits."];
  return details;
}
function jsonBytes(value: unknown): number { try { return Buffer.byteLength(JSON.stringify(value)); } catch { return Number.POSITIVE_INFINITY; } }
