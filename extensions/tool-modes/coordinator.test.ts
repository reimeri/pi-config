import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatToolModeStatus, ToolModeCoordinator } from "./coordinator.ts";
import toolModeCoordinatorExtension from "./index.ts";
import { setToolMode, type ToolModeDefinition } from "./protocol.ts";

type Handler = (event: any, ctx?: any) => any;

class FakeEventBus {
	private readonly listeners = new Map<string, Handler[]>();

	on(eventName: string, handler: Handler): () => void {
		const handlers = this.listeners.get(eventName) ?? [];
		handlers.push(handler);
		this.listeners.set(eventName, handlers);
		return () => {
			this.listeners.set(
				eventName,
				(this.listeners.get(eventName) ?? []).filter((candidate) => candidate !== handler),
			);
		};
	}

	emit(eventName: string, data: unknown): void {
		for (const handler of this.listeners.get(eventName) ?? []) handler(data);
	}
}

class FakeTools {
	private activeTools: string[];

	constructor(toolNames: string[]) {
		this.activeTools = [...toolNames];
	}

	getActiveTools(): string[] {
		return [...this.activeTools];
	}

	setActiveTools(toolNames: string[]): void {
		this.activeTools = [...new Set(toolNames)];
	}
}

function coordinatorWithTools(toolNames: string[]): {
	coordinator: ToolModeCoordinator;
	tools: FakeTools;
} {
	const tools = new FakeTools(toolNames);
	return {
		coordinator: new ToolModeCoordinator(tools as unknown as ExtensionAPI),
		tools,
	};
}

const planMode: ToolModeDefinition = {
	id: "plan",
	priority: 10,
	apply: (toolNames) => toolNames.filter((name) => !["edit", "write", "todo_update"].includes(name)),
};

const quarantineMode: ToolModeDefinition = {
	id: "quarantine",
	priority: 100,
	apply: () => ["read", "grep", "find", "ls"],
};

describe("ToolModeCoordinator", () => {
	test("restores the full baseline after plan mode is disabled", () => {
		const baseline = ["read", "bash", "edit", "write", "todo_update"];
		const { coordinator, tools } = coordinatorWithTools(baseline);

		const enabled = coordinator.setMode(planMode, true);
		expect(enabled.activeModeIds).toEqual(["plan"]);
		expect(tools.getActiveTools()).toEqual(["read", "bash"]);

		const disabled = coordinator.setMode(planMode, false);
		expect(disabled.activeModeIds).toEqual([]);
		expect(disabled.baselineTools).toEqual(baseline);
		expect(tools.getActiveTools()).toEqual(baseline);
	});

	test("keeps the remaining restrictive policy active until the last mode is disabled", () => {
		const baseline = ["read", "bash", "edit", "write", "todo_update"];
		const { coordinator, tools } = coordinatorWithTools(baseline);

		coordinator.setMode(planMode, true);
		coordinator.setMode(quarantineMode, true);
		const planDisabled = coordinator.setMode(planMode, false);

		expect(planDisabled.activeModeIds).toEqual(["quarantine"]);
		expect(tools.getActiveTools()).toEqual(["read", "grep", "find", "ls"]);

		const quarantineDisabled = coordinator.setMode(quarantineMode, false);
		expect(quarantineDisabled.activeModeIds).toEqual([]);
		expect(tools.getActiveTools()).toEqual(baseline);
	});
});

function setupToolModeExtension(toolNames: string[]): {
	pi: ExtensionAPI;
	tools: FakeTools;
	events: FakeEventBus;
	handlers: Map<string, Handler[]>;
} {
	const tools = new FakeTools(toolNames);
	const events = new FakeEventBus();
	const handlers = new Map<string, Handler[]>();
	const pi = {
		events,
		getActiveTools: () => tools.getActiveTools(),
		setActiveTools: (names: string[]) => tools.setActiveTools(names),
		appendEntry: () => "state-entry",
		on: (eventName: string, handler: Handler) => {
			const registered = handlers.get(eventName) ?? [];
			registered.push(handler);
			handlers.set(eventName, registered);
		},
	} as unknown as ExtensionAPI;
	toolModeCoordinatorExtension(pi);
	return { pi, tools, events, handlers };
}

describe("tool-mode extension context integration", () => {
	test("replaces stale status on every model turn after plan mode is turned off", async () => {
		const baseline = ["read", "bash", "edit", "write", "todo_update"];
		const { pi, handlers } = setupToolModeExtension(baseline);
		const beforeAgentStart = handlers.get("before_agent_start")?.[0];
		const context = handlers.get("context")?.[0];
		expect(beforeAgentStart).toBeDefined();
		expect(context).toBeDefined();

		await setToolMode(pi.events, planMode, true);
		expect(await beforeAgentStart?.({ systemPrompt: "unchanged" })).toBeUndefined();
		const activeResult = await context?.({ messages: [] });
		const activeStatus = activeResult.messages.find(
			(message: any) => message.customType === "tool-mode-current-state",
		);
		expect(activeStatus.content).toContain("Active restrictive modes: plan");

		await setToolMode(pi.events, planMode, false);
		const staleAssistant = {
			role: "assistant",
			content: [{ type: "text", text: "Plan mode is still active." }],
		};
		const disabledResult = await context?.({
			messages: [...activeResult.messages, staleAssistant],
		});
		const currentStatuses = disabledResult.messages.filter(
			(message: any) => message.customType === "tool-mode-current-state",
		);

		expect(currentStatuses).toHaveLength(1);
		expect(currentStatuses[0].content).toContain("Active restrictive modes: none");
		expect(currentStatuses[0].content).toContain(
			"Active tools: read, bash, edit, write, todo_update",
		);
		expect(disabledResult.messages).toContain(staleAssistant);
	});

	test("reasserts a locally reported fail-closed mode over a coordinated policy", async () => {
		const baseline = ["read", "bash", "edit", "write", "todo_update"];
		const quarantineTools = ["read", "grep", "find", "ls"];
		const { pi, tools, events, handlers } = setupToolModeExtension(baseline);
		await setToolMode(pi.events, planMode, true);

		// Simulate quarantine's direct fallback after its coordinated activation failed.
		tools.setActiveTools(quarantineTools);
		events.on("tool-modes:local-status", (data) => {
			data.report("quarantine", quarantineTools);
		});

		const beforeAgentStart = handlers.get("before_agent_start")?.[0];
		const context = handlers.get("context")?.[0];
		expect(await beforeAgentStart?.({ systemPrompt: "unchanged" })).toBeUndefined();
		expect(tools.getActiveTools()).toEqual(quarantineTools);

		const result = await context?.({ messages: [] });
		const status = result.messages.find(
			(message: any) => message.customType === "tool-mode-current-state",
		);

		expect(tools.getActiveTools()).toEqual(quarantineTools);
		expect(status.content).toContain("Active restrictive modes: plan, quarantine");
		expect(status.content).toContain("Active tools: read, grep, find, ls");
	});
});

describe("formatToolModeStatus", () => {
	test("makes an unrestricted restored state authoritative to the model", () => {
		const status = formatToolModeStatus({
			activeModeIds: [],
			activeTools: ["read", "bash", "edit", "write", "todo_update"],
		});

		expect(status).toContain("[CURRENT TOOL MODE STATE]");
		expect(status).toContain("Active restrictive modes: none");
		expect(status).toContain("Active tools: read, bash, edit, write, todo_update");
		expect(status).toContain("Ignore earlier conversation claims");
	});

	test("reports composed restrictions without promising unavailable mutation tools", () => {
		const status = formatToolModeStatus({
			activeModeIds: ["plan", "quarantine"],
			activeTools: ["read", "grep", "find", "ls"],
		});

		expect(status).toContain("Active restrictive modes: plan, quarantine");
		expect(status).toContain("Active tools: read, grep, find, ls");
		expect(status).not.toContain("edit");
	});
});
