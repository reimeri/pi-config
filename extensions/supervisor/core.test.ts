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
	test("assigns planning ownership and requires leaf-sized worker checkpoints", () => {
		const prompt = supervisorInstructions();
		expect(prompt).toContain("senior planner and integrator");
		expect(prompt).toContain("You own requirements analysis, architecture, decomposition");
		expect(prompt).toContain("one independently reviewable outcome");
		expect(prompt).toContain("Never assign an entire moderate or complex milestone");
		for (const section of [
			"Goal",
			"Approved design and relevant background",
			"Preconditions and current repository state",
			"In-scope paths and symbols",
			"Required behavior and invariants",
			"Out of scope",
			"Acceptance criteria",
			"Targeted verification",
			"Stop conditions",
			"Expected report",
		]) {
			expect(prompt).toContain(section);
		}
		expect(prompt).toContain("Never place worker in a subagent chain");
		expect(prompt).toContain("After every worker return, inspect the diff");
		expect(prompt).toContain("Observed workspace changes");
		expect(prompt).toContain("Reconcile it against worker's reported Files Changed");
	});

	test("retains bash, concurrency, review, and mode-composition guidance", () => {
		const prompt = supervisorInstructions();
		expect(prompt).toContain("Never launch more than one worker concurrently");
		expect(prompt).toContain("Pass sessionKey when the next leaf continues work");
		expect(prompt).toContain("Omit sessionKey for unrelated leaves");
		// Do not duplicate installed agent names; that copy would diverge from discovery.
		expect(prompt).toContain("have a review agent critique the implementation specification");
		expect(prompt).not.toMatch(/\b(scout|reviewer|researcher)\b/);
		expect(prompt).toContain("Worker verifies its assigned leaf with targeted checks");
		expect(prompt).toContain("supervisor independently inspects or confirms");
		expect(prompt).toContain("Bash remains available");
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
	const restricted: ToolModeDefinition = {
		id: "restricted",
		priority: 10,
		apply: (tools) => tools.filter((name) => !["edit", "write", "todo_update"].includes(name)),
	};
	const quarantine: ToolModeDefinition = {
		id: "quarantine",
		priority: 100,
		apply: () => ["read", "grep", "find", "ls"],
	};

	test("keeps lower-priority restrictions after supervisor is disabled", () => {
		const state = setup();
		state.coordinator.setMode(supervisor, true);
		state.coordinator.setMode(restricted, true);
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
