import { describe, expect, mock, test } from "bun:test";
import { extractPlanSteps } from "./utils.ts";

mock.module("@earendil-works/pi-tui", () => ({
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

describe("plan-mode context", () => {
	test("keeps only the latest persistent plan-mode context while enabled", async () => {
		const { default: planModeExtension } = await import("./index.ts");
		const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
		const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
		const eventListeners = new Map<string, Array<(data: any) => void>>();
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
			sendMessage() {},
			sendUserMessage() {},
		};
		planModeExtension(pi as any);

		const ctx = {
			hasUI: true,
			ui: {
				notify() {},
				setStatus() {},
			},
		};
		await commands.get("plan")?.handler("", ctx);
		expect(activeTools).toContain("ask_user");

		const beforeAgentStart = await handlers.get("before_agent_start")?.[0]?.({}, ctx);
		expect(beforeAgentStart.message.content).toContain("ask_user");

		const contextHandler = handlers.get("context")?.[0];
		const first = { role: "custom", customType: "plan-mode-context", content: "first" };
		const user = { role: "user", content: "question" };
		const latest = { role: "custom", customType: "plan-mode-context", content: "latest" };
		const result = await contextHandler?.({ messages: [first, user, latest] }, ctx);

		expect(result.messages).toEqual([user, latest]);

		await commands.get("plan")?.handler("", ctx);
		const disabledResult = await contextHandler?.({ messages: [first, user, latest] }, ctx);
		expect(disabledResult.messages).toEqual([user]);

		const headlessCtx = { ...ctx, hasUI: false };
		activeTools = ["read", "ask_user"];
		await commands.get("plan")?.handler("", headlessCtx);
		expect(activeTools).not.toContain("ask_user");
		const headlessPrompt = await handlers.get("before_agent_start")?.[0]?.({}, headlessCtx);
		expect(headlessPrompt.message.content).not.toContain("using the ask_user tool");

		await commands.get("plan")?.handler("", headlessCtx);
		allTools = [];
		await commands.get("plan")?.handler("", ctx);
		expect(activeTools).not.toContain("ask_user");
		const unavailablePrompt = await handlers.get("before_agent_start")?.[0]?.({}, ctx);
		expect(unavailablePrompt.message.content).not.toContain("using the ask_user tool");
	});
});
