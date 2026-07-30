import { afterEach, describe, expect, test, vi } from "vitest";
import { shouldFinishOnChildError, terminateWithEscalation } from "./process-control.ts";

function fakeProcess(options: { killThrows?: boolean } = {}) {
	const signals: string[] = [];
	const process = {
		exitCode: null as number | null,
		signalCode: null as NodeJS.Signals | null,
		kill: (signal?: string | number) => {
			signals.push(String(signal));
			if (options.killThrows) throw new Error("EPERM");
			return true;
		},
	};
	return { process, signals };
}

afterEach(() => vi.useRealTimers());

describe("shouldFinishOnChildError", () => {
	test("finishes only when spawning never succeeded", () => {
		expect(shouldFinishOnChildError(false)).toBe(true);
		expect(shouldFinishOnChildError(true)).toBe(false);
	});
});

describe("terminateWithEscalation", () => {
	test("sends SIGKILL when a process ignores SIGTERM", () => {
		vi.useFakeTimers();
		const state = fakeProcess();

		terminateWithEscalation(state.process, { graceMs: 1000 });
		expect(state.signals).toEqual(["SIGTERM"]);
		vi.advanceTimersByTime(1000);

		expect(state.signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	test("does not escalate after the child exits", () => {
		vi.useFakeTimers();
		const state = fakeProcess();

		terminateWithEscalation(state.process, { graceMs: 1000 });
		state.process.exitCode = 0;
		vi.advanceTimersByTime(1000);

		expect(state.signals).toEqual(["SIGTERM"]);
	});

	test("allows close handling to cancel escalation", () => {
		vi.useFakeTimers();
		const state = fakeProcess();
		const onUnterminated = vi.fn();

		const cancel = terminateWithEscalation(state.process, { graceMs: 1000, onUnterminated });
		cancel();
		vi.advanceTimersByTime(10_000);

		expect(state.signals).toEqual(["SIGTERM"]);
		expect(onUnterminated).not.toHaveBeenCalled();
	});

	test("reports a child that outlives SIGKILL so the caller stops waiting", () => {
		vi.useFakeTimers();
		const state = fakeProcess();
		const onUnterminated = vi.fn();

		terminateWithEscalation(state.process, { graceMs: 1000, onUnterminated });
		vi.advanceTimersByTime(1000);
		expect(onUnterminated).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1000);
		expect(onUnterminated).toHaveBeenCalledOnce();
	});

	test("stays quiet when SIGKILL lands", () => {
		vi.useFakeTimers();
		const state = fakeProcess();
		const onUnterminated = vi.fn();

		terminateWithEscalation(state.process, { graceMs: 1000, onUnterminated });
		vi.advanceTimersByTime(1000);
		state.process.signalCode = "SIGKILL";
		vi.advanceTimersByTime(1000);

		expect(onUnterminated).not.toHaveBeenCalled();
	});

	test("survives undeliverable signals and still reports the survivor", () => {
		vi.useFakeTimers();
		const state = fakeProcess({ killThrows: true });
		const onUnterminated = vi.fn();

		expect(() => terminateWithEscalation(state.process, { graceMs: 1000, onUnterminated })).not.toThrow();
		vi.advanceTimersByTime(2000);

		expect(state.signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(onUnterminated).toHaveBeenCalledOnce();
	});
});
