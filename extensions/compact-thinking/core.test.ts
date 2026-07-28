import { describe, expect, test } from "vitest";

import { compactThinkingSummaries, type MessageLike } from "./core.ts";

function thinking(thinkingText: string, signature: string) {
	return { type: "thinking", thinking: thinkingText, thinkingSignature: signature };
}

function assistant(content: unknown[]): MessageLike {
	return { role: "assistant", content, stopReason: "stop" };
}

describe("compactThinkingSummaries", () => {
	test("keeps only the latest title-like summary and counts every compacted step", () => {
		const message = assistant([
			thinking(
				"**Analyzing TUI overlay padding behavior**\n\n"
				+ "**Refining header mapping validation logic**\n\n"
				+ "**Planning synthetic overlay padding test**",
				"first",
			),
			thinking(
				"**Implementing overlay stack presence helper**\n\n"
				+ "**Defining line count compatibility formula**",
				"latest",
			),
		]);

		const result = compactThinkingSummaries(message);

		expect(result).not.toBe(message);
		expect(result.content).toEqual([
			thinking("×5 **Defining line count compatibility formula**", "latest"),
		]);
		expect(message.content).toHaveLength(2);
	});

	test("respects text and tool-call boundaries between thinking runs", () => {
		const text = { type: "text", text: "Visible answer" };
		const toolCall = { type: "toolCall", id: "call-1", name: "read", arguments: {} };
		const message = assistant([
			thinking("**First**", "a"),
			thinking("**Second**", "b"),
			text,
			thinking("**Third**", "c"),
			toolCall,
			thinking("**Fourth**\n\n**Fifth**", "d"),
		]);

		expect(compactThinkingSummaries(message).content).toEqual([
			thinking("×2 **Second**", "b"),
			text,
			thinking("**Third**", "c"),
			toolCall,
			thinking("×2 **Fifth**", "d"),
		]);
	});

	test("leaves ordinary or mixed reasoning untouched", () => {
		const ordinary = assistant([
			thinking("I should inspect the component before deciding.\n\nThen I can test it.", "a"),
			thinking("More free-form reasoning.", "b"),
		]);
		const mixed = assistant([
			thinking("**Planning the change**", "a"),
			thinking("A normal reasoning paragraph.", "b"),
		]);

		expect(compactThinkingSummaries(ordinary)).toBe(ordinary);
		expect(compactThinkingSummaries(mixed)).toBe(mixed);
	});

	test("compacts while the latest title is still streaming", () => {
		const message = assistant([
			thinking("**First summary**\n\n**Second summary**", "a"),
			thinking("**Newest partial summary", "b"),
		]);

		expect(compactThinkingSummaries(message).content).toEqual([
			thinking("×3 **Newest partial summary", "b"),
		]);
	});

	test.each(["", "*", "**", "**  \n\n"])(
		"keeps the previous summary while a new streamed title is only %j",
		(prefix) => {
			const message = assistant([
				thinking("**First summary**\n\n**Second summary**", "a"),
				thinking(prefix, "b"),
			]);

			expect(compactThinkingSummaries(message).content).toEqual([
				thinking("×2 **Second summary**", "a"),
			]);
		},
	);

	test("ignores non-assistant messages", () => {
		const message: MessageLike = {
			role: "user",
			content: [thinking("**First**\n\n**Second**", "a")],
		};
		expect(compactThinkingSummaries(message)).toBe(message);
	});
});
