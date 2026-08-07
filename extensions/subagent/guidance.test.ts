import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { createSubagentPromptMetadata, SUBAGENT_PROMPT_GUIDELINES } from "./guidance.ts";

const guidance = SUBAGENT_PROMPT_GUIDELINES.join("\n");

describe("subagent parent guidance", () => {
	test("uses objective review triggers and skips mechanically verified non-behavioral changes", () => {
		expect(guidance).toContain("affects runtime behavior");
		expect(guidance).toContain("public or cross-component contracts");
		expect(guidance).toContain("persistence/migrations/data-loss risk");
		expect(guidance).toContain("concurrency/process lifecycle");
		expect(guidance).toContain("Skip reviewer only when deterministic checks establish that every change is non-behavioral");
		expect(guidance).toContain("generated output/metadata cleanup proven not to affect runtime behavior or compatibility");
		expect(guidance).toContain("meets the contract trigger and must not use this skip exception");
		expect(guidance).not.toContain("meaningful changes");
	});

	test("starts reviewer reuse on the full review and limits the normal cycle", () => {
		expect(guidance).toContain("assign a stable sessionKey on the initial full reviewer call");
		expect(guidance).toContain("reuse the same reviewer, cwd, and key");
		expect(guidance).toContain("Default to one full review and one follow-up");
		expect(guidance).toContain("After the targeted follow-up, stop delegating and verify directly");
	});

	test("builds the metadata spread into the registered tool", () => {
		const first = createSubagentPromptMetadata();
		const second = createSubagentPromptMetadata();
		const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

		expect(first.promptGuidelines).toEqual([...SUBAGENT_PROMPT_GUIDELINES]);
		expect(first.promptSnippet).toBe(
			"Delegate isolated codebase exploration, independent code review, and broader web research to specialized subagents",
		);
		expect(first.promptGuidelines).not.toBe(second.promptGuidelines);
		expect(indexSource).toContain("...createSubagentPromptMetadata(),");
	});

	test("requires triage and a scoped delta before any exceptional third review", () => {
		expect(guidance).toContain("validate each finding against the governing requirements and current code");
		expect(guidance).toContain("Do not automatically implement suggestions or warnings that expand scope");
		expect(guidance).toContain("identify the prior findings, summarize the fixes, name changed paths, and include verification evidence");
		expect(guidance).toContain("do not request another full review or unrelated suggestions");
		expect(guidance).toContain("A third review is allowed only when the follow-up reports an unresolved critical release blocker");
		expect(guidance).toContain("reuse the same key and request a blocker-only check");
	});
});
