import { describe, expect, test } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatToolModeChange, ToolModeCoordinator } from "./coordinator.ts";
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
	sent: Array<{ customType: string; content: string; display?: boolean }>;
} {
	const tools = new FakeTools(toolNames);
	const events = new FakeEventBus();
	const handlers = new Map<string, Handler[]>();
	const sent: Array<{ customType: string; content: string; display?: boolean }> = [];
	const pi = {
		events,
		getActiveTools: () => tools.getActiveTools(),
		setActiveTools: (names: string[]) => tools.setActiveTools(names),
		appendEntry: () => "state-entry",
		sendMessage: (message: { customType: string; content: string; display?: boolean }) => {
			sent.push(message);
		},
		on: (eventName: string, handler: Handler) => {
			const registered = handlers.get(eventName) ?? [];
			registered.push(handler);
			handlers.set(eventName, registered);
		},
	} as unknown as ExtensionAPI;
	toolModeCoordinatorExtension(pi);
	return { pi, tools, events, handlers, sent };
}

/** Runs the reconcile that establishes the session's starting modes silently. */
async function startSession(handlers: Map<string, Handler[]>): Promise<void> {
	await handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "unchanged" });
}

describe("tool-mode extension context integration", () => {
	test("leaves the model context untouched while still enforcing the active policy", async () => {
		const baseline = ["read", "bash", "edit", "write", "todo_update"];
		const { pi, tools, handlers, sent } = setupToolModeExtension(baseline);
		const context = handlers.get("context")?.[0];
		expect(context).toBeDefined();

		await startSession(handlers);
		await setToolMode(pi.events, planMode, true);

		// Simulate another extension activating a tool the active policy forbids.
		tools.setActiveTools([...tools.getActiveTools(), "write"]);
		const messages = [{ role: "assistant", content: [{ type: "text", text: "hi" }] }];

		expect(await context?.({ messages })).toBeUndefined();
		expect(tools.getActiveTools()).toEqual(["read", "bash"]);
		// The enforcement path must never send a message mid-request.
		expect(sent).toHaveLength(0);
	});

	test("reasserts a locally reported fail-closed mode over a coordinated policy", async () => {
		const baseline = ["read", "bash", "edit", "write", "todo_update"];
		const quarantineTools = ["read", "grep", "find", "ls"];
		const { pi, tools, events, handlers } = setupToolModeExtension(baseline);
		await startSession(handlers);
		await setToolMode(pi.events, planMode, true);

		// Simulate quarantine's direct fallback after its coordinated activation failed.
		tools.setActiveTools(quarantineTools);
		events.on("tool-modes:local-status", (data) => {
			data.report("quarantine", quarantineTools);
		});

		const context = handlers.get("context")?.[0];
		expect(await context?.({ messages: [] })).toBeUndefined();
		expect(tools.getActiveTools()).toEqual(quarantineTools);
	});
});

describe("tool-mode change announcements", () => {
	test("records the session's starting modes without announcing them", async () => {
		const { handlers, sent } = setupToolModeExtension(["read", "bash", "edit"]);

		await startSession(handlers);

		// A resumed branch already carries the message that enabled the mode.
		expect(sent).toHaveLength(0);
	});

	test("announces a transition once, not on every turn", async () => {
		const baseline = ["read", "bash", "edit", "write", "todo_update"];
		const { pi, handlers, sent } = setupToolModeExtension(baseline);
		const turnEnd = handlers.get("turn_end")?.[0];
		await startSession(handlers);

		await setToolMode(pi.events, planMode, true);
		await turnEnd?.({});
		expect(sent).toHaveLength(1);
		expect(sent[0].customType).toBe("tool-mode-change");
		expect(sent[0].display).toBe(false);
		expect(sent[0].content).toContain("Active restrictive modes: plan");

		// Unchanged state across later turns must stay silent.
		await turnEnd?.({});
		await startSession(handlers);
		expect(sent).toHaveLength(1);
	});

	test("announces the return to an unrestricted state", async () => {
		const baseline = ["read", "bash", "edit", "write", "todo_update"];
		const { pi, handlers, sent } = setupToolModeExtension(baseline);
		const turnEnd = handlers.get("turn_end")?.[0];
		await startSession(handlers);

		await setToolMode(pi.events, planMode, true);
		await turnEnd?.({});
		await setToolMode(pi.events, planMode, false);
		await turnEnd?.({});

		expect(sent).toHaveLength(2);
		expect(sent[1].content).toContain("Active restrictive modes: none");
	});

	test("announces a locally reported fail-closed mode the coordinator does not know about", async () => {
		const quarantineTools = ["read", "grep", "find", "ls"];
		const { events, handlers, sent } = setupToolModeExtension(["read", "bash", "edit"]);
		await startSession(handlers);

		events.on("tool-modes:local-status", (data) => {
			data.report("quarantine", quarantineTools);
		});
		await handlers.get("turn_end")?.[0]?.({});

		expect(sent).toHaveLength(1);
		expect(sent[0].content).toContain("Active restrictive modes: quarantine");
	});
});

describe("formatToolModeChange", () => {
	test("supersedes earlier conversation claims when restrictions are lifted", () => {
		const status = formatToolModeChange({ activeModeIds: [] });

		expect(status).toContain("[TOOL MODE CHANGE]");
		expect(status).toContain("Active restrictive modes: none");
		expect(status).toContain("supersedes every earlier claim");
	});

	test("reports composed restrictions", () => {
		const status = formatToolModeChange({ activeModeIds: ["plan", "quarantine"] });

		expect(status).toContain("Active restrictive modes: plan, quarantine");
	});

	test("omits the tool list the request already carries twice", () => {
		const status = formatToolModeChange({ activeModeIds: ["quarantine"] });

		expect(status).not.toContain("Active tools:");
		expect(status.length).toBeLessThan(400);
	});
});
