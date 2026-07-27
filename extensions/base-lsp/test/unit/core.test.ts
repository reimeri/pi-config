import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lineTableStats, offsetsToServerRange, publicToServerPosition, resolveSymbolPosition, serverToPublicPosition } from "../../src/protocol/positions.js";
import { deriveBoundary, resolveInputPath } from "../../src/workspace/boundary.js";
import { RootDetector } from "../../src/servers/roots.js";
import { routeFile } from "../../src/servers/routing.js";
import { BUILTIN_SERVERS } from "../../src/servers/catalog.js";
import { defaultConfig } from "../../src/config/defaults.js";
import { mergeConfig } from "../../src/config/loader.js";
import { validateConfigFile } from "../../src/config/schema.js";
import { isTypeScriptLanguageServer } from "../../src/servers/implementation.js";
import { normalizeCapabilities } from "../../src/protocol/types.js";
import { chunkBudgetMs, pushChunkSize } from "../../src/tools/diagnostics.js";
import { DEFAULT_LIMITS } from "../../src/runtime/limits.js";

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

  it("keeps line lookup independent of document size across mixed newline styles", () => {
    const mixed = "alpha\r\nbeta\ngamma\r\n\ndelta";
    expect(publicToServerPosition(mixed, 3, 1, "utf-16")).toEqual({ line: 2, character: 0 });
    expect(publicToServerPosition(mixed, 4, 1, "utf-16")).toEqual({ line: 3, character: 0 });
    expect(publicToServerPosition(mixed, 5, 6, "utf-16")).toEqual({ line: 4, character: 5 });
    expect(() => publicToServerPosition(mixed, 6, 1, "utf-16")).toThrow(/exceeds document length/);
    expect(offsetsToServerRange(mixed, 0, mixed.length, "utf-16")).toEqual({ start: { line: 0, character: 0 }, end: { line: 4, character: 5 } });
    expect(offsetsToServerRange(mixed, 7, 11, "utf-16")).toEqual({ start: { line: 1, character: 0 }, end: { line: 1, character: 4 } });

    // Converting many positions against one document must not rescan it every time. Without a
    // memoized line table this is O(document) per call and costs seconds on a large file. Assert
    // the memo structurally rather than on wall-clock time, which flakes on a loaded machine.
    const large = "const someIdentifier = someValue + otherValue; // filler\n".repeat(30_000);
    const before = lineTableStats().builds;
    for (let index = 0; index < 400; index += 1) serverToPublicPosition(large, { line: index * 70, character: 6 }, "utf-16");
    expect(lineTableStats().builds - before).toBe(1);
    expect(serverToPublicPosition(large, { line: 29_999, character: 6 }, "utf-16")).toEqual({ line: 30_000, character: 7 });
  });

  it("charges the line-table memo for line offsets, not just text length", () => {
    // A file of many short lines costs far more in offsets than in characters; a budget that
    // counted only text length would understate what the cache retains by several times.
    const shortLines = "ab\n".repeat(20_000);
    const before = lineTableStats();
    serverToPublicPosition(shortLines, { line: 0, character: 0 }, "utf-16");
    const after = lineTableStats();
    expect(after.builds - before.builds).toBe(1);
    expect(after.cost - before.cost).toBeGreaterThan(shortLines.length * 2);
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

describe("push diagnostic chunk scheduling", () => {
  it("keeps a default-sized sweep in one chunk while reserving eviction headroom", () => {
    // The batching win depends on a default sweep opening every file at once: if this ever splits
    // into chunks, clean-settling waits start multiplying by chunk count again.
    expect(pushChunkSize(DEFAULT_LIMITS.maxOpenDocuments)).toBeGreaterThanOrEqual(DEFAULT_LIMITS.maxFiles);
    expect(pushChunkSize(DEFAULT_LIMITS.maxOpenDocuments)).toBeLessThan(DEFAULT_LIMITS.maxOpenDocuments);
    expect(pushChunkSize(1)).toBe(1);
    expect(pushChunkSize(3)).toBe(2);
  });

  it("gives a single chunk the whole deadline and splits it fairly otherwise", () => {
    expect(chunkBudgetMs(1_000, 50, 100)).toBe(1_000);
    expect(chunkBudgetMs(1_000, 100, 100)).toBe(1_000);
    expect(chunkBudgetMs(1_000, 300, 100)).toBe(333);
    expect(chunkBudgetMs(1_000, 101, 100)).toBe(500);
    expect(chunkBudgetMs(0, 300, 100)).toBe(1);
  });
});

describe("capability normalization", () => {
  it("retains only string execute commands from a valid array", () => {
    expect(normalizeCapabilities({ executeCommandProvider: { commands: ["typescript.tsserverRequest", 42 as any] } }).executeCommands).toEqual(["typescript.tsserverRequest"]);
    expect(normalizeCapabilities({ executeCommandProvider: { commands: null as any } }).executeCommands).toEqual([]);
    expect(normalizeCapabilities({ executeCommandProvider: { commands: "not-an-array" as any } }).executeCommands).toEqual([]);
    expect(normalizeCapabilities({}).executeCommands).toEqual([]);
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
