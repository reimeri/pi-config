import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { worktreeLabel } from "./paths.ts";
import { switchToWorktreeSession } from "./session.ts";
import type { RepositorySnapshot, Result, WorktreeOpenResult } from "./types.ts";
import { WorktreeManager } from "./worktree-manager.ts";

interface CommandArguments {
	mode: "list" | "open";
	branch?: string;
	startRef?: string;
}

export function parseWorktreeArguments(input: string): Result<CommandArguments> {
	const tokens = input.trim().split(/\s+/u).filter(Boolean);
	if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === "list")) return { ok: true, value: { mode: "list" } };
	const branch = tokens.shift();
	if (!branch) return { ok: false, error: "Usage: /worktree [list | <branch> [--from <ref>]]" };
	if (branch === "list") return { ok: false, error: "list is reserved for /worktree list and cannot be used as a branch argument." };
	let startRef: string | undefined;
	while (tokens.length > 0) {
		const token = tokens.shift()!;
		if (token.startsWith("--from=")) {
			if (startRef !== undefined || token.length === "--from=".length) return { ok: false, error: "--from requires exactly one ref." };
			startRef = token.slice("--from=".length);
			continue;
		}
		if (token === "--from") {
			if (startRef !== undefined || tokens.length === 0) return { ok: false, error: "--from requires exactly one ref." };
			startRef = tokens.shift();
			continue;
		}
		return { ok: false, error: `Unknown worktree argument: ${token}` };
	}
	return { ok: true, value: { mode: "open", branch, ...(startRef ? { startRef } : {}) } };
}

function notifyWarnings(ctx: ExtensionCommandContext, warnings: string[]): void {
	for (const warning of warnings) ctx.ui.notify(warning, "warning");
}

async function activate(
	ctx: ExtensionCommandContext,
	snapshot: RepositorySnapshot,
	result: WorktreeOpenResult,
): Promise<void> {
	notifyWarnings(ctx, result.warnings);
	await switchToWorktreeSession(ctx, snapshot, result);
}

async function createInteractively(
	manager: WorktreeManager,
	ctx: ExtensionCommandContext,
	snapshot: RepositorySnapshot,
): Promise<void> {
	const branchInput = await ctx.ui.input("Branch name", "feature/my-change");
	const branch = branchInput?.trim();
	if (!branch) return;
	const alreadyExists = snapshot.worktrees.some((worktree) => worktree.branch === branch && !worktree.prunable)
		|| snapshot.refs.some((ref) => ref.kind === "local" && ref.shortName === branch);
	const remoteMatches = alreadyExists ? [] : manager.remoteMatches(snapshot, branch);
	let selectedRemote: string | undefined;
	let startRef: string | undefined;

	if (remoteMatches.length > 1) {
		const choices = [
			...remoteMatches.map((ref) => `Track ${ref.shortName}`),
			"Create a new branch from HEAD",
			"Create a new branch from another ref…",
		];
		const choice = await ctx.ui.select(`Branch ${branch} exists on multiple remotes`, choices);
		if (!choice) return;
		const selected = remoteMatches.find((ref) => choice === `Track ${ref.shortName}`);
		if (selected) selectedRemote = selected.remote;
		else if (choice.endsWith("another ref…")) {
			startRef = (await ctx.ui.input("Start ref", "main"))?.trim();
			if (!startRef) return;
		} else startRef = "HEAD";
	} else if (!alreadyExists && remoteMatches.length === 0) {
		const choice = await ctx.ui.select(`Create branch ${branch}`, ["From HEAD", "From another ref…"]);
		if (!choice) return;
		if (choice === "From another ref…") {
			startRef = (await ctx.ui.input("Start ref", "main"))?.trim();
			if (!startRef) return;
		}
	}

	const opened = await manager.openBranch(ctx.cwd, ctx.isProjectTrusted(), branch, {
		...(startRef ? { startRef } : {}),
		...(selectedRemote ? { selectedRemote } : {}),
	});
	if (!opened.ok) {
		ctx.ui.notify(opened.error, "error");
		return;
	}
	const refreshed = await manager.inspect(ctx.cwd, ctx.isProjectTrusted());
	if (!refreshed.ok) {
		ctx.ui.notify(refreshed.error, "error");
		return;
	}
	await activate(ctx, refreshed.value.snapshot, opened.value);
}

async function showWorktreeList(manager: WorktreeManager, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/worktree without a branch requires interactive UI. Use /worktree <branch> instead.", "error");
		return;
	}
	const inspected = await manager.inspect(ctx.cwd, ctx.isProjectTrusted());
	if (!inspected.ok) {
		ctx.ui.notify(inspected.error, "error");
		return;
	}
	notifyWarnings(ctx, inspected.value.loadedConfig.warnings);
	const snapshot = inspected.value.snapshot;
	const stale = snapshot.worktrees.filter((worktree) => worktree.prunable);
	if (stale.length > 0) {
		ctx.ui.notify(
			`Stale worktree registrations were omitted: ${stale.map((worktree) => `${worktree.path}${worktree.prunable ? ` (${worktree.prunable})` : ""}`).join(", ")}. Repair them or run git worktree prune manually.`,
			"warning",
		);
	}
	const createLabel = "＋ Create a worktree…";
	const available = snapshot.worktrees.filter((worktree) => !worktree.prunable && !worktree.bare);
	const labels = available.map((worktree) => worktreeLabel(worktree, snapshot.primaryRoot));
	const choice = await ctx.ui.select("Open Git worktree", [...labels, createLabel]);
	if (!choice) return;
	if (choice === createLabel) {
		await createInteractively(manager, ctx, snapshot);
		return;
	}
	const index = labels.indexOf(choice);
	const selected = available[index];
	if (!selected) {
		ctx.ui.notify("The selected worktree is no longer available.", "error");
		return;
	}
	const opened = await manager.openExisting(ctx.cwd, ctx.isProjectTrusted(), selected.path);
	if (!opened.ok) {
		ctx.ui.notify(opened.error, "error");
		return;
	}
	const refreshed = await manager.inspect(ctx.cwd, ctx.isProjectTrusted());
	if (!refreshed.ok) {
		ctx.ui.notify(refreshed.error, "error");
		return;
	}
	await activate(ctx, refreshed.value.snapshot, opened.value);
}

export function registerWorktreeCommand(pi: ExtensionAPI): void {
	const manager = new WorktreeManager(pi);
	pi.registerCommand("worktree", {
		description: "Create, list, or open Git worktrees in a fresh Pi session",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const parsed = parseWorktreeArguments(args);
			if (!parsed.ok) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			if (parsed.value.mode === "list") {
				await showWorktreeList(manager, ctx);
				return;
			}
			const branch = parsed.value.branch;
			if (!branch) {
				ctx.ui.notify("Missing worktree branch.", "error");
				return;
			}
			const opened = await manager.openBranch(ctx.cwd, ctx.isProjectTrusted(), branch, {
				...(parsed.value.startRef ? { startRef: parsed.value.startRef } : {}),
			});
			if (!opened.ok) {
				ctx.ui.notify(opened.error, "error");
				return;
			}
			const inspected = await manager.inspect(ctx.cwd, ctx.isProjectTrusted());
			if (!inspected.ok) {
				ctx.ui.notify(inspected.error, "error");
				return;
			}
			await activate(ctx, inspected.value.snapshot, opened.value);
		},
	});
}
