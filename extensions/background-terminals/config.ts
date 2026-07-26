import type { BackgroundTerminalConfig } from "./types.ts";

const DEFAULT_MAX_LOG_BYTES = 1024 * 1024;
const DEFAULT_MAX_LOG_LINES = 10_000;
const DEFAULT_MAX_ACTIVE_JOBS = 16;
const DEFAULT_MAX_RETAINED_JOBS = 100;
export const READINESS_MIN_TIMEOUT_MS = 100;
export const READINESS_FOREGROUND_WAIT_MS = 10_000;
export const READINESS_MAX_TIMEOUT_MS = 60_000;
const DEFAULT_READINESS_TIMEOUT_MS = READINESS_FOREGROUND_WAIT_MS;
const DEFAULT_KILL_GRACE_MS = 2_000;

function positiveIntegerFromEnv(
	name: string,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) return fallback;
	return value;
}

export function loadBackgroundTerminalConfig(): BackgroundTerminalConfig {
	return {
		maxLogBytes: positiveIntegerFromEnv(
			"PI_BACKGROUND_TERMINAL_MAX_BYTES",
			DEFAULT_MAX_LOG_BYTES,
			1024,
			100 * 1024 * 1024,
		),
		maxLogLines: positiveIntegerFromEnv(
			"PI_BACKGROUND_TERMINAL_MAX_LINES",
			DEFAULT_MAX_LOG_LINES,
			10,
			1_000_000,
		),
		maxActiveJobs: positiveIntegerFromEnv(
			"PI_BACKGROUND_TERMINAL_MAX_ACTIVE_JOBS",
			DEFAULT_MAX_ACTIVE_JOBS,
			1,
			256,
		),
		maxRetainedJobs: positiveIntegerFromEnv(
			"PI_BACKGROUND_TERMINAL_MAX_RETAINED_JOBS",
			DEFAULT_MAX_RETAINED_JOBS,
			1,
			10_000,
		),
		defaultReadinessTimeoutMs: positiveIntegerFromEnv(
			"PI_BACKGROUND_TERMINAL_READY_TIMEOUT_MS",
			DEFAULT_READINESS_TIMEOUT_MS,
			READINESS_MIN_TIMEOUT_MS,
			READINESS_MAX_TIMEOUT_MS,
		),
		killGraceMs: positiveIntegerFromEnv(
			"PI_BACKGROUND_TERMINAL_KILL_GRACE_MS",
			DEFAULT_KILL_GRACE_MS,
			0,
			60_000,
		),
	};
}
