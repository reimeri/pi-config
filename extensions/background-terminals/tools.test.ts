import { expect, test } from "vitest";
import "./test-runtime.ts";
import type {
	BackgroundJobSnapshot,
	BackgroundLogRead,
	BackgroundTerminalConfig,
	ReadinessProgress,
	StartBackgroundJobOptions,
} from "./types.ts";

const { registerBackgroundTerminalTools } = await import("./tools.ts");

const config: BackgroundTerminalConfig = {
	maxLogBytes: 1024 * 1024,
	maxLogLines: 10_000,
	maxActiveJobs: 4,
	maxRetainedJobs: 20,
	defaultReadinessTimeoutMs: 10_000,
	killGraceMs: 100,
};

function job(readinessStatus: BackgroundJobSnapshot["readiness"]["status"]): BackgroundJobSnapshot {
	return {
		id: "bg-1",
		command: "example-server",
		cwd: process.cwd(),
		pid: 123,
		status: "running",
		startedAt: Date.now() - 1_000,
		readiness: {
			status: readinessStatus,
			pattern: "KNOWN_MARKER",
			type: "substring",
			timeoutMs: 10_000,
		},
		logStartCursor: 0,
		logEndCursor: 14,
		droppedLogBytes: 0,
	};
}

function logs(snapshot: BackgroundJobSnapshot): BackgroundLogRead {
	return {
		job: snapshot,
		text: "different output",
		startCursor: 0,
		nextCursor: 14,
		droppedBefore: false,
		truncatedToTail: false,
	};
}

function captureStartTool(manager: object): any {
	let startTool: any;
	const pi = {
		registerTool(tool: any) {
			if (tool.name === "background_start") startTool = tool;
		},
	} as any;
	registerBackgroundTerminalTools(pi, manager as never, config);
	return startTool;
}

test("tool schema rejects waits above 60 seconds and warns against invented markers", () => {
	const tool = captureStartTool({});
	const timeoutSchema = tool.parameters.properties.ready_timeout_seconds;

	expect(timeoutSchema.minimum).toBe(0.1);
	expect(timeoutSchema.maximum).toBe(60);
	expect(tool.parameters.properties.ready_pattern.description).toContain("Do not invent");
	expect(tool.promptGuidelines.join("\n")).toContain("never invent");
});

test("streams recent output and returns an explicit timeout diagnostic", async () => {
	const waitingJob = job("waiting");
	const timedOutJob = job("timed_out");
	const updates: string[] = [];
	const manager = {
		async start(options: StartBackgroundJobOptions) {
			const progress: ReadinessProgress = {
				job: waitingJob,
				logs: logs(waitingJob),
				elapsedMs: 1_000,
				foregroundWaitMs: 10_000,
			};
			options.onReadinessProgress?.(progress);
			return { job: timedOutJob, logs: logs(timedOutJob) };
		},
	};
	const tool = captureStartTool(manager);
	const ctx = {
		cwd: process.cwd(),
		sessionManager: {
			getSessionId: () => "session-test",
			getSessionFile: () => undefined,
		},
		model: undefined,
		thinkingLevel: undefined,
	};

	const result = await tool.execute(
		"call-1",
		{ command: "example-server", ready_pattern: "KNOWN_MARKER" },
		undefined,
		(update: any) => updates.push(update.content[0].text),
		ctx,
	);
	const text = result.content[0].text as string;

	expect(updates.some((update) => update.includes("Waiting for readiness pattern"))).toBe(true);
	expect(updates.some((update) => update.includes("different output"))).toBe(true);
	expect(text).toContain('Readiness pattern "KNOWN_MARKER" was not observed within 10.0s');
	expect(text).toContain("Inspect background_logs or test the service directly");
	expect(text).toContain("readiness=timed_out");
});
