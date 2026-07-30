import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { ToolModeCoordinator } from "../tool-modes/coordinator.ts";
import type { ToolModeDefinition } from "../tool-modes/protocol.ts";
import { SUPERVISOR_MODE_PRIORITY, supervisorInstructions, supervisorTools } from "./core.ts";

describe("supervisorTools", () => {
	test("hides direct editing tools while retaining bash and delegation", () => {
		expect(
			supervisorTools([
				"read",
				"bash",
				"edit",
				"write",
				"subagent",
				"lsp_navigation",
				"lsp_diagnostics",
				"lsp_code_actions",
				"lsp_rename",
				"todo_update",
			]),
		).toEqual(["read", "bash", "subagent", "lsp_navigation", "lsp_diagnostics", "todo_update"]);
	});

	test("preserves unknown tools and removes duplicates", () => {
		expect(supervisorTools(["custom_read", "bash", "custom_read"])).toEqual(["custom_read", "bash"]);
	});
});

describe("supervisorInstructions", () => {
	test("states delegation, bash, concurrency, and mode-composition guidance", () => {
		const prompt = supervisorInstructions();
		expect(prompt).toContain("Delegate code changes");
		expect(prompt).toContain("Never launch more than one worker concurrently");
		expect(prompt).toContain("Bash remains available");
		expect(prompt).toContain("In plan mode, do not delegate implementation");
		expect(prompt).toContain("exists only while this mode is active");
	});
});

describe("supervisor tool-mode composition", () => {
	function setup() {
		let tools = ["read", "grep", "find", "ls", "bash", "edit", "write", "subagent", "todo_update"];
		const pi = {
			getActiveTools: () => [...tools],
			setActiveTools: (next: string[]) => {
				tools = [...new Set(next)];
			},
		} as unknown as ExtensionAPI;
		return { coordinator: new ToolModeCoordinator(pi), tools: () => [...tools] };
	}

	const supervisor: ToolModeDefinition = {
		id: "supervisor",
		priority: SUPERVISOR_MODE_PRIORITY,
		apply: supervisorTools,
	};
	const plan: ToolModeDefinition = {
		id: "plan",
		priority: 10,
		apply: (tools) => tools.filter((name) => !["edit", "write", "todo_update"].includes(name)),
	};
	const quarantine: ToolModeDefinition = {
		id: "quarantine",
		priority: 100,
		apply: () => ["read", "grep", "find", "ls"],
	};

	test("keeps plan restrictions after supervisor is disabled", () => {
		const state = setup();
		state.coordinator.setMode(supervisor, true);
		state.coordinator.setMode(plan, true);
		state.coordinator.setMode(supervisor, false);

		expect(state.tools()).toEqual(["read", "grep", "find", "ls", "bash", "subagent"]);
	});

	test("leaves quarantine authoritative", () => {
		const state = setup();
		state.coordinator.setMode(supervisor, true);
		state.coordinator.setMode(quarantine, true);

		expect(state.tools()).toEqual(["read", "grep", "find", "ls"]);
	});
});
