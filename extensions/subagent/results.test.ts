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
	messageForDisplay,
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
		// Exit code 0 does not imply completion when the model hit its output limit.
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
		const messages: Message[] = [assistant([toolCall("edit", { path: "a.ts" })])];
		expect(describeFailure(result({ stopReason: "aborted", messages }))).toContain("may have already changed files");
	});

	test("does not warn about files when the abort landed before the child spoke", () => {
		// A run aborted before spawning must not warn about workspace changes.
		const text = describeFailure(result({ stopReason: "aborted" }));
		expect(text).toContain("before it started");
		expect(text).not.toContain("may have already changed files");
	});

	test("says the child may still be running when it outlived the run", () => {
		// Empty messages do not prove a live child made no changes.
		const text = describeFailure(result({ stopReason: "aborted", childOutlivedRun: true }));
		expect(text).toContain("did not exit");
		expect(text).not.toContain("untouched");
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
		// Label partial output so it cannot be mistaken for completion.
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

describe("messageForDisplay", () => {
	test("keeps assistant text and tool calls, which are what gets rendered", () => {
		const message = assistant([{ type: "text", text: "done" }, toolCall("read", { path: "a.ts" })]);
		expect(messageForDisplay(message)?.content).toEqual(message.content);
	});

	test("drops reasoning, which is stored per run and never rendered", () => {
		const message = assistant([
			{ type: "thinking", thinking: "a long private deliberation" } as AssistantMessage["content"][number],
			{ type: "text", text: "done" },
		]);

		expect(messageForDisplay(message)?.content).toEqual([{ type: "text", text: "done" }]);
	});

	test("preserves the fields read off an assistant message", () => {
		const message = assistant([{ type: "text", text: "cut off" }], "length");
		const stored = messageForDisplay(message);

		expect(stored).toMatchObject({ role: "assistant", stopReason: "length", model: "test-model" });
	});

	test("drops tool results, whose output no renderer reads", () => {
		const toolResult: Message = {
			role: "toolResult",
			toolCallId: "call-read",
			toolName: "read",
			content: [{ type: "text", text: "40KB of file content" }],
			isError: false,
			timestamp: 0,
		};

		expect(messageForDisplay(toolResult)).toBeUndefined();
	});

	test("leaves nothing that getDisplayItems would have shown", () => {
		// Filtered messages must match what renderers ignore.
		const message = assistant([
			{ type: "thinking", thinking: "private" } as AssistantMessage["content"][number],
			{ type: "text", text: "visible" },
			toolCall("grep", { pattern: "x" }),
		]);

		expect(getDisplayItems([message])).toEqual(getDisplayItems([messageForDisplay(message) as Message]));
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
		// Report unavailable context so a delta task is not mistaken for agent judgment.
		const note = formatSessionNote(withSession({ key: "auth" }), tokens);
		expect(note).toContain('"auth" was unavailable');
		expect(note).toContain("fresh context");
		expect(note).not.toContain("undefined");
	});
});
