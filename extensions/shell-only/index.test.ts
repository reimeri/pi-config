import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import toolModeCoordinatorExtension from "../tool-modes/index.ts";
import {
	setToolMode,
	TOOL_MODE_STATE_ENTRY_TYPE,
	TOOL_MODE_STATE_VERSION,
	type ToolModeDefinition,
} from "../tool-modes/protocol.ts";
import shellOnlyExtension, { shellOnlyTools } from "./index.ts";

type Handler = (event: any, ctx?: any) => any;

class FakeEventBus {
	private readonly listeners = new Map<string, Handler[]>();

	on(event: string, handler: Handler): () => void {
		const handlers = this.listeners.get(event) ?? [];
		handlers.push(handler);
		this.listeners.set(event, handlers);
		return () =>
			this.listeners.set(
				event,
				(this.listeners.get(event) ?? []).filter((item) => item !== handler),
			);
	}

	emit(event: string, data: unknown): void {
		for (const handler of this.listeners.get(event) ?? []) handler(data);
	}
}

function tool(name: string, source: string) {
	return {
		name,
		description: `${name} tool`,
		parameters: {},
		promptGuidelines: [],
		sourceInfo: { path: `<${source}:${name}>`, source, scope: "temporary", origin: "top-level" },
	};
}

function setup(options: { flag?: boolean; branch?: any[] } = {}) {
	const events = new FakeEventBus();
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const flags = new Map<string, any>();
	const appended: Array<{ type: string; data: unknown }> = [];
	const modeUpdates: any[] = [];
	const notifications: string[] = [];
	const configuredTools = [
		tool("read", "builtin"),
		tool("bash", "builtin"),
		tool("edit", "builtin"),
		tool("write", "builtin"),
		tool("grep", "builtin"),
		tool("find", "builtin"),
		tool("ls", "builtin"),
		tool("ask_user", "extension"),
		tool("subagent", "extension"),
		tool("sdk_tool", "sdk"),
	];
	let activeTools = configuredTools.map((item) => item.name);

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
		getFlag: (name: string) => (name === "shell-only" ? options.flag ?? false : undefined),
		getAllTools: () => configuredTools,
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			activeTools = [...new Set(names)];
		},
		appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
		sendMessage: vi.fn(),
	} as unknown as ExtensionAPI;

	toolModeCoordinatorExtension(pi);
	shellOnlyExtension(pi);

	const waitForIdle = vi.fn(async () => {});
	const ctx = {
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

async function runHandlers(
	handlers: Map<string, Handler[]>,
	event: string,
	data: any,
	ctx: any,
): Promise<void> {
	for (const handler of handlers.get(event) ?? []) await handler(data, ctx);
}

describe("shellOnlyTools", () => {
	test("keeps Bash and non-builtin tools while removing every other built-in", () => {
		const configured = [
			tool("read", "builtin"),
			tool("bash", "builtin"),
			tool("grep", "builtin"),
			tool("ask_user", "extension"),
			tool("sdk_tool", "sdk"),
		];
		expect(
			shellOnlyTools(
				["read", "bash", "grep", "ask_user", "sdk_tool"],
				configured as ReturnType<ExtensionAPI["getAllTools"]>,
			),
		).toEqual(["bash", "ask_user", "sdk_tool"]);
	});

	test("keeps a custom override even when it uses a built-in tool name", () => {
		const configured = [tool("read", "extension"), tool("bash", "builtin")];
		expect(
			shellOnlyTools(
				["read", "bash"],
				configured as ReturnType<ExtensionAPI["getAllTools"]>,
			),
		).toEqual(["read", "bash"]);
	});
});

describe("shell-only extension", () => {
	test("registers its toggle command and startup flag", () => {
		const state = setup();
		expect(state.commands.get("shell-only")?.description).toContain("shell-only mode");
		expect(state.flags.get("shell-only")).toMatchObject({ type: "boolean", default: false });
	});

	test("leaves the baseline unchanged when default-off", async () => {
		const state = setup();
		const baseline = state.activeTools();

		await runHandlers(state.handlers, "session_start", { reason: "startup" }, state.ctx);

		expect(state.activeTools()).toEqual(baseline);
		expect(state.modeUpdates.at(-1).label).toBeUndefined();
	});

	test("starts from the flag with only Bash and custom tools active", async () => {
		const state = setup({ flag: true });

		await runHandlers(state.handlers, "session_start", { reason: "startup" }, state.ctx);

		expect(state.activeTools()).toEqual(["bash", "ask_user", "subagent", "sdk_tool"]);
		expect(state.modeUpdates.at(-1)).toMatchObject({
			label: "$ shell only",
			compactLabel: "$",
			borderColor: "thinkingLow",
		});
		// The coordinator owns the sole reconciliation hook; shell-only adds no prompt guidance.
		expect(state.handlers.get("before_agent_start")).toHaveLength(1);
		expect(state.handlers.has("tool_call")).toBe(false);
	});

	test("waits for idle before persisting disable and restoring the baseline", async () => {
		const state = setup({ flag: true });
		await runHandlers(state.handlers, "session_start", { reason: "startup" }, state.ctx);
		let releaseIdle!: () => void;
		const idle = new Promise<void>((resolve) => {
			releaseIdle = resolve;
		});
		state.ctx.waitForIdle = vi.fn(() => idle);

		const toggled = state.commands.get("shell-only").handler("", state.ctx);
		await Promise.resolve();

		expect(state.ctx.waitForIdle).toHaveBeenCalledOnce();
		expect(state.activeTools()).toEqual(["bash", "ask_user", "subagent", "sdk_tool"]);
		expect(state.appended).toEqual([]);

		releaseIdle();
		await toggled;
		expect(state.activeTools()).toContain("read");
		expect(state.activeTools()).toContain("write");
		expect(state.appended.at(-1)).toMatchObject({
			type: TOOL_MODE_STATE_ENTRY_TYPE,
			data: { version: TOOL_MODE_STATE_VERSION, activeModeIds: [] },
		});
		expect(state.modeUpdates.at(-1).label).toBeUndefined();
	});

	test("composes with another restrictive mode without restoring its excluded tools", async () => {
		const state = setup();
		await runHandlers(state.handlers, "session_start", { reason: "startup" }, state.ctx);
		const otherMode: ToolModeDefinition = {
			id: "other-restriction",
			priority: 50,
			apply: (toolNames) => toolNames.filter((name) => name !== "subagent"),
		};
		await setToolMode(state.pi.events, otherMode, true);

		await state.commands.get("shell-only").handler("", state.ctx);
		expect(state.activeTools()).toEqual(["bash", "ask_user", "sdk_tool"]);

		await state.commands.get("shell-only").handler("", state.ctx);
		expect(state.activeTools()).toContain("read");
		expect(state.activeTools()).not.toContain("subagent");
	});

	test("restores enabled state and the original baseline from the current branch", async () => {
		const baselineTools = ["read", "bash", "edit", "write", "ask_user", "subagent"];
		const branch = [
			{
				type: "custom",
				customType: TOOL_MODE_STATE_ENTRY_TYPE,
				data: {
					version: TOOL_MODE_STATE_VERSION,
					baselineTools,
					activeModeIds: ["shell-only"],
				},
			},
		];
		const state = setup({ branch });

		await runHandlers(state.handlers, "session_start", { reason: "resume" }, state.ctx);

		expect(state.activeTools()).toEqual(["bash", "ask_user", "subagent"]);
	});
});
