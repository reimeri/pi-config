import type { AgentConfig } from "./agents.ts";

/** Maximum queue wait; bounds calls when a holder never exits. */
export const GATE_WAIT_MS = 10 * 60 * 1000;

export type GateFailure = "busy" | "abandoned" | "aborted";

export type AcquireOutcome = { ok: true; release: () => void } | { ok: false; reason: GateFailure };

export interface AcquireOptions {
	/** Time to spend queued for a held key. Omitted or zero fails immediately, as the gate used to. */
	timeoutMs?: number;
	signal?: AbortSignal;
}

interface Waiter {
	settle: (outcome: AcquireOutcome) => void;
}

/** FIFO mutual exclusion over named keys; busy callers queue until release or timeout. */
export class AgentConcurrencyGate {
	private readonly activeKeys = new Set<string>();
	/** Keys whose holder is never coming back. Waiting on one of these is pointless, so it fails fast. */
	private readonly abandonedKeys = new Set<string>();
	private readonly queues = new Map<string, Waiter[]>();

	isActive(key: string | undefined): boolean {
		return Boolean(key && this.activeKeys.has(key));
	}

	/** How many callers are queued for a key, for status reporting. */
	waiting(key: string | undefined): number {
		return key ? (this.queues.get(key)?.length ?? 0) : 0;
	}

	async acquire(key: string | undefined, options: AcquireOptions = {}): Promise<AcquireOutcome> {
		if (!key) return { ok: true, release: () => {} };
		if (options.signal?.aborted) return { ok: false, reason: "aborted" };
		if (this.abandonedKeys.has(key)) return { ok: false, reason: "abandoned" };
		// Preserve FIFO if handoff ever becomes asynchronous.
		if (!this.activeKeys.has(key) && this.waiting(key) === 0) return { ok: true, release: this.hold(key) };

		const timeoutMs = options.timeoutMs ?? 0;
		if (timeoutMs <= 0) return { ok: false, reason: "busy" };
		return this.wait(key, timeoutMs, options.signal);
	}

	/** Marks a still-used key unusable and fails its waiters immediately. */
	abandon(key: string | undefined): void {
		if (!key) return;
		this.abandonedKeys.add(key);
		this.activeKeys.add(key);
		this.dropWaiters(key);
	}

	/** Fails queued callers without permanently disabling the key. */
	dropWaiters(key: string | undefined): void {
		if (!key) return;
		const queue = this.queues.get(key);
		if (!queue) return;
		this.queues.delete(key);
		for (const waiter of queue) waiter.settle({ ok: false, reason: "abandoned" });
	}

	private hold(key: string): () => void {
		this.activeKeys.add(key);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.activeKeys.delete(key);
			this.handOff(key);
		};
	}

	private handOff(key: string): void {
		const queue = this.queues.get(key);
		const next = queue?.shift();
		if (!queue || !next) return;
		if (queue.length === 0) this.queues.delete(key);
		next.settle({ ok: true, release: this.hold(key) });
	}

	private wait(key: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<AcquireOutcome> {
		return new Promise<AcquireOutcome>((resolve) => {
			let settled = false;
			const onAbort = () => waiter.settle({ ok: false, reason: "aborted" });
			const timer = setTimeout(() => waiter.settle({ ok: false, reason: "busy" }), timeoutMs);
			timer.unref?.();

			const waiter: Waiter = {
				settle: (outcome) => {
					if (settled) return;
					settled = true;
					const queue = this.queues.get(key);
					const index = queue ? queue.indexOf(waiter) : -1;
					if (queue && index >= 0) {
						queue.splice(index, 1);
						if (queue.length === 0) this.queues.delete(key);
					}
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					resolve(outcome);
				},
			};

			signal?.addEventListener("abort", onAbort, { once: true });
			const queue = this.queues.get(key);
			if (queue) queue.push(waiter);
			else this.queues.set(key, [waiter]);
		});
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

/** Rejects grouped agents in chains so the parent can inspect workspace changes between runs. */
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
