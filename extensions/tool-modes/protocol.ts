import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const TOOL_MODE_REQUEST_EVENT = "tool-modes:request";
export const LOCAL_TOOL_MODE_STATUS_EVENT = "tool-modes:local-status";
export const TOOL_MODE_STATE_ENTRY_TYPE = "tool-mode-coordinator-state";
export const TOOL_MODE_STATE_VERSION = 1;

export interface ToolModeDefinition {
	id: string;
	priority: number;
	apply: (toolNames: string[]) => string[];
}

export interface SetToolModeOptions {
	baselineSeed?: string[];
	persist?: boolean;
}

export interface ToolModeCoordinatorState {
	version: typeof TOOL_MODE_STATE_VERSION;
	baselineTools: string[];
	activeModeIds: string[];
}

export interface ToolModeResult {
	status: "applied";
	baselineTools?: string[];
	activeTools: string[];
	activeModeIds: string[];
	unavailableTools: string[];
}

export type ToolModeRequestResult =
	| ToolModeResult
	| { status: "unavailable"; message: string };

interface ToolModeRequestCallbacks {
	acknowledge: () => void;
	respond: (result: ToolModeResult) => void;
	fail: (message: string) => void;
}

export interface SetToolModeRequest extends ToolModeRequestCallbacks {
	action: "set";
	mode: ToolModeDefinition;
	enabled: boolean;
	options?: SetToolModeOptions;
}

export type ToolModeRequest = SetToolModeRequest;

function sendRequest(
	events: ExtensionAPI["events"],
	request: Omit<SetToolModeRequest, keyof ToolModeRequestCallbacks>,
): Promise<ToolModeRequestResult> {
	return new Promise((resolve) => {
		let acknowledged = false;
		let settled = false;
		const settle = (result: ToolModeRequestResult): void => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		try {
			events.emit(TOOL_MODE_REQUEST_EVENT, {
				...request,
				acknowledge: () => {
					acknowledged = true;
				},
				respond: (result: ToolModeResult) => settle(result),
				fail: (message: string) => settle({ status: "unavailable", message }),
			} satisfies ToolModeRequest);
		} catch (error) {
			settle({
				status: "unavailable",
				message: error instanceof Error ? error.message : String(error),
			});
		}

		queueMicrotask(() => {
			if (settled) return;
			settle({
				status: "unavailable",
				message: acknowledged
					? "The tool-mode coordinator did not respond synchronously."
					: "The tool-mode coordinator extension is not available.",
			});
		});
	});
}

export function setToolMode(
	events: ExtensionAPI["events"],
	mode: ToolModeDefinition,
	enabled: boolean,
	options?: SetToolModeOptions,
): Promise<ToolModeRequestResult> {
	return sendRequest(events, { action: "set", mode, enabled, options });
}

function stateToolNames(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length > 256) return undefined;
	if (!value.every((name) => typeof name === "string" && name.length > 0)) return undefined;
	return [...new Set(value)];
}

export function persistedToolModeState(
	ctx: ExtensionContext,
): ToolModeCoordinatorState | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== TOOL_MODE_STATE_ENTRY_TYPE) continue;
		if (!entry.data || typeof entry.data !== "object") continue;
		const state = entry.data as Record<string, unknown>;
		if (state.version !== TOOL_MODE_STATE_VERSION) continue;
		const baselineTools = stateToolNames(state.baselineTools);
		const activeModeIds = stateToolNames(state.activeModeIds);
		if (!baselineTools || !activeModeIds) continue;
		return {
			version: TOOL_MODE_STATE_VERSION,
			baselineTools,
			activeModeIds,
		};
	}
	return undefined;
}

export function persistedToolModeBaseline(ctx: ExtensionContext): string[] | undefined {
	const persistedState = persistedToolModeState(ctx);
	if (persistedState) return persistedState.baselineTools;

	const branch = ctx.sessionManager.getBranch();
	let quarantineEnabled = false;
	let cycleBaseline: string[] | undefined;
	let lastRestored: string[] | undefined;
	for (const entry of branch) {
		if (
			entry.type !== "custom" ||
			entry.customType !== "quarantine-state" ||
			!entry.data ||
			typeof entry.data !== "object"
		) {
			continue;
		}
		const state = entry.data as Record<string, unknown>;
		if (typeof state.enabled !== "boolean") continue;
		const tools = state.enabled
			? stateToolNames(state.toolsBeforeQuarantine)
			: stateToolNames(state.restoredTools);
		if (state.enabled && !quarantineEnabled) cycleBaseline = tools ?? lastRestored;
		if (!state.enabled && tools) lastRestored = tools;
		quarantineEnabled = state.enabled;
	}
	return cycleBaseline ?? lastRestored;
}

export interface LocalToolModeReport {
	modeId: string;
	enforcedTools?: string[];
}

export function locallyActiveToolModeReports(
	events: ExtensionAPI["events"],
): LocalToolModeReport[] {
	const reports = new Map<string, LocalToolModeReport>();
	try {
		events.emit(LOCAL_TOOL_MODE_STATUS_EVENT, {
			report: (modeId: string, enforcedTools?: string[]) => {
				if (modeId.length === 0) return;
				reports.set(modeId, {
					modeId,
					enforcedTools: enforcedTools ? stateToolNames(enforcedTools) : undefined,
				});
			},
		});
	} catch {
		// Coordinator state is primary; local reporting preserves emergency fail-closed behavior.
	}
	return [...reports.values()];
}
