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

export interface ChainConcurrencyConflict {
	agent: string;
	group: string;
}

/**
 * Grouped agents in a chain, which is rejected outright rather than deduplicated.
 *
 * A concurrency group marks an agent that mutates shared workspace state, and the gate alone cannot
 * protect that: chain steps are sequential, so they never overlap, and a chain would run several of
 * them back to back with nothing in between. The parent has to see each result and confirm the
 * workspace before the next one starts, which means separate calls. Even a single grouped step is
 * refused — it is a single-mode call written the long way, and allowing it invites the two-step
 * version that skips the checkpoint.
 */
export function findChainConcurrencyConflicts(
	agents: readonly AgentConfig[],
	agentNames: readonly string[],
): ChainConcurrencyConflict[] {
	const conflicts: ChainConcurrencyConflict[] = [];
	const seen = new Set<string>();
	for (const name of agentNames) {
		const group = agents.find((agent) => agent.name === name)?.concurrencyGroup;
		if (!group || seen.has(name)) continue;
		seen.add(name);
		conflicts.push({ agent: name, group });
	}
	return conflicts;
}
