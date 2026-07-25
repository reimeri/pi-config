import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ToolModeCoordinator } from "./coordinator.ts";
import {
	TOOL_MODE_REQUEST_EVENT,
	TOOL_MODE_STATE_ENTRY_TYPE,
	TOOL_MODE_STATE_VERSION,
	type ToolModeCoordinatorState,
	type ToolModeRequest,
	type ToolModeResult,
} from "./protocol.ts";

function isOptionalToolNameArray(value: unknown): boolean {
	return (
		value === undefined ||
		(Array.isArray(value) &&
			value.length <= 256 &&
			value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 256))
	);
}

function isValidBaselinePatch(value: unknown): boolean {
	if (value === undefined) return true;
	if (!value || typeof value !== "object") return false;
	const patch = value as Record<string, unknown>;
	return isOptionalToolNameArray(patch.add) && isOptionalToolNameArray(patch.remove);
}

function isValidSetOptions(value: unknown): boolean {
	if (value === undefined) return true;
	if (!value || typeof value !== "object") return false;
	const options = value as Record<string, unknown>;
	return (
		isValidBaselinePatch(options.baselinePatch) &&
		isOptionalToolNameArray(options.baselineSeed) &&
		(options.persist === undefined || typeof options.persist === "boolean")
	);
}

function isToolModeRequest(value: unknown): value is ToolModeRequest {
	if (!value || typeof value !== "object") return false;
	const request = value as Record<string, unknown>;
	if (
		typeof request.acknowledge !== "function" ||
		typeof request.respond !== "function" ||
		typeof request.fail !== "function"
	) {
		return false;
	}
	if (request.action === "reconcile") return true;
	if (
		request.action !== "set" ||
		typeof request.enabled !== "boolean" ||
		!isValidSetOptions(request.options)
	) {
		return false;
	}
	if (!request.mode || typeof request.mode !== "object") return false;
	const mode = request.mode as Record<string, unknown>;
	return (
		typeof mode.id === "string" &&
		mode.id.length > 0 &&
		mode.id.length <= 128 &&
		typeof mode.priority === "number" &&
		Number.isFinite(mode.priority) &&
		typeof mode.apply === "function"
	);
}

export default function toolModeCoordinatorExtension(pi: ExtensionAPI): void {
	const coordinator = new ToolModeCoordinator(pi);
	const unsubscribe = pi.events.on(TOOL_MODE_REQUEST_EVENT, (data) => {
		if (!isToolModeRequest(data)) {
			if (data && typeof data === "object") {
				const callbacks = data as Record<string, unknown>;
				if (typeof callbacks.acknowledge === "function" && typeof callbacks.fail === "function") {
					(callbacks.acknowledge as () => void)();
					(callbacks.fail as (message: string) => void)("Invalid tool-mode coordinator request.");
				}
			}
			return;
		}
		data.acknowledge();
		const snapshot = coordinator.snapshot();
		let result: ToolModeResult;
		try {
			result =
				data.action === "set"
					? coordinator.setMode(data.mode, data.enabled, data.options)
					: coordinator.reconcile();
			if (data.action === "set" && data.options?.persist) {
				pi.appendEntry<ToolModeCoordinatorState>(TOOL_MODE_STATE_ENTRY_TYPE, {
					version: TOOL_MODE_STATE_VERSION,
					baselineTools: [...(result.baselineTools ?? result.activeTools)],
					activeModeIds: [...result.activeModeIds],
				});
			}
		} catch (error) {
			try {
				coordinator.restore(snapshot);
			} catch {
				// The requesting mode handles coordinator failure; quarantine has a
				// direct fail-closed fallback and hard tool-call gate.
			}
			data.fail(error instanceof Error ? error.message : String(error));
			return;
		}
		data.respond(result);
	});

	// Reassert active policies around every model turn so tools dynamically
	// activated by another extension cannot escape a restrictive mode.
	pi.on("before_agent_start", () => {
		coordinator.reconcile();
	});
	pi.on("turn_end", () => {
		coordinator.reconcile();
	});

	// A replacement session inherits the process-wide active tool set. Restore
	// the unconstrained baseline before its fresh extension runtime starts.
	pi.on("session_shutdown", () => {
		unsubscribe();
		coordinator.shutdown();
	});
}
