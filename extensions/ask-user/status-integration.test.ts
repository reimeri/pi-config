import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import { withPiDashAttention } from "./attention.ts";
import askUserExtension from "./index.ts";

describe("ask_user Pi Dash attention integration", () => {
	test("emits a correlated wait only while awaiting user input", async () => {
		const attention: Array<{ event: string; payload: any }> = [];
		let answer: ((value: string) => void) | undefined;
		const pendingAnswer = new Promise<string>((resolve) => {
			answer = resolve;
		});
		const execution = withPiDashAttention(
			{ emit: (event, payload) => attention.push({ event, payload }) },
			() => pendingAnswer,
		);

		await vi.waitFor(() => expect(attention).toHaveLength(1));
		expect(attention[0]).toEqual({
			event: "pi-dash:attention",
			payload: {
				phase: "start",
				interactionId: expect.stringMatching(
					/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
				),
				reason: "ask_user",
			},
		});

		answer?.("Small");
		await expect(execution).resolves.toBe("Small");

		expect(attention).toHaveLength(2);
		expect(attention[1]).toEqual({
			event: "pi-dash:attention",
			payload: {
				phase: "end",
				interactionId: attention[0]?.payload.interactionId,
				reason: "ask_user",
			},
		});
		expect(Object.keys(attention[0]?.payload)).toEqual([
			"phase",
			"interactionId",
			"reason",
		]);
	});

	test("ends the wait when the question UI throws", async () => {
		const attention: Array<{ event: string; payload: any }> = [];

		await expect(
			withPiDashAttention(
				{ emit: (event, payload) => attention.push({ event, payload }) },
				async () => {
					throw new Error("UI failed");
				},
			),
		).rejects.toThrow("UI failed");

		expect(attention.map(({ payload }) => payload.phase)).toEqual(["start", "end"]);
		expect(attention[1]?.payload.interactionId).toBe(attention[0]?.payload.interactionId);
	});

	test("does not let status listener failures interfere with the question UI", async () => {
		const result = await withPiDashAttention(
			{
				emit: () => {
					throw new Error("status listener failed");
				},
			},
			async () => "Small",
		);

		expect(result).toBe("Small");
	});

	test("does not let UUID generation failure interfere with the question UI", async () => {
		const emit = vi.fn();
		const result = await withPiDashAttention(
			{ emit },
			async () => "Small",
			() => {
				throw new Error("UUID source unavailable");
			},
		);

		expect(result).toBe("Small");
		expect(emit).not.toHaveBeenCalled();
	});
});

type RegisteredAskUserTool = {
	execute(
		toolCallId: string,
		params: { questions: Array<{ id: string; question: string }> },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: any,
	): Promise<{ details: { status: string } }>;
};

function registerAskUserTool(emit: (event: string, payload: unknown) => void): RegisteredAskUserTool {
	let tool: RegisteredAskUserTool | undefined;
	askUserExtension({
		on: vi.fn(),
		events: { emit },
		registerTool(definition: RegisteredAskUserTool) {
			tool = definition;
		},
	} as unknown as ExtensionAPI);
	if (!tool) throw new Error("ask_user tool was not registered");
	return tool;
}

const askUserParams = {
	questions: [{ id: "scope", question: "Which scope?" }],
};

describe("ask_user attention callsite", () => {
	test("wraps the interactive question flow with attention events", async () => {
		const attention: Array<{ event: string; payload: any }> = [];
		const tool = registerAskUserTool((event, payload) => attention.push({ event, payload }));

		const result = await tool.execute("call-1", askUserParams, undefined, undefined, {
			hasUI: true,
			mode: "rpc",
			ui: {
				input: async () => "Small",
				select: async () => "1. Submit answers",
			},
		});

		expect(result.details.status).toBe("answered");
		expect(attention.map(({ payload }) => payload.phase)).toEqual(["start", "end"]);
		expect(attention[1]?.payload.interactionId).toBe(attention[0]?.payload.interactionId);
	});

	test("does not emit attention when interactive UI is unavailable", async () => {
		const emit = vi.fn();
		const tool = registerAskUserTool(emit);

		const result = await tool.execute("call-2", askUserParams, undefined, undefined, {
			hasUI: false,
			mode: "print",
			ui: {},
		});

		expect(result.details.status).toBe("unavailable");
		expect(emit).not.toHaveBeenCalled();
	});
});
