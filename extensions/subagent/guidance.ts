/** Stable parent-facing instructions for deciding when and how to delegate. */
export const SUBAGENT_PROMPT_GUIDELINES = [
	"Use subagent for broad exploration or source-backed research that would consume substantial parent context. Call reviewer only when the user requests independent review or the specification/change affects runtime behavior, public or cross-component contracts, security/authentication/permissions/secrets, persistence/migrations/data-loss risk, concurrency/process lifecycle, compatibility, or multiple components.",
	"Skip reviewer only when deterministic checks establish that every change is non-behavioral, such as formatting or comments, or generated output/metadata cleanup proven not to affect runtime behavior or compatibility. Documentation that defines behavior, APIs, operations, or requirements meets the contract trigger and must not use this skip exception.",
	"For each qualifying implementation review cycle, assign a stable sessionKey on the initial full reviewer call and reuse the same reviewer, cwd, and key for the targeted follow-up. Default to one full review and one follow-up.",
	"Before editing in response to review output, validate each finding against the governing requirements and current code. Do not automatically implement suggestions or warnings that expand scope.",
	"A reviewer follow-up must identify the prior findings, summarize the fixes, name changed paths, and include verification evidence. Ask only whether the named findings remain or the fix delta introduced a regression; do not request another full review or unrelated suggestions.",
	"After the targeted follow-up, stop delegating and verify directly. A third review is allowed only when the follow-up reports an unresolved critical release blocker involving security/authentication, data loss/persistence/migration, concurrency/process lifecycle, or compatibility; reuse the same key and request a blocker-only check.",
	"Every unkeyed child starts with fresh isolated context and cannot see the parent conversation or earlier children. Give unkeyed tasks the relevant requirements, paths, symbols, constraints, and acceptance criteria; do not delegate trivial lookups, and verify consequential findings.",
] as const;

/** Returns fresh mutable metadata for `registerTool`. */
export function createSubagentPromptMetadata(): { promptSnippet: string; promptGuidelines: string[] } {
	return {
		promptSnippet: "Delegate isolated codebase exploration, independent code review, and broader web research to specialized subagents",
		promptGuidelines: [...SUBAGENT_PROMPT_GUIDELINES],
	};
}
