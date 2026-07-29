import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { WorktreeManager } from "./worktree-manager.ts";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function run(command: string, args: string[], cwd?: string): Promise<string> {
	const result = await execFile(command, args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
	return result.stdout;
}

const pi = {
	async exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
		try {
			const result = await execFile(command, args, {
				cwd: options?.cwd,
				encoding: "utf8",
				maxBuffer: 10 * 1024 * 1024,
			});
			return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
		} catch (error) {
			const failure = error as Error & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
			return {
				stdout: failure.stdout ?? "",
				stderr: failure.stderr ?? failure.message,
				code: typeof failure.code === "number" ? failure.code : 1,
				killed: failure.killed ?? false,
			};
		}
	},
};

async function createRepository() {
	const root = await mkdtemp(join(tmpdir(), "pi-worktree-manager-"));
	roots.push(root);
	const repo = join(root, "repo with spaces");
	const agent = join(root, "agent");
	await mkdir(repo);
	await mkdir(agent);
	await run("git", ["init", "-b", "main"], repo);
	await run("git", ["config", "user.name", "Pi Test"], repo);
	await run("git", ["config", "user.email", "pi@example.test"], repo);
	await writeFile(join(repo, "README.md"), "one\n");
	await run("git", ["add", "README.md"], repo);
	await run("git", ["commit", "-m", "initial"], repo);
	return { root, repo, agent, manager: new WorktreeManager(pi, { agentDir: agent }) };
}

describe("WorktreeManager integration", () => {
	test("creates, discovers from, and reuses a linked worktree", async () => {
		const { repo, manager } = await createRepository();
		const created = await manager.openBranch(repo, false, "feature/auth");
		expect(created).toMatchObject({ ok: true, value: { status: "created", branch: "feature/auth" } });
		if (!created.ok) return;
		expect(created.value.worktreePath).toBe(join(repo, ".worktrees", "feature-auth"));
		expect(await run("git", ["branch", "--show-current"], created.value.worktreePath)).toBe("feature/auth\n");

		const linkedInspection = await manager.inspect(created.value.worktreePath, false);
		expect(linkedInspection).toMatchObject({ ok: true, value: { snapshot: { primaryRoot: resolve(repo), currentRoot: resolve(created.value.worktreePath) } } });
		const reused = await manager.openBranch(repo, false, "feature/auth");
		expect(reused).toMatchObject({ ok: true, value: { status: "reused", worktreePath: created.value.worktreePath } });
		const exclude = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
		expect(exclude).toContain("/.worktrees/");
	});

	test("rejects a symlinked managed root before creating a branch", async () => {
		const { root, repo, manager } = await createRepository();
		const external = join(root, "external");
		await mkdir(external);
		await symlink(external, join(repo, ".worktrees"));
		const opened = await manager.openBranch(repo, false, "feature/escape");
		expect(opened).toMatchObject({ ok: false, error: expect.stringMatching(/symbolic link/u) });
		expect((await run("git", ["show-ref", "--verify", "--quiet", "refs/heads/feature/escape"], repo).catch(() => "missing"))).toBe("missing");
	});

	test("creates a branch from an explicit ref", async () => {
		const { repo, manager } = await createRepository();
		await run("git", ["branch", "base"], repo);
		const opened = await manager.openBranch(repo, false, "feature/from-base", { startRef: "base" });
		expect(opened).toMatchObject({ ok: true, value: { status: "created", branch: "feature/from-base" } });
		if (!opened.ok) return;
		expect((await run("git", ["rev-parse", "HEAD"], opened.value.worktreePath)).trim()).toBe((await run("git", ["rev-parse", "base"], repo)).trim());
	});

	test("tracks a uniquely matching remote branch", async () => {
		const { root, repo, manager } = await createRepository();
		const bare = join(root, "remote.git");
		await run("git", ["init", "--bare", bare]);
		await run("git", ["remote", "add", "origin", bare], repo);
		await run("git", ["push", "origin", "main"], repo);
		await run("git", ["--git-dir", bare, "branch", "feature/remote", "main"]);
		await run("git", ["fetch", "origin"], repo);
		await run("git", ["branch", "origin/feature/remote", "main"], repo);
		const opened = await manager.openBranch(repo, false, "feature/remote");
		expect(opened).toMatchObject({ ok: true, value: { status: "created", branch: "feature/remote" } });
		if (!opened.ok) return;
		expect((await run("git", ["rev-parse", "--symbolic-full-name", "@{upstream}"], opened.value.worktreePath)).trim()).toBe("refs/remotes/origin/feature/remote");
	});
});
