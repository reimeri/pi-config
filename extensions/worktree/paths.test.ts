import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { chooseWorktreePath, rootExcludePattern, sanitizeDirectoryName, validateWorktreeRoot } from "./paths.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function tempRoot() {
	const root = await mkdtemp(join(tmpdir(), "pi-worktree-paths-"));
	roots.push(root);
	return root;
}

describe("worktree paths", () => {
	test("creates readable bounded names", () => {
		expect(sanitizeDirectoryName("Feature/Auth")).toBe("Feature-Auth");
		expect(sanitizeDirectoryName("../../")).toBe("worktree");
		expect(sanitizeDirectoryName("équipe/été")).toBe("equipe-ete");
		expect(sanitizeDirectoryName("x".repeat(200))).toHaveLength(80);
	});

	test("adds a stable hash when the readable path is occupied", async () => {
		const root = await tempRoot();
		await mkdir(join(root, "Feature-Auth"));
		const selected = chooseWorktreePath(root, "Feature/Auth", []);
		expect(selected).toMatch(/Feature-Auth--[a-f0-9]{10}$/u);
		expect(chooseWorktreePath(root, "Feature/Auth", [])).toBe(selected);
	});

	test("builds a local exclude only for roots within the primary checkout", () => {
		expect(rootExcludePattern("/repo", "/repo/.worktrees")).toBe("/.worktrees/");
		expect(rootExcludePattern("/repo", "/other/worktrees")).toBeUndefined();
	});

	test("rejects absolute roots whose existing ancestor resolves through a symlink", async () => {
		const root = await tempRoot();
		const primary = join(root, "primary");
		const external = join(root, "external");
		const redirect = join(root, "redirect");
		await mkdir(join(primary, ".git"), { recursive: true });
		await mkdir(external);
		await symlink(external, redirect);
		await expect(validateWorktreeRoot(primary, join(primary, ".git"), join(redirect, "managed"), [
			{ path: primary, branch: "main", detached: false, bare: false },
		])).rejects.toThrow(/symbolic link/u);
	});

	test("compares canonical metadata and registered-worktree aliases", async () => {
		const root = await tempRoot();
		const primary = join(root, "primary");
		const managed = join(root, "managed");
		const metadataAlias = join(primary, ".git-alias");
		const worktreeAlias = join(root, "worktree-alias");
		await mkdir(primary);
		await mkdir(managed);
		await symlink(managed, metadataAlias);
		await symlink(managed, worktreeAlias);
		await expect(validateWorktreeRoot(primary, metadataAlias, managed, [
			{ path: primary, branch: "main", detached: false, bare: false },
		])).rejects.toThrow(/Git metadata/u);
		await expect(validateWorktreeRoot(primary, join(primary, ".git"), managed, [
			{ path: primary, branch: "main", detached: false, bare: false },
			{ path: worktreeAlias, branch: "other", detached: false, bare: false },
		])).rejects.toThrow(/registered worktree/u);
	});
});
