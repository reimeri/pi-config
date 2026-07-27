import { join } from "node:path";
import type { ServerDefinition } from "../../src/config/schema.js";
import { LspClient } from "../../src/protocol/client.js";
import { DEFAULT_LIMITS } from "../../src/runtime/limits.js";
import { resolveServerCommand } from "../../src/servers/command.js";

export function fakeServer(env: Record<string, string> = {}): ServerDefinition {
  return {
    id: "fake",
    displayName: "Fake LSP",
    enabled: true,
    command: [process.execPath, join(process.cwd(), "test", "fixtures", "lsp-server.mjs")],
    env,
    extensions: [".ts"],
    languageIds: { ".ts": "typescript" },
    role: "primary",
    priority: 100,
    rootMarkers: ["tsconfig.json"],
    rootFallback: "workspace",
  };
}

export async function fakeClient(root: string, env: Record<string, string> = {}): Promise<LspClient> {
  const server = fakeServer(env);
  const command = await resolveServerCommand(server);
  if (!command) throw new Error("Unable to resolve fake server command");
  return new LspClient(server, root, command, { ...DEFAULT_LIMITS, initializeTimeoutMs: 3_000, requestTimeoutMs: 2_000, shutdownTimeoutMs: 100 });
}
