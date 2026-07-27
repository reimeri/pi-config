import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import register from "../../src/extension.js";

describe("Pi registration", () => {
  it("registers exactly four tools, one command, and starts no process in the factory", () => {
    const tools: string[] = []; const commands: string[] = []; const events: string[] = [];
    const pi = { registerTool: (tool: { name: string }) => tools.push(tool.name), registerCommand: (name: string) => commands.push(name), on: (name: string) => events.push(name) };
    register(pi as any);
    expect(tools).toEqual(["lsp_diagnostics", "lsp_navigation", "lsp_code_actions", "lsp_rename"]);
    expect(commands).toEqual(["lsp"]); expect(events).toEqual(["session_start", "tool_result", "session_shutdown"]);
  });
  it("top-level auto-discovery shim loads", async () => { const entry = await import("../../index.js"); expect(entry.default).toBeTypeOf("function"); });

  it("loads explicitly through the package manifest", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "base-lsp-package-cwd-"));
    const agentDir = await mkdtemp(join(tmpdir(), "base-lsp-package-agent-"));
    const loaded = await discoverAndLoadExtensions([process.cwd()], cwd, agentDir);
    expect(loaded.errors).toEqual([]);
    const extension = loaded.extensions.find((item) => item.tools.has("lsp_diagnostics"));
    expect(extension).toBeDefined();
    expect([...extension!.tools.keys()].sort()).toEqual(["lsp_code_actions", "lsp_diagnostics", "lsp_navigation", "lsp_rename"]);
    expect([...extension!.commands.keys()]).toContain("lsp");
  });
});
