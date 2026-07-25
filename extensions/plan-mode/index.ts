/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, built-in write tools are disabled.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P to toggle
 * - Bash restricted to allowlisted read-only commands
 * - Extracts numbered plan steps from "Plan:" sections
 * - Creates canonical execution TODOs through the todos extension
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { setEditorTopBarMode } from "../shared/editor-top-bar.ts";
import { MAX_TODOS, requestTodosFromPlan } from "../todos/protocol.ts";
import { extractPlanSteps, isSafeCommand } from "./utils.ts";

// Tools
const TODO_TOOL_NAME = "todo_update";
const PLAN_MODE_STATE_VERSION = 2;
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write", TODO_TOOL_NAME];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write", TODO_TOOL_NAME]);
const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);

interface PlanModeState {
	version: typeof PLAN_MODE_STATE_VERSION;
	enabled: boolean;
	toolsBeforePlanMode?: string[];
}

function parsePlanModeState(value: unknown, knownTools: Set<string>): PlanModeState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const state = value as { version?: unknown; enabled?: unknown; toolsBeforePlanMode?: unknown };
	if (state.version !== undefined && state.version !== PLAN_MODE_STATE_VERSION) return undefined;
	if (typeof state.enabled !== "boolean") return undefined;
	const toolsBeforePlanMode = Array.isArray(state.toolsBeforePlanMode)
		? [...new Set(state.toolsBeforePlanMode.filter((name): name is string => typeof name === "string" && knownTools.has(name)))]
		: undefined;
	return { version: PLAN_MODE_STATE_VERSION, enabled: state.enabled, toolsBeforePlanMode };
}

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let toolsBeforePlanMode: string[] | undefined;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function updateModeIndicator(ctx: ExtensionContext): void {
		// Clear footer state left by older versions that rendered modes there.
		ctx.ui.setStatus("plan-mode", undefined);
		setEditorTopBarMode(pi, "plan-mode", planModeEnabled ? "⏸ plan" : undefined, {
			compactLabel: "⏸",
			priority: 10,
		});
	}

	function uniqueToolNames(toolNames: string[]): string[] {
		return [...new Set(toolNames)];
	}

	function getPlanModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...activeToolNames.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)),
			...PLAN_MODE_TOOLS,
		]);
	}

	function getNormalModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...NORMAL_MODE_TOOLS,
			...activeToolNames.filter((name) => !PLAN_MANAGED_TOOLS.has(name)),
		]);
	}

	function enablePlanModeTools(captureCurrentTools = false): void {
		if (captureCurrentTools || toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = pi.getActiveTools();
		}
		pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
	}

	function restoreNormalModeTools(requireTodoUpdate = false): void {
		const restoredTools = toolsBeforePlanMode ?? getNormalModeTools(pi.getActiveTools());
		toolsBeforePlanMode = requireTodoUpdate
			? uniqueToolNames([...restoredTools, TODO_TOOL_NAME])
			: restoredTools;
		pi.setActiveTools(toolsBeforePlanMode);
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			version: PLAN_MODE_STATE_VERSION,
			enabled: planModeEnabled,
			toolsBeforePlanMode,
		});
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;

		if (planModeEnabled) {
			enablePlanModeTools(true);
			ctx.ui.notify("Plan mode enabled. Write and TODO update tools disabled.");
		} else {
			restoreNormalModeTools();
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		}
		updateModeIndicator(ctx);
		persistState();
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// Block destructive bash commands in plan mode
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
			};
		}
	});

	// Filter stale context from the previous progress-tracking implementation.
	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (
					msg.customType === "plan-execution-context" ||
					msg.customType === "plan-mode-execute" ||
					msg.customType === "plan-todo-list" ||
					msg.customType === "plan-complete"
				) {
					return false;
				}
				if (planModeEnabled) return true;
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// Inject plan context before the agent starts.
	pi.on("before_agent_start", async () => {
		if (!planModeEnabled) return;
		return {
			message: {
				customType: "plan-mode-context",
				content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- Built-in edit and write tools are disabled
- Other currently active tools remain available
- Bash is restricted to an allowlist of read-only commands

Ask clarifying questions using the questionnaire tool.
Use brave-search skill via bash for web research.

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.`,
				display: false,
			},
		};
	});

	// Extract a completed plan and offer to execute or refine it.
	pi.on("agent_end", async (event, ctx) => {
		if (!planModeEnabled || !ctx.hasUI) return;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		const planSteps = lastAssistant ? extractPlanSteps(getTextContent(lastAssistant)) : [];
		if (planSteps.length === 0) return;
		if (planSteps.length > MAX_TODOS) {
			ctx.ui.notify(
				`Plan has ${planSteps.length} steps; refine it to at most ${MAX_TODOS} before execution.`,
				"warning",
			);
			return;
		}

		const planListText = planSteps.map((step, index) => `${index + 1}. ☐ ${step.text}`).join("\n");
		const planStepListMessage = {
			customType: "plan-step-list",
			content: `**Plan Steps (${planSteps.length}):**\n\n${planListText}`,
			display: true,
		};

		const choice = await ctx.ui.select("Plan mode - what next?", [
			"Execute the plan",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice === "Execute the plan") {
			const firstPlanStep = planSteps[0];
			if (!firstPlanStep) return;

			const replacement = await requestTodosFromPlan(
				pi.events,
				planSteps.map((step) => step.text),
				"Created from the approved plan",
			);
			if (replacement.status === "cancelled") {
				ctx.ui.notify("Plan execution cancelled; existing TODOs were kept.", "info");
				return;
			}
			if (replacement.status === "unavailable") {
				ctx.ui.notify(`Cannot execute plan: ${replacement.message}`, "error");
				return;
			}

			planModeEnabled = false;
			restoreNormalModeTools(true);
			updateModeIndicator(ctx);
			persistState();

			const remainingList = planSteps.map((step) => `${step.step}. ${step.text}`).join("\n");
			const execMessage = `Execute the approved plan.

Plan steps:
${remainingList}

Start with: ${firstPlanStep.text}
Use todo_update as the canonical progress tracker. Mark each item completed only after verification, then move the next pending item to in_progress.`;
			pi.sendMessage(planStepListMessage, { deliverAs: "followUp" });
			pi.sendMessage(
				{ customType: "plan-mode-execute-v2", content: execMessage, display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendMessage(planStepListMessage, { deliverAs: "followUp" });
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
	});

	function restoreState(ctx: ExtensionContext, defaultEnabled: boolean): void {
		const wasPlanModeEnabled = planModeEnabled;
		const planModeEntry = ctx.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "plan-mode")
			.pop();
		const knownTools = new Set(pi.getAllTools().map((tool) => tool.name));
		const state = planModeEntry?.type === "custom" ? parsePlanModeState(planModeEntry.data, knownTools) : undefined;

		planModeEnabled = state?.enabled ?? defaultEnabled;
		if (state?.toolsBeforePlanMode !== undefined) {
			toolsBeforePlanMode = state.toolsBeforePlanMode;
		}
		if (planModeEnabled) {
			enablePlanModeTools();
		} else if (state?.toolsBeforePlanMode !== undefined || wasPlanModeEnabled) {
			restoreNormalModeTools();
		}
		updateModeIndicator(ctx);
	}

	// Restore branch-aware plan-mode state on session start/resume and tree navigation.
	pi.on("session_start", async (_event, ctx) => {
		restoreState(ctx, pi.getFlag("plan") === true);
	});
	pi.on("session_tree", async (_event, ctx) => {
		restoreState(ctx, false);
	});
}
