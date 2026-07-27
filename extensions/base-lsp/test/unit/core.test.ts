import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicToServerPosition, resolveSymbolPosition, serverToPublicPosition } from "../../src/protocol/positions.js";
import { deriveBoundary, resolveInputPath } from "../../src/workspace/boundary.js";
import { RootDetector } from "../../src/servers/roots.js";
import { routeFile } from "../../src/servers/routing.js";
import { BUILTIN_SERVERS } from "../../src/servers/catalog.js";
import { defaultConfig } from "../../src/config/defaults.js";
import { mergeConfig } from "../../src/config/loader.js";
import { validateConfigFile } from "../../src/config/schema.js";
import { isTypeScriptLanguageServer } from "../../src/servers/implementation.js";

async function temp(): Promise<string> { return mkdtemp(join(tmpdir(), "base-lsp-")); }

describe("positions", () => {
  const text = "a😀é\r\nsecond\n";
  it("converts UTF encodings without splitting code points", () => {
    expect(publicToServerPosition(text, 1, 4, "utf-8")).toEqual({ line: 0, character: 5 });
    expect(publicToServerPosition(text, 1, 4, "utf-32")).toEqual({ line: 0, character: 2 });
    expect(serverToPublicPosition(text, { line: 0, character: 5 }, "utf-8")).toEqual({ line: 1, character: 4 });
    expect(() => publicToServerPosition(text, 1, 3, "utf-16")).toThrow(/surrogate/);
  });
  it("resolves literal symbol occurrences", () => {
    expect(resolveSymbolPosition("foo foo", 1, "foo#2").character).toBe(5);
    expect(() => resolveSymbolPosition("foo foo", 1, "foo")).toThrow(/ambiguous/);
  });
});

describe("boundary, roots and routing", () => {
  it("uses nearest nested project marker and rejects symlink escape", async () => {
    const root = await temp(); await mkdir(join(root, ".git")); await mkdir(join(root, "packages", "a"), { recursive: true });
    await writeFile(join(root, "packages", "a", "tsconfig.json"), "{}"); const file = join(root, "packages", "a", "x.ts"); await writeFile(file, "export {}\n");
    const boundary = await deriveBoundary(join(root, "packages", "a")); expect(boundary.root).toBe(root);
    const detector = new RootDetector(1); const routed = await routeFile(file, root, [BUILTIN_SERVERS.typescript!], detector);
    expect(routed.primary?.root).toBe(join(root, "packages", "a"));
    const outside = await temp(); await writeFile(join(outside, "secret.ts"), ""); await symlink(join(outside, "secret.ts"), join(root, "escape.ts"));
    await expect(resolveInputPath("escape.ts", root, root)).rejects.toThrow(/outside/);
  });
});

describe("server implementation identity", () => {
  it("prefers explicit server information over command-name fallback", () => {
    const server = BUILTIN_SERVERS.typescript!;
    expect(isTypeScriptLanguageServer(server)).toBe(true);
    expect(isTypeScriptLanguageServer(server, { name: "typescript-language-server", version: "5" })).toBe(true);
    expect(isTypeScriptLanguageServer(server, { name: "different-server", version: "1" })).toBe(false);
  });
});

describe("configuration merge", () => {
  it("replaces arrays, deep merges objects, and clears null values", () => {
    const merged = mergeConfig(defaultConfig(), { ignore: ["generated/**"], serverOverrides: { typescript: { command: ["custom-ts", "--stdio"], diagnosticPolicy: { settleMs: 10 }, settings: null } } });
    expect(merged.ignore).toEqual(["generated/**"]); expect(merged.servers.typescript!.command[0]).toBe("custom-ts"); expect(merged.servers.typescript!.diagnosticPolicy?.settleMs).toBe(10); expect(merged.servers.typescript!.settings).toBeUndefined();
  });
  it("forbids project-level untrusted execution policy and malformed commands", () => {
    expect(() => validateConfigFile({ allowUntrustedProjects: true }, "project.json", false)).toThrow(/user config/);
    expect(() => validateConfigFile({ servers: { bad: { command: "shell source" } } }, "user.json", true)).toThrow(/non-empty string array/);
    expect(() => mergeConfig(defaultConfig(), { serverOverrides: { typescript: { diagnosticPolicy: { pushFirstMs: -1 } } } })).toThrow(/pushFirstMs/);
  });
});
