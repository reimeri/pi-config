import type { ChildProcess } from "node:child_process";

export type KillableChildProcess = Pick<ChildProcess, "exitCode" | "signalCode" | "kill">;

/** Grace period between termination steps, and between the last one and giving up. */
export const CHILD_TERMINATION_GRACE_MS = 5000;

/** Only a pre-spawn error proves there is no child process left to wait for. */
export function shouldFinishOnChildError(spawned: boolean): boolean {
	return !spawned;
}

export interface TerminationOptions {
	graceMs?: number;
	/** Called when the child outlived SIGKILL, so no "close" event is coming. */
	onUnterminated?: () => void;
}

// killed means signal delivery succeeded; exitCode/signalCode prove termination.
function hasExited(process: KillableChildProcess): boolean {
	return process.exitCode !== null || process.signalCode !== null;
}

function trySignal(process: KillableChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
	try {
		process.kill(signal);
	} catch {
		// Swallow undeliverable signals so escalation reports the failure.
	}
}

/** Escalates SIGTERM to SIGKILL and reports children that still do not exit. */
export function terminateWithEscalation(
	process: KillableChildProcess,
	{ graceMs = CHILD_TERMINATION_GRACE_MS, onUnterminated }: TerminationOptions = {},
): () => void {
	const timers: ReturnType<typeof setTimeout>[] = [];
	const schedule = (delayMs: number, action: () => void): void => {
		const timer = setTimeout(action, delayMs);
		timer.unref?.();
		timers.push(timer);
	};

	trySignal(process, "SIGTERM");
	schedule(graceMs, () => {
		if (!hasExited(process)) trySignal(process, "SIGKILL");
	});
	schedule(graceMs * 2, () => {
		if (!hasExited(process)) onUnterminated?.();
	});

	return () => {
		for (const timer of timers) clearTimeout(timer);
	};
}
