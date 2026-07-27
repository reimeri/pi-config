import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "../../src/extension.js";
import { RootDetector } from "../../src/servers/roots.js";

function harness() {
  const tools = new Map<string, any>(); const commands = new Map<string, any>(); const handlers = new Map<string, any[]>();
  const pi = {
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    on(name: string, handler: any) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
  };
  register(pi as any);
  return { tools, commands, handlers };
}
function context(cwd: string, trusted: boolean, mode: "tui" | "rpc" | "print" = "tui") {
  const statuses: Array<string | undefined> = []; const notifications: string[] = [];
  const hasUI = mode !== "print";
  return {
    cwd, hasUI, mode, signal: undefined,
    isProjectTrusted: () => trusted,
    ui: {
      theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      notify: (message: string) => notifications.push(message),
    },
    statuses, notifications,
  };
}

describe("Pi lifecycle integration", () => {
  it("starts no server at session startup, reports trust denial, and clears status", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-lifecycle-")); await mkdir(join(root, ".git")); const file = join(root, "a.ts"); await writeFile(file, "const x = 1;\n");
    const { tools, handlers } = harness(); const ctx = context(root, false);
    await handlers.get("session_start")![0]({ reason: "startup" }, ctx);
    const result = await tools.get("lsp_diagnostics").execute("call", { paths: [file] }, undefined, undefined, ctx);
    expect(result.details.status).toBe("untrusted");
    expect(ctx.statuses).toContain("LSP: diagnostics"); expect(ctx.statuses.at(-1)).toBeUndefined();
    await handlers.get("session_shutdown")![0]({ reason: "quit" }, ctx);
    expect(ctx.statuses.at(-1)).toBeUndefined();
  });

  it("renders installed servers brighter than missing servers in TUI status", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-status-"));
    await mkdir(join(root, ".git")); await mkdir(join(root, ".pi"));
    await writeFile(join(root, ".pi", "base-lsp.json"), JSON.stringify({ serverOverrides: {
      typescript: { command: [process.execPath] },
      deno: { command: [join(root, "missing-language-server")] },
    } }));
    const { commands, handlers } = harness(); const ctx = context(root, true);
    await handlers.get("session_start")![0]({ reason: "startup" }, ctx);
    try {
      await commands.get("lsp").handler("status", ctx);
      expect(ctx.notifications[0]).toMatch(/<text>typescript: available \(idle\).*<\/text>/);
      expect(ctx.notifications[0]).toMatch(/<dim>deno: missing.*<\/dim>/);

      const rpcCtx = context(root, true, "rpc");
      await commands.get("lsp").handler("status typescript", rpcCtx);
      expect(rpcCtx.notifications[0]).toMatch(/^typescript: available \(idle\)/);
      expect(rpcCtx.notifications[0]).not.toContain("<text>");
    } finally { await handlers.get("session_shutdown")![0]({ reason: "quit" }, ctx); }
  });

  it("invalidates the lexical parent when a marker-named symlink is written", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-symlink-marker-"));
    const project = join(root, "project"); const targets = join(root, "targets");
    await mkdir(project); await mkdir(targets); await mkdir(join(root, ".git"));
    const marker = join(project, "deno.json");
    await symlink(join(targets, "configuration"), marker);
    const { handlers } = harness(); const ctx = context(root, true);
    await handlers.get("session_start")![0]({ reason: "startup" }, ctx);
    const invalidation = vi.spyOn(RootDetector.prototype, "invalidateUnder");
    try {
      await writeFile(marker, "{}\n");
      await handlers.get("tool_result")![0]({ toolName: "write", toolCallId: "write-marker", input: { path: marker }, content: [], details: undefined, isError: false }, ctx);
      expect(invalidation).toHaveBeenCalledWith(project);
    } finally {
      invalidation.mockRestore();
      await handlers.get("session_shutdown")![0]({ reason: "quit" }, ctx);
    }
  });

  it("does not write command output directly into print/JSON streams", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-print-")); const { commands, handlers } = harness(); const ctx = context(root, true, "print");
    await handlers.get("session_start")![0]({ reason: "startup" }, ctx);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try { await commands.get("lsp").handler("status typescript", ctx); expect(stderr).not.toHaveBeenCalled(); }
    finally { stderr.mockRestore(); await handlers.get("session_shutdown")![0]({ reason: "quit" }, ctx); }
  });
});
