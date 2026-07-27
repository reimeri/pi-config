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
