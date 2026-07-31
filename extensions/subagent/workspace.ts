/** Captures and reports workspace changes observed around a child run. */

import { execFile } from "node:child_process";

/** Long enough for `git status` on a large tree, short enough not to stall the tool call. */
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
/** Beyond this the list stops being a summary the parent can read at a glance. */
const MAX_LISTED_CHANGES = 40;

export interface LineDelta {
	added: number;
	removed: number;
}

export interface WorkspaceSnapshot {
	/** Commit at HEAD, or null in a repository without commits. */
	head: string | null;
	/** Porcelain status code per path, e.g. " M", "??", "D ". */
	status: Map<string, string>;
	/** Lines changed per path against the base commit. Absent for untracked and binary files. */
	numstat: Map<string, LineDelta>;
}

export type SnapshotResult = { ok: true; snapshot: WorkspaceSnapshot } | { ok: false; reason: string };

export type WorkspaceChangeKind = "added" | "modified" | "deleted" | "reverted" | "committed";

export interface WorkspaceChange {
	path: string;
	kind: WorkspaceChangeKind;
	/** Lines attributable to this run, when countable. */
	lines?: LineDelta;
}

export interface WorkspaceDelta {
	changes: WorkspaceChange[];
	headBefore: string | null;
	headAfter: string | null;
}

export type WorkspaceReport =
	| { status: "captured"; cwd: string; delta: WorkspaceDelta }
	| { status: "unavailable"; cwd: string; reason: string };

type GitResult = { ok: true; stdout: string } | { ok: false; reason: string; exitCode?: number };

function runGit(cwd: string, args: string[]): Promise<GitResult> {
	return new Promise((resolve) => {
		execFile(
			"git",
			args,
			{
				cwd,
				timeout: GIT_TIMEOUT_MS,
				maxBuffer: GIT_MAX_BUFFER,
				windowsHide: true,
				// Avoid taking the index lock while observing a shared checkout.
				env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
			},
			(error, stdout) => {
				if (!error) return resolve({ ok: true, stdout });
				// Only numeric exit status represents Git's verdict; spawn failures and timeouts do not.
				const code = (error as Error & { code?: string | number }).code;
				const reason =
					code === "ENOENT" ? "git is not available" : error.message.split("\n")[0] || "git failed";
				resolve({ ok: false, reason, exitCode: typeof code === "number" ? code : undefined });
			},
		);
	});
}

/** `XY path\0` records. `--no-renames` keeps every record to a single path. */
export function parseStatus(stdout: string): Map<string, string> {
	const status = new Map<string, string>();
	for (const record of stdout.split("\0")) {
		if (record.length < 4) continue;
		status.set(record.slice(3), record.slice(0, 2));
	}
	return status;
}

/** `added\tremoved\tpath\0` records. Binary files report `-` for both counts and are skipped. */
export function parseNumstat(stdout: string): Map<string, LineDelta> {
	const numstat = new Map<string, LineDelta>();
	for (const record of stdout.split("\0")) {
		if (!record) continue;
		const firstTab = record.indexOf("\t");
		const secondTab = record.indexOf("\t", firstTab + 1);
		if (firstTab === -1 || secondTab === -1) continue;
		const added = Number(record.slice(0, firstTab));
		const removed = Number(record.slice(firstTab + 1, secondTab));
		const path = record.slice(secondTab + 1);
		if (!path || !Number.isFinite(added) || !Number.isFinite(removed)) continue;
		numstat.set(path, { added, removed });
	}
	return numstat;
}

/** Captures status and diff data; `baseHead` overrides the current HEAD. */
export async function captureWorkspaceSnapshot(cwd: string, baseHead?: string | null): Promise<SnapshotResult> {
	// Keep records single-path and include files inside newly created directories.
	const status = await runGit(cwd, ["status", "--porcelain=v1", "-z", "--no-renames", "-uall"]);
	if (!status.ok) return { ok: false, reason: status.reason };

	// Treat exit 1 with no HEAD as an empty repository; report other failures.
	const head = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
	if (!head.ok && head.exitCode !== 1) return { ok: false, reason: head.reason };
	const headSha = head.ok ? head.stdout.trim() || null : null;
	const diffBase = baseHead ?? headSha;
	const numstat = diffBase
		? await runGit(cwd, ["diff", "--numstat", "-z", "--no-renames", diffBase])
		: ({ ok: true, stdout: "" } as const);

	return {
		ok: true,
		snapshot: {
			head: headSha,
			status: parseStatus(status.stdout),
			numstat: numstat.ok ? parseNumstat(numstat.stdout) : new Map(),
		},
	};
}

function subtractLines(after: LineDelta | undefined, before: LineDelta | undefined): LineDelta | undefined {
	if (!after && !before) return undefined;
	return {
		added: (after?.added ?? 0) - (before?.added ?? 0),
		removed: (after?.removed ?? 0) - (before?.removed ?? 0),
	};
}

function kindFromStatus(code: string): WorkspaceChangeKind {
	if (code === "??") return "added";
	if (code.includes("D")) return "deleted";
	if (code.includes("A")) return "added";
	return "modified";
}

/** Detects dirty edits when status or line counts change; equal-count rewrites may be missed. */
export function diffSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceDelta {
	const changes: WorkspaceChange[] = [];
	const paths = new Set([
		...before.status.keys(),
		...after.status.keys(),
		...before.numstat.keys(),
		...after.numstat.keys(),
	]);
	for (const path of paths) {
		const beforeCode = before.status.get(path);
		const afterCode = after.status.get(path);
		const lines = subtractLines(after.numstat.get(path), before.numstat.get(path));
		const moved = Boolean(lines && (lines.added !== 0 || lines.removed !== 0));

		if (beforeCode === afterCode && !moved) continue;
		if (!afterCode) {
			// A disappeared status entry is a revert unless its diff still shows a committed change.
			if (after.numstat.has(path)) {
				changes.push({ path, kind: "committed", ...(moved && lines ? { lines } : {}) });
			} else {
				changes.push({ path, kind: "reverted" });
			}
			continue;
		}
		changes.push({ path, kind: kindFromStatus(afterCode), ...(moved && lines ? { lines } : {}) });
	}

	changes.sort((a, b) => a.path.localeCompare(b.path));
	return { changes, headBefore: before.head, headAfter: after.head };
}

/** Formats signed added/removed line deltas, including negative deltas. */
function formatLines(lines: LineDelta): string {
	const parts: string[] = [];
	if (lines.added) parts.push(lines.added > 0 ? `+${lines.added}` : `${lines.added} added`);
	if (lines.removed) parts.push(lines.removed > 0 ? `-${lines.removed}` : `${lines.removed} removed`);
	return parts.length > 0 ? ` (${parts.join(" ")})` : "";
}

export function formatWorkspaceChange(change: WorkspaceChange): string {
	return `${change.path} — ${change.kind}${change.lines ? formatLines(change.lines) : ""}`;
}

export function workspaceReportLines(report: WorkspaceReport): string[] {
	if (report.status === "unavailable") return [];
	const { changes, headBefore, headAfter } = report.delta;
	const lines = changes.slice(0, MAX_LISTED_CHANGES).map(formatWorkspaceChange);
	if (changes.length > MAX_LISTED_CHANGES) lines.push(`... ${changes.length - MAX_LISTED_CHANGES} more`);
	if (headBefore !== headAfter) {
		lines.push(`HEAD moved: ${headBefore?.slice(0, 7) ?? "(none)"} → ${headAfter?.slice(0, 7) ?? "(none)"}`);
	}
	return lines;
}

export function formatWorkspaceReport(report: WorkspaceReport | undefined): string {
	if (!report) return "";
	if (report.status === "unavailable") return `Observed workspace changes: unavailable (${report.reason}).`;

	const lines = workspaceReportLines(report);
	if (lines.length === 0) return "Observed workspace changes: none.";
	return `Observed workspace changes (git, ${report.cwd}):\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

export function summarizeWorkspaceReport(report: WorkspaceReport | undefined): string | undefined {
	if (!report) return undefined;
	if (report.status === "unavailable") return `workspace: unavailable (${report.reason})`;

	const { changes } = report.delta;
	const headMoved = report.delta.headBefore !== report.delta.headAfter;
	if (changes.length === 0) return headMoved ? "workspace: no file changes, HEAD moved" : "workspace: no changes";

	// Preserve negative totals so the summary matches per-file deltas.
	const totals = changes.reduce(
		(sum, change) => ({
			added: sum.added + (change.lines?.added ?? 0),
			removed: sum.removed + (change.lines?.removed ?? 0),
		}),
		{ added: 0, removed: 0 },
	);
	const counts = formatLines(totals);
	const files = `${changes.length} file${changes.length > 1 ? "s" : ""}`;
	return `workspace: ${files} changed${counts}${headMoved ? ", HEAD moved" : ""}`;
}

/** Diff `before` against the current state, or explain why that could not be observed. */
export async function buildWorkspaceReport(
	cwd: string,
	before: WorkspaceSnapshot | undefined,
	captureFailure: string | undefined,
): Promise<WorkspaceReport> {
	if (!before) return { status: "unavailable", cwd, reason: captureFailure ?? "no baseline snapshot" };
	// Compare against the starting commit even if the child committed changes.
	const after = await captureWorkspaceSnapshot(cwd, before.head);
	if (!after.ok) return { status: "unavailable", cwd, reason: after.reason };
	return { status: "captured", cwd, delta: diffSnapshots(before, after.snapshot) };
}
