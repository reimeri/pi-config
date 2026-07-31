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
			return "was aborted: it may have already changed files";
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
