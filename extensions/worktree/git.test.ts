import { describe, expect, test } from "vitest";
import { resolveBranch } from "./git.ts";
import type { GitRefRecord, RepositorySnapshot, WorktreeRecord } from "./types.ts";

const local = (name: string): GitRefRecord => ({ fullName: `refs/heads/${name}`, shortName: name, objectId: "a", kind: "local" });
const remote = (remoteName: string, name: string): GitRefRecord => ({
	fullName: `refs/remotes/${remoteName}/${name}`,
	shortName: `${remoteName}/${name}`,
	objectId: "a",
	kind: "remote",
	remote: remoteName,
	remoteBranch: name,
});
const worktree = (branch: string, path = `/repo/.worktrees/${branch}`): WorktreeRecord => ({ path, branch, detached: false, bare: false });
const snapshot = (refs: GitRefRecord[] = [], worktrees: WorktreeRecord[] = []): RepositorySnapshot => ({
	currentRoot: "/repo",
	primaryRoot: "/repo",
	commonGitDir: "/repo/.git",
	worktreeRoot: "/repo/.worktrees",
	refs,
	worktrees,
});

describe("resolveBranch", () => {
	test("opens an existing worktree before considering refs", () => {
		expect(resolveBranch(snapshot([local("feature")], [worktree("feature")]), "feature")).toMatchObject({ ok: true, value: { kind: "open" } });
	});

	test("uses local, unique remote, or new branch resolution", () => {
		expect(resolveBranch(snapshot([local("feature")]), "feature")).toMatchObject({ ok: true, value: { kind: "local" } });
		expect(resolveBranch(snapshot([remote("origin", "feature")]), "feature")).toMatchObject({ ok: true, value: { kind: "remote" } });
		expect(resolveBranch(snapshot(), "feature")).toEqual({ ok: true, value: { kind: "new", branch: "feature", startRef: "HEAD" } });
		expect(resolveBranch(snapshot(), "feature", "main")).toEqual({ ok: true, value: { kind: "new", branch: "feature", startRef: "main" } });
	});

	test("reports ambiguous remote branches and supports an explicit selection", () => {
		const state = snapshot([remote("origin", "feature"), remote("upstream", "feature")]);
		expect(resolveBranch(state, "feature")).toMatchObject({ ok: false });
		expect(resolveBranch(state, "feature", undefined, "upstream")).toMatchObject({ ok: true, value: { kind: "remote", ref: { remote: "upstream" } } });
	});

	test("rejects --from for an existing branch", () => {
		expect(resolveBranch(snapshot([local("feature")]), "feature", "main")).toMatchObject({ ok: false });
		expect(resolveBranch(snapshot([], [worktree("feature")]), "feature", "main")).toMatchObject({ ok: false });
	});
});
