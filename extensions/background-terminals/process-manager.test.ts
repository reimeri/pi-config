import { expect, test } from "bun:test";
import "./test-runtime.ts";
import type { BackgroundTerminalConfig, ReadinessStatus } from "./types.ts";

const { BackgroundProcessManager } = await import("./process-manager.ts");
type Manager = InstanceType<typeof BackgroundProcessManager>;

const config: BackgroundTerminalConfig = {
	maxLogBytes: 1024 * 1024,
	maxLogLines: 10_000,
	maxActiveJobs: 4,
	maxRetainedJobs: 20,
	defaultReadinessTimeoutMs: 10_000,
	killGraceMs: 100,
};

function readiness(pattern: string, timeoutMs: number) {
	return { pattern, type: "substring" as const, timeoutMs };
}

async function waitForReadiness(
	manager: Manager,
	id: string,
	status: ReadinessStatus,
	timeoutMs = 1_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (manager.get(id)?.readiness.status === status) return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${id} readiness=${status}`);
}

test("returns ready when a known marker appears during the foreground wait", async () => {
	const manager = new BackgroundProcessManager(config, 250);
	try {
		const result = await manager.start({
			command: "printf 'booting\\n'; sleep 0.03; printf 'KNOWN_READY\\n'; sleep 30",
			cwd: process.cwd(),
			readiness: readiness("KNOWN_READY", 1_000),
		});

		expect(result.job.readiness.status).toBe("ready");
		expect(result.logs.text).toContain("KNOWN_READY");
	} finally {
		await manager.shutdown();
	}
});

test("returns waiting after the foreground limit and keeps monitoring asynchronously", async () => {
	const manager = new BackgroundProcessManager(config, 50);
	const progress: string[] = [];
	try {
		const startedAt = Date.now();
		const result = await manager.start({
			command: "printf 'booting asynchronously\\n'; sleep 0.15; printf 'LATE_READY\\n'; sleep 30",
			cwd: process.cwd(),
			readiness: readiness("LATE_READY", 1_000),
			onReadinessProgress: (update) => progress.push(update.logs.text),
		});

		expect(Date.now() - startedAt).toBeLessThan(500);
		expect(result.job.readiness.status).toBe("waiting");
		expect(progress.some((text) => text.includes("booting asynchronously"))).toBe(true);

		await waitForReadiness(manager, result.job.id, "ready");
		expect(manager.get(result.job.id)?.readiness.matchedAt).toBeNumber();
	} finally {
		await manager.shutdown();
	}
});

test("marks asynchronous monitoring timed out without stopping the job", async () => {
	const manager = new BackgroundProcessManager(config, 40);
	try {
		const result = await manager.start({
			command: "printf 'different output\\n'; sleep 30",
			cwd: process.cwd(),
			readiness: readiness("NEVER_PRINTED", 150),
		});

		expect(result.job.readiness.status).toBe("waiting");
		await waitForReadiness(manager, result.job.id, "timed_out");
		expect(manager.get(result.job.id)?.status).toBe("running");
		expect(manager.canKill(result.job.id)).toBe(true);
	} finally {
		await manager.shutdown();
	}
});

test("rejects readiness waits outside 0.1 to 60 seconds before spawning", async () => {
	const manager = new BackgroundProcessManager(config, 50);
	try {
		for (const timeoutMs of [0, Number.NaN, 60_001]) {
			await expect(
				manager.start({
					command: "sleep 30",
					cwd: process.cwd(),
					readiness: readiness("READY", timeoutMs),
				}),
			).rejects.toThrow("Readiness timeout must be between 0.1 and 60 seconds");
		}
		expect(manager.list()).toHaveLength(0);
	} finally {
		await manager.shutdown();
	}
});

test("caps the foreground wait at 10 seconds for non-test callers", () => {
	expect(() => new BackgroundProcessManager(config, Number.NaN)).toThrow("positive finite duration");
	const manager = new BackgroundProcessManager(config, 60_000) as unknown as {
		foregroundReadinessWaitMs: number;
	};
	expect(manager.foregroundReadinessWaitMs).toBe(10_000);
});

test("aborting before spawn creates no job", async () => {
	const manager = new BackgroundProcessManager(config, 100);
	const controller = new AbortController();
	controller.abort();
	try {
		await expect(
			manager.start({
				command: "sleep 30",
				cwd: process.cwd(),
				readiness: readiness("READY", 1_000),
				signal: controller.signal,
			}),
		).rejects.toThrow("aborted before spawning");
		expect(manager.list()).toHaveLength(0);
	} finally {
		await manager.shutdown();
	}
});

test("aborting during the foreground wait terminates the new job", async () => {
	const manager = new BackgroundProcessManager(config, 250);
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 30);
	try {
		await expect(
			manager.start({
				command: "printf 'starting\\n'; sleep 30",
				cwd: process.cwd(),
				readiness: readiness("READY", 1_000),
				signal: controller.signal,
			}),
		).rejects.toThrow("was terminated");
		const [snapshot] = manager.list();
		expect(snapshot?.status).toBe("killed");
		expect(snapshot?.readiness.status).toBe("aborted");
	} finally {
		await manager.shutdown();
	}
});

test("aborting after the foreground return does not terminate asynchronous monitoring", async () => {
	const manager = new BackgroundProcessManager(config, 40);
	const controller = new AbortController();
	try {
		const result = await manager.start({
			command: "printf 'still starting\\n'; sleep 30",
			cwd: process.cwd(),
			readiness: readiness("READY", 150),
			signal: controller.signal,
		});
		expect(result.job.readiness.status).toBe("waiting");

		controller.abort();
		await Bun.sleep(20);
		expect(manager.get(result.job.id)?.status).toBe("running");
		await waitForReadiness(manager, result.job.id, "timed_out");
	} finally {
		await manager.shutdown();
	}
});

test("process exit settles asynchronous readiness without a later timeout overwrite", async () => {
	const manager = new BackgroundProcessManager(config, 30);
	try {
		const result = await manager.start({
			command: "printf 'not ready\\n'; sleep 0.08; exit 0",
			cwd: process.cwd(),
			readiness: readiness("READY", 300),
		});
		expect(result.job.readiness.status).toBe("waiting");
		await waitForReadiness(manager, result.job.id, "exited");
		await Bun.sleep(300);
		expect(manager.get(result.job.id)?.readiness.status).toBe("exited");
	} finally {
		await manager.shutdown();
	}
});
