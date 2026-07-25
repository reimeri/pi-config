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
import {
	locallyActiveToolModes,
	persistedToolModeBaseline,
	persistedToolModeState,
	reconcileToolModes,
	setToolMode,
	type SetToolModeOptions,
	type ToolModeDefinition,
} from "../tool-modes/protocol.ts";
import { MAX_TODOS, requestTodosFromPlan } from "../todos/protocol.ts";
import { extractPlanSteps, isSafeCommand } from "./utils.ts";

// Tools
const TODO_TOOL_NAME = "todo_update";
const PLAN_MODE_STATE_VERSION = 2;
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls"];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write", TODO_TOOL_NAME]);
const PLAN_MODE_PRIORITY = 10;

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
	let planModeCanAskUser = false;
	let toolsBeforePlanMode: string[] | undefined;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function updateModeIndicator(ctx: ExtensionContext): void {
		// Clear footer state left by older versions that rendered modes there.
		ctx.ui.setStatus("plan-mode", undefined);
		setEditorTopBarMode(pi, "plan-mode", planModeEnabled ? "⏸️ plan" : undefined, {
			compactLabel: "⏸️",
			priority: 10,
			borderColor: "warning",
		});
	}

	function uniqueToolNames(toolNames: string[]): string[] {
		return [...new Set(toolNames)];
	}

	function getPlanModeTools(activeToolNames: string[]): string[] {
		const clarificationTools = planModeCanAskUser ? ["ask_user"] : [];
		return uniqueToolNames([
			...activeToolNames.filter(
				(name) => !PLAN_MODE_DISABLED_TOOLS.has(name) && (planModeCanAskUser || name !== "ask_user"),
			),
			...PLAN_MODE_TOOLS,
			...clarificationTools,
		]);
	}

	const toolModeDefinition: ToolModeDefinition = {
		id: "plan",
		priority: PLAN_MODE_PRIORITY,
		apply: getPlanModeTools,
	};

	async function setPlanModeTools(
		nextEnabled: boolean,
		ctx: ExtensionContext,
		options?: SetToolModeOptions,
	): Promise<boolean> {
		planModeCanAskUser = ctx.hasUI && pi.getAllTools().some((tool) => tool.name === "ask_user");
		const result = await setToolMode(pi.events, toolModeDefinition, nextEnabled, options);
		if (result.status === "unavailable") {
			ctx.ui.notify(`Could not update plan mode tools: ${result.message}`, "error");
			return false;
		}
		if (result.baselineTools !== undefined) {
			toolsBeforePlanMode = [...result.baselineTools];
		}
		return true;
	}

	function persistState(ctx: ExtensionContext): void {
		try {
			// Kept for backward compatibility. The coordinator entry is the
			// canonical state for coordinated mode restoration.
			pi.appendEntry("plan-mode", {
				version: PLAN_MODE_STATE_VERSION,
				enabled: planModeEnabled,
				toolsBeforePlanMode,
			});
		} catch (error) {
			ctx.ui.notify(
				`Plan mode changed, but its legacy state entry could not be written: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	}

	async function togglePlanMode(ctx: ExtensionContext): Promise<void> {
		const nextEnabled = !planModeEnabled;
		if (!(await setPlanModeTools(nextEnabled, ctx, { persist: true }))) return;
		planModeEnabled = nextEnabled;

		if (planModeEnabled) {
			ctx.ui.notify("Plan mode enabled. Write and TODO update tools disabled.");
		} else {
			ctx.ui.notify("Plan mode disabled. Remaining tool-mode policies applied.");
		}
		updateModeIndicator(ctx);
		persistState(ctx);
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => {
			await togglePlanMode(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			await togglePlanMode(ctx);
		},
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
		const latestPlanContextIndex = planModeEnabled
			? event.messages.findLastIndex(
					(message) => (message as AgentMessage & { customType?: string }).customType === "plan-mode-context",
				)
			: -1;
		return {
			messages: event.messages.filter((m, index) => {
				const msg = m as AgentMessage & { customType?: string };
				if (
					msg.customType === "plan-execution-context" ||
					msg.customType === "plan-mode-execute" ||
					msg.customType === "plan-todo-list" ||
					msg.customType === "plan-complete"
				) {
					return false;
				}
				if (msg.customType === "plan-mode-context") return index === latestPlanContextIndex;
				if (planModeEnabled) return true;
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
		const clarificationGuidance = planModeCanAskUser
			? "Ask clarifying questions using the ask_user tool."
			: "If material ambiguities remain, report them instead of assuming answers.";
		return {
			message: {
				customType: "plan-mode-context",
				content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- Built-in edit and write tools are disabled
- Other currently active tools remain available
- Bash is restricted to an allowlist of read-only commands

${clarificationGuidance}
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

			const modeState = await reconcileToolModes(pi.events);
			if (modeState.status === "unavailable") {
				ctx.ui.notify(`Cannot execute plan: ${modeState.message}`, "error");
				return;
			}
			if (
				modeState.activeModeIds.includes("quarantine") ||
				locallyActiveToolModes(pi.events).includes("quarantine")
			) {
				ctx.ui.notify("Cannot execute plan while quarantine is enabled. Disable quarantine first.", "warning");
				return;
			}

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

			if (
				!(await setPlanModeTools(false, ctx, {
					baselinePatch: { add: [TODO_TOOL_NAME] },
					persist: true,
				}))
			) {
				return;
			}
			planModeEnabled = false;
			updateModeIndicator(ctx);
			persistState(ctx);

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

	async function restoreState(ctx: ExtensionContext, defaultEnabled: boolean): Promise<void> {
		const planModeEntry = ctx.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "plan-mode")
			.pop();
		const knownTools = new Set(pi.getAllTools().map((tool) => tool.name));
		const state = planModeEntry?.type === "custom" ? parsePlanModeState(planModeEntry.data, knownTools) : undefined;

		const coordinatorState = persistedToolModeState(ctx);
		const restoredEnabled = coordinatorState
			? coordinatorState.activeModeIds.includes("plan")
			: state?.enabled ?? defaultEnabled;
		if (state?.toolsBeforePlanMode !== undefined) {
			toolsBeforePlanMode = state.toolsBeforePlanMode;
		}
		if (
			await setPlanModeTools(restoredEnabled, ctx, {
				baselineSeed: coordinatorState?.baselineTools ?? persistedToolModeBaseline(ctx),
			})
		) {
			planModeEnabled = restoredEnabled;
		}
		updateModeIndicator(ctx);
	}

	// Restore branch-aware plan-mode state on session start/resume and tree navigation.
	pi.on("session_start", async (_event, ctx) => {
		await restoreState(ctx, pi.getFlag("plan") === true);
	});
	pi.on("session_tree", async (_event, ctx) => {
		await restoreState(ctx, false);
	});
}
