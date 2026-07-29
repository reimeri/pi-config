import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadWorktreeConfig, resolveWorktreeRoot } from "./config.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
async function tempRoot() {
	const root = await mkdtemp(join(tmpdir(), "pi-worktree-config-"));
	roots.push(root);
	return root;
}

describe("worktree config", () => {
	test("defaults to a local root with copying disabled", async () => {
		const root = await tempRoot();
		const loaded = await loadWorktreeConfig(join(root, "checkout"), false, join(root, "agent"));
		expect(loaded.config.root).toBe(".worktrees");
		expect(loaded.config.resources.mode).toBe("none");
		expect(resolveWorktreeRoot("/repo", loaded.config.root)).toBe("/repo/.worktrees");
	});

	test("merges global and trusted project settings", async () => {
		const root = await tempRoot();
		const agent = join(root, "agent");
		const checkout = join(root, "checkout");
		await mkdir(join(checkout, ".pi"), { recursive: true });
		await mkdir(agent, { recursive: true });
		await writeFile(join(agent, "worktree.json"), JSON.stringify({ root: "/shared/worktrees", resources: { mode: "copy" } }));
		await writeFile(join(checkout, ".pi", "worktree.json"), JSON.stringify({ resources: { entries: ["skills", "extensions", "unknown"] } }));
		const loaded = await loadWorktreeConfig(checkout, true, agent);
		expect(loaded.config).toEqual({ root: "/shared/worktrees", resources: { mode: "copy", entries: ["skills", "extensions"] } });
		expect(loaded.warnings).toHaveLength(1);
	});

	test("does not read untrusted project configuration", async () => {
		const root = await tempRoot();
		const checkout = join(root, "checkout");
		await mkdir(join(checkout, ".pi"), { recursive: true });
		await writeFile(join(checkout, ".pi", "worktree.json"), JSON.stringify({ root: "/untrusted" }));
		const loaded = await loadWorktreeConfig(checkout, false, join(root, "agent"));
		expect(loaded.config.root).toBe(".worktrees");
	});
});
