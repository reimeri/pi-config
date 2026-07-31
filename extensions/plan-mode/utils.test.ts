import { describe, expect, test, vi } from "vitest";
import { extractPlanSteps } from "./utils.ts";

vi.mock("@earendil-works/pi-tui", () => ({
	Key: { ctrlAlt: (key: string) => `ctrl+alt+${key}` },
}));

describe("extractPlanSteps", () => {
	test("accepts blank lines between numbered steps", () => {
		expect(extractPlanSteps("Plan:\n1. Inspect A\n\n2. Modify B")).toEqual([
			{ step: 1, text: "Inspect A" },
			{ step: 2, text: "Modify B" },
		]);
	});

	test("accepts short non-empty steps", () => {
		expect(extractPlanSteps("Plan:\n1. Run")).toEqual([{ step: 1, text: "Run" }]);
	});

	test("requires Plan to be the complete header", () => {
		expect(extractPlanSteps("Example Plan:\n1. Demonstration only")).toEqual([]);
	});

	test("ignores Plan headers inside fenced examples", () => {
		expect(extractPlanSteps("```text\nPlan:\n1. Demonstration only\n```")).toEqual([]);
		expect(extractPlanSteps("~~~\nPlan:\n1. Demonstration only\n~~~\n\n## Plan:\n1. Actual step")).toEqual([
			{ step: 1, text: "Actual step" },
		]);
		expect(extractPlanSteps("- ```text\n  Plan:\n  1. Demonstration only\n  ```\n\nPlan:\n1. Actual step")).toEqual([
			{ step: 1, text: "Actual step" },
		]);
		expect(extractPlanSteps("> ```text\n> Plan:\n> 1. Demonstration only\n> ```")).toEqual([]);
		expect(extractPlanSteps("```text\n- ```\nPlan:\n1. Demonstration only\n```\n\nPlan:\n1. Actual step")).toEqual([
			{ step: 1, text: "Actual step" },
		]);
		expect(extractPlanSteps("10. ```text\n    Plan:\n    1. Demonstration only\n    ```\n\nPlan:\n1. Actual step")).toEqual([
			{ step: 1, text: "Actual step" },
		]);
	});

	test("accepts Markdown heading and bold header forms", () => {
		expect(extractPlanSteps("## Plan:\n1. Inspect A\n2. Modify B")).toHaveLength(2);
		expect(extractPlanSteps("**Plan:**\n1. Inspect A\n2. Modify B")).toHaveLength(2);
		expect(extractPlanSteps("## Plan: ##\n1. Inspect A\n2. Modify B")).toHaveLength(2);
	});

	test("keeps indented continuation lines across blank lines", () => {
		expect(extractPlanSteps("Plan:\n1. Inspect A\n\n   and its tests\n2. Modify B")).toEqual([
			{ step: 1, text: "Inspect A and its tests" },
			{ step: 2, text: "Modify B" },
		]);
	});
});

async function createPlanModeHarness() {
	const { default: planModeExtension } = await import("./index.ts");
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const eventListeners = new Map<string, Array<(data: any) => void>>();
	const sentMessages: Array<{ message: any; options: any }> = [];
	const sentUserMessages: Array<{ content: string; options: any }> = [];
	let activeTools = ["read"];
	let allTools = [{ name: "ask_user" }];
	let baselineTools: string[] | undefined;
	const events = {
		on(name: string, listener: (data: any) => void) {
			const listeners = eventListeners.get(name) ?? [];
			listeners.push(listener);
			eventListeners.set(name, listeners);
			return () => {};
		},
		emit(name: string, data: any) {
			if (name === "tool-modes:request") {
				data.acknowledge();
				if (data.enabled) {
					baselineTools ??= [...activeTools];
					activeTools = data.mode.apply([...baselineTools]);
				} else {
					activeTools = [...(baselineTools ?? activeTools)];
					baselineTools = undefined;
				}
				data.respond({
					status: "applied",
					baselineTools: baselineTools ?? [...activeTools],
					activeTools: [...activeTools],
					activeModeIds: data.enabled ? ["plan"] : [],
					unavailableTools: [],
				});
				return;
			}
			for (const listener of eventListeners.get(name) ?? []) listener(data);
		},
	};
	const pi = {
		events,
		on(name: string, handler: (event: any, ctx: any) => any) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		},
		registerFlag() {},
		registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
			commands.set(name, command);
		},
		registerShortcut() {},
		appendEntry() {},
		getAllTools: () => allTools,
		getFlag: () => false,
		sendMessage(message: any, options: any) {
			sentMessages.push({ message, options });
		},
		sendUserMessage(content: string, options: any) {
			sentUserMessages.push({ content, options });
		},
	};
	planModeExtension(pi as any);

	const ctx: any = {
		hasUI: true,
		ui: {
			notify() {},
			setStatus() {},
			select: async () => undefined,
			editor: async () => undefined,
		},
	};
	return {
		handlers,
		commands,
		ctx,
		sentMessages,
		sentUserMessages,
		getActiveTools: () => activeTools,
		setActiveTools: (tools: string[]) => {
			activeTools = tools;
		},
		setAllTools: (tools: Array<{ name: string }>) => {
			allTools = tools;
		},
	};
}

describe("plan-mode context", () => {
	const base = { systemPrompt: "BASE PROMPT" };

	test("carries plan context in the system prompt, not a per-turn message", async () => {
		const harness = await createPlanModeHarness();
		const { commands, handlers, ctx } = harness;

		expect(await handlers.get("before_agent_start")?.[0]?.(base, ctx)).toBeUndefined();

		await commands.get("plan")?.handler("", ctx);
		expect(harness.getActiveTools()).toContain("ask_user");

		const enabled = await handlers.get("before_agent_start")?.[0]?.(base, ctx);
		expect(enabled.message).toBeUndefined();
		expect(enabled.systemPrompt).toContain("BASE PROMPT");
		expect(enabled.systemPrompt).toContain("[PLAN MODE ACTIVE]");
		expect(enabled.systemPrompt).toContain("ask_user");

		// Byte-identical output preserves the cached prefix.
		const nextTurn = await handlers.get("before_agent_start")?.[0]?.(base, ctx);
		expect(nextTurn.systemPrompt).toBe(enabled.systemPrompt);

		await commands.get("plan")?.handler("", ctx);
		expect(await handlers.get("before_agent_start")?.[0]?.(base, ctx)).toBeUndefined();
	});

	test("filters legacy plan-mode messages the same way regardless of mode", async () => {
		const harness = await createPlanModeHarness();
		const { commands, handlers, ctx } = harness;
		const contextHandler = handlers.get("context")?.[0];

		const first = { role: "custom", customType: "plan-mode-context", content: "first" };
		const user = { role: "user", content: "question" };
		const latest = { role: "custom", customType: "plan-mode-context", content: "latest" };
		const messages = [first, user, latest];

		const disabled = await contextHandler?.({ messages }, ctx);
		expect(disabled.messages).toEqual([user]);

		await commands.get("plan")?.handler("", ctx);
		const enabled = await contextHandler?.({ messages }, ctx);

		// Both paths match so toggling cannot move the cache boundary.
		expect(enabled.messages).toEqual(disabled.messages);
	});

	test("drops the ask_user guidance when the tool is unavailable", async () => {
		const harness = await createPlanModeHarness();
		const { commands, handlers, ctx } = harness;

		const headlessCtx = { ...ctx, hasUI: false };
		harness.setActiveTools(["read", "ask_user"]);
		await commands.get("plan")?.handler("", headlessCtx);
		expect(harness.getActiveTools()).not.toContain("ask_user");
		const headless = await handlers.get("before_agent_start")?.[0]?.(base, headlessCtx);
		expect(headless.systemPrompt).not.toContain("using the ask_user tool");

		await commands.get("plan")?.handler("", headlessCtx);
		harness.setAllTools([]);
		await commands.get("plan")?.handler("", ctx);
		expect(harness.getActiveTools()).not.toContain("ask_user");
		const unavailable = await handlers.get("before_agent_start")?.[0]?.(base, ctx);
		expect(unavailable.systemPrompt).not.toContain("using the ask_user tool");
	});
});

describe("plan refinement", () => {
	test("queues one explicit user follow-up containing the request and complete current plan", async () => {
		const harness = await createPlanModeHarness();
		const { commands, handlers, ctx, sentMessages, sentUserMessages } = harness;
		await commands.get("plan")?.handler("", ctx);
		ctx.ui.select = async () => "Refine the plan";
		ctx.ui.editor = async () => "  Split verification into a separate step.  ";

		const assistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Plan:\n1. Inspect the implementation\n2. Update and verify it" }],
		};
		await handlers.get("agent_end")?.[0]?.({ messages: [assistantMessage] }, ctx);

		expect(sentMessages).toEqual([]);
		expect(sentUserMessages).toHaveLength(1);
		expect(sentUserMessages[0]?.options).toEqual({ deliverAs: "followUp" });
		expect(sentUserMessages[0]?.content).toBe(
			'Refine the current plan according to this request:\n\nSplit verification into a separate step.\n\nCurrent plan:\n1. Inspect the implementation\n2. Update and verify it\n\nReturn the complete revised plan under a "Plan:" header. Do not implement it.',
		);
	});
});
