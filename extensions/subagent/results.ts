/**
 * Child-run results: how a finished subagent run is classified and rendered into
 * the text the parent agent reads.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { AgentSource } from "./agents.ts";
import type { WorkspaceReport } from "./workspace.ts";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	agentSource: AgentSource | "unknown";
	task: string;
	exitCode: number;
	/** Child messages, kept for rendering and stripped of what is never rendered. */
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	failureKind?: "concurrency";
	step?: number;
	/** Working-tree changes observed around the run, for agents that opt in. */
	workspace?: WorkspaceReport;
	/** Reused child session, when the call supplied a sessionKey. No `run` means none could be made. */
	session?: { key: string; run?: number };
	/** The run stopped waiting for a child that had not exited, so that child may still be working. */
	childOutlivedRun?: boolean;
}

/**
 * The note telling the parent how far a reused session has grown.
 *
 * A resumed child accumulates context across runs, so the parent needs to see that number to know
 * when a sequence has gone on long enough to warrant a fresh key — otherwise the first sign is the
 * run that stops against its output limit.
 *
 * A key with no run number is one the tool could not honour. That has to be said out loud: the
 * parent wrote its task as a delta against context the child turns out not to have, so a reply that
 * misses the point is the tool's doing rather than the agent's.
 */
export function formatSessionNote(result: SingleResult, formatTokens: (count: number) => string): string {
	if (!result.session) return "";
	const { key, run } = result.session;
	if (run === undefined)
		return `[Subagent session "${key}" was unavailable, so this run started with fresh context and kept nothing from earlier runs. Anything the task assumed the agent already knew has to be restated.]`;
	const context = result.usage.contextTokens;
	const size = context > 0 ? `, child context ~${formatTokens(context)} tokens` : "";
	return `[Subagent session "${key}", run ${run}${size}.]`;
}

/**
 * A child message reduced to the parts the parent will actually render.
 *
 * Everything here is stored per run and persisted with the tool result, so what is kept is paid for
 * in session file size, load time, and export time for the life of the conversation. Only assistant
 * text and tool calls are ever read back — by `getDisplayItems` and `getFinalOutput` — so reasoning
 * is dropped, and so is every tool result, whose output the renderers never look at. Measured over
 * real sessions those two were 94% of the stored bytes.
 *
 * The tool *call* survives, so an aborted editing run still records which files it was working on.
 * Returns undefined for a message with nothing worth keeping.
 */
export function messageForDisplay(message: Message): Message | undefined {
	if (message.role !== "assistant") return undefined;
	const content = message.content.filter((part) => part.type !== "thinking");
	// A turn that errored or was aborted mid-reasoning is nothing but thinking, and what is left of it
	// once that goes is a message no renderer can show: metadata paid for in bytes, for nothing.
	if (content.length === 0) return undefined;
	return { ...message, content };
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> };

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** A run that never produced child messages: unknown agent, blocked group, or a failed spawn. */
export function failureResult(params: {
	agent: string;
	task: string;
	message: string;
	agentSource?: AgentSource | "unknown";
	model?: string;
	failureKind?: "concurrency";
	/** Set when the run failed for a reason `describeFailure` already words well, such as an abort. */
	stopReason?: string;
	step?: number;
}): SingleResult {
	return {
		agent: params.agent,
		agentSource: params.agentSource ?? "unknown",
		task: params.task,
		exitCode: 1,
		messages: [],
		stderr: params.message,
		usage: emptyUsage(),
		model: params.model,
		failureKind: params.failureKind,
		stopReason: params.stopReason,
		step: params.step,
	};
}

/**
 * `length` means the child was cut off by its output limit, mid-run. Its work is
 * unfinished and whatever text it had emitted is not a completion report, so it
 * must not reach the parent as a success.
 */
export function isFailedResult(result: SingleResult): boolean {
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted" ||
		result.stopReason === "length"
	);
}

/** Short, self-explaining reason for a failed run, for the line the parent agent reads. */
export function describeFailure(result: SingleResult): string {
	switch (result.stopReason) {
		case "length":
			return "hit its output limit mid-run: the work it describes is incomplete and any files it touched may be half-edited";
		case "aborted":
			// A child that outlived the run is the one case where no message proves anything: the run
			// stopped reading its output while it was still alive, so what it does next is unknown and
			// unbounded rather than merely unrecorded.
			if (result.childOutlivedRun)
				return "was aborted but its child did not exit: it may still be running and changing files";
			// A child cannot have edited anything without first emitting the assistant turn that
			// requested the tool, so an abort with no messages — one that landed while the run was
			// still queued for its concurrency group or session — is known to have changed nothing.
			// Warning about files either way would train the parent to ignore the warning.
			return result.messages.length === 0
				? "was aborted before it started, leaving the workspace untouched"
				: "was aborted: it may have already changed files";
		case "error":
			return "failed with an error";
		default:
			return result.exitCode > 0 ? `failed (exit code ${result.exitCode})` : "failed";
	}
}

/** Text of the last assistant message that carries any, i.e. the child's report. */
export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

/**
 * What the parent agent is given for a run.
 *
 * On the failure path the child's text is deliberately labelled rather than
 * returned bare: an aborted or truncated run ends on whatever it happened to be
 * narrating, and that reads exactly like a completion report. The parent has to
 * be able to tell the difference.
 */
export function getResultOutput(result: SingleResult): string {
	if (!isFailedResult(result)) return getFinalOutput(result.messages) || "(no output)";

	const sections: string[] = [];
	const reason = result.errorMessage?.trim() || result.stderr.trim();
	if (reason) sections.push(reason);
	const partial = getFinalOutput(result.messages).trim();
	if (partial) sections.push(`Last output before failure (partial, not a completion report):\n\n${partial}`);
	return sections.join("\n\n") || "(no output)";
}

export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}
