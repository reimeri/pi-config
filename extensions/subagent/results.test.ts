import type { AssistantMessage, Message, StopReason, ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import {
	describeFailure,
	emptyUsage,
	failureResult,
	formatSessionNote,
	getDisplayItems,
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	type SingleResult,
} from "./results.ts";

function assistant(content: AssistantMessage["content"], stopReason: StopReason = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "messages" as AssistantMessage["api"],
		provider: "anthropic" as AssistantMessage["provider"],
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
	};
}

function toolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
	return { type: "toolCall", id: `call-${name}`, name, arguments: args } as ToolCall;
}

function result(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "worker",
		agentSource: "extension",
		task: "do the thing",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...overrides,
	};
}

describe("isFailedResult", () => {
	test("treats an output-limit cutoff as a failure", () => {
		// The child exits 0 when the model runs out of output budget, so exit code alone reported a
		// worker that stopped mid-edit as a completed leaf task.
		expect(isFailedResult(result({ exitCode: 0, stopReason: "length" }))).toBe(true);
	});

	test("keeps error, abort, and non-zero exits failing", () => {
		expect(isFailedResult(result({ stopReason: "error" }))).toBe(true);
		expect(isFailedResult(result({ stopReason: "aborted" }))).toBe(true);
		expect(isFailedResult(result({ exitCode: 1 }))).toBe(true);
	});

	test("accepts a normal completion", () => {
		expect(isFailedResult(result({ exitCode: 0, stopReason: "stop" }))).toBe(false);
	});
});

describe("describeFailure", () => {
	test("explains an output-limit cutoff in terms of the work left behind", () => {
		const text = describeFailure(result({ stopReason: "length" }));
		expect(text).toContain("output limit");
		expect(text).toContain("incomplete");
	});

	test("warns that an aborted agent may already have edited files", () => {
		expect(describeFailure(result({ stopReason: "aborted" }))).toContain("may have already changed files");
	});

	test("falls back to the exit code", () => {
		expect(describeFailure(result({ exitCode: 3 }))).toBe("failed (exit code 3)");
	});
});

describe("getResultOutput", () => {
	test("returns the report for a successful run", () => {
		const messages: Message[] = [assistant([{ type: "text", text: "## Completed\nDone." }])];
		expect(getResultOutput(result({ messages }))).toBe("## Completed\nDone.");
	});

	test("labels the trailing text of a truncated run instead of passing it off as a report", () => {
		// A cut-off worker ends on whatever it was narrating, which reads exactly like a completion
		// report. The parent has to be able to tell the two apart.
		const messages: Message[] = [
			assistant([{ type: "text", text: "## Completed\nMigrated every call site." }], "length"),
		];
		const output = getResultOutput(result({ messages, stopReason: "length" }));
		expect(output).toContain("partial, not a completion report");
		expect(output).toContain("Migrated every call site.");
		expect(output.startsWith("## Completed")).toBe(false);
	});

	test("keeps the partial output of an aborted run alongside the reason", () => {
		const messages: Message[] = [assistant([{ type: "text", text: "Editing src/foo.ts" }])];
		const output = getResultOutput(
			result({ messages, stopReason: "aborted", errorMessage: "Subagent was aborted before it finished." }),
		);
		expect(output).toContain("Subagent was aborted before it finished.");
		expect(output).toContain("Editing src/foo.ts");
	});

	test("reports stderr when the child produced no messages", () => {
		expect(getResultOutput(result({ exitCode: 1, stderr: "Unknown agent: \"nope\"." }))).toBe(
			'Unknown agent: "nope".',
		);
	});

	test("never returns an empty string", () => {
		expect(getResultOutput(result())).toBe("(no output)");
		expect(getResultOutput(result({ exitCode: 1 }))).toBe("(no output)");
	});
});

describe("getFinalOutput", () => {
	test("ignores tool results and user turns", () => {
		const messages: Message[] = [
			assistant([{ type: "text", text: "first" }]),
			{ role: "toolResult", toolCallId: "call-read", toolName: "read", content: [], isError: false, timestamp: 0 },
			assistant([{ type: "text", text: "final" }]),
		];
		expect(getFinalOutput(messages)).toBe("final");
	});

	test("returns empty when no assistant message carried text", () => {
		expect(getFinalOutput([assistant([toolCall("read")])])).toBe("");
	});
});

describe("getDisplayItems", () => {
	test("collects assistant text and tool calls in order", () => {
		const messages: Message[] = [assistant([{ type: "text", text: "looking" }, toolCall("read", { path: "a.ts" })])];
		expect(getDisplayItems(messages)).toEqual([
			{ type: "text", text: "looking" },
			{ type: "toolCall", name: "read", args: { path: "a.ts" } },
		]);
	});
});

describe("failureResult", () => {
	test("builds a reportable result with no child messages", () => {
		const failure = failureResult({ agent: "worker", task: "t", message: "spawn E2BIG", step: 2 });
		expect(isFailedResult(failure)).toBe(true);
		expect(getResultOutput(failure)).toBe("spawn E2BIG");
		expect(failure.step).toBe(2);
	});
});

describe("formatSessionNote", () => {
	const tokens = (count: number) => `${Math.round(count / 1000)}k`;
	const withSession = (session: SingleResult["session"], contextTokens = 0): SingleResult => ({
		agent: "worker",
		agentSource: "user",
		task: "t",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { ...emptyUsage(), contextTokens },
		session,
	});

	test("says nothing for a run that asked for no session", () => {
		expect(formatSessionNote(withSession(undefined), tokens)).toBe("");
	});

	test("reports the run number and the child's context size", () => {
		expect(formatSessionNote(withSession({ key: "auth", run: 3 }, 48000), tokens)).toBe(
			'[Subagent session "auth", run 3, child context ~48k tokens.]',
		);
	});

	test("tells the parent when the key could not be honoured", () => {
		// The parent wrote its task as a delta against context the child turns out not to have, so
		// silence here would let a reply that misses the point read as the agent's own judgement.
		const note = formatSessionNote(withSession({ key: "auth" }), tokens);
		expect(note).toContain('"auth" was unavailable');
		expect(note).toContain("fresh context");
		expect(note).not.toContain("undefined");
	});
});
