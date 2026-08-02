import type { ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { withPiDashAttention } from "./attention.ts";
import {
	answerSummary,
	runAskUserFlow,
	type AskUserDetails,
	type AskUserStatus,
	type NormalizedQuestion,
} from "./flow.ts";
import { createAskUserUI } from "./tui.ts";
import { setToolMode, type ToolModeDefinition } from "../tool-modes/protocol.ts";

const OptionSchema = Type.Object({
	label: Type.String({ minLength: 1, maxLength: 200, pattern: "\\S", description: "Concise option label" }),
	description: Type.Optional(
		Type.String({ maxLength: 500, description: "Optional explanation of the option or its tradeoffs" }),
	),
});

const QuestionSchema = Type.Object({
	id: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 64,
			description: "Short stable identifier used to associate the answer with this question",
		}),
	),
	question: Type.String({
		minLength: 1,
		maxLength: 1000,
		pattern: "\\S",
		description: "The complete question to show the user",
	}),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			maxItems: 8,
			description: "Suggested answers. Omit or leave empty for a free-text question.",
		}),
	),
	allowOther: Type.Optional(
		Type.Boolean({ description: "Allow a free-text answer in addition to the options (default: true)" }),
	),
	placeholder: Type.Optional(
		Type.String({ maxLength: 200, description: "Placeholder shown for free-text input" }),
	),
});

const AskUserParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: 8,
		description: "One or more related questions to ask in order",
	}),
});

function currentAssistantAskUserCallIds(ctx: ExtensionContext): string[] {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		return entry.message.content
			.filter((part): part is ToolCall => part.type === "toolCall" && part.name === "ask_user")
			.map((part) => part.id);
	}
	return [];
}

// Use a tool mode so the coordinator restores active tools without load-order races.
const NO_ASK_USER_MODE: ToolModeDefinition = {
	id: "no-ask-user",
	priority: 0,
	apply: (toolNames) => toolNames.filter((name) => name !== "ask_user"),
};

export default function askUserExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) return;
		// Derive this from ctx.hasUI on each start instead of persisting it.
		const result = await setToolMode(pi.events, NO_ASK_USER_MODE, true);
		if (result.status === "unavailable") {
			pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "ask_user"));
		}
	});

	pi.on("tool_call", (event, ctx) => {
		const askUserCallIds = currentAssistantAskUserCallIds(ctx);
		if (askUserCallIds.length === 0) return;
		if (event.toolName !== "ask_user" || event.toolCallId !== askUserCallIds[0]) {
			return {
				block: true,
				reason: "ask_user must be the only tool called in its assistant message; wait for the user's answers before choosing or executing the next action.",
			};
		}
	});

	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user one or more clarifying questions and wait for their answers. Use this before implementation whenever requirements, behavior, scope, constraints, or tradeoffs are materially ambiguous. Questions may offer choices and always support free text unless allowOther is false.",
		promptSnippet: "Ask the user one or more clarifying questions before implementation",
		promptGuidelines: [
			"Before starting any implementation, use ask_user to resolve every material ambiguity in requirements, expected behavior, scope, constraints, and tradeoffs; do not guess or begin editing while important details remain unclear. Skip only low-impact reversible choices or details the user explicitly delegated to your judgment.",
			"Inspect the relevant code and context before using ask_user when the answer can be discovered locally; do not ask the user questions that repository exploration can answer.",
			"Use ask_user as soon as ambiguity is identified, group related questions into one call when practical, and provide concise options with tradeoffs.",
			"Call ask_user by itself in an assistant message, with no sibling tool calls, then wait for its answers before choosing or executing the next action.",
			"If ask_user is cancelled or unavailable, do not infer an answer or silently choose a default; explain what remains unresolved and wait for direction.",
		],
		parameters: AskUserParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const usedIds = new Set<string>();
			const questions: NormalizedQuestion[] = params.questions.map((question, index) => {
				const baseId = question.id?.trim() || `question_${index + 1}`;
				let id = baseId;
				let suffix = 2;
				while (usedIds.has(id)) id = `${baseId}_${suffix++}`;
				usedIds.add(id);
				return {
					id,
					question: question.question.trim(),
					options: question.options ?? [],
					allowOther: question.allowOther !== false,
					placeholder: question.placeholder,
				};
			});

			if (!ctx.hasUI) {
				const details: AskUserDetails = { questions, answers: [], status: "unavailable" };
				return {
					content: [
						{
							type: "text",
							text: "Cannot ask the user because interactive UI is unavailable. Do not assume answers; report the unresolved questions to the user.",
						},
					],
					details,
				};
			}

			const ui = createAskUserUI(ctx.ui, ctx.mode === "tui");
			const details = await withPiDashAttention(pi.events, () =>
				runAskUserFlow(questions, ui, signal, {
					allowBackNavigation: ctx.mode === "tui",
				}),
			);
			if (details.status === "answered") {
				return {
					content: [{ type: "text", text: details.answers.map(answerSummary).join("\n") }],
					details,
				};
			}

			const reason =
				details.status === "aborted"
					? details.stoppedAt
						? "The question dialog was aborted"
						: "The answer review was aborted"
					: details.status === "empty"
						? "User submitted an empty answer"
						: "User cancelled the question dialog";
			const location = details.stoppedAt ? ` at ${details.stoppedAt}` : "";
			const partial =
				details.answers.length > 0
					? ` Answers received before it stopped:\n${details.answers.map(answerSummary).join("\n")}`
					: "";
			return {
				content: [
					{
						type: "text",
						text: `${reason}${location}. Do not assume an answer.${partial}`,
					},
				],
				details,
			};
		},

		renderCall(args, theme) {
			const questions = Array.isArray(args.questions) ? args.questions : [];
			const heading = `${theme.fg("toolTitle", theme.bold("ask_user "))}${theme.fg(
				"muted",
				`${questions.length} question${questions.length === 1 ? "" : "s"}`,
			)}`;
			const prompts = questions
				.map((question, index) => {
					const prompt =
						question && typeof question === "object" && "question" in question && typeof question.question === "string"
							? question.question
							: "";
					return theme.fg("dim", `  ${index + 1}. ${prompt}`);
				})
				.join("\n");
			return new Text(prompts ? `${heading}\n${prompts}` : heading, 0, 0);
		},

		renderResult(result, options, theme) {
			const details = result.details as AskUserDetails | undefined;
			if (!details) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "", 0, 0);
			}
			if (details.status !== "answered") {
				const labels: Record<Exclude<AskUserStatus, "answered">, string> = {
					cancelled: "Cancelled",
					empty: "Empty answer",
					aborted: "Aborted",
					unavailable: "UI unavailable",
				};
				const suffix = details.stoppedAt ? ` at ${details.stoppedAt}` : "";
				let text = theme.fg("warning", `${labels[details.status]}${suffix}`);
				if (options.expanded && details.answers.length > 0) {
					text += `\n${details.answers.map(answerSummary).map((line) => theme.fg("dim", `  ${line}`)).join("\n")}`;
				}
				return new Text(text, 0, 0);
			}
			const lines = details.answers.map(
				(answer) =>
					`${theme.fg("success", "✓ ")}${theme.fg("accent", answer.id)}: ${theme.fg("text", answer.answer)}`,
			);
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
