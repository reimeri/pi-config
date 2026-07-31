import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadAgentFromFile } from "../subagent/agents.ts";

const workerPath = fileURLToPath(new URL("./worker.md", import.meta.url));
const reviewerPath = fileURLToPath(new URL("../../agents/reviewer.md", import.meta.url));

describe("supervisor agent prompts", () => {
	test("worker validates leaf-task scope before editing", () => {
		const worker = loadAgentFromFile(workerPath, "extension", "supervisor");

		expect(worker).toBeDefined();
		// Reconcile reported files only when workspace capture was requested.
		expect(worker?.captureDiff).toBe(true);
		expect(worker?.systemPrompt).toContain("## Scope gate");
		expect(worker?.systemPrompt).toContain("explicit Goal naming one primary, independently reviewable outcome");
		expect(worker?.systemPrompt).toContain("approved design and relevant background");
		expect(worker?.systemPrompt).toContain("completed preconditions and the current repository state");
		expect(worker?.systemPrompt).toContain("in-scope paths or symbols and out-of-scope work");
		expect(worker?.systemPrompt).toContain("exact required behavior and invariants");
		expect(worker?.systemPrompt).toContain("observable acceptance criteria and targeted verification");
		expect(worker?.systemPrompt).toContain("stop conditions and an expected completion report");
		expect(worker?.systemPrompt).toContain("If any required assignment element is absent, reject");
		expect(worker?.systemPrompt).toContain("Do not reject based on prompt length or file count alone");
		expect(worker?.systemPrompt).toContain("## Scope Rejected");
		expect(worker?.systemPrompt).toContain("## Missing Assignment Elements or Decisions");
		expect(worker?.systemPrompt).toContain("Every missing required element, unresolved decision, or prerequisite");
		expect(worker?.systemPrompt).toContain("## Suggested Split");
		expect(worker?.systemPrompt).toContain("## Acceptance Criteria");
		expect(worker?.systemPrompt).toContain("Do not continue into a likely next task");
		// A resumed worker's prior suggestions are not authoritative.
		expect(worker?.systemPrompt).toContain("You may be resumed with your earlier tasks still in context");
		expect(worker?.systemPrompt).toContain("An earlier Recommended Next Task is not an assignment");
	});

	test("reviewer supports pre-implementation specification review", () => {
		const reviewer = loadAgentFromFile(reviewerPath, "user");

		expect(reviewer).toBeDefined();
		expect(reviewer?.description).toContain("implementation specifications");
		expect(reviewer?.systemPrompt).toContain("## Specification review");
		expect(reviewer?.systemPrompt).toContain("material product and technical decisions are resolved");
		expect(reviewer?.systemPrompt).toContain("independently reviewable leaf tasks");
		expect(reviewer?.systemPrompt).toContain("## Readiness");
		expect(reviewer?.systemPrompt).toContain("## Code review");
	});
});
