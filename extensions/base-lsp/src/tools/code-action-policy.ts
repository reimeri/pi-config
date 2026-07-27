import { pathToFileURL } from "node:url";
import type { CodeAction, TextEdit, WorkspaceEdit } from "../protocol/types.js";
import type { ServerDefinition } from "../config/schema.js";
import { isTypeScriptLanguageServer } from "../servers/implementation.js";

export type CodeActionCommandDisposition = "none" | "redundant" | "unsupported";
export interface CodeActionCommandPolicy {
  disposition: CodeActionCommandDisposition;
  reason?: string;
}

export function classifyCodeActionCommand(server: ServerDefinition, action: CodeAction, serverInfo?: { name: string; version?: string }): CodeActionCommandPolicy {
  if (!action.command) return { disposition: "none" };
  if (!action.edit) return { disposition: "unsupported", reason: "Command-only actions are unsupported" };
  if (!isTypeScriptLanguageServer(server, serverInfo) || action.command.command !== "_typescript.applyCodeActionCommand") {
    return { disposition: "unsupported", reason: "Actions containing both edit and command cannot be applied" };
  }
  if (!hasOnlyKeys(action.command, ["title", "command", "arguments"]) || action.command.arguments?.length !== 1) {
    return { disposition: "unsupported", reason: "TypeScript code-action command payload is malformed" };
  }
  const argument = action.command.arguments[0];
  if (!isRecord(argument) || !hasOnlyKeys(argument, ["action", "diagnostic", "documentUri"]) || typeof argument.documentUri !== "string" || !isRecord(argument.action)) {
    return { disposition: "unsupported", reason: "TypeScript code-action command payload is malformed" };
  }
  const tsAction = argument.action;
  if (!hasOnlyKeys(tsAction, ["fixName", "description", "changes", "commands", "fixId", "fixAllDescription"]) || typeof tsAction.fixName !== "string" || typeof tsAction.description !== "string" || !Array.isArray(tsAction.changes)) {
    return { disposition: "unsupported", reason: "TypeScript code-action payload contains unsupported fields" };
  }
  const nested = tsAction.commands;
  if (nested !== undefined && (!Array.isArray(nested) || nested.length > 0)) {
    return { disposition: "unsupported", reason: "TypeScript code action requires additional nested commands" };
  }
  const commandEdit = normalizeTypeScriptChanges(tsAction.changes);
  const lspEdit = normalizeLspEdit(action.edit);
  if (!commandEdit || !lspEdit || JSON.stringify(commandEdit) !== JSON.stringify(lspEdit)) {
    return { disposition: "unsupported", reason: "TypeScript wrapper changes do not exactly match the LSP workspace edit" };
  }
  return { disposition: "redundant" };
}

interface ComparableEdit { uri: string; edits: Array<{ startLine: number; startCharacter: number; endLine: number; endCharacter: number; newText: string }> }

function normalizeTypeScriptChanges(changes: unknown[]): ComparableEdit[] | undefined {
  const byUri = new Map<string, ComparableEdit["edits"]>();
  for (const change of changes) {
    if (!isRecord(change) || !hasOnlyKeys(change, ["fileName", "textChanges"]) || typeof change.fileName !== "string" || !Array.isArray(change.textChanges)) return undefined;
    const uri = pathToFileURL(change.fileName).href;
    const edits = byUri.get(uri) ?? [];
    for (const item of change.textChanges) {
      if (!isRecord(item) || !hasOnlyKeys(item, ["start", "end", "newText"]) || !isRecord(item.start) || !isRecord(item.end) || !hasOnlyKeys(item.start, ["line", "offset"]) || !hasOnlyKeys(item.end, ["line", "offset"]) || typeof item.newText !== "string") return undefined;
      const values = [item.start.line, item.start.offset, item.end.line, item.end.offset];
      if (values.some((value) => !Number.isSafeInteger(value) || Number(value) < 1)) return undefined;
      edits.push({ startLine: Number(item.start.line) - 1, startCharacter: Number(item.start.offset) - 1, endLine: Number(item.end.line) - 1, endCharacter: Number(item.end.offset) - 1, newText: item.newText });
    }
    byUri.set(uri, edits);
  }
  return comparableEntries(byUri);
}

function normalizeLspEdit(edit: WorkspaceEdit): ComparableEdit[] | undefined {
  const byUri = new Map<string, ComparableEdit["edits"]>();
  const add = (uri: string, edits: TextEdit[]): void => {
    const output = byUri.get(uri) ?? [];
    for (const item of edits) output.push({ startLine: item.range.start.line, startCharacter: item.range.start.character, endLine: item.range.end.line, endCharacter: item.range.end.character, newText: item.newText });
    byUri.set(uri, output);
  };
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) add(uri, edits);
  for (const change of edit.documentChanges ?? []) {
    if (!("textDocument" in change)) return undefined;
    add(change.textDocument.uri, change.edits);
  }
  return comparableEntries(byUri);
}

function comparableEntries(byUri: Map<string, ComparableEdit["edits"]>): ComparableEdit[] {
  return [...byUri].map(([uri, edits]) => ({ uri, edits: [...edits].sort((a, b) => a.startLine - b.startLine || a.startCharacter - b.startCharacter || a.endLine - b.endLine || a.endCharacter - b.endCharacter) })).sort((a, b) => a.uri.localeCompare(b.uri));
}

function hasOnlyKeys(value: object, allowed: string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
