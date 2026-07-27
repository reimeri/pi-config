import { describe, expect, it } from "vitest";
import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocumentStore } from "../../src/runtime/document-store.js";
import { fakeServer } from "../helpers/fake.js";
import type { NormalizedCapabilities } from "../../src/protocol/types.js";

const capabilities: NormalizedCapabilities = {
  positionEncoding: "utf-16", syncKind: 2, openClose: true, save: { includeText: true }, diagnostics: { pull: false, workspace: false },
  declaration: false, definition: false, typeDefinition: false, implementation: false, references: false, hover: false, documentSymbols: false,
  workspaceSymbols: false, workspaceSymbolResolve: false, callHierarchy: false, codeActions: false, codeActionResolve: false, rename: false, prepareRename: false, executeCommands: [],
};

describe("unchanged-document detection", () => {
  const store = (methods: string[] = []) => new DocumentStore(fakeServer(), capabilities, async (method) => { methods.push(method); }, 10, 1024 * 1024);

  it("catches a same-length rewrite, however fast it follows the last sync", async () => {
    // The hazard in trusting size and modification time: an agent flipping a digit or a boolean
    // leaves the byte count untouched, and back-to-back edits can land within one clock tick.
    const root = await mkdtemp(join(tmpdir(), "base-lsp-doc-samesize-"));
    const path = join(root, "a.ts");
    const documents = store();
    await writeFile(path, "export const v = 0;\n");
    expect((await documents.sync(path)).syncState).toBe("opened");
    for (let value = 1; value < 40; value++) {
      await writeFile(path, `export const v = ${value % 10};\n`);
      const snapshot = await documents.sync(path);
      expect(snapshot.syncState, `edit ${value}`).toBe("changed");
      expect(snapshot.text, `edit ${value}`).toBe(`export const v = ${value % 10};\n`);
    }
  });

  it("catches a rewrite that keeps the recorded modification time", async () => {
    // Pinning mtime back after the write is what a stale-cache bug looks like from the outside.
    // Only the racily-clean rule — the timestamp must predate the read that cached the text —
    // separates this from the trusted case below.
    const root = await mkdtemp(join(tmpdir(), "base-lsp-doc-racy-"));
    const path = join(root, "a.ts");
    const pinned = new Date(Date.now() + 60_000);
    await writeFile(path, "const v = 1;\n");
    await utimes(path, pinned, pinned);
    const documents = store();
    expect((await documents.sync(path)).syncState).toBe("opened");
    await writeFile(path, "const v = 2;\n");
    await utimes(path, pinned, pinned);
    const snapshot = await documents.sync(path);
    expect(snapshot.syncState).toBe("changed");
    expect(snapshot.text).toBe("const v = 2;\n");
  });

  it("catches a length change that keeps the recorded modification time", async () => {
    // Timestamp deliberately old enough to be trusted, so only the size comparison rejects this.
    const root = await mkdtemp(join(tmpdir(), "base-lsp-doc-size-"));
    const path = join(root, "a.ts");
    const past = new Date(Date.now() - 60_000);
    await writeFile(path, "const v = 1;\n");
    await utimes(path, past, past);
    const documents = store();
    await documents.sync(path);
    await writeFile(path, "const v = 1; // appended\n");
    await utimes(path, past, past);
    const snapshot = await documents.sync(path);
    expect(snapshot.syncState).toBe("changed");
    expect(snapshot.text).toBe("const v = 1; // appended\n");
  });

  it("skips the read when size and modification time both hold steady", async () => {
    // Proving the fast path engages by observing its deliberate blind spot: a file rewritten to the
    // same length with its old timestamp restored is indistinguishable from an untouched one. That
    // takes an external actor preserving timestamps (`cp -p`, `rsync --times`); ordinary writes
    // move mtime forward and are caught by the test above.
    const root = await mkdtemp(join(tmpdir(), "base-lsp-doc-fastpath-"));
    const path = join(root, "a.ts");
    const past = new Date(Date.now() - 60_000);
    await writeFile(path, "const v = 1;\n");
    await utimes(path, past, past);
    const documents = store();
    await documents.sync(path);
    await writeFile(path, "const v = 2;\n");
    await utimes(path, past, past);
    const snapshot = await documents.sync(path);
    expect(snapshot.syncState).toBe("unchanged");
    expect(snapshot.text).toBe("const v = 1;\n");
  });

  it("reports a length change and a touched-but-identical file correctly", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-doc-states-"));
    const path = join(root, "a.ts");
    const methods: string[] = [];
    const documents = store(methods);
    await writeFile(path, "const v = 1;\n");
    await documents.sync(path);

    await writeFile(path, "const v = 1; // longer now\n");
    expect((await documents.sync(path)).syncState).toBe("changed");

    // Rewriting identical bytes moves mtime but is not an edit; the server must not be told it is.
    await writeFile(path, "const v = 1; // longer now\n");
    expect((await documents.sync(path)).syncState).toBe("unchanged");
    expect(methods).toEqual(["textDocument/didOpen", "textDocument/didChange"]);
  });
});

describe("document synchronization ordering", () => {
  it("enforces maxOpen atomically across concurrent URI synchronizations", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-doc-capacity-"));
    const a = join(root, "a.ts"); const b = join(root, "b.ts"); await writeFile(a, "export {};\n"); await writeFile(b, "export {};\n");
    const store = new DocumentStore(fakeServer(), capabilities, async (method) => { if (method === "textDocument/didOpen") await new Promise((resolve) => setTimeout(resolve, 10)); }, 1, 1024 * 1024);
    const settled = await Promise.allSettled([store.sync(a), store.sync(b)]);
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(2);
    expect(store.list()).toHaveLength(1);
  });

  it("returns immutable document snapshots from registry accessors", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-doc-snapshots-")); const path = join(root, "a.ts"); await writeFile(path, "const original = 1;\n");
    const store = new DocumentStore(fakeServer(), capabilities, async () => undefined, 2, 1024 * 1024);
    await store.sync(path);
    const listed = store.list(); listed[0]!.text = "mutated"; listed[0]!.version = 99;
    expect(store.get(path)).toMatchObject({ text: "const original = 1;\n", version: 1 });
    const byUri = store.getByUri(store.get(path)!.uri)!; byUri.text = "also mutated";
    expect(store.get(path)?.text).toBe("const original = 1;\n");
  });

  it("pins every document in a multi-document request against LRU eviction", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-doc-pins-"));
    const paths = ["a.ts", "b.ts", "c.ts"].map((name) => join(root, name));
    await Promise.all(paths.map((path, index) => writeFile(path, `const v = ${index};\n`)));
    const store = new DocumentStore(fakeServer(), capabilities, async () => undefined, 2, 1024 * 1024);
    await store.sync(paths[2]!);
    await store.withSynchronizedDocuments(paths.slice(0, 2), undefined, async () => {
      expect(store.list().map((document) => document.canonicalPath).sort()).toEqual(paths.slice(0, 2).sort());
    });
    await expect(store.withSynchronizedDocuments(paths, undefined, async () => undefined)).rejects.toThrow(/document limit/);
  });

  it("holds the URI queue across a synchronized request callback", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-doc-request-")); const path = join(root, "a.ts"); await writeFile(path, "const v = 1;\n");
    const methods: string[] = [];
    const store = new DocumentStore(fakeServer(), capabilities, async (method) => { methods.push(method); }, 10, 1024 * 1024);
    await store.sync(path);
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const requestEntered = new Promise<void>((resolve) => { entered = resolve; });
    const request = store.withSynchronizedDocument(path, undefined, async () => { methods.push("request"); entered(); await gate; });
    await requestEntered;
    await writeFile(path, "const v = 2;\n");
    const laterSync = store.sync(path);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(methods).toEqual(["textDocument/didOpen", "request"]);
    release(); await request; await laterSync;
    expect(methods).toEqual(["textDocument/didOpen", "request", "textDocument/didChange"]);
  });

  it("never reuses a document version after a close and reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-doc-versions-")); const path = join(root, "a.ts"); await writeFile(path, "const v = 1;\n");
    const opened: number[] = [];
    const store = new DocumentStore(fakeServer(), capabilities, async (method, value) => { if (method === "textDocument/didOpen") opened.push((value as any).textDocument.version); }, 10, 1024 * 1024);
    await store.sync(path);
    await writeFile(path, "const v = 2;\n"); await store.sync(path);
    expect(store.get(path)?.version).toBe(2);
    await store.close(path);
    // Reopening with different content must not reuse version 1: consumers treat a matching
    // (uri, version) pair as proof that a server publication describes this exact content.
    await writeFile(path, "const v = 3;\n");
    const reopened = await store.sync(path);
    expect(reopened.syncState).toBe("opened");
    expect(reopened.version).toBe(3);
    expect(opened).toEqual([1, 3]);
  });

  it("serializes didChange, didSave, and a later didChange on the same URI", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-doc-store-")); const path = join(root, "a.ts"); await writeFile(path, "const v = 1;\n");
    const methods: string[] = []; const params: unknown[] = [];
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const didChangeEntered = new Promise<void>((resolve) => { entered = resolve; });
    let changes = 0;
    const store = new DocumentStore(fakeServer(), capabilities, async (method, value) => {
      methods.push(method); params.push(value);
      if (method === "textDocument/didChange" && changes++ === 0) { entered(); await gate; }
    }, 10, 1024 * 1024);
    await store.sync(path);
    await writeFile(path, "const v = 2;\n");
    const save = store.syncAndSave(path);
    await didChangeEntered;
    await writeFile(path, "const v = 3;\n");
    const later = store.sync(path);
    release(); await save; await later;
    expect(methods).toEqual(["textDocument/didOpen", "textDocument/didChange", "textDocument/didSave", "textDocument/didChange"]);
    expect((params[2] as any).text).toBe("const v = 2;\n");
  });
});
