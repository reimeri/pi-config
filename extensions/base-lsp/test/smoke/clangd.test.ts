import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_SERVERS } from "../../src/servers/catalog.js";
import { resolveServerCommand } from "../../src/servers/command.js";
import { LspClient } from "../../src/protocol/client.js";
import { DEFAULT_LIMITS } from "../../src/runtime/limits.js";

describe("clangd smoke", () => {
  it("initializes against a compile database and resolves a definition", async () => {
    const server = BUILTIN_SERVERS.clangd!; const command = await resolveServerCommand(server);
    if (!command) return;
    const root = await mkdtemp(join(tmpdir(), "base-lsp-clangd-")); const file = join(root, "main.cpp");
    await writeFile(file, "int square(int x) { return x * x; }\nint main() { return square(2); }\n");
    await writeFile(join(root, "compile_commands.json"), JSON.stringify([{ directory: root, command: "clang++ -std=c++20 -c main.cpp", file }]));
    const client = new LspClient(server, root, command, { ...DEFAULT_LIMITS, initializeTimeoutMs: 20_000, requestTimeoutMs: 20_000 });
    try {
      await client.start(); const snapshot = await client.documents!.sync(file);
      const result = await client.request<any>("textDocument/definition", { textDocument: { uri: snapshot.uri }, position: { line: 1, character: 22 } });
      expect(result).toBeTruthy(); expect(JSON.stringify(result)).toContain("main.cpp");
    } finally { await client.shutdown(); }
  }, 30_000);
});
