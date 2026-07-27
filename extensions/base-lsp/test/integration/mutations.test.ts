import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientManager } from "../../src/runtime/client-manager.js";
import { defaultConfig } from "../../src/config/defaults.js";
import { ServerRegistry } from "../../src/servers/registry.js";
import { RootDetector } from "../../src/servers/roots.js";
import { DiagnosticService } from "../../src/protocol/diagnostics.js";
import { registerCodeActionsTool } from "../../src/tools/code-actions.js";
import { registerRenameTool } from "../../src/tools/rename.js";
import { fakeServer } from "../helpers/fake.js";
import type { SessionRuntime } from "../../src/tools/context.js";
import type { Route } from "../../src/servers/routing.js";

async function setup(env: Record<string, string> = {}, serverId = "fake") {
  const root = await mkdtemp(join(tmpdir(), "base-lsp-mutations-"));
  await writeFile(join(root, "tsconfig.json"), "{}");
  const a = join(root, "a.ts"); const b = join(root, "b.ts");
  await writeFile(a, "const ERROR = alpha;\n"); await writeFile(b, "console.log(alpha);\n");
  const server = { ...fakeServer(env), id: serverId };
  const config = { ...defaultConfig(), servers: { fake: server } };
  const loaded = { config, generation: 1, userPath: join(root, "user.json"), warnings: [], trusted: true, authorized: true };
  const manager = new ClientManager(loaded);
  const runtime: SessionRuntime = { cwd: root, boundary: root, loaded, registry: new ServerRegistry(config.servers), roots: new RootDetector(1), manager, diagnostics: new DiagnosticService(), changed: new Set(), previewActions: new Set(), previewRenames: new Set() };
  let codeActions: any; let rename: any;
  const pi = { registerTool(definition: any) { if (definition.name === "lsp_code_actions") codeActions = definition; else if (definition.name === "lsp_rename") rename = definition; } } as any;
  registerCodeActionsTool(pi, () => runtime); registerRenameTool(pi, () => runtime);
  return { root, a, b, server, manager, runtime, codeActions, rename };
}
async function execute(tool: any, params: Record<string, unknown>) { return tool.execute("call", params, undefined, undefined, { cwd: process.cwd() }); }

describe("code actions", () => {
  it("requires an actually rendered preview identity before apply", async () => {
    const { a, manager, runtime, codeActions } = await setup();
    try {
      const list = await execute(codeActions, { path: a, line: 1, symbol: "ERROR" });
      const actionId = list.details.actions[0].actionId;
      expect(list.details.actions[0].previewed).toBe(false);
      expect(runtime.previewActions.has(actionId)).toBe(false);
      await expect(execute(codeActions, { path: a, line: 1, symbol: "ERROR", apply: true, actionId })).rejects.toThrow(/not previewed/);
      const preview = await execute(codeActions, { path: a, line: 1, symbol: "ERROR", title: "Fix ERROR" });
      expect(preview.details.preview).toContain("-const ERROR");
      expect(preview.details.actions[0].previewed).toBe(true);
      const applied = await execute(codeActions, { path: a, line: 1, symbol: "ERROR", apply: true, actionId: preview.details.actionId });
      expect(applied.details.applied).toBe(true);
      expect(await readFile(a, "utf8")).toContain("const fixed");
    } finally { await manager.shutdown(); }
  });

  it("isolates malformed candidates instead of hiding valid actions", async () => {
    const { a, manager, codeActions } = await setup({ FAKE_LSP_ACTION_MODE: "mixed-malformed" });
    try {
      const result = await execute(codeActions, { path: a, line: 1, symbol: "ERROR" });
      expect(result.details.status).toBe("partial");
      expect(result.details.actions).toHaveLength(2);
      expect(result.details.actions[0]).toMatchObject({ title: "Fix ERROR", supported: true });
      expect(result.details.actions[1]).toMatchObject({ title: "Malformed fix", supported: false });
      expect(result.details.actions[1].normalizationError).toMatch(/UTF-16 character exceeds line length/);
    } finally { await manager.shutdown(); }
  });

  it("applies TypeScript edit actions whose wrapper command is provably redundant", async () => {
    const { a, manager, codeActions } = await setup({ FAKE_LSP_ACTION_MODE: "typescript-redundant", FAKE_LSP_SERVER_NAME: "typescript-language-server" }, "typescript");
    try {
      const preview = await execute(codeActions, { path: a, line: 1, symbol: "ERROR", title: "Fix ERROR" });
      expect(preview.details.actions[0]).toMatchObject({ supported: true, commandDisposition: "redundant", commandExecuted: false });
      const applied = await execute(codeActions, { path: a, line: 1, symbol: "ERROR", title: "Fix ERROR", actionId: preview.details.actionId, apply: true });
      expect(applied.details.applied).toBe(true);
      expect(await readFile(a, "utf8")).toContain("fixed");
    } finally { await manager.shutdown(); }
  });

  it("rejects TypeScript wrapper commands that contain nested commands", async () => {
    const { a, manager, codeActions } = await setup({ FAKE_LSP_ACTION_MODE: "typescript-nested", FAKE_LSP_SERVER_NAME: "typescript-language-server" }, "typescript");
    try {
      const result = await execute(codeActions, { path: a, line: 1, symbol: "ERROR", title: "Fix ERROR" });
      expect(result.details.actions[0]).toMatchObject({ supported: false, commandDisposition: "unsupported" });
      expect(result.details.actions[0].reason).toContain("nested commands");
    } finally { await manager.shutdown(); }
  });

  it("never applies command-only, edit-plus-command, formatting, or resource actions", async () => {
    for (const [mode, reason] of [["command", "Command-only"], ["both", "both edit and command"], ["format", "Formatting"], ["resource", "Resource operations"]] as const) {
      const { a, manager, codeActions, runtime } = await setup({ FAKE_LSP_ACTION_MODE: mode });
      try {
        const title = mode === "command" ? "Run unsafe command" : "Fix ERROR";
        const result = await execute(codeActions, { path: a, line: 1, symbol: "ERROR", title });
        expect(result.details.actions[0].supported).toBe(false);
        expect(result.details.actions[0].reason).toContain(reason);
        expect(runtime.previewActions.has(result.details.actionId)).toBe(false);
      } finally { await manager.shutdown(); }
    }
  });
});

describe("rename", () => {
  it("previews and identity-matches a complete multi-file rename before apply", async () => {
    const { root, a, b, server, manager, rename } = await setup();
    try {
      const route: Route = { server, root, resolution: { root, distance: 0, markerPriority: 0 }, specificity: 1 };
      const client = await manager.acquire(route); await client.documents!.sync(a); await client.documents!.sync(b);
      await expect(execute(rename, { path: a, line: 1, symbol: "alpha", newName: "beta", apply: true })).rejects.toThrow(/requires renameId/);
      const preview = await execute(rename, { path: a, line: 1, symbol: "alpha", newName: "beta" });
      expect(preview.details.files).toHaveLength(2); expect(preview.details.applicable).toBe(true);
      const applied = await execute(rename, { path: a, line: 1, symbol: "alpha", newName: "beta", apply: true, renameId: preview.details.renameId });
      expect(applied.details.applied).toBe(true);
      expect(await readFile(a, "utf8")).toContain("beta"); expect(await readFile(b, "utf8")).toContain("beta");
    } finally { await manager.shutdown(); }
  });

  it("converges on the complete edit when a warming server first answers with only the source file", async () => {
    const { root, a, b, server, manager, rename } = await setup({ FAKE_LSP_RENAME_WARMUP: "1" });
    try {
      const route: Route = { server, root, resolution: { root, distance: 0, markerPriority: 0 }, specificity: 1 };
      const client = await manager.acquire(route); await client.documents!.sync(a); await client.documents!.sync(b);
      const preview = await execute(rename, { path: a, line: 1, symbol: "alpha", newName: "beta" });
      // The first response covered a.ts alone; stability confirmation must discard it rather than
      // publish a half-finished rename, and settle on the complete two-file edit.
      expect(preview.details).toMatchObject({ stable: true, applicable: true, attempts: 3 });
      expect(preview.details.files).toHaveLength(2);
      const applied = await execute(rename, { path: a, line: 1, symbol: "alpha", newName: "beta", apply: true, renameId: preview.details.renameId });
      expect(applied.details.applied).toBe(true);
      expect(await readFile(a, "utf8")).toContain("beta");
      expect(await readFile(b, "utf8")).toContain("beta");
    } finally { await manager.shutdown(); }
  });

  it("refuses to bless a rename while the server keeps changing its answer", async () => {
    const { root, a, server, manager, runtime, rename } = await setup({ FAKE_LSP_RENAME_FLAP: "1" });
    try {
      const route: Route = { server, root, resolution: { root, distance: 0, markerPriority: 0 }, specificity: 1 };
      const client = await manager.acquire(route); await client.documents!.sync(a); await client.documents!.sync(join(root, "b.ts"));
      const preview = await execute(rename, { path: a, line: 1, symbol: "alpha", newName: "beta" });
      expect(preview.details).toMatchObject({ stable: false, applicable: false, status: "partial" });
      expect(preview.details.reasons.join(" ")).toMatch(/still changing/);
      expect(runtime.previewRenames.has(preview.details.renameId)).toBe(false);
      await expect(execute(rename, { path: a, line: 1, symbol: "alpha", newName: "beta", apply: true, renameId: preview.details.renameId })).rejects.toThrow(/not previewed/);
      expect(await readFile(a, "utf8")).toContain("alpha");
    } finally { await manager.shutdown(); }
  });

  it("rejects a stale preview identity after the server edit changes", async () => {
    const { a, b, manager, rename } = await setup();
    try {
      const preview = await execute(rename, { path: a, line: 1, symbol: "alpha", newName: "beta" });
      await writeFile(a, "const ERROR = alpha; console.log(alpha);\n");
      await expect(execute(rename, { path: a, line: 1, symbol: "alpha#1", newName: "beta", apply: true, renameId: preview.details.renameId })).rejects.toThrow(/does not match/);
    } finally { await manager.shutdown(); }
  });
});
