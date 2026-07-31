import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SUBAGENT_AGENT_DISCOVERY_EVENT = "subagent:agent-discovery";

export interface ExtensionAgentContribution {
	providerId: string;
	filePath: string;
}

export interface ExtensionAgentDiscoveryRequest {
	cwd: string;
	add: (contribution: ExtensionAgentContribution) => void;
}

function isValidContribution(value: unknown): value is ExtensionAgentContribution {
	if (!value || typeof value !== "object") return false;
	const contribution = value as Record<string, unknown>;
	return (
		typeof contribution.providerId === "string" &&
		contribution.providerId.length > 0 &&
		contribution.providerId.length <= 128 &&
		typeof contribution.filePath === "string" &&
		contribution.filePath.length > 0 &&
		contribution.filePath.length <= 4096
	);
}

/** Collect trusted extension-provided agent files synchronously for one invocation. */
export function discoverExtensionAgents(
	events: ExtensionAPI["events"],
	cwd: string,
): ExtensionAgentContribution[] {
	const contributions = new Map<string, ExtensionAgentContribution>();
	try {
		events.emit(SUBAGENT_AGENT_DISCOVERY_EVENT, {
			cwd,
			add: (value: ExtensionAgentContribution) => {
				if (!isValidContribution(value)) return;
				const key = `${value.providerId}\0${value.filePath}`;
				contributions.set(key, { ...value });
			},
		} satisfies ExtensionAgentDiscoveryRequest);
	} catch {
		// Ignore one faulty contributor so built-in discovery still succeeds.
	}
	return [...contributions.values()];
}
