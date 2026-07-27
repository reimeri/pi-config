import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { normalizeWorkspaceEdit } from "../../src/workspace/edits.js";
import { applyManifest } from "../../src/workspace/transaction.js";
import { renderManifest } from "../../src/workspace/diff.js";
import { DEFAULT_LIMITS } from "../../src/runtime/limits.js";

async function rootWithFiles() {
  const root = await mkdtemp(join(tmpdir(), "base-lsp-transaction-"));
  const a = join(root, "a.ts"); const b = join(root, "b.ts");
  await writeFile(a, "const alpha = 1;\n"); await writeFile(b, "console.log(alpha);\n");
  return { root, a, b };
}
function replacement(uri: string, version: number | null, start: number, end: number, text: string) {
  return { textDocument: { uri, version }, edits: [{ range: { start: { line: 0, character: start }, end: { line: 0, character: end } }, newText: text }] };
}

describe("workspace edit safety", () => {
  it("validates document versions and rejects resource-operation subsets", async () => {
    const { root, a } = await rootWithFiles(); const uri = pathToFileURL(a).href;
    const mismatch = await normalizeWorkspaceEdit({ documentChanges: [replacement(uri, 3, 6, 11, "beta")] }, root, "utf-16", DEFAULT_LIMITS, new Map([[uri, 2]]));
    expect(mismatch.applicable).toBe(false); expect(mismatch.reasons.join(" ")).toMatch(/version mismatch/);
    const resource = await normalizeWorkspaceEdit({ documentChanges: [replacement(uri, null, 6, 11, "beta"), { kind: "create", uri: pathToFileURL(join(root, "new.ts")).href }] }, root, "utf-16", DEFAULT_LIMITS);
    expect(resource.files).toHaveLength(1); expect(resource.applicable).toBe(false); expect(resource.reasons.join(" ")).toMatch(/Resource operations/);
  });

  it("normalizes versioned edits against the synchronized snapshot", async () => {
    const { root, a } = await rootWithFiles(); const uri = pathToFileURL(a).href;
    const original = "const alpha = 1;\n";
    await writeFile(a, "const diskChanged = 2;\n");
    const manifest = await normalizeWorkspaceEdit(
      { documentChanges: [replacement(uri, 4, 6, 11, "beta")] },
      root,
      "utf-16",
      DEFAULT_LIMITS,
      new Map([[uri, 4]]),
      new Map([[uri, { uri, canonicalPath: a, version: 4, text: original, contentHash: "4be1c9f74149d8947ca52f0591271dfdb153386c722cffa23182e17d36af8403" }]]),
    );
    expect(manifest.files[0]?.original).toBe(original);
    expect(manifest.files[0]?.updated).toContain("beta");
    await expect(applyManifest(manifest)).rejects.toThrow(/changed since/);
  });

  it("rejects symlink escapes and stale files before publication", async () => {
    const { root, a } = await rootWithFiles();
    const outside = join(await mkdtemp(join(tmpdir(), "base-lsp-outside-")), "outside.ts"); await writeFile(outside, "outside\n");
    const link = join(root, "link.ts"); await symlink(outside, link);
    const escaped = await normalizeWorkspaceEdit({ changes: { [pathToFileURL(link).href]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } }, newText: "changed" }] } }, root, "utf-16", DEFAULT_LIMITS);
    expect(escaped.applicable).toBe(false); expect(escaped.reasons.join(" ")).toMatch(/outside/);
    const uri = pathToFileURL(a).href;
    const manifest = await normalizeWorkspaceEdit({ documentChanges: [replacement(uri, null, 6, 11, "beta")] }, root, "utf-16", DEFAULT_LIMITS);
    await writeFile(a, "const changed = 2;\n");
    await expect(applyManifest(manifest)).rejects.toThrow(/changed since/);
    expect(await readFile(a, "utf8")).toBe("const changed = 2;\n");
  });

  it("publishes complete multi-file transactions", async () => {
    const { root, a, b } = await rootWithFiles();
    const edit = { documentChanges: [replacement(pathToFileURL(a).href, null, 6, 11, "beta"), replacement(pathToFileURL(b).href, null, 12, 17, "beta")] };
    const manifest = await normalizeWorkspaceEdit(edit, root, "utf-16", DEFAULT_LIMITS);
    expect(manifest.applicable).toBe(true); expect(manifest.totalEdits).toBe(2);
    await applyManifest(manifest);
    expect(await readFile(a, "utf8")).toContain("beta"); expect(await readFile(b, "utf8")).toContain("beta");
  });

  it("coordinates with Pi's mutation queue and rechecks cancellation after acquisition", async () => {
    const { root, a } = await rootWithFiles(); const uri = pathToFileURL(a).href;
    const manifest = await normalizeWorkspaceEdit({ documentChanges: [replacement(uri, null, 6, 11, "beta")] }, root, "utf-16", DEFAULT_LIMITS);
    let release!: () => void; let entered!: () => void;
    const acquired = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const blocker = withFileMutationQueue(a, async () => { entered(); await gate; });
    await acquired;
    const controller = new AbortController();
    const applying = applyManifest(manifest, controller.signal);
    controller.abort(); release(); await blocker;
    await expect(applying).rejects.toMatchObject({ name: "CancelledError" });
    expect(await readFile(a, "utf8")).toBe("const alpha = 1;\n");
  });
});

describe("diff preview", () => {
  function staged(original: string, updated: string) {
    return { files: [{ path: "/root/a.ts", uri: "file:///root/a.ts", original, updated, hash: "h", mode: 0o644, mtimeMs: 0, edits: 1 }], totalEdits: 1, resourceOperations: [], applicable: true, reasons: [], fingerprint: "f" };
  }

  it("shows an edit that only changes the trailing newline", () => {
    const added = renderManifest(staged("alpha", "alpha\n"), 40_000, "/root").text;
    expect(added).toContain("-alpha\n\\ No newline at end of file\n");
    expect(added).toContain("+alpha\n");
    const removed = renderManifest(staged("alpha\n", "alpha"), 40_000, "/root").text;
    expect(removed).toContain("+alpha\n\\ No newline at end of file\n");
  });

  it("leaves an ordinary hunk unmarked", () => {
    const text = renderManifest(staged("alpha\nbeta\n", "alpha\ngamma\n"), 40_000, "/root").text;
    expect(text).toContain("-beta\n");
    expect(text).toContain("+gamma\n");
    expect(text).not.toContain("No newline");
  });
});
