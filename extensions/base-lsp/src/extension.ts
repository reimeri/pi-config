import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isEditToolResult, isWriteToolResult } from "@earendil-works/pi-coding-agent";
import { deriveBoundary, resolveInputPathDetails } from "./workspace/boundary.js";
import { loadConfig, redactConfig } from "./config/loader.js";
import { ServerRegistry } from "./servers/registry.js";
import { RootDetector, isRootMarkerName } from "./servers/roots.js";
import { fileNameOf } from "./workspace/files.js";
import { ClientManager } from "./runtime/client-manager.js";
import { DiagnosticService } from "./protocol/diagnostics.js";
import type { SessionRuntime } from "./tools/context.js";
import { registerDiagnosticsTool } from "./tools/diagnostics.js";
import { registerNavigationTool } from "./tools/navigation.js";
import { registerCodeActionsTool } from "./tools/code-actions.js";
import { registerRenameTool } from "./tools/rename.js";
import { resolveExecutable } from "./servers/command.js";
import { sanitizeText, stripLeadingAt } from "./util/text.js";

export default function registerBaseLsp(pi: ExtensionAPI): void {
  let runtime: SessionRuntime | undefined;
  const getRuntime = (): SessionRuntime => { if (!runtime) throw new Error("base-lsp session has not started"); return runtime; };

  const toolApi = withLspStatus(pi);
  registerDiagnosticsTool(toolApi, getRuntime);
  registerNavigationTool(toolApi, getRuntime);
  registerCodeActionsTool(toolApi, getRuntime);
  registerRenameTool(toolApi, getRuntime);

  pi.registerCommand("lsp", {
    description: "Show, restart, stop, or inspect base-lsp configuration",
    handler: async (args, ctx) => {
      const current = runtime;
      if (!current) { notify(ctx, "base-lsp is not initialized", "warning"); return; }
      const [operation = "status", server] = args.trim().split(/\s+/);
      if (operation === "restart") { const count = await current.manager.restart(server); notify(ctx, `Stopped ${count} client(s); they will restart lazily.`, "info"); return; }
      if (operation === "stop") { const count = await current.manager.stop(server); notify(ctx, `Stopped ${count} client(s).`, "info"); return; }
      if (operation === "config") { notify(ctx, sanitizeText(JSON.stringify({ userPath: current.loaded.userPath, projectPath: current.loaded.projectPath, warnings: current.loaded.warnings, effective: redactConfig(current.loaded.config) }, null, 2), 30_000), "info"); return; }
      if (operation !== "status" && operation !== "") { notify(ctx, "Usage: /lsp [status [server]|restart [server]|stop [server]|config]", "warning"); return; }
      const active = current.manager.status().filter((item) => !server || item.server === server);
      const definitions = current.registry.list().filter((item) => !server || item.id === server);
      const lines = await Promise.all(definitions.map(async (definition) => {
        const client = active.find((item) => item.server === definition.id);
        const available = await resolveExecutable(definition.command[0]!);
        const serverInfo = client?.serverInfo ? ` server=${client.serverInfo.name}${client.serverInfo.version ? `@${client.serverInfo.version}` : ""}` : "";
        const capabilities = client?.capabilities ? ` capabilities=${enabledCapabilities(client.capabilities).join(",") || "none"}` : "";
        const line = `${definition.id}: ${client?.state ?? (available ? "available (idle)" : "missing")} command=${definition.command.join(" ")}${client ? ` root=${client.root}` : ""}${serverInfo}${capabilities}${!available && definition.installationHint ? `; ${definition.installationHint}` : ""}`;
        return ctx.mode === "tui" ? ctx.ui.theme.fg(available ? "text" : "dim", line) : line;
      }));
      notify(ctx, lines.join("\n"), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (runtime) await runtime.manager.shutdown();
    const boundary = await deriveBoundary(ctx.cwd);
    const loaded = await loadConfig(ctx.cwd, boundary.root, ctx.isProjectTrusted());
    runtime = { cwd: ctx.cwd, boundary: boundary.root, loaded, registry: new ServerRegistry(loaded.config.servers), roots: new RootDetector(loaded.generation), manager: new ClientManager(loaded), diagnostics: new DiagnosticService(loaded.config.limits.maxDiagnostics), changed: new Set(), previewActions: new Set(), previewRenames: new Set() };
    if (ctx.hasUI) { ctx.ui.setStatus("base-lsp", undefined); for (const warning of loaded.warnings.slice(0, 3)) ctx.ui.notify(`base-lsp: ${sanitizeText(warning, 500)}`, "warning"); }
  });
  pi.on("tool_result", async (event, ctx) => {
    const current = runtime;
    if (!current || event.isError !== false || (!isWriteToolResult(event) && !isEditToolResult(event))) return;
    const input = event.input as { path?: unknown }; if (typeof input.path !== "string") return;
    try {
      const path = await resolveInputPathDetails(stripLeadingAt(input.path), ctx.cwd, current.boundary);
      if (runtime !== current) return;
      current.changed.add(path.canonical);
      // Match the name and parent through which the tool wrote. The canonical file may be the
      // target of a marker-named symlink and therefore have a completely different name and parent.
      if (path.lexicalDirectory && isRootMarkerName(current.registry.enabled(), fileNameOf(path.lexical))) current.roots.invalidateUnder(path.lexicalDirectory);
      await current.manager.syncActiveFile(path.canonical, ctx.signal, true);
    } catch { /* mutation outside the active boundary or removed file */ }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("base-lsp", undefined);
    const current = runtime; runtime = undefined; await current?.manager.shutdown();
  });
}

function withLspStatus(pi: ExtensionAPI): ExtensionAPI {
  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property !== "registerTool") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (definition: any) => {
        const execute = definition.execute;
        target.registerTool({
          ...definition,
          async execute(...args: any[]) {
            const ctx = args[4] as ExtensionContext | undefined;
            if (ctx?.hasUI) ctx.ui.setStatus("base-lsp", `LSP: ${String(definition.name).replace(/^lsp_/, "")}`);
            try { return await execute.apply(definition, args); }
            finally { if (ctx?.hasUI) ctx.ui.setStatus("base-lsp", undefined); }
          },
        });
      };
    },
  }) as ExtensionAPI;
}
function enabledCapabilities(capabilities: NonNullable<ReturnType<ClientManager["status"]>[number]["capabilities"]>): string[] {
  const names: string[] = [];
  if (capabilities.diagnostics.pull) names.push("diagnostic-pull");
  if (capabilities.diagnostics.workspace) names.push("diagnostic-workspace");
  for (const key of ["declaration", "definition", "typeDefinition", "implementation", "references", "hover", "documentSymbols", "workspaceSymbols", "callHierarchy", "codeActions", "rename"] as const) if (capabilities[key]) names.push(key);
  return names;
}
function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void { if (ctx.hasUI) ctx.ui.notify(message, level); }
