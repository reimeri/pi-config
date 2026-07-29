import { describe, expect, test } from "vitest";
import { parseRefListing, parseWorktreePorcelain } from "./porcelain.ts";

describe("parseWorktreePorcelain", () => {
	test("parses branch, detached, locked, and prunable records with spaces", () => {
		const output = [
			"worktree /repo with spaces", "HEAD aaaa", "branch refs/heads/main", "locked reason with spaces", "",
			"worktree /repo/.worktrees/detached", "HEAD bbbb", "detached", "prunable gitdir file points to non-existent location", "",
		].join("\0");
		expect(parseWorktreePorcelain(output)).toEqual({
			ok: true,
			value: [
				{ path: "/repo with spaces", head: "aaaa", branch: "main", detached: false, bare: false, locked: "reason with spaces" },
				{ path: "/repo/.worktrees/detached", head: "bbbb", detached: true, bare: false, prunable: "gitdir file points to non-existent location" },
			],
		});
	});

	test("rejects output without worktree records", () => {
		expect(parseWorktreePorcelain("")).toMatchObject({ ok: false });
		expect(parseWorktreePorcelain("HEAD aaaa\0")).toMatchObject({ ok: false });
	});
});

describe("parseRefListing", () => {
	test("classifies local and remote refs and excludes symbolic HEAD", () => {
		const output = [
			"refs/heads/main\tmain\taaaa\torigin/main\t",
			"refs/remotes/origin/feature/x\torigin/feature/x\tbbbb\t\t",
			"refs/remotes/origin/HEAD\torigin/HEAD\taaaa\t\trefs/remotes/origin/main",
		].join("\n");
		expect(parseRefListing(output, ["origin"])).toEqual([
			{ fullName: "refs/heads/main", shortName: "main", objectId: "aaaa", kind: "local", upstream: "origin/main" },
			{ fullName: "refs/remotes/origin/feature/x", shortName: "origin/feature/x", objectId: "bbbb", kind: "remote", remote: "origin", remoteBranch: "feature/x" },
		]);
	});

	test("derives names from full refs when Git's short names are ambiguous", () => {
		const output = [
			"refs/heads/origin/main\theads/origin/main\taaaa\t\t",
			"refs/remotes/origin/main\tremotes/origin/main\tbbbb\t\t",
		].join("\n");
		expect(parseRefListing(output, ["origin"])).toEqual([
			{ fullName: "refs/heads/origin/main", shortName: "origin/main", objectId: "aaaa", kind: "local" },
			{ fullName: "refs/remotes/origin/main", shortName: "origin/main", objectId: "bbbb", kind: "remote", remote: "origin", remoteBranch: "main" },
		]);
	});
});
