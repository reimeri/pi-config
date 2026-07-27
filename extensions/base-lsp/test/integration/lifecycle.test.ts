import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "../../src/extension.js";

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
function context(cwd: string, trusted: boolean, hasUI = true) {
  const statuses: Array<string | undefined> = []; const notifications: string[] = [];
  return {
    cwd, hasUI, mode: hasUI ? "tui" : "print", signal: undefined,
    isProjectTrusted: () => trusted,
    ui: { setStatus: (_key: string, value: string | undefined) => statuses.push(value), notify: (message: string) => notifications.push(message) },
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

  it("does not write command output directly into print/JSON streams", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-print-")); const { commands, handlers } = harness(); const ctx = context(root, true, false);
    await handlers.get("session_start")![0]({ reason: "startup" }, ctx);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try { await commands.get("lsp").handler("status typescript", ctx); expect(stderr).not.toHaveBeenCalled(); }
    finally { stderr.mockRestore(); await handlers.get("session_shutdown")![0]({ reason: "quit" }, ctx); }
  });
});
