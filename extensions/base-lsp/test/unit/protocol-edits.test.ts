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
import { stableHash } from "../../src/util/text.js";

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

  it("rejects a header that never terminates", async () => {
    const stream = new PassThrough(); const reader = new BoundedStreamMessageReader(stream, { maxHeaderBytes: 256, maxBodyBytes: 1024 });
    const errors: Error[] = []; reader.onError((error) => errors.push(error)); reader.listen(() => undefined);
    stream.write("Content-Length: 10\r\n".repeat(40)); await new Promise((resolve) => setImmediate(resolve));
    expect(errors[0]?.message).toMatch(/header limit/);
  });

  it("reassembles a separator split across a chunk boundary", async () => {
    const stream = new PassThrough(); const reader = new BoundedStreamMessageReader(stream, { maxHeaderBytes: 256, maxBodyBytes: 1024 });
    const messages: any[] = []; const errors: Error[] = [];
    reader.onError((error) => errors.push(error)); reader.listen((message) => messages.push(message));
    const body = JSON.stringify({ jsonrpc: "2.0", id: 7, result: "ok" });
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    // Cut between the two CRLF pairs, the one place a naive scan can lose the frame boundary.
    const cut = frame.indexOf("\r\n\r\n") + 2;
    stream.write(frame.slice(0, cut)); stream.write(frame.slice(cut));
    await new Promise((resolve) => setImmediate(resolve));
    expect(errors).toEqual([]); expect(messages).toEqual([{ jsonrpc: "2.0", id: 7, result: "ok" }]);
  });

  it("reclaims space across a long run of frames rather than growing without bound", async () => {
    // Each frame is a sizeable fraction of the reader's working buffer, so consuming them has to
    // slide the remainder down; a reader that only ever appended would balloon instead.
    const stream = new PassThrough(); const reader = new BoundedStreamMessageReader(stream, { maxHeaderBytes: 1024, maxBodyBytes: 128 * 1024 });
    const messages: any[] = []; const errors: Error[] = [];
    reader.onError((error) => errors.push(error)); reader.listen((message) => messages.push(message));
    for (let id = 0; id < 200; id += 1) {
      const body = JSON.stringify({ jsonrpc: "2.0", id, result: { pad: "é".repeat(3_000) } });
      const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, "utf8");
      for (let offset = 0; offset < frame.length; offset += 997) stream.write(frame.subarray(offset, offset + 997));
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(errors).toEqual([]);
    expect(messages.map((message) => message.id)).toEqual(Array.from({ length: 200 }, (_, index) => index));
    expect(messages[199].result.pad).toBe("é".repeat(3_000));
  });

  it("accumulates a large body in linear time", async () => {
    // Concatenating the whole retained buffer per chunk cost ~576ms for this input; the copying is
    // now amortised to one pass over the bytes received.
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { data: "x".repeat(8 * 1024 * 1024) } });
    const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`, "utf8");
    const stream = new PassThrough(); const reader = new BoundedStreamMessageReader(stream, { maxHeaderBytes: 64 * 1024, maxBodyBytes: 64 * 1024 * 1024 });
    const errors: Error[] = []; let received: any;
    reader.onError((error) => errors.push(error));
    const settled = new Promise<void>((resolve) => reader.listen((message) => { received = message; resolve(); }));
    const started = performance.now();
    for (let offset = 0; offset < frame.length; offset += 8 * 1024) stream.write(frame.subarray(offset, offset + 8 * 1024));
    await settled;
    const elapsed = performance.now() - started;
    expect(errors).toEqual([]);
    expect(received.result.data).toHaveLength(8 * 1024 * 1024);
    expect(elapsed).toBeLessThan(150);
  });
});

describe("workspace edits", () => {
  it("stages and applies non-overlapping edits and rejects overlaps", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-edit-")); const file = join(root, "a.ts"); await writeFile(file, "hello world\n"); const uri = pathToFileURL(file).href;
    const manifest = await normalizeWorkspaceEdit({ changes: { [uri]: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: "LSP" }] } }, root, "utf-16", DEFAULT_LIMITS);
    expect(manifest.applicable).toBe(true); await applyManifest(manifest); expect(await readFile(file, "utf8")).toBe("hello LSP\n");
    await expect(normalizeWorkspaceEdit({ changes: { [uri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "x" }, { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } }, newText: "y" }] } }, root, "utf-16", DEFAULT_LIMITS)).rejects.toThrow(/Overlapping/);
  });

  it("assembles the same text a per-edit splice would, across randomized edit sets", async () => {
    // The staged text is what gets written to the user's files, so the single forward pass has to
    // agree with the obvious splice-each-edit-in-reverse reference on every shape: insertions,
    // deletions, replacements, edits meeting end-to-start, and edits at both boundaries.
    const root = await mkdtemp(join(tmpdir(), "base-lsp-edit-fuzz-"));
    // Multi-byte but single-unit characters, so every character offset is a legal boundary; astral
    // characters appear in the replacement text, which is inserted rather than indexed into.
    const lines = Array.from({ length: 40 }, (_, index) => `const value${index} = compute(${index}, "héllo → wörld");`);
    const original = `${lines.join("\n")}\n`;
    const file = join(root, "fuzz.ts");
    await writeFile(file, original);
    const uri = pathToFileURL(file).href;

    let seed = 20_260_727;
    const rand = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

    for (let trial = 0; trial < 120; trial++) {
      // Non-overlapping ranges within one line, walking forward so they can touch but never cross.
      const edits = [];
      const line = rand(lines.length);
      const width = lines[line]!.length;
      let column = 0;
      while (column < width && edits.length < DEFAULT_LIMITS.maxEditsPerFile) {
        const start = column + rand(4);
        const end = Math.min(width, start + rand(5));
        if (start > width) break;
        const newText = ["", "X", "→🙂", "replacement", "\n  "][rand(5)]!;
        edits.push({ range: { start: { line, character: start }, end: { line, character: end } }, newText });
        column = end + rand(3);
      }
      if (edits.length === 0) continue;

      const manifest = await normalizeWorkspaceEdit({ changes: { [uri]: edits } }, root, "utf-16", DEFAULT_LIMITS);
      expect(manifest.applicable, `trial ${trial}`).toBe(true);

      // Reference: splice each edit into an accumulating string, highest offset first, exactly as
      // the previous implementation did.
      const offsets = edits.map((edit, index) => {
        const lineStart = original.split("\n").slice(0, edit.range.start.line).join("\n").length + (edit.range.start.line > 0 ? 1 : 0);
        return { start: lineStart + edit.range.start.character, end: lineStart + edit.range.end.character, text: edit.newText, index };
      });
      let expected = original;
      for (const item of [...offsets].sort((a, b) => b.start - a.start || b.end - a.end || b.index - a.index)) {
        expected = expected.slice(0, item.start) + item.text + expected.slice(item.end);
      }
      expect(manifest.files[0]!.updated, `trial ${trial}`).toBe(expected);
    }
  });

  it("uses one digest of the original for both the snapshot check and the staged hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-edit-hash-"));
    const file = join(root, "a.ts");
    const original = "hello world\n";
    await writeFile(file, original);
    const uri = pathToFileURL(file).href;
    const edit = { changes: { [uri]: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: "LSP" }] } };
    // Take the canonical path from a snapshot-free pass so the comparison cannot trip on symlinks.
    const canonicalPath = (await normalizeWorkspaceEdit(edit, root, "utf-16", DEFAULT_LIMITS)).files[0]!.path;
    const snapshot = { uri, canonicalPath, version: 1, text: original, contentHash: stableHash(original) };

    const matched = await normalizeWorkspaceEdit(edit, root, "utf-16", DEFAULT_LIMITS, undefined, new Map([[uri, snapshot]]));
    expect(matched.applicable).toBe(true);
    expect(matched.files[0]!.hash).toBe(snapshot.contentHash);

    const stale = await normalizeWorkspaceEdit(edit, root, "utf-16", DEFAULT_LIMITS, undefined, new Map([[uri, { ...snapshot, contentHash: stableHash("stale content\n") }]]));
    expect(stale.applicable).toBe(false);
    expect(stale.reasons.join(" ")).toMatch(/snapshot hash is inconsistent/);
  });

  it("stages an unchanged file when the edit list is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-edit-empty-"));
    const file = join(root, "a.ts");
    await writeFile(file, "unchanged\n");
    const manifest = await normalizeWorkspaceEdit({ changes: { [pathToFileURL(file).href]: [] } }, root, "utf-16", DEFAULT_LIMITS);
    expect(manifest.files[0]?.updated).toBe("unchanged\n");
    expect(manifest.files[0]?.original).toBe("unchanged\n");
  });
});
