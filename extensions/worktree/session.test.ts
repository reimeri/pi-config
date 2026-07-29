import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { SessionManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { persistenceSentinel, switchToWorktreeSession, WORKTREE_CONTEXT_TYPE, worktreeContextText } from "./session.ts";
import type { RepositorySnapshot, WorktreeOpenResult } from "./types.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-worktree-session-"));
	roots.push(root);
	const source = join(root, "source");
	const target = join(root, "target");
	const sessions = join(root, "sessions");
	await mkdir(source);
	await mkdir(target);
	const sourceManager = SessionManager.create(source, sessions);
	sourceManager.appendMessage({ role: "user", content: "old context", timestamp: Date.now() });
	sourceManager.appendMessage(persistenceSentinel());
	const sourceFile = sourceManager.getSessionFile()!;
	const notifications: string[] = [];
	const switched: string[] = [];
	let cancelled = false;
	let throwBeforeReplacement = false;
	let throwAfterReplacement = false;
	const ctx = {
		sessionManager: sourceManager,
		async switchSession(path: string, options?: { withSession?: (ctx: ExtensionCommandContext) => Promise<void> }) {
			switched.push(path);
			if (throwBeforeReplacement) throw new Error("switch failed before replacement");
			if (cancelled) return { cancelled: true };
			await options?.withSession?.({ ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionCommandContext);
			if (throwAfterReplacement) throw new Error("switch failed after replacement");
			return { cancelled: false };
		},
	} as unknown as ExtensionCommandContext;
	const snapshot: RepositorySnapshot = {
		currentRoot: source,
		primaryRoot: source,
		commonGitDir: join(source, ".git"),
		worktreeRoot: join(source, ".worktrees"),
		refs: [],
		worktrees: [],
	};
	const result: WorktreeOpenResult = {
		status: "created",
		branch: "feature/auth",
		worktreePath: target,
		worktree: { path: target, branch: "feature/auth", head: "abcdef1234567890", detached: false, bare: false },
		warnings: [],
	};
	return {
		sourceFile,
		sessions,
		ctx,
		snapshot,
		result,
		switched,
		notifications,
		cancel: () => { cancelled = true; },
		failBeforeReplacement: () => { throwBeforeReplacement = true; },
		failAfterReplacement: () => { throwAfterReplacement = true; },
	};
}

describe("worktree session switching", () => {
	test("creates a fresh persisted session with lineage and hidden model context", async () => {
		const value = await fixture();
		await switchToWorktreeSession(value.ctx, value.snapshot, value.result, {
			createSession: (cwd, parent) => SessionManager.create(cwd, value.sessions, parent ? { parentSession: parent } : undefined),
		});
		expect(value.switched).toHaveLength(1);
		const opened = SessionManager.open(value.switched[0]!, value.sessions);
		expect(opened.getCwd()).toBe(value.result.worktreePath);
		expect(opened.getHeader()?.parentSession).toBe(value.sourceFile);
		expect(opened.getSessionName()).toBe("Worktree: feature/auth");
		const messages = opened.buildSessionContext().messages;
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			role: "custom",
			customType: WORKTREE_CONTEXT_TYPE,
			display: false,
			details: { version: 1, branch: "feature/auth", sourceSessionFile: value.sourceFile },
		});
		expect(JSON.stringify(messages)).not.toContain("old context");
		expect(value.notifications).toEqual([`Created and opened worktree: ${value.result.worktreePath}`]);
	});

	test("removes the newly created session file when switching is cancelled", async () => {
		const value = await fixture();
		value.cancel();
		await expect(switchToWorktreeSession(value.ctx, value.snapshot, value.result, {
			createSession: (cwd, parent) => SessionManager.create(cwd, value.sessions, parent ? { parentSession: parent } : undefined),
		})).rejects.toThrow(/cancelled/u);
		expect(value.switched).toHaveLength(1);
		expect(existsSync(value.switched[0]!)).toBe(false);
	});

	test("preserves the session file when switching throws because activation may already have occurred", async () => {
		const before = await fixture();
		before.failBeforeReplacement();
		await expect(switchToWorktreeSession(before.ctx, before.snapshot, before.result, {
			createSession: (cwd, parent) => SessionManager.create(cwd, before.sessions, parent ? { parentSession: parent } : undefined),
		})).rejects.toThrow(/before replacement/u);
		expect(existsSync(before.switched[0]!)).toBe(true);

		const after = await fixture();
		after.failAfterReplacement();
		await expect(switchToWorktreeSession(after.ctx, after.snapshot, after.result, {
			createSession: (cwd, parent) => SessionManager.create(cwd, after.sessions, parent ? { parentSession: parent } : undefined),
		})).rejects.toThrow(/after replacement/u);
		expect(existsSync(after.switched[0]!)).toBe(true);
	});

	test("describes branch and detached worktrees", () => {
		const snapshot = { primaryRoot: "/repo" } as RepositorySnapshot;
		const branch = { branch: "feature", worktreePath: "/repo/.worktrees/feature", worktree: { head: "abc" } } as WorktreeOpenResult;
		expect(worktreeContextText(snapshot, branch)).toContain("branch `feature`");
		const detached = { worktreePath: "/tmp/review", worktree: { head: "abcdef123456789" } } as WorktreeOpenResult;
		expect(worktreeContextText(snapshot, detached)).toContain("detached HEAD `abcdef123456`");
	});
});
