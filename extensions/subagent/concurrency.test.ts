import { describe, expect, test } from "vitest";
import type { AgentConfig } from "./agents.ts";
import {
	AgentConcurrencyGate,
	findChainConcurrencyConflicts,
	findParallelConcurrencyConflict,
} from "./concurrency.ts";

function agent(name: string, concurrencyGroup?: string): AgentConfig {
	return {
		name,
		description: name,
		concurrencyGroup,
		captureDiff: Boolean(concurrencyGroup),
		systemPrompt: "",
		source: "extension",
		filePath: `/agents/${name}.md`,
	};
}

describe("AgentConcurrencyGate", () => {
	test("rejects overlapping work in the same group and releases idempotently", () => {
		const gate = new AgentConcurrencyGate();
		const release = gate.tryAcquire("workspace-writer");
		expect(release).toBeTypeOf("function");
		expect(gate.isActive("workspace-writer")).toBe(true);
		expect(gate.tryAcquire("workspace-writer")).toBeUndefined();

		release?.();
		release?.();
		expect(gate.isActive("workspace-writer")).toBe(false);
		expect(gate.tryAcquire("workspace-writer")).toBeTypeOf("function");
	});

	test("does not constrain agents without a concurrency group", () => {
		const gate = new AgentConcurrencyGate();
		expect(gate.tryAcquire(undefined)).toBeTypeOf("function");
		expect(gate.tryAcquire(undefined)).toBeTypeOf("function");
	});
});

describe("findParallelConcurrencyConflict", () => {
	const agents = [agent("worker", "workspace-writer"), agent("scout"), agent("reviewer")];

	test("rejects two editing workers", () => {
		expect(findParallelConcurrencyConflict(agents, ["worker", "worker"])).toBe("workspace-writer");
	});

	test("allows one worker alongside read-only agents", () => {
		expect(findParallelConcurrencyConflict(agents, ["worker", "scout", "reviewer"])).toBeUndefined();
	});

	test("allows parallel read-only agents", () => {
		expect(findParallelConcurrencyConflict(agents, ["scout", "reviewer"])).toBeUndefined();
	});
});

describe("findChainConcurrencyConflicts", () => {
	const agents = [agent("worker", "workspace-writer"), agent("scout"), agent("reviewer")];

	test("rejects a lone editing step, which would skip the parent's checkpoint", () => {
		expect(findChainConcurrencyConflicts(agents, ["worker"])).toEqual([
			{ agent: "worker", group: "workspace-writer" },
		]);
	});

	test("rejects an editing step chained behind read-only work", () => {
		expect(findChainConcurrencyConflicts(agents, ["scout", "worker"])).toEqual([
			{ agent: "worker", group: "workspace-writer" },
		]);
	});

	test("reports each conflicting agent once", () => {
		expect(findChainConcurrencyConflicts(agents, ["worker", "worker", "scout"])).toEqual([
			{ agent: "worker", group: "workspace-writer" },
		]);
	});

	test("allows chains of ungrouped agents", () => {
		expect(findChainConcurrencyConflicts(agents, ["scout", "reviewer"])).toEqual([]);
	});

	test("ignores unknown agent names, which the run itself reports", () => {
		expect(findChainConcurrencyConflicts(agents, ["nope"])).toEqual([]);
	});
});
