import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RootDetector, isRootMarkerName } from "../../src/servers/roots.js";
import { resolveInputPathDetails } from "../../src/workspace/boundary.js";
import { fileNameOf } from "../../src/workspace/files.js";
import type { RootMarker, ServerDefinition } from "../../src/config/schema.js";

function server(overrides: Partial<ServerDefinition> = {}): ServerDefinition {
  return {
    id: "probe", displayName: "Probe", enabled: true, command: ["probe"], extensions: [".ts"],
    languageIds: { ".ts": "typescript" }, role: "primary", priority: 50,
    rootMarkers: ["deno.json", "deno.jsonc", { glob: "*.sln" }], rootFallback: "none", ...overrides,
  };
}

/** A workspace whose leaf is several levels below the boundary, with no marker anywhere. */
async function workspace(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "base-lsp-roots-"));
  const leaf = join(root, "a", "b", "c", "d");
  await mkdir(leaf, { recursive: true });
  const file = join(leaf, "module.ts");
  await writeFile(file, "export {};\n");
  return { root, file };
}

describe("root detection caching", () => {
  it("serves a repeated rootless answer without re-walking the ancestors", async () => {
    // A repeated search constructs a fresh result object, while a cache hit returns the original.
    // Freeze the expiry clock so this assertion is independent of machine and filesystem speed.
    const { root, file } = await workspace();
    const detector = new RootDetector(1, () => 1_000_000);
    const definition = server();

    const first = await detector.find(definition, file, root);
    expect(first.root).toBeUndefined();
    for (let i = 0; i < 50; i += 1) expect(await detector.find(definition, file, root)).toBe(first);

    await rm(root, { recursive: true, force: true });
  });

  it("notices a marker created after the rootless answer was cached", async () => {
    // The reason a miss is not cached outright: creating deno.json must start routing files to the
    // server without waiting for a config reload. The clock is injected so the window is exact.
    const { root, file } = await workspace();
    let now = 1_000_000;
    const detector = new RootDetector(1, () => now);
    const definition = server();

    expect((await detector.find(definition, file, root)).root).toBeUndefined();
    await writeFile(join(root, "a", "deno.json"), "{}\n");

    // Still inside the window, so the cached miss stands.
    now += 4_999;
    expect((await detector.find(definition, file, root)).root).toBeUndefined();

    now += 2;
    expect((await detector.find(definition, file, root)).root).toBe(join(root, "a"));
    await rm(root, { recursive: true, force: true });
  });

  it("expires a fallback root, which named a directory without matching a marker", async () => {
    // `workspace` and `file-directory` answers carry a root but found nothing, so they have to age
    // out like any other markerless answer — otherwise most of the catalog stays rooted at the
    // boundary for the session even after a marker shows up nearer the file.
    const { root, file } = await workspace();
    let now = 1_000_000;
    const detector = new RootDetector(1, () => now);
    const definition = server({ rootFallback: "workspace" });

    expect((await detector.find(definition, file, root)).fallback).toBe("workspace");
    await writeFile(join(root, "a", "b", "deno.json"), "{}\n");

    now += 5_001;
    const resolution = await detector.find(definition, file, root);
    expect(resolution.root).toBe(join(root, "a", "b"));
    expect(resolution.fallback).toBeUndefined();
    await rm(root, { recursive: true, force: true });
  });

  it("keeps a resolved root cached indefinitely", async () => {
    const { root, file } = await workspace();
    let now = 1_000_000;
    const detector = new RootDetector(1, () => now);
    const marker = join(root, "a", "b", "deno.json");
    await writeFile(marker, "{}\n");
    const definition = server();

    expect((await detector.find(definition, file, root)).root).toBe(join(root, "a", "b"));
    // Removing the marker is what distinguishes a retained answer from a repeated walk: only a
    // cache that never expires positives can still name a directory whose marker is gone.
    await rm(marker);
    now += 10 * 60 * 1_000;
    expect((await detector.find(definition, file, root)).root).toBe(join(root, "a", "b"));
    await rm(root, { recursive: true, force: true });
  });

  it("sees a marker straight away once the write that created it is announced", async () => {
    // The window exists for markers nobody tells us about. A marker the agent writes itself is
    // announced, and waiting out the window there would report "no server" for a project the very
    // same turn just created.
    const { root, file } = await workspace();
    let now = 1_000_000;
    const detector = new RootDetector(1, () => now);
    const definition = server();

    expect((await detector.find(definition, file, root)).root).toBeUndefined();
    const marker = join(root, "a", "deno.json");
    await writeFile(marker, "{}\n");
    detector.invalidateUnder(dirname(marker));

    expect((await detector.find(definition, file, root)).root).toBe(join(root, "a"));
    await rm(root, { recursive: true, force: true });
  });

  it("retries a search invalidated while it is in flight", async () => {
    const { root, file } = await workspace();
    const leaf = dirname(file);
    let releaseAncestor!: () => void;
    let announceAncestor!: () => void;
    const ancestorReached = new Promise<void>((resolve) => { announceAncestor = resolve; });
    const ancestorReleased = new Promise<void>((resolve) => { releaseAncestor = resolve; });
    let firstWalk = true;
    const probe = async (directory: string, marker: RootMarker): Promise<boolean> => {
      if (firstWalk && directory === leaf) return false;
      if (firstWalk) {
        firstWalk = false;
        announceAncestor();
        await ancestorReleased;
        return false;
      }
      try { await stat(join(directory, typeof marker === "string" ? marker : marker.glob)); return true; } catch { return false; }
    };
    const detector = new RootDetector(1, Date.now, probe);
    const definition = server({ rootMarkers: ["deno.json"] });

    const pending = detector.find(definition, file, root);
    await ancestorReached;
    await writeFile(join(leaf, "deno.json"), "{}\n");
    detector.invalidateUnder(leaf);
    releaseAncestor();

    expect((await pending).root).toBe(leaf);
    await rm(root, { recursive: true, force: true });
  });

  it("does not retry an unrelated in-flight search", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-roots-parallel-"));
    const left = join(root, "left"); const right = join(root, "right");
    await mkdir(left); await mkdir(right);
    const leftFile = join(left, "module.ts"); const rightFile = join(right, "module.ts");
    await writeFile(leftFile, "export {};\n"); await writeFile(rightFile, "export {};\n");
    const leafVisits = new Map<string, number>();
    let blocked = 0; let announceBlocked!: () => void; let release!: () => void;
    const bothBlocked = new Promise<void>((resolve) => { announceBlocked = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const probe = async (directory: string): Promise<boolean> => {
      if (directory === left || directory === right) {
        const visits = (leafVisits.get(directory) ?? 0) + 1;
        leafVisits.set(directory, visits);
        if (visits === 1) {
          blocked += 1;
          if (blocked === 2) announceBlocked();
          await released;
        }
      }
      return false;
    };
    const detector = new RootDetector(1, Date.now, probe);
    const definition = server({ rootMarkers: ["deno.json"] });

    const leftResult = detector.find(definition, leftFile, root);
    const rightResult = detector.find(definition, rightFile, root);
    await bothBlocked;
    detector.invalidateUnder(left);
    release();
    await Promise.all([leftResult, rightResult]);

    expect(leafVisits.get(left)).toBe(2);
    expect(leafVisits.get(right)).toBe(1);
    await rm(root, { recursive: true, force: true });
  });

  it("invalidates by the lexical parent of a marker-named symlink", async () => {
    const { root, file } = await workspace();
    const project = dirname(file);
    const targetDirectory = join(root, "targets");
    const target = join(targetDirectory, "configuration");
    await mkdir(targetDirectory);
    await symlink(target, join(project, "deno.json"));
    await mkdir(join(root, ".git"));
    const definition = server({ rootMarkers: ["deno.json", ".git"] });
    const detector = new RootDetector(1);

    expect((await detector.find(definition, file, root)).root).toBe(root);
    await writeFile(join(project, "deno.json"), "{}\n");
    const path = await resolveInputPathDetails(join(project, "deno.json"), root, root);
    expect(path).toMatchObject({ canonical: target, lexical: join(project, "deno.json"), lexicalDirectory: project });
    expect(isRootMarkerName([definition], fileNameOf(path.lexical))).toBe(true);
    detector.invalidateUnder(path.lexicalDirectory!);

    expect((await detector.find(definition, file, root)).root).toBe(project);
    await rm(root, { recursive: true, force: true });
  });

  it("leaves answers resolved outside the invalidated subtree alone", async () => {
    // Only the walks that could climb through the written directory can change, and a write is
    // frequent enough that clearing wholesale would undo the caching this exists for.
    const { root, file } = await workspace();
    let now = 1_000_000;
    const detector = new RootDetector(1, () => now);
    const marker = join(root, "a", "b", "deno.json");
    await writeFile(marker, "{}\n");
    const definition = server();

    expect((await detector.find(definition, file, root)).root).toBe(join(root, "a", "b"));
    await rm(marker);
    // A sibling subtree of the cached answer's start directory: nothing it resolved can be affected.
    await mkdir(join(root, "elsewhere"), { recursive: true });
    detector.invalidateUnder(join(root, "elsewhere"));

    now += 10 * 60 * 1_000;
    expect((await detector.find(definition, file, root)).root).toBe(join(root, "a", "b"));
    await rm(root, { recursive: true, force: true });
  });

  it("recognises the file names that can create a root", async () => {
    const definitions = [server(), server({ id: "other", rootMarkers: ["package.json"] })];
    expect(isRootMarkerName(definitions, "deno.json")).toBe(true);
    expect(isRootMarkerName(definitions, "App.sln")).toBe(true);
    expect(isRootMarkerName(definitions, "package.json")).toBe(true);
    expect(isRootMarkerName(definitions, "module.ts")).toBe(false);
    expect(isRootMarkerName(definitions, "denoXjson")).toBe(false);
  });

  it("drops every cached answer when the generation changes", async () => {
    const { root, file } = await workspace();
    const detector = new RootDetector(1);
    const definition = server();
    expect((await detector.find(definition, file, root)).root).toBeUndefined();
    await writeFile(join(root, "deno.json"), "{}\n");
    detector.clear();
    expect((await detector.find(definition, file, root)).root).toBe(root);
    await rm(root, { recursive: true, force: true });
  });

  it("resolves glob markers and reports the matched marker", async () => {
    const { root, file } = await workspace();
    await writeFile(join(root, "a", "App.sln"), "");
    const detector = new RootDetector(1);
    const resolution = await detector.find(server(), file, root);
    expect(resolution.root).toBe(join(root, "a"));
    expect(resolution.marker).toBe("*.sln");
    await rm(root, { recursive: true, force: true });
  });

  it("still applies the workspace and file-directory fallbacks", async () => {
    const { root, file } = await workspace();
    const detector = new RootDetector(1);
    expect((await detector.find(server({ id: "ws", rootFallback: "workspace" }), file, root)).root).toBe(root);
    expect((await detector.find(server({ id: "fd", rootFallback: "file-directory" }), file, root)).root).toBe(join(root, "a", "b", "c", "d"));
    await rm(root, { recursive: true, force: true });
  });
});
