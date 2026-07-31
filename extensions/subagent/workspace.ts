/**
 * Observed workspace changes for a child run.
 *
 * The parent is told what an agent changed by the agent itself, which is a claim. Snapshotting the
 * working tree around the run turns that into something checkable: the parent sees the files that
 * actually moved, including the case where a confident completion report accompanies no change at
 * all, without spending a turn on its own `git` call.
 */

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
				// Keep this observation from taking the index lock, so it cannot interfere with
				// anything the child or the user is doing in the same checkout.
				env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
			},
			(error, stdout) => {
				if (!error) return resolve({ ok: true, stdout });
				// A numeric `code` is the command's own exit status; a string one means the spawn
				// itself failed, and a kill (the timeout) leaves neither. Only the first is a
				// verdict from git that a caller can act on.
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

/**
 * The state of the checkout right now.
 *
 * `baseHead` is the commit to count lines against, which for the closing snapshot is the commit the
 * run started from rather than the current one: a child that commits its work would otherwise leave
 * nothing to see, since both `git status` and a diff against the new `HEAD` are then empty.
 */
export async function captureWorkspaceSnapshot(cwd: string, baseHead?: string | null): Promise<SnapshotResult> {
	// `--no-renames` keeps every record single-path, so a rename reads as a delete plus an add
	// rather than needing a second field. For "what did this run touch", that is the better shape.
	// `-uall` names the files inside a newly created directory instead of collapsing them into it.
	const status = await runGit(cwd, ["status", "--porcelain=v1", "-z", "--no-renames", "-uall"]);
	if (!status.ok) return { ok: false, reason: status.reason };

	// Exit 1 with no output is a repository without commits, which is not an error: there is simply
	// nothing to diff against, and the status codes alone still describe what changed. Any other
	// failure is a real one, and reporting it as "no commits" would invent a HEAD move.
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

/**
 * Changes between two snapshots of the same checkout.
 *
 * A path whose status code is unchanged is still compared by line counts, because an edit to a file
 * that was already dirty leaves the code at " M" throughout. That comparison is by size, so a
 * rewrite of an already-dirty file that happens to add and remove exactly as much as the edit it
 * replaced does not register; a clean tree before the run, which is the normal case, has no such
 * blind spot.
 *
 * Line counts carry the paths a run committed, which `git status` no longer knows about, so they
 * are a source of paths in their own right and not only a detail of the ones status reports.
 */
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
			// Gone from `git status` is either a revert or a commit, and still differing from the
			// commit the run started at is what tells the two apart. A revert's counts are the
			// negative of what it undid, which is noise, so only the commit carries them.
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

/**
 * `+24 -6`, the first count being added lines and the second removed.
 *
 * Either is a delta and can be negative, for a run that undid part of a change the tree already
 * carried. The bare sign convention cannot say that — `+-7` is nonsense — so it is spelled out.
 */
function formatLines(lines: LineDelta): string {
	const parts: string[] = [];
	if (lines.added) parts.push(lines.added > 0 ? `+${lines.added}` : `${lines.added} added`);
	if (lines.removed) parts.push(lines.removed > 0 ? `-${lines.removed}` : `${lines.removed} removed`);
	return parts.length > 0 ? ` (${parts.join(" ")})` : "";
}

/** One line naming a change, as the parent agent reads it. */
export function formatWorkspaceChange(change: WorkspaceChange): string {
	return `${change.path} — ${change.kind}${change.lines ? formatLines(change.lines) : ""}`;
}

/** Every reportable line, including the HEAD move. Empty when the run changed nothing. */
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

/** The section appended to what the parent agent reads. Empty when there is nothing to report. */
export function formatWorkspaceReport(report: WorkspaceReport | undefined): string {
	if (!report) return "";
	if (report.status === "unavailable") return `Observed workspace changes: unavailable (${report.reason}).`;

	const lines = workspaceReportLines(report);
	if (lines.length === 0) return "Observed workspace changes: none.";
	return `Observed workspace changes (git, ${report.cwd}):\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

/** Compact status for the collapsed tool view. */
export function summarizeWorkspaceReport(report: WorkspaceReport | undefined): string | undefined {
	if (!report) return undefined;
	if (report.status === "unavailable") return `workspace: unavailable (${report.reason})`;

	const { changes } = report.delta;
	const headMoved = report.delta.headBefore !== report.delta.headAfter;
	if (changes.length === 0) return headMoved ? "workspace: no file changes, HEAD moved" : "workspace: no changes";

	// Summed as they are, negatives included, so this line agrees with the per-file list it stands in
	// for rather than quietly clamping to a different number.
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
	// Counted against the commit the run started from, which is the only base that survives the run
	// committing its own work.
	const after = await captureWorkspaceSnapshot(cwd, before.head);
	if (!after.ok) return { status: "unavailable", cwd, reason: after.reason };
	return { status: "captured", cwd, delta: diffSnapshots(before, after.snapshot) };
}
