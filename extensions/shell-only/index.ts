import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setEditorTopBarMode } from "../shared/editor-top-bar.ts";
import {
	persistedToolModeBaseline,
	persistedToolModeState,
	setToolMode,
	type SetToolModeOptions,
	type ToolModeDefinition,
} from "../tool-modes/protocol.ts";

const SHELL_ONLY_MODE_ID = "shell-only";
const SHELL_ONLY_MODE_PRIORITY = 20;

type ConfiguredTool = ReturnType<ExtensionAPI["getAllTools"]>[number];

export function shellOnlyTools(
	activeToolNames: string[],
	configuredTools: readonly ConfiguredTool[],
): string[] {
	const configuredByName = new Map(configuredTools.map((tool) => [tool.name, tool]));
	return activeToolNames.filter((name) => {
		const tool = configuredByName.get(name);
		return name === "bash" || tool?.sourceInfo.source !== "builtin";
	});
}

export default function shellOnlyExtension(pi: ExtensionAPI): void {
	let enabled = false;

	pi.registerFlag("shell-only", {
		description: "Start with Bash as the only active built-in tool",
		type: "boolean",
		default: false,
	});

	const toolModeDefinition: ToolModeDefinition = {
		id: SHELL_ONLY_MODE_ID,
		priority: SHELL_ONLY_MODE_PRIORITY,
		apply: (toolNames) => shellOnlyTools(toolNames, pi.getAllTools()),
	};

	function updateIndicator(): void {
		setEditorTopBarMode(pi, SHELL_ONLY_MODE_ID, enabled ? "$ shell only" : undefined, {
			compactLabel: "$",
			priority: SHELL_ONLY_MODE_PRIORITY,
			borderColor: "thinkingLow",
		});
	}

	async function applyMode(
		nextEnabled: boolean,
		ctx: ExtensionContext,
		options?: SetToolModeOptions,
	): Promise<boolean> {
		const result = await setToolMode(pi.events, toolModeDefinition, nextEnabled, options);
		if (result.status === "unavailable") {
			ctx.ui.notify(`Could not update shell-only mode: ${result.message}`, "error");
			return false;
		}
		enabled = nextEnabled;
		updateIndicator();
		return true;
	}

	async function toggle(ctx: ExtensionContext): Promise<void> {
		const nextEnabled = !enabled;
		if (!(await applyMode(nextEnabled, ctx, { persist: true }))) return;
		ctx.ui.notify(
			nextEnabled
				? "Shell-only mode enabled. Bash is the only active built-in tool; custom tools remain available."
				: "Shell-only mode disabled. Remaining tool-mode policies applied.",
			"info",
		);
	}

	pi.registerCommand("shell-only", {
		description: "Toggle shell-only mode",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			await toggle(ctx);
		},
	});

	async function restore(ctx: ExtensionContext, defaultEnabled: boolean): Promise<void> {
		const coordinatorState = persistedToolModeState(ctx);
		const restoredEnabled = coordinatorState
			? coordinatorState.activeModeIds.includes(SHELL_ONLY_MODE_ID)
			: defaultEnabled;
		await applyMode(restoredEnabled, ctx, {
			baselineSeed: coordinatorState?.baselineTools ?? persistedToolModeBaseline(ctx),
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		await restore(ctx, pi.getFlag("shell-only") === true);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await restore(ctx, false);
	});
}
