import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	buildWorkspaceReport,
	captureWorkspaceSnapshot,
	diffSnapshots,
	formatWorkspaceReport,
	parseNumstat,
	parseStatus,
	summarizeWorkspaceReport,
	type WorkspaceReport,
	type WorkspaceSnapshot,
} from "./workspace.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
	});
}

/** Repository state normally present when a worker starts. */
function repo(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-workspace-"));
	tempDirs.push(dir);
	git(dir, "init", "-q", ".");
	writeFileSync(join(dir, "tracked.txt"), "a\nb\nc\n");
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "init");
	return dir;
}

function snapshot(
	status: Record<string, string>,
	numstat: Record<string, { added: number; removed: number }> = {},
	head: string | null = "abc1234",
): WorkspaceSnapshot {
	return { head, status: new Map(Object.entries(status)), numstat: new Map(Object.entries(numstat)) };
}

describe("parseStatus", () => {
	test("reads NUL-terminated porcelain records", () => {
		expect(parseStatus(" M tracked.txt\x00?? sub/deep.txt\x00D  gone.txt\x00")).toEqual(
			new Map([
				["tracked.txt", " M"],
				["sub/deep.txt", "??"],
				["gone.txt", "D "],
			]),
		);
	});

	test("keeps paths containing spaces intact", () => {
		expect(parseStatus("?? a file.txt\x00")).toEqual(new Map([["a file.txt", "??"]]));
	});

	test("ignores empty output", () => {
		expect(parseStatus("")).toEqual(new Map());
	});
});

describe("parseNumstat", () => {
	test("reads counts per path", () => {
		expect(parseNumstat("2\t1\ttracked.txt\x004\t0\tnew.txt\x00")).toEqual(
			new Map([
				["tracked.txt", { added: 2, removed: 1 }],
				["new.txt", { added: 4, removed: 0 }],
			]),
		);
	});

	test("skips binary files, which report dashes instead of counts", () => {
		expect(parseNumstat("-\t-\tbin.dat\x003\t1\tsrc.ts\x00")).toEqual(new Map([["src.ts", { added: 3, removed: 1 }]]));
	});
});

describe("diffSnapshots", () => {
	test("reports a file created during the run", () => {
		const delta = diffSnapshots(snapshot({}), snapshot({ "src/new.ts": "??" }));
		expect(delta.changes).toEqual([{ path: "src/new.ts", kind: "added" }]);
	});

	test("reports a modification with the lines attributable to the run", () => {
		const delta = diffSnapshots(snapshot({}), snapshot({ "src/a.ts": " M" }, { "src/a.ts": { added: 24, removed: 6 } }));
		expect(delta.changes).toEqual([{ path: "src/a.ts", kind: "modified", lines: { added: 24, removed: 6 } }]);
	});

	test("subtracts pre-existing changes so a dirty tree does not inflate the run", () => {
		// Isolate this run's changes from pre-existing ones.
		const before = snapshot({ "src/a.ts": " M" }, { "src/a.ts": { added: 10, removed: 2 } });
		const after = snapshot({ "src/a.ts": " M" }, { "src/a.ts": { added: 14, removed: 5 } });

		expect(diffSnapshots(before, after).changes).toEqual([
			{ path: "src/a.ts", kind: "modified", lines: { added: 4, removed: 3 } },
		]);
	});

	test("finds an edit to an already-dirty file even though its status never changes", () => {
		const before = snapshot({ "src/a.ts": " M" }, { "src/a.ts": { added: 1, removed: 0 } });
		const after = snapshot({ "src/a.ts": " M" }, { "src/a.ts": { added: 9, removed: 0 } });

		expect(diffSnapshots(before, after).changes).toHaveLength(1);
	});

	test("stays silent about a file the run never touched", () => {
		const dirty = snapshot({ "src/a.ts": " M" }, { "src/a.ts": { added: 3, removed: 1 } });
		expect(diffSnapshots(dirty, dirty).changes).toEqual([]);
	});

	test("reports deletions and reverted changes distinctly", () => {
		const before = snapshot({ "src/stale.ts": " M" }, { "src/stale.ts": { added: 2, removed: 0 } });
		const after = snapshot({ "src/gone.ts": " D" });

		expect(diffSnapshots(before, after).changes).toEqual([
			{ path: "src/gone.ts", kind: "deleted" },
			{ path: "src/stale.ts", kind: "reverted" },
		]);
	});

	test("distinguishes a committed path from a reverted one", () => {
		// Both clear status; only a commit differs from the starting HEAD.
		const before = snapshot({ "src/kept.ts": " M", "src/undone.ts": " M" }, { "src/kept.ts": { added: 1, removed: 1 } });
		const after = snapshot({}, { "src/kept.ts": { added: 1, removed: 1 } }, "bbbbbbb");

		expect(diffSnapshots(before, after).changes).toEqual([
			{ path: "src/kept.ts", kind: "committed" },
			{ path: "src/undone.ts", kind: "reverted" },
		]);
	});

	test("carries the HEAD move, which means the agent committed", () => {
		const delta = diffSnapshots(snapshot({}, {}, "aaaaaaa"), snapshot({}, {}, "bbbbbbb"));
		expect(delta).toMatchObject({ headBefore: "aaaaaaa", headAfter: "bbbbbbb", changes: [] });
	});
});

describe("formatWorkspaceReport", () => {
	const captured = (delta: Partial<WorkspaceReport & { delta: unknown }> = {}): WorkspaceReport =>
		({
			status: "captured",
			cwd: "/repo",
			delta: { changes: [], headBefore: "a", headAfter: "a" },
			...delta,
		}) as WorkspaceReport;

	test("says so plainly when a run changed nothing", () => {
		// A successful-looking report over an untouched tree must be detectable.
		expect(formatWorkspaceReport(captured())).toBe("Observed workspace changes: none.");
	});

	test("lists each change with its line counts", () => {
		const report = captured({
			delta: {
				changes: [
					{ path: "src/a.ts", kind: "modified", lines: { added: 24, removed: 6 } },
					{ path: "src/a.test.ts", kind: "added" },
				],
				headBefore: "a",
				headAfter: "a",
			},
		});

		expect(formatWorkspaceReport(report)).toBe(
			"Observed workspace changes (git, /repo):\n- src/a.ts — modified (+24 -6)\n- src/a.test.ts — added",
		);
	});

	test("spells out a count that went down instead of printing a doubled sign", () => {
		const report = captured({
			delta: {
				changes: [{ path: "src/a.ts", kind: "modified", lines: { added: -7, removed: 0 } }],
				headBefore: "a",
				headAfter: "a",
			},
		});

		expect(formatWorkspaceReport(report)).toBe(
			"Observed workspace changes (git, /repo):\n- src/a.ts — modified (-7 added)",
		);
	});

	test("surfaces a HEAD move", () => {
		const report = captured({ delta: { changes: [], headBefore: "aaaaaaabbb", headAfter: "cccccccddd" } });
		expect(formatWorkspaceReport(report)).toContain("HEAD moved: aaaaaaa → ccccccc");
	});

	test("explains why an observation is missing rather than implying nothing changed", () => {
		expect(formatWorkspaceReport({ status: "unavailable", cwd: "/repo", reason: "git is not available" })).toBe(
			"Observed workspace changes: unavailable (git is not available).",
		);
	});

	test("returns nothing for an agent that did not opt in", () => {
		expect(formatWorkspaceReport(undefined)).toBe("");
	});
});

describe("summarizeWorkspaceReport", () => {
	test("counts files and lines for the collapsed view", () => {
		const report: WorkspaceReport = {
			status: "captured",
			cwd: "/repo",
			delta: {
				changes: [
					{ path: "a.ts", kind: "modified", lines: { added: 10, removed: 2 } },
					{ path: "b.ts", kind: "added", lines: { added: 5, removed: 0 } },
				],
				headBefore: "a",
				headAfter: "a",
			},
		};

		expect(summarizeWorkspaceReport(report)).toBe("workspace: 2 files changed (+15 -2)");
	});

	test("is undefined when the agent did not opt in", () => {
		expect(summarizeWorkspaceReport(undefined)).toBeUndefined();
	});
});

describe("captureWorkspaceSnapshot", () => {
	test("observes a real edit, creation, and deletion across a run", async () => {
		const dir = repo();
		const before = await captureWorkspaceSnapshot(dir);
		expect(before.ok).toBe(true);

		writeFileSync(join(dir, "tracked.txt"), "a\nB\nc\nd\n");
		writeFileSync(join(dir, "created.txt"), "one\ntwo\n");

		const report = await buildWorkspaceReport(dir, before.ok ? before.snapshot : undefined, undefined);

		expect(report.status).toBe("captured");
		if (report.status !== "captured") return;
		expect(report.delta.changes).toEqual([
			{ path: "created.txt", kind: "added" },
			{ path: "tracked.txt", kind: "modified", lines: { added: 2, removed: 1 } },
		]);
	});

	test("reports no changes when the run left the tree alone", async () => {
		const dir = repo();
		const before = await captureWorkspaceSnapshot(dir);

		const report = await buildWorkspaceReport(dir, before.ok ? before.snapshot : undefined, undefined);

		expect(formatWorkspaceReport(report)).toBe("Observed workspace changes: none.");
	});

	test("still names the files when the run commits its own work", async () => {
		const dir = repo();
		const before = await captureWorkspaceSnapshot(dir);

		writeFileSync(join(dir, "tracked.txt"), "committed\n");
		writeFileSync(join(dir, "created.txt"), "new\n");
		git(dir, "add", ".");
		git(dir, "commit", "-qm", "worker commit");

		const report = await buildWorkspaceReport(dir, before.ok ? before.snapshot : undefined, undefined);

		const text = formatWorkspaceReport(report);
		expect(text).toContain("HEAD moved");
		expect(text).toContain("created.txt — committed");
		expect(text).toContain("tracked.txt — committed (+1 -3)");
	});

	test("names each file in a directory the run created", async () => {
		const dir = repo();
		const before = await captureWorkspaceSnapshot(dir);

		mkdirSync(join(dir, "src", "deep"), { recursive: true });
		writeFileSync(join(dir, "src", "deep", "one.txt"), "1\n");
		writeFileSync(join(dir, "src", "deep", "two.txt"), "2\n");

		const report = await buildWorkspaceReport(dir, before.ok ? before.snapshot : undefined, undefined);

		expect(formatWorkspaceReport(report)).toBe(
			`Observed workspace changes (git, ${dir}):\n- src/deep/one.txt — added\n- src/deep/two.txt — added`,
		);
	});

	test("works in a repository with no commits yet", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-workspace-empty-"));
		tempDirs.push(dir);
		git(dir, "init", "-q", ".");

		const before = await captureWorkspaceSnapshot(dir);
		expect(before).toMatchObject({ ok: true, snapshot: { head: null } });

		writeFileSync(join(dir, "first.txt"), "hello\n");
		const report = await buildWorkspaceReport(dir, before.ok ? before.snapshot : undefined, undefined);

		expect(formatWorkspaceReport(report)).toContain("first.txt — added");
	});

	test("is unavailable outside a repository, rather than reporting no changes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-workspace-bare-"));
		tempDirs.push(dir);

		const captured = await captureWorkspaceSnapshot(dir);

		expect(captured.ok).toBe(false);
		expect(formatWorkspaceReport(await buildWorkspaceReport(dir, undefined, "not a git repository"))).toContain(
			"unavailable",
		);
	});
});
