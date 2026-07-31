import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.js";
import { ClientManager } from "../../src/runtime/client-manager.js";
import { DiagnosticService } from "../../src/protocol/diagnostics.js";
import { ServerRegistry } from "../../src/servers/registry.js";
import { RootDetector } from "../../src/servers/roots.js";
import { registerDiagnosticsTool } from "../../src/tools/diagnostics.js";
import type { SessionRuntime } from "../../src/tools/context.js";
import { fakeServer } from "../helpers/fake.js";

function toolFor(runtime: SessionRuntime) {
  let tool: any;
  registerDiagnosticsTool({ registerTool(definition: any) { tool = definition; } } as any, () => runtime);
  return tool;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Condition was not met before the test deadline");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("diagnostics tool scheduling", () => {
  it("summarizes unavailable servers while retaining per-file evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-diagnostic-unavailable-"));
    await writeFile(join(root, "tsconfig.json"), "{}");
    const firstPath = join(root, "a.ts"); const secondPath = join(root, "b.ts");
    await writeFile(firstPath, "const first = 1;\n"); await writeFile(secondPath, "const second = 2;\n");
    const missing = { ...fakeServer(), id: "missing", command: [join(root, "missing-language-server")], installationHint: "install missing-ls" };
    const config = { ...defaultConfig(), servers: { missing } };
    const loaded = { config, generation: 1, userPath: join(root, "user.json"), warnings: [], trusted: true, authorized: true };
    const manager = new ClientManager(loaded);
    const runtime: SessionRuntime = { cwd: root, boundary: root, loaded, registry: new ServerRegistry(config.servers), roots: new RootDetector(1), manager, diagnostics: new DiagnosticService(), changed: new Set(), previewActions: new Set(), previewRenames: new Set() };
    try {
      const result = await toolFor(runtime).execute("call", { paths: [firstPath, secondPath], mode: "paths", waitMs: 1_000 }, undefined, undefined, { cwd: root });
      expect(result.details.status).toBe("unavailable");
      expect(result.details.files).toHaveLength(2);
      expect(result.details.unavailableServers).toEqual([expect.objectContaining({ server: "missing", files: 2, installationHint: "install missing-ls" })]);
      expect(result.details.coverage).toMatchObject({ requested: 2, unavailable: 2, affirmative: 0 });
      expect(result.content[0].text.match(/unavailable for 2 file\(s\)/g)).toHaveLength(1);
    } finally { await manager.shutdown(); }
  });

  it("keeps diagnostics whose ranges fit when a sibling range does not", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-diagnostic-stale-"));
    await writeFile(join(root, "tsconfig.json"), "{}");
    const path = join(root, "a.ts");
    await writeFile(path, "const ERROR = 1;\n");
    const server = { ...fakeServer({ FAKE_LSP_STALE_RANGE: "1" }), id: "fake" };
    const config = { ...defaultConfig(), servers: { fake: server } };
    const loaded = { config, generation: 1, userPath: join(root, "user.json"), warnings: [], trusted: true, authorized: true };
    const manager = new ClientManager(loaded);
    const runtime: SessionRuntime = { cwd: root, boundary: root, loaded, registry: new ServerRegistry(config.servers), roots: new RootDetector(1), manager, diagnostics: new DiagnosticService(), changed: new Set(), previewActions: new Set(), previewRenames: new Set() };
    try {
      const result = await toolFor(runtime).execute("call", { paths: [path], mode: "paths", waitMs: 1_500 }, undefined, undefined, { cwd: root });
      const file = result.details.files[0];
      // Preserve valid diagnostics when one range is invalid.
      expect(file.state).toBe("diagnostics");
      expect(file.diagnostics).toHaveLength(2);
      expect(file.message).toBeUndefined();
      const good = file.diagnostics.find((item: any) => !item.rangeUnresolved);
      expect(good).toMatchObject({ message: "fake error 1", range: { start: { line: 1, character: 7 } } });
      const stale = file.diagnostics.find((item: any) => item.rangeUnresolved);
      expect(stale).toMatchObject({ message: "stale range error", rangeUnresolved: "out-of-range", rawRange: { start: { line: 400, character: 0 } }, range: { start: { line: 401 } } });
      expect(stale.range.start.character).toBeUndefined();
      expect(file.unresolvedRanges).toBe(1);
      expect(result.details.unresolvedRanges).toBe(1);
      expect(result.details.status).toBe("partial");
      expect(result.details.warnings.some((warning: string) => /did not fit the synchronized document/.test(warning))).toBe(true);
      expect(result.content[0].text).toContain("[stale range]");
    } finally { await manager.shutdown(); }
  });

  it("batches push-only files so one clean grace covers the whole server/root group", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-diagnostic-push-batch-"));
    await writeFile(join(root, "tsconfig.json"), "{}");
    const files = Array.from({ length: 8 }, (_, index) => join(root, `file-${index}.ts`));
    await Promise.all(files.map((path) => writeFile(path, "const value = 1;\n")));
    const typescript = {
      ...fakeServer({ FAKE_LSP_PUSH: "1", FAKE_LSP_UNVERSIONED: "1", FAKE_LSP_NO_PULL: "1", FAKE_LSP_SERVER_NAME: "typescript-language-server" }),
      id: "typescript",
      diagnosticPolicy: { pushFirstMs: 100, settleMs: 5, acceptUnversionedEmptyAfterOpen: true },
    };
    const config = { ...defaultConfig(), servers: { typescript } };
    const loaded = { config, generation: 1, userPath: join(root, "user.json"), warnings: [], trusted: true, authorized: true };
    const manager = new ClientManager(loaded);
    const runtime: SessionRuntime = { cwd: root, boundary: root, loaded, registry: new ServerRegistry(config.servers), roots: new RootDetector(1), manager, diagnostics: new DiagnosticService(), changed: new Set(), previewActions: new Set(), previewRenames: new Set() };
    try {
      const started = Date.now();
      const result = await toolFor(runtime).execute("call", { paths: files, mode: "paths", waitMs: 1_000 }, undefined, undefined, { cwd: root });
      expect(Date.now() - started).toBeLessThan(500);
      expect(result.details.status).toBe("ok");
      expect(result.details.files).toHaveLength(files.length);
      expect(result.details.files.every((file: any) => file.state === "clean" && file.confirmation === "post_open_server_policy")).toBe(true);
    } finally { await manager.shutdown(); }
  });

  it("uses one shared deadline when one file in a push batch stays silent", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-diagnostic-push-silent-"));
    await writeFile(join(root, "tsconfig.json"), "{}");
    const files = [join(root, "first.ts"), join(root, "second.ts"), join(root, "silent.ts")];
    await Promise.all(files.map((path) => writeFile(path, "const value = 1;\n")));
    const typescript = {
      ...fakeServer({ FAKE_LSP_PUSH: "1", FAKE_LSP_UNVERSIONED: "1", FAKE_LSP_NO_PULL: "1", FAKE_LSP_SERVER_NAME: "typescript-language-server", FAKE_LSP_SILENT_URI_SUFFIX: "silent.ts" }),
      id: "typescript",
      diagnosticPolicy: { pushFirstMs: 20, settleMs: 5, acceptUnversionedEmptyAfterOpen: true },
    };
    const config = { ...defaultConfig(), servers: { typescript } };
    const loaded = { config, generation: 1, userPath: join(root, "user.json"), warnings: [], trusted: true, authorized: true };
    const manager = new ClientManager(loaded);
    const runtime: SessionRuntime = { cwd: root, boundary: root, loaded, registry: new ServerRegistry(config.servers), roots: new RootDetector(1), manager, diagnostics: new DiagnosticService(), changed: new Set(), previewActions: new Set(), previewRenames: new Set() };
    try {
      const started = Date.now();
      const result = await toolFor(runtime).execute("call", { paths: files, mode: "paths", waitMs: 150 }, undefined, undefined, { cwd: root });
      expect(Date.now() - started).toBeLessThan(400);
      expect(result.details.files.filter((file: any) => file.state === "clean")).toHaveLength(2);
      expect(result.details.files.find((file: any) => file.path === "silent.ts")?.state).toMatch(/^(timed_out|unconfirmed)$/);
    } finally { await manager.shutdown(); }
  });

  it("bypasses the TypeScript push grace when affirmative tsserver requests are available", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-diagnostic-tsserver-batch-"));
    await writeFile(join(root, "tsconfig.json"), "{}");
    const files = Array.from({ length: 8 }, (_, index) => join(root, `file-${index}.ts`));
    await Promise.all(files.map((path, index) => writeFile(path, index === 3 ? "const ERROR = 1;\n" : "const value = 1;\n")));
    const typescript = {
      ...fakeServer({ FAKE_LSP_NO_PULL: "1", FAKE_LSP_TS_REQUEST: "1", FAKE_LSP_SERVER_NAME: "typescript-language-server" }),
      id: "typescript",
      diagnosticPolicy: { pushFirstMs: 10_000, settleMs: 5, acceptUnversionedEmptyAfterOpen: true },
    };
    const config = { ...defaultConfig(), servers: { typescript } };
    const loaded = { config, generation: 1, userPath: join(root, "user.json"), warnings: [], trusted: true, authorized: true };
    const manager = new ClientManager(loaded);
    const runtime: SessionRuntime = { cwd: root, boundary: root, loaded, registry: new ServerRegistry(config.servers), roots: new RootDetector(1), manager, diagnostics: new DiagnosticService(), changed: new Set(), previewActions: new Set(), previewRenames: new Set() };
    try {
      const started = Date.now();
      const result = await toolFor(runtime).execute("call", { paths: files, mode: "paths", waitMs: 1_000 }, undefined, undefined, { cwd: root });
      expect(Date.now() - started).toBeLessThan(500);
      expect(result.details.files.every((file: any) => file.confirmation === "typescript_tsserver_request")).toBe(true);
      expect(result.details.files.find((file: any) => file.path === "file-3.ts")?.diagnostics[0]?.code).toBe("9001");
    } finally { await manager.shutdown(); }
  });

  it("does not accept an early empty batch publication when delayed diagnostics arrive", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-diagnostic-push-delayed-"));
    await writeFile(join(root, "tsconfig.json"), "{}");
    const files = [join(root, "first.ts"), join(root, "second.ts")];
    await Promise.all(files.map((path) => writeFile(path, "const value = 1;\n")));
    const typescript = {
      ...fakeServer({ FAKE_LSP_PUSH: "1", FAKE_LSP_UNVERSIONED: "1", FAKE_LSP_NO_PULL: "1", FAKE_LSP_SERVER_NAME: "typescript-language-server", FAKE_LSP_PUSH_SECOND_ERROR_DELAY_MS: "50" }),
      id: "typescript",
      diagnosticPolicy: { pushFirstMs: 100, settleMs: 5, acceptUnversionedEmptyAfterOpen: true },
    };
    const config = { ...defaultConfig(), servers: { typescript } };
    const loaded = { config, generation: 1, userPath: join(root, "user.json"), warnings: [], trusted: true, authorized: true };
    const manager = new ClientManager(loaded);
    const runtime: SessionRuntime = { cwd: root, boundary: root, loaded, registry: new ServerRegistry(config.servers), roots: new RootDetector(1), manager, diagnostics: new DiagnosticService(), changed: new Set(), previewActions: new Set(), previewRenames: new Set() };
    try {
      const result = await toolFor(runtime).execute("call", { paths: files, mode: "paths", waitMs: 500 }, undefined, undefined, { cwd: root });
      expect(result.details.files.every((file: any) => file.state === "diagnostics" && file.diagnostics[0]?.message === "delayed semantic error")).toBe(true);
    } finally { await manager.shutdown(); }
  });

  it("chunks above the open-document cap without granting each chunk a fresh deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-diagnostic-push-chunks-"));
    await writeFile(join(root, "tsconfig.json"), "{}");
    const files = Array.from({ length: 4 }, (_, index) => join(root, `file-${index}.ts`));
    await Promise.all(files.map((path) => writeFile(path, "const value = 1;\n")));
    const pushOnly = { ...fakeServer({ FAKE_LSP_NO_PULL: "1" }), id: "push-only" };
    const base = defaultConfig();
    const config = { ...base, limits: { ...base.limits, maxOpenDocuments: 2 }, servers: { "push-only": pushOnly } };
    const loaded = { config, generation: 1, userPath: join(root, "user.json"), warnings: [], trusted: true, authorized: true };
    const manager = new ClientManager(loaded);
    const runtime: SessionRuntime = { cwd: root, boundary: root, loaded, registry: new ServerRegistry(config.servers), roots: new RootDetector(1), manager, diagnostics: new DiagnosticService(), changed: new Set(), previewActions: new Set(), previewRenames: new Set() };
    try {
      const started = Date.now();
      const result = await toolFor(runtime).execute("call", { paths: files, mode: "paths", waitMs: 100 }, undefined, undefined, { cwd: root });
      expect(Date.now() - started).toBeLessThan(250);
      expect(result.details.files).toHaveLength(4);
      expect(result.details.files.every((file: any) => file.state === "timed_out" || file.state === "unconfirmed")).toBe(true);
    } finally { await manager.shutdown(); }
  });

  it("checks every chunk instead of letting the first one consume the whole deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-diagnostic-chunk-share-"));
    await writeFile(join(root, "tsconfig.json"), "{}");
    // Put the silent file first so first-come budgeting would starve later chunks.
    const files = [join(root, "a-silent.ts"), join(root, "b.ts"), join(root, "c.ts"), join(root, "d.ts")];
    await Promise.all(files.map((path) => writeFile(path, "const value = 1;\n")));
    const pushOnly = { ...fakeServer({ FAKE_LSP_NO_PULL: "1", FAKE_LSP_PUSH: "1", FAKE_LSP_SILENT_URI_SUFFIX: "a-silent.ts" }), id: "push-only" };
    const base = defaultConfig();
    const config = { ...base, limits: { ...base.limits, maxOpenDocuments: 2 }, servers: { "push-only": pushOnly } };
    const loaded = { config, generation: 1, userPath: join(root, "user.json"), warnings: [], trusted: true, authorized: true };
    const manager = new ClientManager(loaded);
    const runtime: SessionRuntime = { cwd: root, boundary: root, loaded, registry: new ServerRegistry(config.servers), roots: new RootDetector(1), manager, diagnostics: new DiagnosticService(), changed: new Set(), previewActions: new Set(), previewRenames: new Set() };
    try {
      const started = Date.now();
      const result = await toolFor(runtime).execute("call", { paths: files, mode: "paths", waitMs: 800 }, undefined, undefined, { cwd: root });
      expect(Date.now() - started).toBeLessThan(1_000);
      const byPath = new Map(result.details.files.map((file: any) => [file.path, file.state]));
      expect(byPath.get("a-silent.ts")).toMatch(/^(timed_out|unconfirmed)$/);
      // The silent file consumes only its share; continue collecting other chunks.
      expect([byPath.get("b.ts"), byPath.get("c.ts"), byPath.get("d.ts")]).toEqual(["clean", "clean", "clean"]);
    } finally { await manager.shutdown(); }
  });

  it("leaves a slow-starting server warm when the deadline expires during acquisition", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-diagnostic-slow-start-"));
    await writeFile(join(root, "tsconfig.json"), "{}");
    const path = join(root, "a.ts");
    await writeFile(path, "const value = 1;\n");
    const slow = { ...fakeServer({ FAKE_LSP_NO_PULL: "1", FAKE_LSP_PUSH: "1", FAKE_LSP_INIT_DELAY_MS: "400" }), id: "slow" };
    const config = { ...defaultConfig(), servers: { slow } };
    const loaded = { config, generation: 1, userPath: join(root, "user.json"), warnings: [], trusted: true, authorized: true };
    const manager = new ClientManager(loaded);
    const runtime: SessionRuntime = { cwd: root, boundary: root, loaded, registry: new ServerRegistry(config.servers), roots: new RootDetector(1), manager, diagnostics: new DiagnosticService(), changed: new Set(), previewActions: new Set(), previewRenames: new Set() };
    const tool = toolFor(runtime);
    try {
      const first = await tool.execute("call", { paths: [path], mode: "paths", waitMs: 120 }, undefined, undefined, { cwd: root });
      expect(first.details.status).toBe("timed_out");
      expect(first.details.files[0].state).toBe("timed_out");
      // Timeout must not kill initialization; retry reuses the warming client.
      await waitUntil(() => manager.status().some((client) => client.state === "ready"));
      const second = await tool.execute("call", { paths: [path], mode: "paths", waitMs: 120 }, undefined, undefined, { cwd: root });
      expect(second.details.status).toBe("ok");
      expect(second.details.files[0].state).toBe("clean");
    } finally { await manager.shutdown(); }
  });

  it("leaves eviction headroom so a concurrent sync survives a push batch", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-diagnostic-headroom-"));
    await writeFile(join(root, "tsconfig.json"), "{}");
    const swept = [join(root, "a.ts"), join(root, "b.ts"), join(root, "c.ts")];
    const bystander = join(root, "z.ts");
    await Promise.all([...swept, bystander].map((path) => writeFile(path, "const value = 1;\n")));
    const pushOnly = { ...fakeServer({ FAKE_LSP_NO_PULL: "1" }), id: "push-only" };
    const base = defaultConfig();
    const config = { ...base, limits: { ...base.limits, maxOpenDocuments: 3 }, servers: { "push-only": pushOnly } };
    const loaded = { config, generation: 1, userPath: join(root, "user.json"), warnings: [], trusted: true, authorized: true };
    const manager = new ClientManager(loaded);
    const runtime: SessionRuntime = { cwd: root, boundary: root, loaded, registry: new ServerRegistry(config.servers), roots: new RootDetector(1), manager, diagnostics: new DiagnosticService(), changed: new Set(), previewActions: new Set(), previewRenames: new Set() };
    try {
      const sweep = toolFor(runtime).execute("call", { paths: swept, mode: "paths", waitMs: 1_500 }, undefined, undefined, { cwd: root });
      await waitUntil(() => manager.getActiveClients().length > 0);
      const client = manager.getActiveClients()[0]!;
      // Let the batch enter collection before starting the competing request.
      await waitUntil(() => client.status().openDocuments >= 2);
      await new Promise((resolve) => setTimeout(resolve, 150));
      // Reserved headroom lets competing calls proceed while the sweep pins documents.
      const started = Date.now();
      const snapshot = await client.documents!.sync(bystander);
      expect(Date.now() - started).toBeLessThan(400);
      expect(snapshot.canonicalPath).toBe(bystander);
      const result = await sweep;
      expect(result.details.files).toHaveLength(3);
    } finally { await manager.shutdown(); }
  });

  it("runs independent server groups concurrently while preserving result order", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-diagnostic-groups-"));
    await writeFile(join(root, "tsconfig.json"), "{}");
    const ts = join(root, "a.ts"); const foo = join(root, "b.foo");
    await writeFile(ts, "const value = 1;\n"); await writeFile(foo, "value\n");
    const log = join(root, "did-open.log");
    const common = { FAKE_LSP_PUSH: "1", FAKE_LSP_PUSH_DELAY_MS: "50", FAKE_LSP_DID_OPEN_LOG: log, FAKE_LSP_DID_OPEN_BARRIER_COUNT: "2" };
    const first = { ...fakeServer({ ...common, FAKE_LSP_INSTANCE: "first" }), id: "first", extensions: [".ts"], languageIds: { ".ts": "typescript" }, priority: 100 };
    const second = { ...fakeServer({ ...common, FAKE_LSP_INSTANCE: "second" }), id: "second", extensions: [".foo"], languageIds: { ".foo": "foo" }, priority: 100 };
    const config = { ...defaultConfig(), servers: { first, second } };
    const loaded = { config, generation: 1, userPath: join(root, "user.json"), warnings: [], trusted: true, authorized: true };
    const manager = new ClientManager(loaded);
    const runtime: SessionRuntime = { cwd: root, boundary: root, loaded, registry: new ServerRegistry(config.servers), roots: new RootDetector(1), manager, diagnostics: new DiagnosticService(), changed: new Set(), previewActions: new Set(), previewRenames: new Set() };
    try {
      const result = await toolFor(runtime).execute("call", { paths: [ts, foo], mode: "paths", waitMs: 1_500 }, undefined, undefined, { cwd: root });
      expect(result.details.status).toBe("ok");
      expect(result.details.servers.map((run: any) => run.server)).toEqual(["first", "second"]);
      const instances = (await readFile(log, "utf8")).trim().split("\n").map((line) => line.split(" ")[0]).sort();
      expect(instances).toEqual(["first", "second"]);
    } finally { await manager.shutdown(); }
  });
});
