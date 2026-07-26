export type BackgroundStream = "stdout" | "stderr";

export type BackgroundJobStatus =
	| "starting"
	| "running"
	| "stopping"
	| "exited"
	| "killed"
	| "failed";

export type ReadinessStatus =
	| "not_requested"
	| "waiting"
	| "ready"
	| "timed_out"
	| "exited"
	| "aborted"
	/** Pattern matching was abandoned for exceeding its time budget; the job keeps running. */
	| "budget_exceeded";

export type ReadinessPatternType = "substring" | "regex";

export interface ReadinessRequest {
	pattern: string;
	type: ReadinessPatternType;
	timeoutMs: number;
}

export interface ReadinessResult {
	status: ReadinessStatus;
	pattern?: string;
	type?: ReadinessPatternType;
	timeoutMs?: number;
	matchedAt?: number;
}

export interface BackgroundTerminalConfig {
	maxLogBytes: number;
	maxLogLines: number;
	maxActiveJobs: number;
	maxRetainedJobs: number;
	defaultReadinessTimeoutMs: number;
	killGraceMs: number;
}

export interface BackgroundJobSnapshot {
	id: string;
	name?: string;
	command: string;
	cwd: string;
	pid?: number;
	status: BackgroundJobStatus;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	exitSignal?: NodeJS.Signals | null;
	readiness: ReadinessResult;
	logStartCursor: number;
	logEndCursor: number;
	droppedLogBytes: number;
}

export interface BackgroundLogRead {
	job: BackgroundJobSnapshot;
	text: string;
	startCursor: number;
	nextCursor: number;
	droppedBefore: boolean;
	truncatedToTail: boolean;
}

export interface ReadinessProgress {
	job: BackgroundJobSnapshot;
	logs: BackgroundLogRead;
	elapsedMs: number;
	foregroundWaitMs: number;
}

export interface StartBackgroundJobOptions {
	command: string;
	name?: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	readiness?: ReadinessRequest;
	signal?: AbortSignal;
	onReadinessProgress?: (progress: ReadinessProgress) => void;
}

export interface StartBackgroundJobResult {
	job: BackgroundJobSnapshot;
	logs: BackgroundLogRead;
}

export interface ReadBackgroundLogsOptions {
	cursor?: number;
	tailLines?: number;
	maxBytes?: number;
}
