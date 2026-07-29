import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadWorktreeConfig, resolveWorktreeRoot } from "./config.ts";
import {
	addWorktree,
	discoverRepository,
	matchingRemoteRefs,
	refreshWorktrees,
	resolveBranch,
	validateBranchName,
	validateStartRef,
	type GitExecutor,
} from "./git.ts";
import { ensureLocalExclude } from "./local-exclude.ts";
import { chooseWorktreePath, rootExcludePattern, validateWorktreeRoot } from "./paths.ts";
import { copyProjectResources, resourceSummaryWarnings } from "./resources.ts";
import type {
	GitRefRecord,
	LoadedWorktreeConfig,
	RepositorySnapshot,
	Result,
	WorktreeOpenResult,
	WorktreeRecord,
} from "./types.ts";

interface Inspection {
	snapshot: RepositorySnapshot;
	loadedConfig: LoadedWorktreeConfig;
}

const repositoryQueues = new Map<string, Promise<void>>();

async function withRepositoryQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
	const previous = repositoryQueues.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((done) => {
		release = done;
	});
	const tail = previous.then(() => current);
	repositoryQueues.set(key, tail);
	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (repositoryQueues.get(key) === tail) repositoryQueues.delete(key);
	}
}

export interface WorktreeManagerOptions {
	agentDir?: string;
}

export class WorktreeManager {
	constructor(
		private readonly pi: GitExecutor,
		private readonly options: WorktreeManagerOptions = {},
	) {}

	async inspect(cwd: string, projectTrusted: boolean): Promise<Result<Inspection>> {
		let loadedConfig: LoadedWorktreeConfig | undefined;
		const discovered = await discoverRepository(this.pi, cwd, async (primaryRoot, currentRoot) => {
			loadedConfig = await loadWorktreeConfig(currentRoot, projectTrusted, this.options.agentDir);
			return resolveWorktreeRoot(primaryRoot, loadedConfig.config.root);
		});
		if (!discovered.ok) return discovered;
		if (!loadedConfig) return { ok: false, error: "Failed to load worktree configuration." };
		return { ok: true, value: { snapshot: discovered.value, loadedConfig } };
	}

	remoteMatches(snapshot: RepositorySnapshot, branch: string): GitRefRecord[] {
		return matchingRemoteRefs(snapshot.refs, branch);
	}

	async openBranch(
		cwd: string,
		projectTrusted: boolean,
		branch: string,
		options: { startRef?: string; selectedRemote?: string } = {},
	): Promise<Result<WorktreeOpenResult>> {
		const preliminary = await this.inspect(cwd, projectTrusted);
		if (!preliminary.ok) return preliminary;
		return withRepositoryQueue(preliminary.value.snapshot.commonGitDir, async () => {
			const inspected = await this.inspect(cwd, projectTrusted);
			if (!inspected.ok) return inspected;
			const { snapshot, loadedConfig } = inspected.value;
			const branchValidation = await validateBranchName(this.pi, snapshot.currentRoot, branch);
			if (!branchValidation.ok) return branchValidation;
			if (options.startRef) {
				const startValidation = await validateStartRef(this.pi, snapshot.currentRoot, options.startRef);
				if (!startValidation.ok) return startValidation;
			}
			const stale = snapshot.worktrees.find((worktree) => worktree.branch === branch && worktree.prunable);
			if (stale) {
				return { ok: false, error: `Branch ${branch} has a stale worktree registration at ${stale.path}. Run git worktree prune or repair it before continuing.` };
			}
			const resolution = resolveBranch(snapshot, branch, options.startRef, options.selectedRemote);
			if (!resolution.ok) return resolution;
			if (resolution.value.kind === "open") {
				return this.finishOpen(snapshot, loadedConfig, resolution.value.worktree, "reused");
			}

			let path: string;
			try {
				await validateWorktreeRoot(snapshot.primaryRoot, snapshot.commonGitDir, snapshot.worktreeRoot, snapshot.worktrees);
				path = chooseWorktreePath(snapshot.worktreeRoot, branch, snapshot.worktrees);
				await mkdir(snapshot.worktreeRoot, { recursive: true });
				await validateWorktreeRoot(snapshot.primaryRoot, snapshot.commonGitDir, snapshot.worktreeRoot, snapshot.worktrees);
				await ensureLocalExclude(snapshot.commonGitDir, rootExcludePattern(snapshot.primaryRoot, snapshot.worktreeRoot));
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
			const added = await addWorktree(this.pi, snapshot, resolution.value, path);
			if (!added.ok) return added;
			const refreshed = await refreshWorktrees(this.pi, snapshot.currentRoot);
			if (!refreshed.ok) return refreshed;
			const worktree = refreshed.value.find((item) => resolve(item.path) === resolve(path));
			if (!worktree) return { ok: false, error: `Git created ${path}, but it was not present in the refreshed worktree list.` };
			return this.finishOpen(snapshot, loadedConfig, worktree, "created");
		});
	}

	async openExisting(
		cwd: string,
		projectTrusted: boolean,
		worktreePath: string,
	): Promise<Result<WorktreeOpenResult>> {
		const preliminary = await this.inspect(cwd, projectTrusted);
		if (!preliminary.ok) return preliminary;
		return withRepositoryQueue(preliminary.value.snapshot.commonGitDir, async () => {
			const inspected = await this.inspect(cwd, projectTrusted);
			if (!inspected.ok) return inspected;
			const worktree = inspected.value.snapshot.worktrees.find(
				(item) => resolve(item.path) === resolve(worktreePath) && !item.prunable,
			);
			if (!worktree) return { ok: false, error: `Worktree is no longer available: ${worktreePath}` };
			return this.finishOpen(inspected.value.snapshot, inspected.value.loadedConfig, worktree, "reused");
		});
	}

	private async finishOpen(
		snapshot: RepositorySnapshot,
		loadedConfig: LoadedWorktreeConfig,
		worktree: WorktreeRecord,
		status: "created" | "reused",
	): Promise<Result<WorktreeOpenResult>> {
		const warnings = [...loadedConfig.warnings];
		try {
			const summary = await copyProjectResources(snapshot.currentRoot, worktree.path, loadedConfig.config.resources);
			warnings.push(...resourceSummaryWarnings(summary));
		} catch (error) {
			warnings.push(`Could not prepare Pi resources: ${error instanceof Error ? error.message : String(error)}`);
		}
		return {
			ok: true,
			value: {
				status,
				...(worktree.branch ? { branch: worktree.branch } : {}),
				worktreePath: worktree.path,
				worktree,
				warnings,
			},
		};
	}
}

export type WorktreeExtensionApi = Pick<ExtensionAPI, "exec">;
