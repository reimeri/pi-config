import { resolve } from "node:path";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseRefListing, parseWorktreePorcelain } from "./porcelain.ts";
import type { BranchResolution, GitRefRecord, RepositorySnapshot, Result, WorktreeRecord } from "./types.ts";

export type GitExecutor = Pick<ExtensionAPI, "exec">;

function commandError(result: ExecResult, fallback: string): string {
	return result.stderr.trim() || result.stdout.trim() || fallback;
}

async function execGit(pi: GitExecutor, cwd: string, args: string[]): Promise<Result<string>> {
	const result = await pi.exec("git", args, { cwd });
	if (result.code !== 0) return { ok: false, error: commandError(result, `Git command failed: git ${args.join(" ")}`) };
	return { ok: true, value: result.stdout };
}

export async function validateBranchName(pi: GitExecutor, cwd: string, branch: string): Promise<Result<void>> {
	const result = await pi.exec("git", ["check-ref-format", "--branch", branch], { cwd });
	return result.code === 0
		? { ok: true, value: undefined }
		: { ok: false, error: commandError(result, `Invalid branch name: ${branch}`) };
}

export async function validateStartRef(pi: GitExecutor, cwd: string, startRef: string): Promise<Result<void>> {
	const result = await pi.exec("git", ["rev-parse", "--verify", "--quiet", `${startRef}^{commit}`], { cwd });
	return result.code === 0
		? { ok: true, value: undefined }
		: { ok: false, error: `Start ref does not resolve to a commit: ${startRef}` };
}

export async function discoverRepository(
	pi: GitExecutor,
	cwd: string,
	worktreeRootForPrimary: (primaryRoot: string, currentRoot: string) => Promise<string>,
): Promise<Result<RepositorySnapshot>> {
	const currentRootResult = await execGit(pi, cwd, ["rev-parse", "--show-toplevel"]);
	if (!currentRootResult.ok) return { ok: false, error: "Not inside a Git worktree." };
	const currentRoot = resolve(currentRootResult.value.trim());

	const bareResult = await execGit(pi, currentRoot, ["rev-parse", "--is-bare-repository"]);
	if (!bareResult.ok || bareResult.value.trim() === "true") return { ok: false, error: "Bare Git repositories are not supported." };
	const commonResult = await execGit(pi, currentRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (!commonResult.ok) return commonResult;
	const listResult = await execGit(pi, currentRoot, ["worktree", "list", "--porcelain", "-z"]);
	if (!listResult.ok) return listResult;
	const parsed = parseWorktreePorcelain(listResult.value);
	if (!parsed.ok) return parsed;
	const primary = parsed.value[0];
	if (!primary || primary.bare) return { ok: false, error: "Could not determine the repository's primary checkout." };
	const primaryRoot = resolve(primary.path);

	const remoteResult = await execGit(pi, currentRoot, ["remote"]);
	if (!remoteResult.ok) return remoteResult;
	const remotes = remoteResult.value.split("\n").map((line) => line.trim()).filter(Boolean);
	const refsResult = await execGit(pi, currentRoot, [
		"for-each-ref",
		"--format=%(refname)%09%(refname:short)%09%(objectname)%09%(upstream:short)%09%(symref)",
		"refs/heads",
		"refs/remotes",
	]);
	if (!refsResult.ok) return refsResult;
	const worktreeRoot = await worktreeRootForPrimary(primaryRoot, currentRoot);
	return {
		ok: true,
		value: {
			currentRoot,
			primaryRoot,
			commonGitDir: resolve(commonResult.value.trim()),
			worktreeRoot: resolve(worktreeRoot),
			worktrees: parsed.value.map((worktree) => ({ ...worktree, path: resolve(worktree.path) })),
			refs: parseRefListing(refsResult.value, remotes),
		},
	};
}

function localRef(refs: GitRefRecord[], branch: string): GitRefRecord | undefined {
	return refs.find((ref) => ref.kind === "local" && ref.shortName === branch);
}

export function matchingRemoteRefs(refs: GitRefRecord[], branch: string): GitRefRecord[] {
	return refs.filter((ref) => ref.kind === "remote" && ref.remoteBranch === branch);
}

export function resolveBranch(
	snapshot: RepositorySnapshot,
	branch: string,
	startRef?: string,
	selectedRemote?: string,
): Result<BranchResolution> {
	const existingWorktree = snapshot.worktrees.find((worktree) => worktree.branch === branch && !worktree.prunable);
	if (existingWorktree) {
		if (startRef) return { ok: false, error: `--from cannot be used because branch ${branch} already exists in a worktree.` };
		return { ok: true, value: { kind: "open", branch, worktree: existingWorktree } };
	}
	const local = localRef(snapshot.refs, branch);
	if (local) {
		if (startRef) return { ok: false, error: `--from cannot be used because local branch ${branch} already exists.` };
		return { ok: true, value: { kind: "local", branch, ref: local } };
	}
	if (startRef) return { ok: true, value: { kind: "new", branch, startRef } };
	const remotes = matchingRemoteRefs(snapshot.refs, branch);
	if (selectedRemote) {
		const selected = remotes.find((ref) => ref.remote === selectedRemote);
		return selected
			? { ok: true, value: { kind: "remote", branch, ref: selected } }
			: { ok: false, error: `Remote ${selectedRemote} does not contain branch ${branch}.` };
	}
	if (remotes.length === 1) return { ok: true, value: { kind: "remote", branch, ref: remotes[0]! } };
	if (remotes.length > 1) {
		return { ok: false, error: `Branch ${branch} exists on multiple remotes: ${remotes.map((ref) => ref.remote).join(", ")}.` };
	}
	return { ok: true, value: { kind: "new", branch, startRef: "HEAD" } };
}

export async function addWorktree(
	pi: GitExecutor,
	snapshot: RepositorySnapshot,
	resolution: Exclude<BranchResolution, { kind: "open" }>,
	path: string,
): Promise<Result<void>> {
	let args: string[];
	switch (resolution.kind) {
		case "local":
			args = ["worktree", "add", "--", path, resolution.branch];
			break;
		case "remote":
			args = ["worktree", "add", "--track", "-b", resolution.branch, "--", path, resolution.ref.fullName];
			break;
		case "new":
			args = ["worktree", "add", "-b", resolution.branch, "--", path, resolution.startRef];
			break;
	}
	// Run from the invoking checkout so relative start refs (HEAD, HEAD~1, @{-1}) resolve in the
	// same worktree that validateStartRef checked them against.
	const result = await pi.exec("git", args, { cwd: snapshot.currentRoot });
	return result.code === 0
		? { ok: true, value: undefined }
		: { ok: false, error: commandError(result, `Failed to create worktree for ${resolution.branch}`) };
}

export async function refreshWorktrees(pi: GitExecutor, cwd: string): Promise<Result<WorktreeRecord[]>> {
	const result = await execGit(pi, cwd, ["worktree", "list", "--porcelain", "-z"]);
	if (!result.ok) return result;
	return parseWorktreePorcelain(result.value);
}
