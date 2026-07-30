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

// ChildProcess.killed only means kill() successfully sent a signal. It does not
// mean the process exited, so use the exit/signal status instead.
function hasExited(process: KillableChildProcess): boolean {
	return process.exitCode !== null || process.signalCode !== null;
}

function trySignal(process: KillableChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
	try {
		process.kill(signal);
	} catch {
		// A signal that cannot be delivered must not escape into the abort listener
		// that asked for termination. The escalation below reports it instead.
	}
}

/**
 * Send SIGTERM now and SIGKILL after the grace period if the child is still
 * alive. If it also survives SIGKILL, signals are not reaching it (EPERM after
 * a credential change, an uninterruptible state), so it will never emit "close"
 * and `onUnterminated` tells the caller to stop waiting for one.
 */
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
