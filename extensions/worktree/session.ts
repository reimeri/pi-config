import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { SessionManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RepositorySnapshot, WorktreeOpenResult } from "./types.ts";

export const WORKTREE_CONTEXT_TYPE = "worktree-context";
const SENTINEL_PROVIDER = "worktree-extension";
const SENTINEL_MODEL = "session-persistence";

type SessionMessage = Parameters<SessionManager["appendMessage"]>[0];

type WorktreeSessionManager = Pick<
	SessionManager,
	"appendMessage" | "resetLeaf" | "appendCustomMessageEntry" | "appendSessionInfo" | "getSessionFile"
>;

export interface WorktreeSessionOptions {
	createSession?: (cwd: string, parentSession: string | undefined) => WorktreeSessionManager;
	fileExists?: (path: string) => boolean;
	removeFile?: (path: string) => Promise<void>;
}

function zeroUsage(): SessionMessage extends { usage: infer Usage } ? Usage : never {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	} as SessionMessage extends { usage: infer Usage } ? Usage : never;
}

export function persistenceSentinel(timestamp = Date.now()): SessionMessage {
	return {
		role: "assistant",
		content: [],
		api: "synthetic",
		provider: SENTINEL_PROVIDER,
		model: SENTINEL_MODEL,
		usage: zeroUsage(),
		stopReason: "aborted",
		timestamp,
	};
}

export function worktreeContextText(snapshot: RepositorySnapshot, result: WorktreeOpenResult): string {
	const checkout = result.branch ? `branch \`${result.branch}\`` : `detached HEAD \`${result.worktree.head?.slice(0, 12) ?? "unknown"}\``;
	return `You are working in Git worktree \`${result.worktreePath}\` on ${checkout}. The repository's primary checkout is \`${snapshot.primaryRoot}\`. Keep all file changes within the current worktree.`;
}

export async function switchToWorktreeSession(
	ctx: ExtensionCommandContext,
	snapshot: RepositorySnapshot,
	result: WorktreeOpenResult,
	options: WorktreeSessionOptions = {},
): Promise<void> {
	const fileExists = options.fileExists ?? existsSync;
	const sourceSessionFile = ctx.sessionManager.getSessionFile();
	const parentSession = sourceSessionFile && fileExists(sourceSessionFile) ? sourceSessionFile : undefined;
	const sourceSessionId = ctx.sessionManager.getSessionId();
	const createSession = options.createSession ?? ((cwd: string, parent: string | undefined) =>
		SessionManager.create(cwd, undefined, parent ? { parentSession: parent } : undefined));
	const manager = createSession(result.worktreePath, parentSession);

	// Pi intentionally does not write a new session file until it has an assistant
	// message. Persist one orphaned synthetic message, then reset the active leaf so
	// the fresh worktree context is the only message visible to the model.
	manager.appendMessage(persistenceSentinel());
	manager.resetLeaf();
	manager.appendCustomMessageEntry(
		WORKTREE_CONTEXT_TYPE,
		worktreeContextText(snapshot, result),
		false,
		{
			version: 1,
			repository: snapshot.primaryRoot,
			commonGitDir: snapshot.commonGitDir,
			worktreePath: result.worktreePath,
			branch: result.branch,
			head: result.worktree.head,
			sourceSessionId,
			sourceSessionFile: parentSession,
		},
	);
	manager.appendSessionInfo(result.branch ? `Worktree: ${result.branch}` : `Worktree: detached ${result.worktree.head?.slice(0, 10) ?? "HEAD"}`);

	const sessionFile = manager.getSessionFile();
	if (!sessionFile || !fileExists(sessionFile)) throw new Error("Pi did not persist the new worktree session.");
	const removeFile = options.removeFile ?? (async (path: string) => rm(path, { force: true }));
	const switched = await ctx.switchSession(sessionFile, {
		withSession: async (nextCtx) => {
			const verb = result.status === "created" ? "Created and opened" : "Opened";
			nextCtx.ui.notify(`${verb} worktree: ${result.worktreePath}`, "info");
		},
	});
	if (switched.cancelled) {
		await removeFile(sessionFile);
		throw new Error("Worktree session switch was cancelled.");
	}
}
