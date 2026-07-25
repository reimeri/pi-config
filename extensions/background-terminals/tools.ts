import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	TruncationResult,
} from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { BackgroundProcessManager } from "./process-manager.ts";
import type {
	BackgroundJobSnapshot,
	BackgroundLogRead,
	BackgroundTerminalConfig,
	ReadinessPatternType,
} from "./types.ts";

const JOB_STATUSES = ["starting", "running", "stopping", "exited", "killed", "failed"] as const;
const READINESS_PATTERN_TYPES = ["substring", "regex"] as const;
const JOB_ID_PATTERN = "^bg-[1-9][0-9]*$";
const COMMAND_MAX_LENGTH = 100_000;
const NAME_MAX_LENGTH = 80;
const PATTERN_MAX_LENGTH = 1_000;
const DETAILS_MAX_BYTES = 16 * 1024;
const DETAILS_MAX_LINES = 200;
const LOG_PAGE_METADATA_RESERVE_BYTES = 2 * 1024;
const LOG_PAGE_METADATA_RESERVE_LINES = 10;
const DETAILS_MAX_JOBS = 100;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;

interface LimitedOutput {
	text: string;
	truncation?: TruncationResult;
}

interface JobToolSummary {
	id: string;
	name?: string;
	status: BackgroundJobSnapshot["status"];
	pid?: number;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	readinessStatus: BackgroundJobSnapshot["readiness"]["status"];
	commandPreview: string;
	line: string;
}

interface LogToolSummary {
	job: JobToolSummary;
	excerpt: string;
	startCursor: number;
	nextCursor: number;
	droppedBefore: boolean;
	truncatedToTail: boolean;
}

interface StartToolDetails {
	job: JobToolSummary;
	logs: LogToolSummary;
	truncation?: TruncationResult;
}

interface ListToolDetails {
	jobs: JobToolSummary[];
	totalJobs: number;
	activeJobs: number;
	detailsTruncated: boolean;
	truncation?: TruncationResult;
}

interface LogsToolDetails {
	logs: LogToolSummary;
	truncation?: TruncationResult;
}

interface KillToolDetails {
	job: JobToolSummary;
}

function normalizeInline(value: string): string {
	return value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
}

function commandPreview(command: string, maximum = 100): string {
	const normalized = normalizeInline(command);
	return normalized.length > maximum ? `${normalized.slice(0, maximum - 1)}…` : normalized;
}

function formatDuration(milliseconds: number): string {
	if (milliseconds < 1000) return `${milliseconds}ms`;
	if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`;
	return `${(milliseconds / 60_000).toFixed(1)}m`;
}

export function formatBackgroundJob(job: BackgroundJobSnapshot): string {
	const duration = (job.endedAt ?? Date.now()) - job.startedAt;
	const identity = job.name ? `${job.id} (${normalizeInline(job.name)})` : job.id;
	const pid = job.pid === undefined ? "pid=?" : `pid=${job.pid}`;
	const exit = job.exitCode === undefined ? "" : ` exit=${job.exitCode ?? "null"}`;
	return `${identity} ${job.status} ${pid} ${formatDuration(duration)}${exit} — ${commandPreview(job.command)}`;
}

function summarizeJob(job: BackgroundJobSnapshot): JobToolSummary {
	return {
		id: job.id,
		name: job.name,
		status: job.status,
		pid: job.pid,
		startedAt: job.startedAt,
		endedAt: job.endedAt,
		exitCode: job.exitCode,
		readinessStatus: job.readiness.status,
		commandPreview: commandPreview(job.command, 200),
		line: formatBackgroundJob(job),
	};
}

function summarizeLogs(logs: BackgroundLogRead): LogToolSummary {
	const excerpt = truncateTail(logs.text, {
		maxLines: DETAILS_MAX_LINES,
		maxBytes: DETAILS_MAX_BYTES,
	}).content;
	return {
		job: summarizeJob(logs.job),
		excerpt,
		startCursor: logs.startCursor,
		nextCursor: logs.nextCursor,
		droppedBefore: logs.droppedBefore,
		truncatedToTail: logs.truncatedToTail || excerpt !== logs.text,
	};
}

function appendNoticeWithinLimit(
	text: string,
	direction: "head" | "tail",
	message: string,
): LimitedOutput {
	const truncate = direction === "head" ? truncateHead : truncateTail;
	const initial = truncate(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!initial.truncated) return { text: initial.content };

	const notice = `\n\n[Output truncated: showing ${initial.outputLines} of ${initial.totalLines} lines (${formatSize(initial.outputBytes)} of ${formatSize(initial.totalBytes)}). ${message}]`;
	const noticeBytes = Buffer.byteLength(notice, "utf8");
	const noticeLines = notice.split("\n").length - 1;
	const body = truncate(text, {
		maxLines: Math.max(1, DEFAULT_MAX_LINES - noticeLines),
		maxBytes: Math.max(1, DEFAULT_MAX_BYTES - noticeBytes),
	}).content;
	const guarded = truncate(`${body}${notice}`, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	return { text: guarded.content, truncation: initial };
}

function limitTail(text: string, message: string): LimitedOutput {
	return appendNoticeWithinLimit(text, "tail", message);
}

function limitHead(text: string, message: string): LimitedOutput {
	return appendNoticeWithinLimit(text, "head", message);
}

function sessionEnvironment(ctx: ExtensionContext): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile) env.PI_SESSION_FILE = sessionFile;
	if (ctx.model) {
		env.PI_PROVIDER = ctx.model.provider;
		env.PI_MODEL = ctx.model.id;
	}
	if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	return env;
}

function resultText(content: Array<{ type: string; text?: string }>): string {
	return content.find((item) => item.type === "text")?.text ?? "";
}

function tailLines(text: string, count: number): string {
	const lines = text.trimEnd().split("\n");
	return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

export function registerBackgroundTerminalTools(
	pi: ExtensionAPI,
	manager: BackgroundProcessManager,
	config: BackgroundTerminalConfig,
): void {
	pi.registerTool({
		name: "background_start",
		label: "Background Start",
		description:
			`Start a long-running shell command in a session-scoped background process. Returns after spawning, or optionally waits for a readiness substring/safe regex. Readiness defaults to ${config.defaultReadinessTimeoutMs / 1000}s. A readiness timeout leaves the job running. Captured output is retained in a bounded tail and tool output is limited to ${DEFAULT_MAX_LINES} lines/${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Start a long-running server or watcher in a managed background process",
		promptGuidelines: [
			"Use background_start for long-running servers and watchers instead of appending '&' in bash.",
			"After background_start reports readiness, use bash or another foreground tool to call and test the background service.",
		],
		parameters: Type.Object({
			command: Type.String({
				minLength: 1,
				maxLength: COMMAND_MAX_LENGTH,
				pattern: "\\S",
				description: "Shell command to run in the current working directory; keep the server in the foreground",
			}),
			name: Type.Optional(
				Type.String({ minLength: 1, maxLength: NAME_MAX_LENGTH, pattern: "\\S", description: "Short job label" }),
			),
			ready_pattern: Type.Optional(
				Type.String({
					minLength: 1,
					maxLength: PATTERN_MAX_LENGTH,
					description: "Optional output substring or safe JavaScript regex that indicates readiness",
				}),
			),
			ready_pattern_type: Type.Optional(StringEnum(READINESS_PATTERN_TYPES)),
			ready_timeout_seconds: Type.Optional(
				Type.Number({ minimum: 0.1, maximum: 600, description: "Readiness wait timeout in seconds" }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!params.ready_pattern && (params.ready_pattern_type || params.ready_timeout_seconds !== undefined)) {
				throw new Error("ready_pattern is required when readiness options are provided");
			}
			const name = params.name ? normalizeInline(params.name) : undefined;
			if (params.name && !name) throw new Error("name cannot contain only control characters");
			const patternType: ReadinessPatternType = params.ready_pattern_type ?? "substring";
			const readiness = params.ready_pattern
				? {
						pattern: params.ready_pattern,
						type: patternType,
						timeoutMs: Math.round(
							(params.ready_timeout_seconds ?? config.defaultReadinessTimeoutMs / 1000) * 1000,
						),
					}
				: undefined;
			const result = await manager.start({
				command: params.command,
				name,
				cwd: ctx.cwd,
				env: sessionEnvironment(ctx),
				readiness,
				signal,
			});
			const metadata = `[job=${result.job.id} status=${result.job.status} readiness=${result.job.readiness.status} next_cursor=${result.logs.nextCursor}]`;
			const combined = result.logs.text ? `${result.logs.text}\n\n${metadata}` : metadata;
			const limited = limitTail(combined, `Use background_logs with id ${result.job.id} for retained output.`);
			return {
				content: [{ type: "text", text: limited.text }],
				details: {
					job: summarizeJob(result.job),
					logs: summarizeLogs(result.logs),
					truncation: limited.truncation,
				} as StartToolDetails,
			};
		},
		renderCall(args, theme) {
			const label = args.name ? ` (${normalizeInline(args.name)})` : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("background_start"))}${theme.fg("accent", label)} ${theme.fg("muted", commandPreview(args.command))}`,
				0,
				0,
			);
		},
		renderResult(result, options, theme) {
			const details = result.details as StartToolDetails | undefined;
			if (!details) return new Text(resultText(result.content), 0, 0);
			const readinessColor = details.job.readinessStatus === "ready" ? "success" : "warning";
			let text = `${theme.fg("success", "✓")} ${theme.fg("accent", details.job.id)} ${theme.fg("muted", details.job.status)} ${theme.fg(readinessColor, `readiness=${details.job.readinessStatus}`)}`;
			if (options.expanded && details.logs.excerpt) text += `\n${theme.fg("toolOutput", details.logs.excerpt)}`;
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "background_list",
		label: "Background List",
		description: "List session-scoped background jobs, including completed jobs retained until session end.",
		promptSnippet: "List managed background processes and their state",
		parameters: Type.Object({
			status: Type.Optional(StringEnum(JOB_STATUSES, { description: "Optional status filter" })),
		}),
		async execute(_toolCallId, params) {
			const jobs = manager.list(params.status);
			const activeJobs = jobs.filter((job) => manager.canKill(job.id)).length;
			const output = jobs.length > 0
				? [`${jobs.length} background job(s), ${activeJobs} active`, ...jobs.map(formatBackgroundJob)].join("\n")
				: "No background jobs.";
			const limited = limitHead(output, "Use a status filter or /ps to narrow the list.");
			return {
				content: [{ type: "text", text: limited.text }],
				details: {
					jobs: jobs.slice(0, DETAILS_MAX_JOBS).map(summarizeJob),
					totalJobs: jobs.length,
					activeJobs,
					detailsTruncated: jobs.length > DETAILS_MAX_JOBS,
					truncation: limited.truncation,
				} as ListToolDetails,
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("background_list")), 0, 0);
		},
		renderResult(result, options, theme) {
			const details = result.details as ListToolDetails | undefined;
			if (!details) return new Text(resultText(result.content), 0, 0);
			if (details.totalJobs === 0) return new Text(theme.fg("dim", "No background jobs"), 0, 0);
			let text = theme.fg("muted", `${details.totalJobs} job(s), ${details.activeJobs} active`);
			if (options.expanded) {
				text += `\n${details.jobs.map((job) => theme.fg("dim", job.line)).join("\n")}`;
				if (details.detailsTruncated) text += `\n${theme.fg("warning", "Additional jobs omitted from rendered details")}`;
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "background_logs",
		label: "Background Logs",
		description:
			`Read retained output for a background job. Pass the previous next_cursor to receive only newer output. Output is limited to ${DEFAULT_MAX_LINES} lines/${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Read new or recent output from a managed background process",
		parameters: Type.Object({
			id: Type.String({ pattern: JOB_ID_PATTERN, description: "Background job ID, for example bg-1" }),
			cursor: Type.Optional(
				Type.Integer({ minimum: 0, description: "Opaque next_cursor returned by a previous background_logs call" }),
			),
			tail_lines: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: DEFAULT_MAX_LINES,
					description:
						"Maximum lines to return. Without a cursor these are the newest lines; with a cursor they are the next lines following it.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const pageLines = Math.min(
				params.tail_lines ?? DEFAULT_MAX_LINES - LOG_PAGE_METADATA_RESERVE_LINES,
				DEFAULT_MAX_LINES - LOG_PAGE_METADATA_RESERVE_LINES,
			);
			const logs = manager.readLogs(params.id, {
				cursor: params.cursor,
				tailLines: pageLines,
				maxBytes: DEFAULT_MAX_BYTES - LOG_PAGE_METADATA_RESERVE_BYTES,
			});
			const body = logs.text || "(no new output)";
			const metadata = `[job=${logs.job.id} status=${logs.job.status} start_cursor=${logs.startCursor} next_cursor=${logs.nextCursor} retained_start_cursor=${logs.job.logStartCursor} dropped_before=${logs.droppedBefore}]`;
			const notices: string[] = [];
			if (logs.droppedBefore) notices.push("requested cursor predates retained output");
			if (logs.truncatedToTail) {
				notices.push(
					params.cursor === undefined
						? `limited to the newest ${pageLines} lines/${formatSize(DEFAULT_MAX_BYTES - LOG_PAGE_METADATA_RESERVE_BYTES)}`
						: `more output remains; continue from cursor ${logs.nextCursor}`,
				);
			}
			const suffix = notices.length > 0 ? `${metadata}\n[${notices.join("; ")}]` : metadata;
			const limited = limitTail(`${body}\n\n${suffix}`, `Call background_logs again with cursor ${logs.nextCursor} for newer output.`);
			return {
				content: [{ type: "text", text: limited.text }],
				details: { logs: summarizeLogs(logs), truncation: limited.truncation } as LogsToolDetails,
			};
		},
		renderCall(args, theme) {
			const cursor = args.cursor === undefined ? "" : theme.fg("dim", ` cursor=${args.cursor}`);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("background_logs"))} ${theme.fg("accent", args.id)}${cursor}`,
				0,
				0,
			);
		},
		renderResult(result, options, theme) {
			const details = result.details as LogsToolDetails | undefined;
			if (!details) return new Text(resultText(result.content), 0, 0);
			const output = details.logs.excerpt || "(no new output)";
			const visible = options.expanded ? output : tailLines(output, 8);
			let text = theme.fg("toolOutput", visible);
			text += `\n${theme.fg("dim", `next_cursor=${details.logs.nextCursor} status=${details.logs.job.status}`)}`;
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "background_kill",
		label: "Background Kill",
		description: "Gracefully stop a managed background process group with SIGTERM, escalating to SIGKILL after the grace period.",
		promptSnippet: "Stop a managed background process and its descendants",
		parameters: Type.Object({
			id: Type.String({ pattern: JOB_ID_PATTERN, description: "Background job ID, for example bg-1" }),
		}),
		async execute(_toolCallId, params) {
			const before = manager.get(params.id);
			if (!before) throw new Error(`Unknown background job: ${params.id}`);
			const job = await manager.kill(params.id);
			const unchanged = before.status === job.status && (job.status === "exited" || job.status === "killed" || job.status === "failed");
			return {
				content: [{ type: "text", text: unchanged ? `${job.id} was already ${job.status}.` : `Stopped ${formatBackgroundJob(job)}` }],
				details: { job: summarizeJob(job) } as KillToolDetails,
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("background_kill"))} ${theme.fg("accent", args.id)}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const details = result.details as KillToolDetails | undefined;
			if (!details) return new Text(resultText(result.content), 0, 0);
			return new Text(
				`${theme.fg("success", "✓")} ${theme.fg("accent", details.job.id)} ${theme.fg("muted", details.job.status)}`,
				0,
				0,
			);
		},
	});
}
