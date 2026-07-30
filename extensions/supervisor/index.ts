import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setEditorTopBarMode } from "../shared/editor-top-bar.ts";
import type { ExtensionAgentDiscoveryRequest } from "../subagent/protocol.ts";
import { SUBAGENT_AGENT_DISCOVERY_EVENT } from "../subagent/protocol.ts";
import {
	persistedToolModeBaseline,
	persistedToolModeState,
	setToolMode,
	type SetToolModeOptions,
	type ToolModeDefinition,
} from "../tool-modes/protocol.ts";
import {
	SUPERVISOR_MODE_ID,
	SUPERVISOR_MODE_PRIORITY,
	supervisorInstructions,
	supervisorTools,
} from "./core.ts";

const WORKER_AGENT_PATH = fileURLToPath(new URL("./worker.md", import.meta.url));

export default function supervisorExtension(pi: ExtensionAPI): void {
	let enabled = false;

	pi.registerFlag("supervisor", {
		description: "Start in supervisor mode and delegate implementation to a worker",
		type: "boolean",
		default: false,
	});

	const toolModeDefinition: ToolModeDefinition = {
		id: SUPERVISOR_MODE_ID,
		priority: SUPERVISOR_MODE_PRIORITY,
		apply: supervisorTools,
	};

	function updateIndicator(): void {
		setEditorTopBarMode(pi, SUPERVISOR_MODE_ID, enabled ? "◆ supervisor" : undefined, {
			compactLabel: "◆",
			priority: SUPERVISOR_MODE_PRIORITY,
			borderColor: "warning",
		});
	}

	async function applyMode(
		nextEnabled: boolean,
		ctx: ExtensionContext,
		options?: SetToolModeOptions,
	): Promise<boolean> {
		const result = await setToolMode(pi.events, toolModeDefinition, nextEnabled, options);
		if (result.status === "unavailable") {
			ctx.ui.notify(`Could not update supervisor mode: ${result.message}`, "error");
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
				? "Supervisor mode enabled. Direct edit tools are hidden; implementation should be delegated to worker."
				: "Supervisor mode disabled. Remaining tool-mode policies applied.",
			"info",
		);
	}

	pi.registerCommand("supervisor", {
		description: "Toggle supervisor mode",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			await toggle(ctx);
		},
	});

	const unsubscribeAgentDiscovery = pi.events.on(SUBAGENT_AGENT_DISCOVERY_EVENT, (data) => {
		if (!enabled || !data || typeof data !== "object") return;
		const request = data as Partial<ExtensionAgentDiscoveryRequest>;
		if (typeof request.add !== "function") return;
		request.add({ providerId: SUPERVISOR_MODE_ID, filePath: WORKER_AGENT_PATH });
	});

	pi.on("before_agent_start", async (event) => {
		if (!enabled) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${supervisorInstructions()}` };
	});

	async function restore(ctx: ExtensionContext, defaultEnabled: boolean): Promise<void> {
		const coordinatorState = persistedToolModeState(ctx);
		const restoredEnabled = coordinatorState
			? coordinatorState.activeModeIds.includes(SUPERVISOR_MODE_ID)
			: defaultEnabled;
		await applyMode(restoredEnabled, ctx, {
			baselineSeed: coordinatorState?.baselineTools ?? persistedToolModeBaseline(ctx),
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		await restore(ctx, pi.getFlag("supervisor") === true);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await restore(ctx, false);
	});

	pi.on("session_shutdown", () => {
		unsubscribeAgentDiscovery();
	});
}
