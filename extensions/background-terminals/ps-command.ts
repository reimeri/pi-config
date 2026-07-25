import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type Theme,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
	type TUI,
} from "@earendil-works/pi-tui";
import { BackgroundProcessManager } from "./process-manager.ts";
import { formatBackgroundJob } from "./tools.ts";
import type { BackgroundJobSnapshot } from "./types.ts";

const JOB_ID = /^bg-[1-9][0-9]*$/u;

function jobOption(manager: BackgroundProcessManager, job: BackgroundJobSnapshot): string {
	const marker = manager.canKill(job.id) ? "●" : "○";
	return `${marker} ${job.id} — ${job.name ?? job.command.replace(/\s+/gu, " ").trim().slice(0, 80)} [${job.status}]`;
}

class JobLogsComponent {
	private scrollFromBottom = 0;
	private cachedWidth?: number;
	private cachedWrappedLines?: string[];

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly job: BackgroundJobSnapshot,
		private readonly output: string,
		private readonly onClose: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
			this.onClose();
			return;
		}
		const pageSize = Math.max(1, this.tui.terminal.rows - 10);
		if (matchesKey(data, Key.up)) this.scrollFromBottom++;
		else if (matchesKey(data, Key.down)) this.scrollFromBottom = Math.max(0, this.scrollFromBottom - 1);
		else if (matchesKey(data, Key.pageUp)) this.scrollFromBottom += pageSize;
		else if (matchesKey(data, Key.pageDown)) this.scrollFromBottom = Math.max(0, this.scrollFromBottom - pageSize);
		else if (matchesKey(data, Key.home)) this.scrollFromBottom = Number.MAX_SAFE_INTEGER;
		else if (matchesKey(data, Key.end)) this.scrollFromBottom = 0;
		else return;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const innerWidth = Math.max(1, width - 2);
		const bodyHeight = Math.max(4, this.tui.terminal.rows - 9);
		if (this.cachedWidth !== innerWidth || !this.cachedWrappedLines) {
			const sourceLines = (this.output || "(no output captured)").split("\n");
			this.cachedWrappedLines = sourceLines.flatMap((line) => wrapTextWithAnsi(line || " ", innerWidth));
			this.cachedWidth = innerWidth;
		}
		const wrappedLines = this.cachedWrappedLines;
		const maximumStart = Math.max(0, wrappedLines.length - bodyHeight);
		const start = Math.max(0, maximumStart - Math.min(this.scrollFromBottom, maximumStart));
		const visible = wrappedLines.slice(start, start + bodyHeight);
		const position = wrappedLines.length > bodyHeight
			? ` lines ${start + 1}-${start + visible.length}/${wrappedLines.length}`
			: ` ${wrappedLines.length} line${wrappedLines.length === 1 ? "" : "s"}`;
		const border = (text: string) => this.theme.fg("borderMuted", text);
		const lines = [
			truncateToWidth(
				`${border("─")} ${this.theme.fg("accent", this.theme.bold(this.job.id))} ${this.theme.fg("muted", this.job.status)}${this.job.name ? ` ${this.theme.fg("text", this.job.name)}` : ""} ${border("─".repeat(width))}`,
				width,
				"",
			),
			truncateToWidth(` ${this.theme.fg("dim", formatBackgroundJob(this.job))}`, width, "…"),
			border("─".repeat(width)),
			...visible.map((line) => truncateToWidth(` ${this.theme.fg("toolOutput", line)}`, width, "")),
			border("─".repeat(width)),
			truncateToWidth(
				` ${this.theme.fg("dim", `↑↓/PgUp/PgDn scroll • Home/End • q/Esc close •${position}`)}`,
				width,
				"…",
			),
		];
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedWrappedLines = undefined;
	}
}

async function showLogs(
	manager: BackgroundProcessManager,
	id: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const logs = manager.readLogs(id, {
		tailLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/ps requires interactive TUI mode; use background_list or background_logs instead", "warning");
		return;
	}
	const output = truncateTail(logs.text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	}).content;
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
		new JobLogsComponent(tui, theme, logs.job, output, () => done()),
	);
}

async function killWithConfirmation(
	manager: BackgroundProcessManager,
	id: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const job = manager.get(id);
	if (!job) {
		ctx.ui.notify(`Unknown background job: ${id}`, "error");
		return;
	}
	if (!manager.canKill(id)) {
		ctx.ui.notify(`${id} is already ${job.status}`, "info");
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify(`Cannot confirm termination of ${id} without UI`, "error");
		return;
	}
	const confirmed = await ctx.ui.confirm("Stop background job?", formatBackgroundJob(job));
	if (!confirmed) return;
	const stopped = await manager.kill(id);
	ctx.ui.notify(`${id} is ${stopped.status}`, "info");
}

async function manageJob(
	manager: BackgroundProcessManager,
	id: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	while (true) {
		const job = manager.get(id);
		if (!job) {
			ctx.ui.notify(`Unknown background job: ${id}`, "error");
			return;
		}
		if (ctx.mode !== "tui") {
			await showLogs(manager, id, ctx);
			return;
		}

		const actions = ["View logs"];
		if (manager.canKill(id)) actions.push("Kill job");
		else actions.push("Clear record");
		actions.push("Back");
		const action = await ctx.ui.select(formatBackgroundJob(job), actions);
		if (!action || action === "Back") return;
		if (action === "View logs") await showLogs(manager, id, ctx);
		if (action === "Kill job") await killWithConfirmation(manager, id, ctx);
		if (action === "Clear record") {
			manager.clear(id);
			ctx.ui.notify(`Cleared ${id}`, "info");
			return;
		}
	}
}

async function showManager(
	manager: BackgroundProcessManager,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (ctx.mode !== "tui") {
		const jobs = manager.list();
		ctx.ui.notify(jobs.length > 0 ? `${jobs.length} background job(s), ${manager.runningCount} active` : "No background jobs", "info");
		return;
	}

	while (true) {
		const jobs = manager.list();
		const options = jobs.map((job) => jobOption(manager, job));
		if (jobs.some((job) => !manager.canKill(job.id))) options.push("Clear completed records");
		options.push("Close");
		const selected = await ctx.ui.select(
			`Background jobs (${manager.runningCount} active, ${jobs.length} total)`,
			options,
		);
		if (!selected || selected === "Close") return;
		if (selected === "Clear completed records") {
			const cleared = manager.clearCompleted();
			ctx.ui.notify(`Cleared ${cleared} completed background job${cleared === 1 ? "" : "s"}`, "info");
			continue;
		}
		const index = options.indexOf(selected);
		const job = jobs[index];
		if (job) await manageJob(manager, job.id, ctx);
	}
}

export function registerBackgroundPsCommand(
	pi: ExtensionAPI,
	manager: BackgroundProcessManager,
): void {
	pi.registerCommand("ps", {
		description: "Manage session-scoped background jobs; /ps [id|kill <id>|clear <id|completed>]",
		getArgumentCompletions: (prefix) => {
			const candidates = [
				"kill ",
				"clear completed",
				"clear exited",
				...manager.list().map((job) => job.id),
				...manager.list().filter((job) => manager.canKill(job.id)).map((job) => `kill ${job.id}`),
				...manager.list().filter((job) => !manager.canKill(job.id)).map((job) => `clear ${job.id}`),
			];
			const matches = [...new Set(candidates)]
				.filter((candidate) => candidate.startsWith(prefix))
				.map((candidate) => ({ value: candidate, label: candidate }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/ps requires interactive TUI mode; use background terminal tools instead", "warning");
				return;
			}
			const parts = args.trim().split(/\s+/u).filter(Boolean);
			if (parts.length === 0) {
				await showManager(manager, ctx);
				return;
			}
			if (parts[0] === "kill" && parts.length === 2 && JOB_ID.test(parts[1])) {
				await killWithConfirmation(manager, parts[1], ctx);
				return;
			}
			if (parts[0] === "clear" && parts.length === 2) {
				try {
					if (parts[1] === "completed" || parts[1] === "exited") {
						const cleared = manager.clearCompleted();
						ctx.ui.notify(`Cleared ${cleared} completed background job${cleared === 1 ? "" : "s"}`, "info");
					} else if (JOB_ID.test(parts[1])) {
						manager.clear(parts[1]);
						ctx.ui.notify(`Cleared ${parts[1]}`, "info");
					} else {
						throw new Error(`Invalid background job ID: ${parts[1]}`);
					}
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			if (parts.length === 1 && JOB_ID.test(parts[0])) {
				await manageJob(manager, parts[0], ctx);
				return;
			}
			ctx.ui.notify("Usage: /ps [id | kill <id> | clear <id|completed>]", "error");
		},
	});
}
