import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_SERVERS } from "../../src/servers/catalog.js";
import { resolveServerCommand } from "../../src/servers/command.js";
import { LspClient } from "../../src/protocol/client.js";
import { DEFAULT_LIMITS } from "../../src/runtime/limits.js";
import { normalizeWorkspaceEdit } from "../../src/workspace/edits.js";
import { applyManifest } from "../../src/workspace/transaction.js";
import type { WorkspaceEdit } from "../../src/protocol/types.js";
import { DiagnosticService } from "../../src/protocol/diagnostics.js";
import { ClientManager } from "../../src/runtime/client-manager.js";
import { defaultConfig } from "../../src/config/defaults.js";
import { ServerRegistry } from "../../src/servers/registry.js";
import { RootDetector } from "../../src/servers/roots.js";
import { registerCodeActionsTool } from "../../src/tools/code-actions.js";
import type { SessionRuntime } from "../../src/tools/context.js";

describe("typescript-language-server smoke", () => {
  it("initializes, reuses documents, and resolves a definition", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-ts-"));
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext" }, include: ["*.ts"] }));
    const a = join(root, "a.ts"); const b = join(root, "b.ts");
    await writeFile(a, "export const x = 42;\n"); await writeFile(b, "import { x } from './a.js';\nconsole.log(x);\n");
    const server = { ...BUILTIN_SERVERS.typescript!, initializationOptions: { tsserver: { path: join(process.cwd(), "node_modules", "typescript", "lib", "tsserver.js") } } }; const command = await resolveServerCommand(server); expect(command).toBeDefined();
    const client = new LspClient(server, root, command!, { ...DEFAULT_LIMITS, initializeTimeoutMs: 20_000, requestTimeoutMs: 20_000 });
    try {
      await client.start();
      const diagnostics = new DiagnosticService(); diagnostics.observe(client);
      await client.documents!.sync(a); const checkpoint = diagnostics.checkpoint(client); const snapshot = await client.documents!.sync(b);
      const clean = await diagnostics.check(client, snapshot, 10_000, true, undefined, checkpoint);
      expect(clean).toMatchObject({ state: "clean", confirmation: "post_open_server_policy" });
      const result = await client.request<any>("textDocument/definition", { textDocument: { uri: snapshot.uri }, position: { line: 1, character: 12 } });
      expect(result).toBeTruthy(); expect(JSON.stringify(result)).toContain("a.ts");
      expect(client.status().openDocuments).toBe(2);
    } finally { await client.shutdown(); }
  }, 30_000);

  it("keeps valid TypeScript quick fixes when a sibling edit is malformed and omits a redundant command", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-ts-actions-"));
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext", typeRoots: [join(process.cwd(), "node_modules", "@types")], types: ["node"] }, include: ["*.ts"] }));
    const file = join(root, "action.ts");
    await writeFile(file, "export function loadPackage(): string {\n\treturn readFileSync(\"package.json\", \"utf8\");\n}\n");
    const server = { ...BUILTIN_SERVERS.typescript!, initializationOptions: { tsserver: { path: join(process.cwd(), "node_modules", "typescript", "lib", "tsserver.js") } } };
    const config = { ...defaultConfig(), servers: { typescript: server } };
    const loaded = { config, generation: 1, userPath: join(root, "user.json"), warnings: [], trusted: true, authorized: true };
    const manager = new ClientManager(loaded);
    const runtime: SessionRuntime = { cwd: root, boundary: root, loaded, registry: new ServerRegistry(config.servers), roots: new RootDetector(1), manager, diagnostics: new DiagnosticService(), changed: new Set(), previewActions: new Set(), previewRenames: new Set() };
    let tool: any;
    registerCodeActionsTool({ registerTool(definition: any) { tool = definition; } } as any, () => runtime);
    try {
      const list = await tool.execute("call", { path: file, line: 2, symbol: "readFileSync" }, undefined, undefined, { cwd: root });
      const importAction = list.details.actions.find((action: any) => action.title.startsWith("Add import"));
      expect(importAction).toMatchObject({ supported: true, commandDisposition: "redundant", commandExecuted: false });
      expect(list.details.actions.some((action: any) => action.normalizationError?.includes("UTF-16 character exceeds line length"))).toBe(true);

      const preview = await tool.execute("call", { path: file, line: 2, symbol: "readFileSync", title: importAction.title }, undefined, undefined, { cwd: root });
      expect(preview.details).toMatchObject({ applicable: true, commandDisposition: "redundant", commandExecuted: false });
      const applied = await tool.execute("call", { path: file, line: 2, symbol: "readFileSync", title: importAction.title, actionId: preview.details.actionId, apply: true }, undefined, undefined, { cwd: root });
      expect(applied.details.applied).toBe(true);
      expect(await readFile(file, "utf8")).toMatch(/import \{ readFileSync \} from ["'](?:node:)?fs["']/);
    } finally { await manager.shutdown(); }
  }, 30_000);

  it("produces and safely applies a real multi-file rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-ts-rename-"));
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext" }, include: ["*.ts"] }));
    const a = join(root, "a.ts"); const b = join(root, "b.ts");
    await writeFile(a, "export const thing = 42;\n"); await writeFile(b, "import { thing } from './a.js';\nconsole.log(thing);\n");
    const server = { ...BUILTIN_SERVERS.typescript!, initializationOptions: { tsserver: { path: join(process.cwd(), "node_modules", "typescript", "lib", "tsserver.js") } } };
    const command = await resolveServerCommand(server); expect(command).toBeDefined();
    const client = new LspClient(server, root, command!, { ...DEFAULT_LIMITS, initializeTimeoutMs: 20_000, requestTimeoutMs: 20_000 });
    try {
      await client.start(); const source = await client.documents!.sync(a); await client.documents!.sync(b);
      const edit = await client.request<WorkspaceEdit>("textDocument/rename", { textDocument: { uri: source.uri }, position: { line: 0, character: 13 }, newName: "renamedThing" });
      const versions = new Map(client.documents!.list().map((document) => [document.uri, document.version] as const));
      const manifest = await normalizeWorkspaceEdit(edit, root, client.capabilities!.positionEncoding, DEFAULT_LIMITS, versions);
      expect(manifest.applicable).toBe(true); expect(manifest.files).toHaveLength(2);
      await applyManifest(manifest);
      expect(await readFile(a, "utf8")).toContain("renamedThing"); expect(await readFile(b, "utf8")).toContain("renamedThing");
    } finally { await client.shutdown(); }
  }, 30_000);
});
