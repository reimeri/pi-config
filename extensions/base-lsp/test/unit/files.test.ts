import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverFiles, languageIdFor, matchesServerFile } from "../../src/workspace/files.js";
import { BUILTIN_SERVERS } from "../../src/servers/catalog.js";
import { fakeServer } from "../helpers/fake.js";

describe("server file matching", () => {
  const overlapping = () => ({ ...fakeServer(), extensions: [".ts", ".d.ts"], languageIds: { ".ts": "typescript", ".d.ts": "declarations" } });

  it("resolves the most specific extension, not the first listed", () => {
    // Pin ordering preserved by the per-definition cache.
    expect(languageIdFor(overlapping(), "/repo/types.d.ts")).toBe("declarations");
    expect(languageIdFor(overlapping(), "/repo/main.ts")).toBe("typescript");
    expect(languageIdFor({ ...overlapping(), extensions: [".d.ts", ".ts"] }, "/repo/types.d.ts")).toBe("declarations");
  });

  it("prefers an exact file name over any extension", () => {
    const server = { ...fakeServer(), extensions: [".rb"], filenames: ["Gemfile"], languageIds: { ".rb": "ruby", Gemfile: "gemfile" } };
    expect(matchesServerFile(server, "/repo/Gemfile")).toBe(true);
    expect(languageIdFor(server, "/repo/Gemfile")).toBe("gemfile");
  });

  it("keeps cached extension order separate per definition", () => {
    // Cache keys use definition identity, not only server ID.
    const wide = overlapping();
    const narrow = { ...overlapping(), extensions: [".ts"], languageIds: { ".ts": "typescript" } };
    expect(languageIdFor(wide, "/repo/types.d.ts")).toBe("declarations");
    expect(languageIdFor(narrow, "/repo/types.d.ts")).toBe("typescript");
    expect(languageIdFor(wide, "/repo/types.d.ts")).toBe("declarations");
  });

  it("sorts each server's extensions at most once, however many paths it sees", () => {
    // Assert sort reuse structurally instead of with flaky timing.
    const servers = Object.values(BUILTIN_SERVERS);
    const suffixes = [".ts", ".py", ".json", ".md", ".lock", ".png", ".txt", ".toml", ".snap", ""];
    const paths = Array.from({ length: 2_000 }, (_, index) => `/repo/src/pkg${index % 50}/file${index}${suffixes[index % suffixes.length]}`);
    const sort = vi.spyOn(Array.prototype, "sort");

    let matched = 0;
    for (const path of paths) if (servers.some((server) => matchesServerFile(server, path))) matched += 1;
    expect(matched).toBe(600);
    // Boolean matching does not require ordering.
    expect(sort).not.toHaveBeenCalled();

    for (const path of paths) for (const server of servers) languageIdFor(server, path);
    // Longest-match ordering is needed once per definition.
    expect(sort.mock.calls.length).toBeLessThanOrEqual(servers.length);
  });
});

describe("bounded file discovery", () => {
  it("never exceeds the global entry budget even in a wide directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-discovery-"));
    await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(root, `${String(index).padStart(3, "0")}.ts`), "export {};\n")));
    const result = await discoverFiles(root, root, [fakeServer()], [], 10, 100, 1024 * 1024);
    expect(result.entries).toBeLessThanOrEqual(10);
    expect(result.files.length).toBeLessThanOrEqual(10);
    expect(result.capped).toBe(true);
  });
});
