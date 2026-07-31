import type { AgentConfig } from "./agents.ts";

/**
 * How long a run waits for a key that is already held before giving up.
 *
 * The bound exists for the child that never exits: it keeps its key for the rest of the conversation,
 * and an unbounded wait would hang the tool call with it. It is generous because the normal holder is
 * an editing worker, which takes minutes, and because timing out wastes the whole wait — the caller
 * has to start over. Aborting cancels a wait immediately, so the user is never held to this number.
 */
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

/**
 * Mutual exclusion over named keys, with a queue.
 *
 * The gate used to refuse a busy key outright, which reads as a reasonable API and behaves badly in
 * this setting: the caller is a model, it has no way to sleep, and the only thing it can do with the
 * refusal is spend a turn and try again blind. Two workers launched in one turn made the second one
 * fail rather than follow the first. Queuing turns that into what the parent wanted in the first
 * place — the second run starts when the first is done — and the timeout keeps the pathological case
 * (a held key nobody will ever release) from hanging the call forever.
 *
 * Handoff is FIFO and immediate: a release passes the key straight to the longest-waiting caller
 * inside the same tick, so no later arrival can take it first and no window exists in which the key
 * looks free while someone is queued for it.
 */
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
		// The queue check is what makes the handoff fair. It cannot currently be reached — release
		// hands off synchronously — but without it a future asynchronous release would silently let
		// arrivals barge ahead of callers that have been waiting for minutes.
		if (!this.activeKeys.has(key) && this.waiting(key) === 0) return { ok: true, release: this.hold(key) };

		const timeoutMs = options.timeoutMs ?? 0;
		if (timeoutMs <= 0) return { ok: false, reason: "busy" };
		return this.wait(key, timeoutMs, options.signal);
	}

	/**
	 * Give up on a key whose holder is still using whatever it protects.
	 *
	 * Releasing would be wrong and waiting would be futile, so the key stays held and everyone queued
	 * for it is told now rather than at the end of a timeout they cannot benefit from.
	 */
	abandon(key: string | undefined): void {
		if (!key) return;
		this.abandonedKeys.add(key);
		this.activeKeys.add(key);
		this.dropWaiters(key);
	}

	/**
	 * Fail everyone queued for a key without marking the key itself unusable.
	 *
	 * For the holder that must release but must not be inherited from: its child outlived the run and
	 * may still be doing whatever the key protects, so handing the key straight to the caller queued
	 * behind it would start exactly the overlap the key exists to prevent. A later run the parent
	 * chooses to launch, having read why this one gave up, can still take the key.
	 */
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
					// A no-op when the handoff already took this waiter off the queue.
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
