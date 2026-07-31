/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import {
	AgentConcurrencyGate,
	findChainConcurrencyConflicts,
	findParallelConcurrencyConflict,
	GATE_WAIT_MS,
	type GateFailure,
} from "./concurrency.ts";
import { LineStream } from "./line-stream.ts";
import {
	CHILD_TERMINATION_GRACE_MS,
	shouldFinishOnChildError,
	terminateWithEscalation,
} from "./process-control.ts";
import { OutputOverflowStore } from "./overflow.ts";
import { discoverExtensionAgents } from "./protocol.ts";
import { findDuplicateSessionKey, SubagentSessionStore } from "./session-store.ts";
import { planTaskDelivery } from "./task-delivery.ts";
import {
	type DisplayItem,
	describeFailure,
	emptyUsage,
	failureResult,
	formatSessionNote,
	getDisplayItems,
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	messageForDisplay,
	type SingleResult,
} from "./results.ts";
import {
	buildWorkspaceReport,
	captureWorkspaceSnapshot,
	formatWorkspaceReport,
	summarizeWorkspaceReport,
	type WorkspaceSnapshot,
	workspaceReportLines,
} from "./workspace.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

/** Turn a thrown spawn/setup failure into a reportable result instead of losing the whole call. */
async function runSafely(
	agent: string,
	task: string,
	step: number | undefined,
	run: () => Promise<SingleResult>,
): Promise<SingleResult> {
	try {
		return await run();
	} catch (error) {
		return failureResult({ agent, task, step, message: error instanceof Error ? error.message : String(error) });
	}
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

/**
 * The files one child run is handed: its system prompt, and its task when that is too large to be a
 * command-line argument. One directory per run, created only when something needs it and removed
 * with its contents once the run is done with them.
 */
class ChildTempFiles {
	private dir: string | null = null;

	/** Callers write sequentially within a run, so the lazy directory needs no locking. */
	async write(name: string, contents: string): Promise<string> {
		this.dir ??= await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
		const filePath = path.join(this.dir, name);
		await withFileMutationQueue(filePath, async () => {
			await fs.promises.writeFile(filePath, contents, { encoding: "utf-8", mode: 0o600 });
		});
		return filePath;
	}

	remove(): void {
		if (!this.dir) return;
		try {
			// Recursive and forcing, so residue cannot strand the directory: a write that failed after
			// creating its file leaves one this run never learned the name of, and a file the child
			// still holds open cannot be unlinked on Windows at all. Either would defeat a plain
			// `rmdir`, and the leftovers hold the task text.
			fs.rmSync(this.dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
		this.dir = null;
	}
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/**
 * Why a session key could not be taken, said in terms of what the parent should do next.
 *
 * `abandoned` is the case worth separating: the child from a previous run never exited and still has
 * the file open, so unlike an ordinary busy key this one is not going to free up and telling the
 * parent to wait would send it in circles for the rest of the conversation.
 */
/**
 * Why a concurrency group could not be taken, said in terms of what the parent should do next.
 *
 * `abandoned` is per-run here rather than permanent, unlike a session's: the run that held the group
 * gave up on a child that never exited, so the group is not passed to whoever was queued behind it,
 * but a later run the parent decides to launch can still have it.
 */
function groupBusyMessage(reason: GateFailure, group: string | undefined, agentName: string): string {
	switch (reason) {
		case "aborted":
			return `Subagent was aborted while queued for concurrency group "${group}".`;
		case "abandoned":
			return `Agent concurrency group "${group}" was not handed on: the run holding it stopped waiting for a child that never exited, and that child may still be changing files. Check what it left behind before launching another ${agentName}.`;
		default:
			return `Agent concurrency group "${group}" was still held after waiting ${formatDuration(GATE_WAIT_MS)}. The run holding it has been going that long and may be stuck; check on it before delegating more work to this group.`;
	}
}

function sessionBusyMessage(reason: GateFailure, sessionKey: string, agentName: string): string {
	switch (reason) {
		case "aborted":
			return `Subagent was aborted while queued for session "${sessionKey}".`;
		case "abandoned":
			return `Subagent session "${sessionKey}" cannot be reused: the child from its previous run never exited and still has the session file open. Use a different sessionKey, and restate anything the task assumed that session already held.`;
		default:
			return `Subagent session "${sessionKey}" was still in use by a running ${agentName} after waiting ${formatDuration(GATE_WAIT_MS)}. Wait for it to finish, or use a different sessionKey.`;
	}
}

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	concurrencyGate: AgentConcurrencyGate,
	sessionKey: string | undefined,
	sessions: SubagentSessionStore,
	sessionGate: AgentConcurrencyGate,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return failureResult({
			agent: agentName,
			task,
			step,
			message: `Unknown agent: "${agentName}". Available agents: ${available}.`,
		});
	}

	const tempFiles = new ChildTempFiles();
	let releaseSession: (() => void) | undefined;
	let heldSessionId: string | undefined;
	// Set on the paths that stop waiting for a child that has not exited. Its session file is still
	// open to it, so the lock on that session must not come back. Read in the `finally`, hence out
	// here rather than beside the run it belongs to.
	let childOutlivedRun = false;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: agent.model,
		step,
	};

	let status = "(running...)";
	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || status }],
				details: makeDetails([currentResult]),
			});
		}
	};

	const workingDir = cwd ?? defaultCwd;

	const queuedForGroup = concurrencyGate.isActive(agent.concurrencyGroup);
	if (queuedForGroup) {
		// The wait is silent otherwise, and a worker that has not started looks identical to one that
		// started and has yet to say anything.
		status = `(waiting for concurrency group "${agent.concurrencyGroup}"...)`;
		emitUpdate();
	}
	const concurrency = await concurrencyGate.acquire(agent.concurrencyGroup, { timeoutMs: GATE_WAIT_MS, signal });
	status = "(running...)";
	if (!concurrency.ok) {
		return failureResult({
			agent: agent.name,
			agentSource: agent.source,
			task,
			step,
			model: agent.model,
			failureKind: concurrency.reason === "aborted" ? undefined : "concurrency",
			stopReason: concurrency.reason === "aborted" ? "aborted" : undefined,
			message: groupBusyMessage(concurrency.reason, agent.concurrencyGroup, agent.name),
		});
	}
	// The waiting text is the last thing the parent was shown, and nothing else emits until the child
	// speaks — which for an editing worker is a minute of spawn and first turn after the wait ended.
	if (queuedForGroup) emitUpdate();
	const releaseConcurrency = concurrency.release;

	// Session flags are decided below, once the store has answered; everything before that point is
	// identical between runs of one session, which is what lets the provider cache the prefix.
	const args: string[] = ["--mode", "json", "-p", "--exclude-tools", "subagent"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.thinking) args.push("--thinking", agent.thinking);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	try {
		const session = sessionKey ? await sessions.resolve({ agent: agent.name, cwd: workingDir, sessionKey }) : undefined;
		if (sessionKey && session) {
			// Two children writing one session file would interleave their histories into something
			// neither of them wrote.
			const queuedForSession = sessionGate.isActive(session.id);
			if (queuedForSession) {
				status = `(waiting for subagent session "${sessionKey}"...)`;
				emitUpdate();
			}
			const held = await sessionGate.acquire(session.id, { timeoutMs: GATE_WAIT_MS, signal });
			status = "(running...)";
			if (queuedForSession && held.ok) emitUpdate();
			if (!held.ok) {
				return failureResult({
					agent: agent.name,
					agentSource: agent.source,
					task,
					step,
					model: agent.model,
					stopReason: held.reason === "aborted" ? "aborted" : undefined,
					message: sessionBusyMessage(held.reason, sessionKey, agent.name),
				});
			}
			releaseSession = held.release;
			heldSessionId = session.id;
			args.push("--session-id", session.id, "--session-dir", session.dir);
			currentResult.session = { key: sessionKey, run: session.begin() };
		} else {
			args.push("--no-session");
			// A key that could not be given a session leaves the child with none, and the parent asked
			// for continuity precisely because its task text assumes it — a delta that names work the
			// child is supposed to already remember. Recording the key without a run number makes the
			// result say so rather than let the parent read a confused reply as the agent's judgement.
			if (sessionKey) currentResult.session = { key: sessionKey };
		}

		if (agent.systemPrompt.trim()) {
			const safeName = agent.name.replace(/[^\w.-]+/g, "_");
			args.push("--append-system-prompt", await tempFiles.write(`prompt-${safeName}.md`, agent.systemPrompt));
		}

		// Taken after the concurrency gate is held and released only in the `finally` below, so no
		// second run of the same group can move the tree between these two observations.
		let workspaceBefore: WorkspaceSnapshot | undefined;
		let workspaceCaptureFailure: string | undefined;
		if (agent.captureDiff) {
			const captured = await captureWorkspaceSnapshot(workingDir);
			if (captured.ok) workspaceBefore = captured.snapshot;
			else workspaceCaptureFailure = captured.reason;
		}

		// Last, so a task large enough to need a file is written only once the run is certain to
		// start — after the gates, and after the workspace snapshot that a failure here would strand.
		const delivery = planTaskDelivery(task);
		if (delivery.kind === "file") args.push(`@${await tempFiles.write(delivery.fileName, delivery.contents)}`);
		args.push(delivery.argument);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					const stored = messageForDisplay(msg);
					if (stored) currentResult.messages.push(stored);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				// `tool_result_end` carries the child's tool output, which no renderer reads and which
				// was the bulk of what every run persisted. The assistant message that requested the
				// tool is kept, so the call and its arguments still appear.
			};

			const stdoutLines = new LineStream(processLine);
			let settled = false;
			let spawned = false;
			let cancelEscalation: (() => void) | undefined;
			let abandonTimer: ReturnType<typeof setTimeout> | undefined;
			let killProc: (() => void) | undefined;
			const cleanup = () => {
				cancelEscalation?.();
				cancelEscalation = undefined;
				if (abandonTimer) clearTimeout(abandonTimer);
				abandonTimer = undefined;
				if (signal && killProc) signal.removeEventListener("abort", killProc);
			};
			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				stdoutLines.end();
				cleanup();
				resolve(code);
			};
			// Stop waiting for a "close" that is not coming. Hanging here would keep
			// the whole tool call pending for the rest of the session, and the
			// agent's concurrency group with it.
			const abandonAfter = (delayMs: number) => {
				if (settled || abandonTimer) return;
				abandonTimer = setTimeout(() => {
					childOutlivedRun = true;
					finish(1);
				}, delayMs);
				abandonTimer.unref?.();
			};

			proc.stdout.on("data", (data: Buffer) => {
				stdoutLines.write(data);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.once("spawn", () => {
				spawned = true;
			});
			proc.on("close", (code) => finish(code ?? 0));
			proc.on("error", (error) => {
				currentResult.stderr += `${currentResult.stderr ? "\n" : ""}${error.message}`;
				// A child that spawned still owes a "close" carrying its real exit code,
				// so an error must not settle the run on its own. It does mean something
				// went wrong with the handle, so bound the wait for that close.
				if (shouldFinishOnChildError(spawned)) finish(1);
				else abandonAfter(CHILD_TERMINATION_GRACE_MS);
			});

			if (signal) {
				killProc = () => {
					if (wasAborted || settled) return;
					wasAborted = true;
					cancelEscalation = terminateWithEscalation(proc, {
						onUnterminated: () => {
							childOutlivedRun = true;
							finish(1);
						},
					});
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		// Carried into the result because it changes what the messages mean: they stop at the moment
		// the run gave up reading, not at the moment the child stopped working.
		if (childOutlivedRun) currentResult.childOutlivedRun = true;
		// Deliberately not passed the abort signal: an aborted worker is exactly the case where the
		// parent most needs to know which files were left changed.
		if (agent.captureDiff) {
			currentResult.workspace = await buildWorkspaceReport(workingDir, workspaceBefore, workspaceCaptureFailure);
		}
		if (wasAborted) {
			// Returning the run rather than throwing it away is the whole point: an aborted worker
			// may already have edited files, and the messages collected so far are the only record
			// of which ones. A throw here also took every finished sibling in a parallel batch down
			// with it. `isFailedResult` keeps this an error; a signalled child reports exit code 0.
			currentResult.stopReason = "aborted";
			currentResult.errorMessage ??= "Subagent was aborted before it finished.";
		}
		return currentResult;
	} finally {
		// Deliberately not released when the child outlived the run: it still has the session file
		// open, and a second pi appending to the same file would interleave two histories into one
		// neither of them wrote. Holding the key costs the parent a session; releasing it costs the
		// transcript. Abandoning rather than simply not releasing is what stops the next run from
		// queuing for minutes on a key nobody is coming back to. The concurrency group is released
		// either way, as it always was — waiting on a process that may never exit would block the
		// agent for the rest of the conversation — but it is not handed to whoever is queued behind
		// it: that child is still alive and may still be editing, and the queue would put a second
		// worker in the same tree without anyone having read why the first one was given up on.
		if (childOutlivedRun) {
			sessionGate.abandon(heldSessionId);
			concurrencyGate.dropWaiters(agent.concurrencyGroup);
		} else releaseSession?.();
		releaseConcurrency();
		// Both files are read by the child while it starts, so a child that exited is done with them.
		// One that outlived the run may not have got there yet, and its task arrives as an `@file`,
		// which pi exits on when it is missing rather than degrading the way an absent
		// `--append-system-prompt` path does. Deleting them would kill the child this path exists to
		// let keep working, so they are left for the OS to reap.
		if (!childOutlivedRun) tempFiles.remove();
	}
}

const SESSION_KEY_DESCRIPTION =
	"Optional label that reuses a prior child session. Two calls to the same agent with the same sessionKey share one context: the second starts already holding what the first read and concluded, so its task can be a short delta instead of a full re-briefing. Use it for successive tasks on the same code; omit it to start fresh, which is the default and the right choice for unrelated work. Sessions are separate per agent and per working directory, last only for this conversation, and cannot be used by two runs at once.";

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	sessionKey: Type.Optional(Type.String({ description: SESSION_KEY_DESCRIPTION })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	sessionKey: Type.Optional(Type.String({ description: SESSION_KEY_DESCRIPTION })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	sessionKey: Type.Optional(Type.String({ description: `${SESSION_KEY_DESCRIPTION} (single mode)` })),
});

export default function (pi: ExtensionAPI) {
	const concurrencyGate = new AgentConcurrencyGate();
	// Keyed by session id rather than by agent, so unrelated sessions of the same agent stay free to
	// run while one of them is busy.
	const sessionGate = new AgentConcurrencyGate();
	const sessions = new SubagentSessionStore();
	// Caps what reaches the parent's context in every mode. Parallel fans out and was capped from the
	// start, but a single worker report or chain step lands in the same context window and had none.
	const overflow = new OutputOverflowStore();

	/**
	 * What one run contributes to the parent's context: the agent's own report, capped, followed by
	 * what the tool observed of the workspace. The observation is appended after the cap so it can
	 * never be the part that gets truncated away — it is small, and it is the part the agent did not
	 * write itself.
	 */
	const reportForParent = async (result: SingleResult): Promise<string> => {
		const capped = await overflow.capForParent(result.agent, getResultOutput(result));
		const trailer = [formatWorkspaceReport(result.workspace), formatSessionNote(result, formatTokens)].filter(Boolean);
		return trailer.length > 0 ? `${capped}\n\n${trailer.join("\n\n")}` : capped;
	};

	pi.on("session_shutdown", () => {
		overflow.dispose();
		sessions.dispose();
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate substantial codebase exploration to the scout agent, independent code review to the reviewer agent, and broader web research to the researcher agent.",
			"Every child starts with fresh isolated context and does not automatically receive the parent conversation or context from prior subagent invocations; share context explicitly in the task, including with chain mode's {previous} placeholder.",
			"The exception is sessionKey: repeating it sends a follow-up task to the same child, which still cannot see the parent conversation but does keep everything from its own earlier runs.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder). Agents that mutate the workspace cannot run in chain mode; give each one its own single call so you can inspect its result before delegating the next task.",
			"Long agent output is capped; when it is, the result ends with a notice giving the path to a file holding the full text, which you can read if the omitted part matters.",
			"Results for agents that change files end with an \"Observed workspace changes\" section measured by this tool rather than reported by the agent; reconcile it against what the agent claims it changed.",
			"Make every task self-contained; for follow-up work, include the relevant prior findings and context instead of assuming the agent remembers them.",
			`Models, thinking levels, tools, and prompts are configured in agent Markdown files under ${path.join(getAgentDir(), "agents")}.`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		promptSnippet: "Delegate isolated codebase exploration, independent code review, and broader web research to specialized subagents",
		promptGuidelines: [
			"Use subagent with the scout agent for broad codebase exploration that would consume substantial main-agent context.",
			"Use subagent with the reviewer agent for an independent review after meaningful code changes.",
			"Use subagent with the researcher agent for broader web research that benefits from source evaluation and evidence-backed synthesis.",
			"Every subagent invocation starts with fresh context and does not automatically receive the parent conversation or prior subagent calls; pass needed context explicitly in the task (chain mode may use {previous}) and never assume agent memory.",
			"Give subagent focused, self-contained tasks with the relevant requirements, paths, symbols, constraints, and acceptance criteria; do not delegate trivial lookups, and verify consequential findings before editing.",
			"For follow-up tasks, include a concise handoff of the prior findings, affected locations, failure scenarios, and expected resolution; quote prior output when exact details matter rather than referring to 'your previous review'.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const extensionAgents = discoverExtensionAgents(pi.events, ctx.cwd);
			const discovery = discoverAgents(ctx.cwd, agentScope, extensionAgents);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const chainConflicts = findChainConcurrencyConflicts(
					agents,
					params.chain.map((step) => step.agent),
				);
				if (chainConflicts.length > 0) {
					const named = chainConflicts.map((c) => `${c.agent} (group "${c.group}")`).join(", ");
					return {
						content: [
							{
								type: "text",
								text:
									`Chain mode cannot include workspace-mutating agents: ${named}. ` +
									"Run each one as its own single subagent call, so the result of each can be inspected and " +
									"verified before the next task is delegated.",
							},
						],
						details: makeDetails("chain")([]),
						isError: true,
					};
				}

				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					// Replacer function, not a replacement string: `$&`, `$'`, "$`", and `$1`
					// occurring in a prior agent's output must be inserted literally.
					const taskWithContext = step.task.replace(/\{previous\}/g, () => previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSafely(step.agent, taskWithContext, i + 1, () =>
						runSingleAgent(
							ctx.cwd,
							agents,
							step.agent,
							taskWithContext,
							step.cwd,
							i + 1,
							signal,
							chainUpdate,
							makeDetails("chain"),
							concurrencyGate,
							step.sessionKey,
							sessions,
							sessionGate,
						),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = await reportForParent(result);
						return {
							content: [
								{
									type: "text",
									text: `Chain stopped at step ${i + 1} (${step.agent}), which ${describeFailure(result)}: ${errorMsg}`,
								},
							],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				const last = results[results.length - 1];
				return {
					content: [{ type: "text", text: await reportForParent(last) }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				const requestedAgentNames = params.tasks.map((task) => task.agent);
				const concurrencyConflict = findParallelConcurrencyConflict(agents, requestedAgentNames);
				if (concurrencyConflict) {
					return {
						content: [{
							type: "text",
							text: `Parallel tasks cannot include multiple agents from concurrency group "${concurrencyConflict}". Run editing workers sequentially.`,
						}],
						details: makeDetails("parallel")([]),
						isError: true,
					};
				}
				const duplicateSessionKey = findDuplicateSessionKey(params.tasks, ctx.cwd);
				if (duplicateSessionKey) {
					return {
						content: [
							{
								type: "text",
								text: `Parallel tasks cannot share sessionKey "${duplicateSessionKey}" for the same agent and working directory: one session cannot hold two runs at once. Give them different keys, or run them sequentially.`,
							},
						],
						details: makeDetails("parallel")([]),
						isError: true,
					};
				}
				// A group already held by another tool call no longer rejects the batch. The one task
				// that needs it queues for it, which is what the parent asked for, while its read-only
				// siblings — the reason the batch was parallel — run immediately instead of being
				// thrown away over a conflict none of them had. The waiting task does occupy one of
				// the MAX_CONCURRENCY slots while it queues, but `findParallelConcurrencyConflict`
				// above caps that at one task per group, so it cannot stall the batch.

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: emptyUsage(),
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				// One task's failure must not discard its siblings' finished work, so each is contained
				// here rather than allowed to reject the whole batch.
				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSafely(t.agent, t.task, undefined, () =>
						runSingleAgent(
							ctx.cwd,
							agents,
							t.agent,
							t.task,
							t.cwd,
							undefined,
							signal,
							// Per-task update callback
							(partial) => {
								const inProgress = partial.details?.results[0];
								if (inProgress) {
									// A partial carries the run's initial exit code of 0, which is the sentinel
									// for a finished, successful task. Keeping the placeholder's -1 is what makes
									// a task still running — or, since the gate learned to queue, one that has
									// not started at all — count and render as running rather than as done.
									allResults[index] = { ...inProgress, exitCode: -1 };
									emitParallelUpdate();
								}
							},
							makeDetails("parallel"),
							concurrencyGate,
							t.sessionKey,
							sessions,
							sessionGate,
						),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = await Promise.all(
					results.map(async (r) => {
						const output = await reportForParent(r);
						const status = isFailedResult(r) ? describeFailure(r) : "completed";
						return `### [${r.agent}] ${status}\n\n${output}`;
					}),
				);
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
					isError: results.some((result) => result.failureKind === "concurrency"),
				};
			}

			if (params.agent && params.task) {
				const agentName = params.agent;
				const task = params.task;
				const result = await runSafely(agentName, task, undefined, () =>
					runSingleAgent(
						ctx.cwd,
						agents,
						agentName,
						task,
						params.cwd,
						undefined,
						signal,
						onUpdate,
						makeDetails("single"),
						concurrencyGate,
						params.sessionKey,
						sessions,
						sessionGate,
					),
				);
				const isError = isFailedResult(result);
				const output = await reportForParent(result);
				if (isError) {
					return {
						content: [{ type: "text", text: `Agent ${result.agent} ${describeFailure(result)}.\n\n${output}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: output }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			/** Observed workspace changes, listed when expanded and summarized when not. */
			const workspaceComponents = (result: SingleResult): Component[] => {
				const summary = summarizeWorkspaceReport(result.workspace);
				if (!summary) return [];
				const color = result.workspace?.status === "unavailable" ? "warning" : "accent";
				const parts: Component[] = [new Text(theme.fg(color, `⌂ ${summary}`), 0, 0)];
				if (result.workspace?.status === "captured") {
					for (const line of workspaceReportLines(result.workspace)) {
						parts.push(new Text(theme.fg("dim", `  ${line}`), 0, 0));
					}
				}
				return parts;
			};

			const workspaceSummaryLine = (result: SingleResult): string => {
				const summary = summarizeWorkspaceReport(result.workspace);
				if (!summary) return "";
				const color = result.workspace?.status === "unavailable" ? "warning" : "accent";
				return `\n${theme.fg(color, `⌂ ${summary}`)}`;
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const workspaceParts = workspaceComponents(r);
					if (workspaceParts.length > 0) {
						container.addChild(new Spacer(1));
						for (const part of workspaceParts) container.addChild(part);
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				text += workspaceSummaryLine(r);
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						for (const part of workspaceComponents(r)) container.addChild(part);
						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
					text += workspaceSummaryLine(r);
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						for (const part of workspaceComponents(r)) container.addChild(part);
						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
					text += workspaceSummaryLine(r);
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
