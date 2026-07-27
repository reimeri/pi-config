#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendFileSync, readFileSync } from "node:fs";

let buffer = Buffer.alloc(0);
const documents = new Map();
const cancelled = new Set();
let descendant;
if (process.env.FAKE_LSP_DESCENDANT === "1") {
  descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  process.stderr.write(`DESCENDANT_PID=${descendant.pid}\n`);
}

process.stdin.on("data", (chunk) => { buffer = Buffer.concat([buffer, chunk]); parse(); });
process.stdin.on("end", () => process.exit(0));

function parse() {
  while (true) {
    const separator = buffer.indexOf("\r\n\r\n");
    if (separator < 0) return;
    const header = buffer.subarray(0, separator).toString("ascii");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const start = separator + 4;
    if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.subarray(start, start + length).toString("utf8"));
    buffer = buffer.subarray(start + length);
    void handle(message);
  }
}

async function handle(message) {
  if (message.method === "$/cancelRequest") { cancelled.add(message.params?.id); return; }
  if (message.id !== undefined && message.method === undefined) return;
  if (message.id === undefined) { handleNotification(message); return; }
  const delay = Number(process.env.FAKE_LSP_DELAY_MS ?? 0);
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  if (cancelled.has(message.id) && process.env.FAKE_LSP_IGNORE_CANCEL !== "1") return;
  try { send({ jsonrpc: "2.0", id: message.id, result: await resultFor(message.method, message.params) }); }
  catch (error) { send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error.message } }); }
}

function handleNotification(message) {
  if (message.method === "textDocument/didOpen") {
    const document = message.params.textDocument;
    documents.set(document.uri, { text: document.text, version: document.version });
    if (process.env.FAKE_LSP_DID_OPEN_LOG) appendFileSync(process.env.FAKE_LSP_DID_OPEN_LOG, `${process.env.FAKE_LSP_INSTANCE ?? "fake"} ${Date.now()}\n`);
    if (process.env.FAKE_LSP_PUSH === "1") void publish(document.uri);
  } else if (message.method === "textDocument/didChange") {
    const document = documents.get(message.params.textDocument.uri) ?? { text: "", version: 0 };
    const changes = message.params.contentChanges ?? [];
    if (changes.length) document.text = changes.at(-1).text;
    document.version = message.params.textDocument.version;
    documents.set(message.params.textDocument.uri, document);
    if (process.env.FAKE_LSP_PUSH === "1") void publish(message.params.textDocument.uri);
  } else if (message.method === "textDocument/didClose") documents.delete(message.params.textDocument.uri);
  else if (message.method === "exit" && process.env.FAKE_LSP_IGNORE_EXIT !== "1") { descendant?.kill(); process.exit(0); }
}

async function resultFor(method, params) {
  switch (method) {
    case "initialize":
      if (process.env.FAKE_LSP_MALFORMED === "1") { process.stdout.write("Content-Length: 999999999\r\n\r\n"); return new Promise(() => {}); }
      return { capabilities: {
        positionEncoding: process.env.FAKE_LSP_ENCODING ?? "utf-16",
        textDocumentSync: { openClose: true, change: 2, save: { includeText: true } },
        diagnosticProvider: { identifier: "fake", interFileDependencies: true, workspaceDiagnostics: true },
        ...(process.env.FAKE_LSP_NO_DECLARATION === "1" ? {} : { declarationProvider: true }), definitionProvider: true, typeDefinitionProvider: true, implementationProvider: true, referencesProvider: true, hoverProvider: true,
        documentSymbolProvider: true, workspaceSymbolProvider: { resolveProvider: true }, callHierarchyProvider: true,
        codeActionProvider: { resolveProvider: true }, renameProvider: { prepareProvider: true },
      }, serverInfo: { name: process.env.FAKE_LSP_SERVER_NAME ?? "base-lsp-fake", version: "1" } };
    case "shutdown": if (process.env.FAKE_LSP_HANG_SHUTDOWN === "1") return new Promise(() => {}); return null;
    case "textDocument/diagnostic": return documentDiagnostic(params.textDocument.uri, params.previousResultId);
    case "workspace/diagnostic": return workspaceDiagnostic(params);
    case "textDocument/declaration":
    case "textDocument/definition":
    case "textDocument/typeDefinition":
    case "textDocument/implementation": {
      const targetUri = [...documents.keys()][0] ?? params.textDocument.uri;
      return [{ targetUri, targetRange: range(0, 0, 0, 5), targetSelectionRange: range(0, 0, 0, 5), originSelectionRange: range(params.position.line, params.position.character, params.position.line, params.position.character + 1) }];
    }
    case "textDocument/references": return [...documents.keys()].map((uri) => ({ uri, range: range(0, 0, 0, 5) }));
    case "textDocument/hover": return { contents: { kind: "markdown", value: "**fake hover**" }, range: range(params.position.line, params.position.character, params.position.line, params.position.character + 1) };
    case "textDocument/documentSymbol": return [{ name: "outer", kind: 12, range: range(0, 0, 1, 0), selectionRange: range(0, 0, 0, 5), children: [{ name: "inner", kind: 13, range: range(0, 0, 0, 5), selectionRange: range(0, 0, 0, 5) }] }];
    case "workspace/symbol": return [{ name: params.query || "symbol", kind: 12, location: { uri: [...documents.keys()][0] ?? "file:///missing" }, data: { resolve: true } }];
    case "workspaceSymbol/resolve": return { ...params, location: { uri: params.location.uri, range: range(0, 0, 0, 5) } };
    case "textDocument/prepareCallHierarchy": return [callItem(params.textDocument.uri)];
    case "callHierarchy/incomingCalls": return [{ from: callItem(params.item.uri), fromRanges: [range(0, 0, 0, 1)] }];
    case "callHierarchy/outgoingCalls": return [{ to: callItem(params.item.uri), fromRanges: [range(0, 0, 0, 1)] }];
    case "textDocument/codeAction": {
      const mode = process.env.FAKE_LSP_ACTION_MODE;
      if (mode === "command") return [{ title: "Run unsafe command", command: "fake.command", arguments: [] }];
      if (mode === "mixed-malformed") return [
        { title: "Fix ERROR", kind: "quickfix", data: { uri: params.textDocument.uri, mode: "valid" } },
        { title: "Malformed fix", kind: "quickfix", data: { uri: params.textDocument.uri, mode: "malformed" } },
      ];
      return [{ title: "Fix ERROR", kind: mode === "format" ? "source.format.fake" : "quickfix", data: { uri: params.textDocument.uri, mode } }];
    }
    case "codeAction/resolve": {
      const action = { ...params, edit: replacementEdit(params.data.uri, "ERROR", "fixed") };
      if (params.data.mode === "malformed") action.edit = { documentChanges: [{ textDocument: { uri: params.data.uri, version: documents.get(params.data.uri)?.version ?? 1 }, edits: [{ range: range(0, 999, 0, 999), newText: "broken" }] }] };
      if (params.data.mode === "both") action.command = { title: "Follow-up", command: "fake.command" };
      if (params.data.mode === "typescript-redundant") action.command = { title: "", command: "_typescript.applyCodeActionCommand", arguments: [{ action: { fixName: "fake", description: "Fix ERROR", changes: replacementCommandChanges(params.data.uri, "ERROR", "fixed") }, diagnostic: {}, documentUri: params.data.uri }] };
      if (params.data.mode === "typescript-nested") action.command = { title: "", command: "_typescript.applyCodeActionCommand", arguments: [{ action: { fixName: "fake", description: "Fix ERROR", changes: replacementCommandChanges(params.data.uri, "ERROR", "fixed"), commands: [{ type: "install package" }] }, diagnostic: {}, documentUri: params.data.uri }] };
      if (params.data.mode === "resource") action.edit.documentChanges.push({ kind: "create", uri: new URL("created.ts", params.data.uri).href });
      return action;
    }
    case "textDocument/prepareRename": return range(params.position.line, params.position.character, params.position.line, params.position.character + wordAt(params.textDocument.uri, params.position).length);
    case "textDocument/rename": {
      const oldName = wordAt(params.textDocument.uri, params.position);
      return renameEdit(oldName, params.newName);
    }
    default: throw new Error(`Unsupported method ${method}`);
  }
}

function workspaceDiagnostic(params) {
  const items = [...documents].map(([uri]) => ({ uri, version: documents.get(uri).version + Number(process.env.FAKE_LSP_WORKSPACE_VERSION_OFFSET ?? 0), ...documentDiagnostic(uri, params.previousResultIds?.find((item) => item.uri === uri)?.value) }));
  if (process.env.FAKE_LSP_EXTRA_WORKSPACE === "1") items.push({ uri: "file:///external/extra.ts", version: 1, kind: "full", resultId: "extra", items: [{ range: range(0, 0, 0, 1), severity: 1, message: "extra" }] });
  return { items };
}
function documentDiagnostic(uri, previousResultId) {
  const document = documents.get(uri) ?? { text: "", version: 0 };
  const resultId = `${document.version}:${hash(document.text)}`;
  if (process.env.FAKE_LSP_FORCE_UNCHANGED === "1") return { kind: "unchanged", resultId: "unknown-result" };
  if (previousResultId === resultId) return { kind: "unchanged", resultId };
  const offset = document.text.indexOf("ERROR");
  const count = Math.max(1, Number(process.env.FAKE_LSP_MANY_DIAGNOSTICS ?? 1));
  const items = offset < 0 ? [] : Array.from({ length: count }, (_, index) => ({ range: offsetRange(document.text, offset, 5), severity: 1, source: "fake", message: `fake error ${index + 1}` }));
  return { kind: "full", resultId, items };
}
async function publish(uri) {
  const barrierCount = Number(process.env.FAKE_LSP_DID_OPEN_BARRIER_COUNT ?? 0);
  if (barrierCount > 0 && process.env.FAKE_LSP_DID_OPEN_LOG && !await waitForOpenBarrier(process.env.FAKE_LSP_DID_OPEN_LOG, barrierCount)) return;
  const document = documents.get(uri);
  const report = documentDiagnostic(uri);
  const version = process.env.FAKE_LSP_UNVERSIONED === "1" ? undefined : document.version + Number(process.env.FAKE_LSP_PUSH_VERSION_OFFSET ?? 0);
  setTimeout(() => send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, ...(version === undefined ? {} : { version }), diagnostics: report.items } }), Number(process.env.FAKE_LSP_PUSH_DELAY_MS ?? 0));
  const secondDelay = Number(process.env.FAKE_LSP_PUSH_SECOND_ERROR_DELAY_MS ?? 0);
  if (secondDelay > 0) setTimeout(() => send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [{ range: range(0, 0, 0, 1), severity: 1, source: "fake", message: "delayed semantic error" }] } }), secondDelay);
}
async function waitForOpenBarrier(path, count) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    let entries = 0;
    try { entries = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length; } catch { /* log not created yet */ }
    if (entries >= count) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}
function replacementEdit(uri, oldText, newText) {
  const document = documents.get(uri) ?? { text: "", version: 0 };
  const offset = document.text.indexOf(oldText);
  return { documentChanges: offset < 0 ? [] : [{ textDocument: { uri, version: document.version }, edits: [{ range: offsetRange(document.text, offset, oldText.length), newText }] }] };
}
function replacementCommandChanges(uri, oldText, newText) {
  const document = documents.get(uri) ?? { text: "", version: 0 };
  const offset = document.text.indexOf(oldText);
  if (offset < 0) return [];
  const before = document.text.slice(0, offset).split(/\r?\n/);
  const start = { line: before.length, offset: before.at(-1).length + 1 };
  const end = { line: start.line, offset: start.offset + oldText.length };
  return [{ fileName: fileURLToPath(uri), textChanges: [{ start, end, newText }] }];
}
function renameEdit(oldName, newName) {
  return { documentChanges: [...documents].map(([uri, document]) => ({ textDocument: { uri, version: document.version }, edits: occurrences(document.text, oldName).map((offset) => ({ range: offsetRange(document.text, offset, oldName.length), newText: newName })) })).filter((change) => change.edits.length) };
}
function wordAt(uri, position) {
  const text = documents.get(uri)?.text ?? "";
  const lines = text.split(/\r?\n/);
  const line = lines[position.line] ?? "";
  let start = Math.min(position.character, line.length), end = start;
  while (start > 0 && /[A-Za-z0-9_$]/.test(line[start - 1])) start--;
  while (end < line.length && /[A-Za-z0-9_$]/.test(line[end])) end++;
  return line.slice(start, end);
}
function occurrences(text, needle) { const result = []; if (!needle) return result; for (let at = 0; (at = text.indexOf(needle, at)) >= 0; at += needle.length) result.push(at); return result; }
function offsetRange(text, offset, length) { const before = text.slice(0, offset).split(/\r?\n/); const line = before.length - 1; const character = before.at(-1).length; return range(line, character, line, character + length); }
function range(startLine, startCharacter, endLine, endCharacter) { return { start: { line: startLine, character: startCharacter }, end: { line: endLine, character: endCharacter } }; }
function callItem(uri) { return { name: "fakeCall", kind: 12, uri, range: range(0, 0, 0, 5), selectionRange: range(0, 0, 0, 5), data: { fake: true } }; }
function hash(text) { return createHash("sha1").update(text).digest("hex").slice(0, 8); }
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  if (process.env.FAKE_LSP_FRAGMENT === "1" && frame.length > 8) { process.stdout.write(frame.subarray(0, 7)); setImmediate(() => process.stdout.write(frame.subarray(7))); }
  else process.stdout.write(frame);
}
