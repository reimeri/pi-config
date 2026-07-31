import { describe, expect, test } from "vitest";
import type { AgentConfig } from "./agents.ts";
import {
	AgentConcurrencyGate,
	findChainConcurrencyConflicts,
	findParallelConcurrencyConflict,
} from "./concurrency.ts";

function agent(name: string, concurrencyGroup?: string): AgentConfig {
	return {
		name,
		description: name,
		concurrencyGroup,
		captureDiff: Boolean(concurrencyGroup),
		systemPrompt: "",
		source: "extension",
		filePath: `/agents/${name}.md`,
	};
}

const GROUP = "workspace-writer";

/** Held so the test controls exactly when the key comes free. */
async function hold(gate: AgentConcurrencyGate, key = GROUP): Promise<() => void> {
	const outcome = await gate.acquire(key);
	if (!outcome.ok) throw new Error(`expected to acquire "${key}", got ${outcome.reason}`);
	return outcome.release;
}

describe("AgentConcurrencyGate", () => {
	test("refuses a held key outright when no wait was asked for", async () => {
		const gate = new AgentConcurrencyGate();
		const release = await hold(gate);
		expect(gate.isActive(GROUP)).toBe(true);

		expect(await gate.acquire(GROUP)).toEqual({ ok: false, reason: "busy" });

		release();
		release();
		expect(gate.isActive(GROUP)).toBe(false);
		expect((await gate.acquire(GROUP)).ok).toBe(true);
	});

	test("does not constrain agents without a concurrency group", async () => {
		const gate = new AgentConcurrencyGate();
		expect((await gate.acquire(undefined)).ok).toBe(true);
		expect((await gate.acquire(undefined)).ok).toBe(true);
	});

	test("hands the key to a waiter when the holder releases", async () => {
		// The point of the whole change: a second worker launched while the first is running follows
		// it instead of failing and making the model spend a turn discovering that.
		const gate = new AgentConcurrencyGate();
		const release = await hold(gate);

		const queued = gate.acquire(GROUP, { timeoutMs: 5_000 });
		await Promise.resolve();
		expect(gate.waiting(GROUP)).toBe(1);

		release();
		const outcome = await queued;
		expect(outcome.ok).toBe(true);
		// Handed over rather than freed: the key is still held, now by the waiter.
		expect(gate.isActive(GROUP)).toBe(true);
		expect(gate.waiting(GROUP)).toBe(0);
	});

	test("serves waiters in the order they arrived", async () => {
		const gate = new AgentConcurrencyGate();
		let release = await hold(gate);
		const served: number[] = [];

		const queued = [1, 2, 3].map(async (n) => {
			const outcome = await gate.acquire(GROUP, { timeoutMs: 5_000 });
			if (!outcome.ok) throw new Error(`waiter ${n}: ${outcome.reason}`);
			served.push(n);
			return outcome.release;
		});
		await Promise.resolve();
		expect(gate.waiting(GROUP)).toBe(3);

		for (const pending of queued) {
			release();
			release = await pending;
		}
		release();

		expect(served).toEqual([1, 2, 3]);
	});

	test("a late arrival cannot take a key someone is already queued for", async () => {
		const gate = new AgentConcurrencyGate();
		const release = await hold(gate);
		const queued = gate.acquire(GROUP, { timeoutMs: 5_000 });
		await Promise.resolve();

		release();
		// The handoff is synchronous with the release, so by the time anyone else can ask, the key is
		// held again. Barging would mean a waiter sitting through another full run.
		expect(await gate.acquire(GROUP)).toEqual({ ok: false, reason: "busy" });
		expect((await queued).ok).toBe(true);
	});

	test("gives up on a key nobody releases, without wedging the queue", async () => {
		const gate = new AgentConcurrencyGate();
		const release = await hold(gate);

		expect(await gate.acquire(GROUP, { timeoutMs: 20 })).toEqual({ ok: false, reason: "busy" });
		expect(gate.waiting(GROUP)).toBe(0);

		// The key that timed out must not be handed to the caller that already walked away.
		release();
		expect(gate.isActive(GROUP)).toBe(false);
	});

	test("stops waiting as soon as the run is aborted", async () => {
		// Otherwise pressing escape on a queued worker does nothing until the timeout expires.
		const gate = new AgentConcurrencyGate();
		await hold(gate);
		const controller = new AbortController();

		const queued = gate.acquire(GROUP, { timeoutMs: 60_000, signal: controller.signal });
		await Promise.resolve();
		controller.abort();

		expect(await queued).toEqual({ ok: false, reason: "aborted" });
		expect(gate.waiting(GROUP)).toBe(0);
	});

	test("refuses immediately when the signal is already aborted", async () => {
		const gate = new AgentConcurrencyGate();
		expect(await gate.acquire(GROUP, { signal: AbortSignal.abort() })).toEqual({ ok: false, reason: "aborted" });
		expect(gate.isActive(GROUP)).toBe(false);
	});

	test("abandoning a key fails its waiters now rather than at the end of the timeout", async () => {
		// A child that outlived its run keeps its session file open for the rest of the conversation.
		// Waiting for it is not slow, it is futile, and the parent needs to hear that while it can
		// still choose another key.
		const gate = new AgentConcurrencyGate();
		await hold(gate, "session-1");
		const queued = gate.acquire("session-1", { timeoutMs: 60_000 });
		await Promise.resolve();

		gate.abandon("session-1");

		expect(await queued).toEqual({ ok: false, reason: "abandoned" });
		expect(await gate.acquire("session-1", { timeoutMs: 60_000 })).toEqual({ ok: false, reason: "abandoned" });
	});

	test("dropping waiters releases the key without handing it to the queue", async () => {
		// The holder whose child outlived the run: it has to give the group back, but the queue must
		// not inherit it, or a second worker starts editing beside a child that is still alive.
		const gate = new AgentConcurrencyGate();
		const release = await hold(gate);
		const queued = gate.acquire(GROUP, { timeoutMs: 60_000 });
		await Promise.resolve();

		gate.dropWaiters(GROUP);
		release();

		expect(await queued).toEqual({ ok: false, reason: "abandoned" });
		// Unlike `abandon`, this leaves the key usable by a run the parent decides to launch later.
		expect(gate.isActive(GROUP)).toBe(false);
		expect((await gate.acquire(GROUP)).ok).toBe(true);
	});

	test("keeps keys independent", async () => {
		const gate = new AgentConcurrencyGate();
		await hold(gate, "session-1");
		expect((await gate.acquire("session-2", { timeoutMs: 20 })).ok).toBe(true);
	});
});

describe("findParallelConcurrencyConflict", () => {
	const agents = [agent("worker", "workspace-writer"), agent("scout"), agent("reviewer")];

	test("rejects two editing workers", () => {
		expect(findParallelConcurrencyConflict(agents, ["worker", "worker"])).toBe("workspace-writer");
	});

	test("allows one worker alongside read-only agents", () => {
		expect(findParallelConcurrencyConflict(agents, ["worker", "scout", "reviewer"])).toBeUndefined();
	});

	test("allows parallel read-only agents", () => {
		expect(findParallelConcurrencyConflict(agents, ["scout", "reviewer"])).toBeUndefined();
	});
});

describe("findChainConcurrencyConflicts", () => {
	const agents = [agent("worker", "workspace-writer"), agent("scout"), agent("reviewer")];

	test("rejects a lone editing step, which would skip the parent's checkpoint", () => {
		expect(findChainConcurrencyConflicts(agents, ["worker"])).toEqual([
			{ agent: "worker", group: "workspace-writer" },
		]);
	});

	test("rejects an editing step chained behind read-only work", () => {
		expect(findChainConcurrencyConflicts(agents, ["scout", "worker"])).toEqual([
			{ agent: "worker", group: "workspace-writer" },
		]);
	});

	test("reports each conflicting agent once", () => {
		expect(findChainConcurrencyConflicts(agents, ["worker", "worker", "scout"])).toEqual([
			{ agent: "worker", group: "workspace-writer" },
		]);
	});

	test("allows chains of ungrouped agents", () => {
		expect(findChainConcurrencyConflicts(agents, ["scout", "reviewer"])).toEqual([]);
	});

	test("ignores unknown agent names, which the run itself reports", () => {
		expect(findChainConcurrencyConflicts(agents, ["nope"])).toEqual([]);
	});
});
