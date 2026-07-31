
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

/** Formats session reuse status and run number for the parent. */
export function formatSessionNote(result: SingleResult, formatTokens: (count: number) => string): string {
	if (!result.session) return "";
	const { key, run } = result.session;
	if (run === undefined)
		return `[Subagent session "${key}" was unavailable, so this run started with fresh context and kept nothing from earlier runs. Anything the task assumed the agent already knew has to be restated.]`;
	const context = result.usage.contextTokens;
	const size = context > 0 ? `, child context ~${formatTokens(context)} tokens` : "";
	return `[Subagent session "${key}", run ${run}${size}.]`;
}

/** Retains assistant text and tool calls needed by renderers, excluding thinking and tool results. */
export function messageForDisplay(message: Message): Message | undefined {
	if (message.role !== "assistant") return undefined;
	const content = message.content.filter((part) => part.type !== "thinking");
	// Drop messages that become invisible after thinking is removed.
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

/** Treat output-limit termination as unfinished regardless of exit code. */
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
			// A live child may continue producing unknown changes after reading stops.
			if (result.childOutlivedRun)
				return "was aborted but its child did not exit: it may still be running and changing files";
			// No messages means no tool call was requested, so a queued abort cannot have edited files.
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

/** Formats parent-visible output, labeling failures and partial output. */
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
