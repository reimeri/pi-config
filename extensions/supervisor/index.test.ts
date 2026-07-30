import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import { discoverAgents } from "../subagent/agents.ts";
import { discoverExtensionAgents } from "../subagent/protocol.ts";
import toolModeCoordinatorExtension from "../tool-modes/index.ts";
import { TOOL_MODE_STATE_ENTRY_TYPE, TOOL_MODE_STATE_VERSION } from "../tool-modes/protocol.ts";
import supervisorExtension from "./index.ts";

type Handler = (event: any, ctx?: any) => any;

class FakeEventBus {
	private readonly listeners = new Map<string, Handler[]>();

	on(event: string, handler: Handler): () => void {
		const handlers = this.listeners.get(event) ?? [];
		handlers.push(handler);
		this.listeners.set(event, handlers);
		return () => this.listeners.set(event, (this.listeners.get(event) ?? []).filter((item) => item !== handler));
	}

	emit(event: string, data: unknown): void {
		for (const handler of this.listeners.get(event) ?? []) handler(data);
	}
}

function setup(options: { flag?: boolean; branch?: any[] } = {}) {
	const events = new FakeEventBus();
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const flags = new Map<string, any>();
	const appended: Array<{ type: string; data: unknown }> = [];
	const modeUpdates: any[] = [];
	const notifications: string[] = [];
	let activeTools = [
		"read",
		"bash",
		"edit",
		"write",
		"subagent",
		"lsp_navigation",
		"lsp_code_actions",
		"lsp_rename",
		"todo_update",
	];

	events.on("editor-top-bar:mode", (update) => modeUpdates.push(update));
	const pi = {
		events,
		on: (event: string, handler: Handler) => {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerFlag: (name: string, flag: any) => flags.set(name, flag),
		getFlag: (name: string) => (name === "supervisor" ? options.flag ?? false : undefined),
		getActiveTools: () => [...activeTools],
		setActiveTools: (tools: string[]) => {
			activeTools = [...new Set(tools)];
		},
		appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
		sendMessage: vi.fn(),
	} as unknown as ExtensionAPI;

	toolModeCoordinatorExtension(pi);
	supervisorExtension(pi);

	const waitForIdle = vi.fn(async () => {});
	const ctx = {
		hasUI: true,
		waitForIdle,
		ui: { notify: (message: string) => notifications.push(message) },
		sessionManager: { getBranch: () => options.branch ?? [] },
	};

	return {
		pi,
		events,
		handlers,
		commands,
		flags,
		appended,
		modeUpdates,
		notifications,
		ctx,
		waitForIdle,
		activeTools: () => [...activeTools],
	};
}

async function runHandlers(handlers: Map<string, Handler[]>, event: string, data: any, ctx: any): Promise<void> {
	for (const handler of handlers.get(event) ?? []) await handler(data, ctx);
}

describe("supervisor extension", () => {
	test("registers its command and startup flag", () => {
		const state = setup();
		expect(state.commands.get("supervisor")?.description).toContain("supervisor mode");
		expect(state.flags.get("supervisor")).toMatchObject({ type: "boolean", default: false });
	});

	test("starts enabled from the flag, filters direct edit tools, and contributes worker", async () => {
		const state = setup({ flag: true });
		expect(discoverExtensionAgents(state.pi.events, "/repo")).toEqual([]);

		await runHandlers(state.handlers, "session_start", { reason: "startup" }, state.ctx);

		expect(state.activeTools()).toEqual([
			"read",
			"bash",
			"subagent",
			"lsp_navigation",
			"todo_update",
		]);
		const contributions = discoverExtensionAgents(state.pi.events, "/repo");
		expect(contributions).toHaveLength(1);
		const discovery = discoverAgents("/tmp", "project", contributions);
		expect(discovery.agents[0]).toMatchObject({
			name: "worker",
			source: "extension",
			sourceId: "supervisor",
			concurrencyGroup: "workspace-writer",
		});
		expect(state.modeUpdates.at(-1)).toMatchObject({ label: "◆ supervisor", compactLabel: "◆" });
	});

	test("appends supervisor instructions only while enabled and installs no hard gate", async () => {
		const state = setup({ flag: true });
		await runHandlers(state.handlers, "session_start", { reason: "startup" }, state.ctx);
		const promptHandler = state.handlers.get("before_agent_start")?.at(-1);
		const result = await promptHandler?.({ systemPrompt: "base" }, state.ctx);

		expect(result.systemPrompt).toContain("[SUPERVISOR MODE ACTIVE]");
		expect(state.handlers.has("tool_call")).toBe(false);
	});

	test("waits for idle, persists disable, restores baseline, and hides worker", async () => {
		const state = setup({ flag: true });
		await runHandlers(state.handlers, "session_start", { reason: "startup" }, state.ctx);

		await state.commands.get("supervisor").handler("", state.ctx);

		expect(state.waitForIdle).toHaveBeenCalledOnce();
		expect(state.activeTools()).toContain("edit");
		expect(discoverExtensionAgents(state.pi.events, "/repo")).toEqual([]);
		expect(state.appended.at(-1)).toMatchObject({
			type: TOOL_MODE_STATE_ENTRY_TYPE,
			data: { version: TOOL_MODE_STATE_VERSION, activeModeIds: [] },
		});
		expect(state.modeUpdates.at(-1).label).toBeUndefined();
	});

	test("restores enabled state from the current branch", async () => {
		const baselineTools = ["read", "bash", "edit", "write", "subagent"];
		const branch = [{
			type: "custom",
			customType: TOOL_MODE_STATE_ENTRY_TYPE,
			data: { version: TOOL_MODE_STATE_VERSION, baselineTools, activeModeIds: ["supervisor"] },
		}];
		const state = setup({ branch });

		await runHandlers(state.handlers, "session_start", { reason: "resume" }, state.ctx);

		expect(state.activeTools()).toEqual(["read", "bash", "subagent"]);
		expect(discoverExtensionAgents(state.pi.events, "/repo")).toHaveLength(1);
	});
});
