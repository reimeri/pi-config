import { describe, expect, it } from "vitest";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ClientManager } from "../../src/runtime/client-manager.js";
import { defaultConfig } from "../../src/config/defaults.js";
import { ServerRegistry } from "../../src/servers/registry.js";
import { RootDetector } from "../../src/servers/roots.js";
import { DiagnosticService } from "../../src/protocol/diagnostics.js";
import { registerNavigationTool } from "../../src/tools/navigation.js";
import { fakeServer } from "../helpers/fake.js";
import type { SessionRuntime } from "../../src/tools/context.js";
import { normalizeLocations } from "../../src/protocol/locations.js";

async function setup(env: Record<string, string> = {}, serverId = "fake") {
  const root = await mkdtemp(join(tmpdir(), "base-lsp-navigation-"));
  await writeFile(join(root, "tsconfig.json"), "{}");
  const path = join(root, "a.ts");
  await writeFile(path, "const alpha = 1;\nconsole.log(alpha);\n");
  const server = { ...fakeServer(env), id: serverId };
  const config = { ...defaultConfig(), servers: { [serverId]: server } };
  const loaded = { config, generation: 1, userPath: join(root, "user.json"), warnings: [], trusted: true, authorized: true };
  const manager = new ClientManager(loaded);
  const runtime: SessionRuntime = { cwd: root, boundary: root, loaded, registry: new ServerRegistry(config.servers), roots: new RootDetector(1), manager, diagnostics: new DiagnosticService(), changed: new Set(), previewActions: new Set(), previewRenames: new Set() };
  let tool: any;
  registerNavigationTool({ registerTool(definition: any) { tool = definition; } } as any, () => runtime);
  return { root, path, manager, tool };
}

async function execute(tool: any, params: Record<string, unknown>) {
  return tool.execute("call", params, undefined, undefined, { cwd: process.cwd() });
}

describe("semantic navigation tool", () => {
  it("normalizes all position-based location operations and hover", async () => {
    const { path, manager, tool } = await setup();
    try {
      for (const operation of ["declaration", "definition", "type_definition", "implementation", "references"] as const) {
        const result = await execute(tool, { operation, path, line: 1, symbol: "alpha" });
        expect(result.details.status).toBe("ok");
        expect(result.details.locations[0].range.start.line).toBe(1);
        expect(result.details.locations[0].range.start.character).toBe(1);
        expect(result.details.locations[0].external).toBe(false);
      }
      const hover = await execute(tool, { operation: "hover", path, line: 1, symbol: "alpha" });
      expect(hover.details.hover).toContain("fake hover");
    } finally { await manager.shutdown(); }
  });

  it("explains TypeScript declaration capability gaps without silently falling back", async () => {
    const { path, manager, tool } = await setup({ FAKE_LSP_NO_DECLARATION: "1", FAKE_LSP_SERVER_NAME: "typescript-language-server" }, "typescript");
    try {
      const result = await execute(tool, { operation: "declaration", path, line: 1, symbol: "alpha" });
      expect(result.details).toMatchObject({ status: "unsupported", capabilityAdvertised: false, suggestedOperation: "definition", serverInfo: { name: "typescript-language-server", version: "1" } });
      expect(result.content[0].text).toContain("does not advertise declaration support");
    } finally { await manager.shutdown(); }
  });

  it("flattens hierarchical symbols, resolves workspace symbols, and handles calls", async () => {
    const { path, manager, tool } = await setup();
    try {
      const document = await execute(tool, { operation: "document_symbols", path });
      expect(document.details.symbols.map((item: any) => item.name)).toEqual(["outer", "inner"]);
      expect(document.details.total).toBe(2);
      const workspace = await execute(tool, { operation: "workspace_symbols", path, query: "alpha" });
      expect(workspace.details.symbols[0].location.range.start.line).toBe(1);
      for (const operation of ["incoming_calls", "outgoing_calls"] as const) {
        const calls = await execute(tool, { operation, path, line: 1, symbol: "alpha" });
        expect(calls.details.status).toBe("ok");
        expect(calls.details.calls[0].location.external).toBe(false);
      }
    } finally { await manager.shutdown(); }
  });
});

describe("location normalization", () => {
  it("preserves raw encoded positions for unreadable external targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-location-"));
    const result = await normalizeLocations({ uri: "zip://dependency/lib.ts", range: { start: { line: 2, character: 7 }, end: { line: 2, character: 9 } } }, root, root, "utf-8", 10);
    expect(result.locations[0]).toMatchObject({ external: true, rawRange: { start: { line: 2, character: 7 } }, range: { start: { line: 3 } }, positionEncoding: "utf-8" });
    expect(result.locations[0]!.range.start.character).toBeUndefined();
  });

  it("does not read an in-boundary symlink whose canonical target is external", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-location-root-"));
    const outside = join(await mkdtemp(join(tmpdir(), "base-lsp-location-outside-")), "secret.ts");
    await writeFile(outside, "const secret = '😀';\n");
    const link = join(root, "linked.ts"); await symlink(outside, link);
    const result = await normalizeLocations({ uri: pathToFileURL(link).href, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } } }, root, root, "utf-8", 10);
    expect(result.locations[0]).toMatchObject({ external: true, rawRange: { start: { line: 0, character: 6 } } });
    expect(result.locations[0]!.path).toBeUndefined();
    expect(result.locations[0]!.range.start.character).toBeUndefined();
  });
});
