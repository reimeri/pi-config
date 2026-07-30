import type { AgentConfig } from "./agents.ts";

export class AgentConcurrencyGate {
	private readonly activeGroups = new Set<string>();

	isActive(group: string | undefined): boolean {
		return Boolean(group && this.activeGroups.has(group));
	}

	tryAcquire(group: string | undefined): (() => void) | undefined {
		if (!group) return () => {};
		if (this.isActive(group)) return undefined;
		this.activeGroups.add(group);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.activeGroups.delete(group);
		};
	}
}

export function findParallelConcurrencyConflict(
	agents: readonly AgentConfig[],
	agentNames: readonly string[],
): string | undefined {
	const groups = new Set<string>();
	for (const name of agentNames) {
		const group = agents.find((agent) => agent.name === name)?.concurrencyGroup;
		if (!group) continue;
		if (groups.has(group)) return group;
		groups.add(group);
	}
	return undefined;
}
