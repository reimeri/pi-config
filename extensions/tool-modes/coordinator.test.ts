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
	/** Every setActiveTools call rebuilds Pi's system prompt, so call counts matter. */
	applyCount = 0;

	constructor(toolNames: string[]) {
		this.activeTools = [...toolNames];
	}

	getActiveTools(): string[] {
		return [...this.activeTools];
	}

	setActiveTools(toolNames: string[]): void {
		this.applyCount++;
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

const restrictedMode: ToolModeDefinition = {
	id: "restricted",
	priority: 10,
	apply: (toolNames) => toolNames.filter((name) => !["edit", "write", "todo_update"].includes(name)),
};

const quarantineMode: ToolModeDefinition = {
	id: "quarantine",
	priority: 100,
	apply: () => ["read", "grep", "find", "ls"],
};

describe("ToolModeCoordinator", () => {
	test("restores the full baseline after a mode is disabled", () => {
		const baseline = ["read", "bash", "edit", "write", "todo_update"];
		const { coordinator, tools } = coordinatorWithTools(baseline);

		const enabled = coordinator.setMode(restrictedMode, true);
		expect(enabled.activeModeIds).toEqual(["restricted"]);
		expect(tools.getActiveTools()).toEqual(["read", "bash"]);

		const disabled = coordinator.setMode(restrictedMode, false);
		expect(disabled.activeModeIds).toEqual([]);
		expect(disabled.baselineTools).toEqual(baseline);
		expect(tools.getActiveTools()).toEqual(baseline);
	});

	test("ignores a policy that reorders the tools it was given", () => {
		const baseline = ["read", "bash", "edit"];
		const { coordinator, tools } = coordinatorWithTools(baseline);
		const reorderingMode: ToolModeDefinition = {
			id: "reorder",
			priority: 5,
			apply: (toolNames) => [...toolNames].reverse(),
		};

		coordinator.setMode(reorderingMode, true);

		// Preserve member order because reordering rewrites tool definitions and the prompt.
		expect(tools.getActiveTools()).toEqual(baseline);
		expect(tools.applyCount).toBe(0);
	});

	test("does not reapply an unchanged policy on repeated reconciles", () => {
		const baseline = ["read", "bash", "edit", "write", "todo_update"];
		const { coordinator, tools } = coordinatorWithTools(baseline);

		coordinator.setMode(restrictedMode, true);
		const afterEnable = tools.applyCount;
		expect(afterEnable).toBe(1);

		coordinator.reconcile();
		coordinator.reconcile();
		coordinator.reconcile();

		expect(tools.applyCount).toBe(afterEnable);
		expect(tools.getActiveTools()).toEqual(["read", "bash"]);
	});

	test("still applies a genuine membership change", () => {
		const baseline = ["read", "bash", "edit"];
		const { coordinator, tools } = coordinatorWithTools(baseline);

		coordinator.setMode(quarantineMode, true);

		expect(tools.applyCount).toBe(1);
		expect(tools.getActiveTools()).toEqual(["read", "grep", "find", "ls"]);
	});

	test("keeps the remaining restrictive policy active until the last mode is disabled", () => {
		const baseline = ["read", "bash", "edit", "write", "todo_update"];
		const { coordinator, tools } = coordinatorWithTools(baseline);

		coordinator.setMode(restrictedMode, true);
		coordinator.setMode(quarantineMode, true);
		const restrictedDisabled = coordinator.setMode(restrictedMode, false);

		expect(restrictedDisabled.activeModeIds).toEqual(["quarantine"]);
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
		await setToolMode(pi.events, restrictedMode, true);

		tools.setActiveTools([...tools.getActiveTools(), "write"]);
		const messages = [{ role: "assistant", content: [{ type: "text", text: "hi" }] }];

		expect(await context?.({ messages })).toBeUndefined();
		expect(tools.getActiveTools()).toEqual(["read", "bash"]);
		expect(sent).toHaveLength(0);
	});

	test("reasserts a locally reported fail-closed mode over a coordinated policy", async () => {
		const baseline = ["read", "bash", "edit", "write", "todo_update"];
		const quarantineTools = ["read", "grep", "find", "ls"];
		const { pi, tools, events, handlers } = setupToolModeExtension(baseline);
		await startSession(handlers);
		await setToolMode(pi.events, restrictedMode, true);

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

		expect(sent).toHaveLength(0);
	});

	test("announces when a persisted mode no longer has an active policy", async () => {
		const { handlers, sent } = setupToolModeExtension(["read", "bash", "edit"]);
		const sessionStart = handlers.get("session_start")?.[0];
		await sessionStart?.({}, {
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						customType: "tool-mode-coordinator-state",
						data: {
							version: 1,
							baselineTools: ["read", "bash", "edit"],
							activeModeIds: ["removed"],
						},
					},
				],
			},
		});

		await startSession(handlers);

		expect(sent).toHaveLength(1);
		expect(sent[0].content).toContain("Active restrictive modes: none");
	});

	test("announces a transition once, not on every turn", async () => {
		const baseline = ["read", "bash", "edit", "write", "todo_update"];
		const { pi, handlers, sent } = setupToolModeExtension(baseline);
		const turnEnd = handlers.get("turn_end")?.[0];
		await startSession(handlers);

		await setToolMode(pi.events, restrictedMode, true);
		await turnEnd?.({});
		expect(sent).toHaveLength(1);
		expect(sent[0].customType).toBe("tool-mode-change");
		expect(sent[0].display).toBe(false);
		expect(sent[0].content).toContain("Active restrictive modes: restricted");

		await turnEnd?.({});
		await startSession(handlers);
		expect(sent).toHaveLength(1);
	});

	test("announces the return to an unrestricted state", async () => {
		const baseline = ["read", "bash", "edit", "write", "todo_update"];
		const { pi, handlers, sent } = setupToolModeExtension(baseline);
		const turnEnd = handlers.get("turn_end")?.[0];
		await startSession(handlers);

		await setToolMode(pi.events, restrictedMode, true);
		await turnEnd?.({});
		await setToolMode(pi.events, restrictedMode, false);
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
		const status = formatToolModeChange({ activeModeIds: ["restricted", "quarantine"] });

		expect(status).toContain("Active restrictive modes: restricted, quarantine");
	});

	test("omits the tool list the request already carries twice", () => {
		const status = formatToolModeChange({ activeModeIds: ["quarantine"] });

		expect(status).not.toContain("Active tools:");
		expect(status.length).toBeLessThan(400);
	});
});
