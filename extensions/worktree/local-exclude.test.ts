import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ensureLocalExclude, excludeContains } from "./local-exclude.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("local Git exclude", () => {
	test("creates the file and appends a pattern once", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-worktree-exclude-"));
		roots.push(root);
		await ensureLocalExclude(root, "/.worktrees/");
		await ensureLocalExclude(root, "/.worktrees/");
		const content = await readFile(join(root, "info", "exclude"), "utf8");
		expect(content).toBe("/.worktrees/\n");
		expect(excludeContains(content, "/.worktrees/")).toBe(true);
	});

	test("does nothing without a pattern", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-worktree-exclude-"));
		roots.push(root);
		await ensureLocalExclude(root, undefined);
		await expect(readFile(join(root, "info", "exclude"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});
});
