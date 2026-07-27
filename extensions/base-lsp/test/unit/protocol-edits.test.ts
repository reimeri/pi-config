import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BoundedStreamMessageReader } from "../../src/protocol/bounded-reader.js";
import { normalizeWorkspaceEdit } from "../../src/workspace/edits.js";
import { applyManifest } from "../../src/workspace/transaction.js";
import { DEFAULT_LIMITS } from "../../src/runtime/limits.js";

describe("bounded protocol reader", () => {
  it("handles fragmented/combined frames and rejects oversized bodies", async () => {
    const stream = new PassThrough(); const reader = new BoundedStreamMessageReader(stream, { maxHeaderBytes: 100, maxBodyBytes: 100 });
    const messages: any[] = []; const errors: Error[] = []; reader.onError((error) => errors.push(error)); reader.listen((message) => messages.push(message));
    const body = JSON.stringify({ jsonrpc: "2.0", method: "x" }); const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    stream.write(frame.slice(0, 10)); stream.write(frame.slice(10) + frame); await new Promise((resolve) => setImmediate(resolve));
    expect(messages).toHaveLength(2); expect(errors).toHaveLength(0);
    stream.write("Content-Length: 101\r\n\r\n"); await new Promise((resolve) => setImmediate(resolve)); expect(errors[0]?.message).toMatch(/oversized/);
  });

  it("accepts bursts of many complete frames without confusing throughput with buffering", async () => {
    const stream = new PassThrough(); const reader = new BoundedStreamMessageReader(stream, { maxHeaderBytes: 100, maxBodyBytes: 100 });
    const messages: any[] = []; const errors: Error[] = []; reader.onError((error) => errors.push(error)); reader.listen((message) => messages.push(message));
    const frames = Array.from({ length: 25 }, (_, id) => { const body = JSON.stringify({ jsonrpc: "2.0", id, result: null }); return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`; }).join("");
    stream.write(frames); await new Promise((resolve) => setImmediate(resolve));
    expect(messages).toHaveLength(25); expect(errors).toEqual([]);
  });
});

describe("workspace edits", () => {
  it("stages and applies non-overlapping edits and rejects overlaps", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-edit-")); const file = join(root, "a.ts"); await writeFile(file, "hello world\n"); const uri = pathToFileURL(file).href;
    const manifest = await normalizeWorkspaceEdit({ changes: { [uri]: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: "LSP" }] } }, root, "utf-16", DEFAULT_LIMITS);
    expect(manifest.applicable).toBe(true); await applyManifest(manifest); expect(await readFile(file, "utf8")).toBe("hello LSP\n");
    await expect(normalizeWorkspaceEdit({ changes: { [uri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "x" }, { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } }, newText: "y" }] } }, root, "utf-16", DEFAULT_LIMITS)).rejects.toThrow(/Overlapping/);
  });
});
