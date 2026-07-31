import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	SetToolModeOptions,
	ToolModeBaselinePatch,
	ToolModeDefinition,
	ToolModeResult,
} from "./protocol.ts";

function uniqueToolNames(toolNames: string[]): string[] {
	return [...new Set(toolNames)];
}

function sameToolSet(left: readonly string[], right: readonly string[]): boolean {
	const target = new Set(right);
	const source = new Set(left);
	return source.size === target.size && [...source].every((name) => target.has(name));
}

export interface ToolModeCoordinatorSnapshot {
	activeModes: Map<string, ToolModeDefinition>;
	baselineTools?: string[];
	activeTools: string[];
}

// Record only the transition reason; tool definitions and the system prompt carry the active set.
export function formatToolModeChange(state: Pick<ToolModeResult, "activeModeIds">): string {
	const activeModes = state.activeModeIds.length > 0 ? state.activeModeIds.join(", ") : "none";
	return `[TOOL MODE CHANGE]
Tool modes changed at this point in the conversation. This supersedes every earlier claim about which tool modes or tools are active; the tool definitions sent with each request are the complete list of what you can call.
Active restrictive modes: ${activeModes}`;
}

export class ToolModeCoordinator {
	private readonly activeModes = new Map<string, ToolModeDefinition>();
	private baselineTools: string[] | undefined;

	constructor(private readonly pi: ExtensionAPI) {}

	setMode(
		mode: ToolModeDefinition,
		enabled: boolean,
		options: SetToolModeOptions = {},
	): ToolModeResult {
		const previousModes = new Map(this.activeModes);
		const previousBaseline = this.baselineTools ? [...this.baselineTools] : undefined;
		const previousActiveTools = this.pi.getActiveTools();

		try {
			if (options.baselineSeed !== undefined) {
				this.baselineTools = uniqueToolNames(options.baselineSeed);
			} else if (enabled && this.baselineTools === undefined) {
				this.baselineTools = this.pi.getActiveTools();
			}
			this.patchBaseline(options.baselinePatch);

			if (enabled) this.activeModes.set(mode.id, mode);
			else this.activeModes.delete(mode.id);

			if (this.activeModes.size === 0) {
				const restoredBaseline = this.baselineTools ? [...this.baselineTools] : undefined;
				const result = this.applyToolSet(restoredBaseline ?? this.pi.getActiveTools());
				this.baselineTools = undefined;
				return {
					...result,
					baselineTools: restoredBaseline,
					activeModeIds: [],
				};
			}

			return {
				...this.applyPolicies(),
				baselineTools: this.baselineTools ? [...this.baselineTools] : undefined,
				activeModeIds: this.activeModeIds(),
			};
		} catch (error) {
			this.activeModes.clear();
			for (const [id, definition] of previousModes) this.activeModes.set(id, definition);
			this.baselineTools = previousBaseline;
			try {
				this.pi.setActiveTools(previousActiveTools);
			} catch {
				// Preserve the transition error; restrictive modes retain independent guards.
			}
			throw error;
		}
	}

	snapshot(): ToolModeCoordinatorSnapshot {
		return {
			activeModes: new Map(this.activeModes),
			baselineTools: this.baselineTools ? [...this.baselineTools] : undefined,
			activeTools: this.pi.getActiveTools(),
		};
	}

	restore(snapshot: ToolModeCoordinatorSnapshot): void {
		this.activeModes.clear();
		for (const [id, definition] of snapshot.activeModes) this.activeModes.set(id, definition);
		this.baselineTools = snapshot.baselineTools ? [...snapshot.baselineTools] : undefined;
		this.pi.setActiveTools(snapshot.activeTools);
	}

	reconcile(): ToolModeResult {
		if (this.activeModes.size === 0 || this.baselineTools === undefined) {
			return {
				status: "applied",
				activeTools: this.pi.getActiveTools(),
				activeModeIds: [],
				unavailableTools: [],
			};
		}

		return {
			...this.applyPolicies(),
			baselineTools: [...this.baselineTools],
			activeModeIds: this.activeModeIds(),
		};
	}

	shutdown(): void {
		if (this.baselineTools !== undefined) {
			this.pi.setActiveTools(this.baselineTools);
		}
		this.activeModes.clear();
		this.baselineTools = undefined;
	}

	private patchBaseline(patch: ToolModeBaselinePatch | undefined): void {
		if (!patch || this.baselineTools === undefined) return;

		const removed = new Set(patch.remove ?? []);
		this.baselineTools = uniqueToolNames([
			...this.baselineTools.filter((name) => !removed.has(name)),
			...(patch.add ?? []),
		]);
	}

	private sortedPolicies(): ToolModeDefinition[] {
		return [...this.activeModes.values()].sort(
			(a, b) => a.priority - b.priority || a.id.localeCompare(b.id),
		);
	}

	private activeModeIds(): string[] {
		return this.sortedPolicies().map((policy) => policy.id);
	}

	private applyPolicies(): Pick<ToolModeResult, "status" | "activeTools" | "unavailableTools"> {
		let effectiveTools = [...(this.baselineTools ?? [])];
		for (const policy of this.sortedPolicies()) {
			const policyTools = policy.apply([...effectiveTools]);
			if (
				!Array.isArray(policyTools) ||
				policyTools.length > 256 ||
				policyTools.some(
					(name) => typeof name !== "string" || name.length === 0 || name.length > 256,
				)
			) {
				throw new Error(`Tool mode "${policy.id}" returned an invalid tool list.`);
			}
			effectiveTools = uniqueToolNames(policyTools);
		}
		return this.applyToolSet(effectiveTools);
	}

	private applyToolSet(
		toolNames: string[],
	): Pick<ToolModeResult, "status" | "activeTools" | "unavailableTools"> {
		const requestedTools = uniqueToolNames(toolNames);
		// Use a set so tool order does not invalidate the cache.
		if (!sameToolSet(requestedTools, this.pi.getActiveTools())) {
			this.pi.setActiveTools(requestedTools);
		}
		const activeTools = this.pi.getActiveTools();
		const active = new Set(activeTools);
		return {
			status: "applied",
			activeTools,
			unavailableTools: requestedTools.filter((name) => !active.has(name)),
		};
	}
}
