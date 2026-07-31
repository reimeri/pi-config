import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import {
	READINESS_FOREGROUND_WAIT_MS,
	READINESS_MAX_TIMEOUT_MS,
	READINESS_MIN_TIMEOUT_MS,
} from "./config.ts";
import { BoundedLogBuffer } from "./log-buffer.ts";
import {
	compileReadinessMatcher,
	scanReadinessWindows,
	type ReadinessMatcher,
} from "./readiness.ts";
import type {
	BackgroundJobSnapshot,
	BackgroundLogRead,
	BackgroundTerminalConfig,
	ReadBackgroundLogsOptions,
	ReadinessRequest,
	ReadinessResult,
	StartBackgroundJobOptions,
	StartBackgroundJobResult,
} from "./types.ts";

interface ManagedJob {
	snapshot: BackgroundJobSnapshot;
	child: ChildProcess;
	buffer: BoundedLogBuffer;
	stdoutDecoder: StringDecoder;
	stderrDecoder: StringDecoder;
	outputListeners: Set<(text: string) => void>;
	readinessMatcher?: ReadinessMatcher;
	readinessWindow: string;
	readinessMatchedAt?: number;
	readinessPromise?: Promise<ReadinessResult["status"]>;
	settleReadiness?: (status: ReadinessResult["status"]) => void;
	closePromise: Promise<void>;
	resolveClose: () => void;
	closed: boolean;
	groupKnownGone: boolean;
	groupMonitor?: NodeJS.Timeout;
	terminationRequested: boolean;
}

function cloneSnapshot(snapshot: BackgroundJobSnapshot): BackgroundJobSnapshot {
	return { ...snapshot, readiness: { ...snapshot.readiness } };
}

function isFinalStatus(status: BackgroundJobSnapshot["status"]): boolean {
	return status === "exited" || status === "killed" || status === "failed";
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class BackgroundProcessManager {
	private readonly config: BackgroundTerminalConfig;
	private readonly foregroundReadinessWaitMs: number;
	private readonly jobs = new Map<string, ManagedJob>();
	private nextId = 1;
	private shutdownPromise?: Promise<void>;

	constructor(config: BackgroundTerminalConfig, foregroundReadinessWaitMs = READINESS_FOREGROUND_WAIT_MS) {
		if (!Number.isFinite(foregroundReadinessWaitMs) || foregroundReadinessWaitMs <= 0) {
			throw new Error("Foreground readiness wait must be a positive finite duration");
		}
		this.config = config;
		this.foregroundReadinessWaitMs = Math.min(foregroundReadinessWaitMs, READINESS_FOREGROUND_WAIT_MS);
	}

	list(status?: BackgroundJobSnapshot["status"]): BackgroundJobSnapshot[] {
		return [...this.jobs.values()]
			.map((job) => this.snapshot(job))
			.filter((job) => status === undefined || job.status === status)
			.sort((left, right) => left.startedAt - right.startedAt);
	}

	get(id: string): BackgroundJobSnapshot | undefined {
		const job = this.jobs.get(id);
		return job ? this.snapshot(job) : undefined;
	}

	canKill(id: string): boolean {
		const job = this.jobs.get(id);
		return job !== undefined && (!isFinalStatus(job.snapshot.status) || this.processGroupExists(job));
	}

	get runningCount(): number {
		return [...this.jobs.values()].filter(
			(job) => !isFinalStatus(job.snapshot.status) || this.processGroupExists(job),
		).length;
	}

	async start(options: StartBackgroundJobOptions): Promise<StartBackgroundJobResult> {
		if (this.shutdownPromise) throw new Error("Background terminal manager is shutting down");
		if (process.platform === "win32") throw new Error("Background terminals currently support Linux and macOS only");
		if (options.signal?.aborted) throw new Error("Background start aborted before spawning");
		if (
			options.readiness
			&& (
				!Number.isFinite(options.readiness.timeoutMs)
				|| options.readiness.timeoutMs < READINESS_MIN_TIMEOUT_MS
				|| options.readiness.timeoutMs > READINESS_MAX_TIMEOUT_MS
			)
		) {
			throw new Error(
				`Readiness timeout must be between ${READINESS_MIN_TIMEOUT_MS / 1000} and ${READINESS_MAX_TIMEOUT_MS / 1000} seconds`,
			);
		}
		const readinessMatcher = options.readiness
			? compileReadinessMatcher(options.readiness)
			: undefined;
		await access(options.cwd);
		if (this.shutdownPromise) throw new Error("Background terminal manager is shutting down");
		this.pruneCompletedJobs(this.config.maxRetainedJobs - 1);
		if (this.runningCount >= this.config.maxActiveJobs) {
			throw new Error(`Background terminal active-job limit reached (${this.config.maxActiveJobs})`);
		}
		if (this.jobs.size >= this.config.maxRetainedJobs) {
			throw new Error(`Background terminal retained-job limit reached (${this.config.maxRetainedJobs})`);
		}

		const shell = getShellConfig();
		const commandFromStdin = shell.commandTransport === "stdin";
		const child = spawn(shell.shell, commandFromStdin ? shell.args : [...shell.args, options.command], {
			cwd: options.cwd,
			detached: true,
			env: options.env ?? process.env,
			stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		if (commandFromStdin) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(options.command);
		}

		const id = `bg-${this.nextId++}`;
		let resolveClose = () => {};
		const closePromise = new Promise<void>((resolve) => {
			resolveClose = resolve;
		});
		const readiness: ReadinessResult = options.readiness
			? {
					status: "waiting",
					pattern: options.readiness.pattern,
					type: options.readiness.type,
					timeoutMs: options.readiness.timeoutMs,
				}
			: { status: "not_requested" };
		const job: ManagedJob = {
			snapshot: {
				id,
				name: options.name,
				command: options.command,
				cwd: options.cwd,
				pid: child.pid,
				status: "starting",
				startedAt: Date.now(),
				readiness,
				logStartCursor: 0,
				logEndCursor: 0,
				droppedLogBytes: 0,
			},
			child,
			buffer: new BoundedLogBuffer(this.config.maxLogBytes, this.config.maxLogLines),
			stdoutDecoder: new StringDecoder("utf8"),
			stderrDecoder: new StringDecoder("utf8"),
			outputListeners: new Set(),
			readinessMatcher,
			readinessWindow: "",
			closePromise,
			resolveClose,
			closed: false,
			groupKnownGone: false,
			terminationRequested: false,
		};
		this.jobs.set(id, job);
		this.attachProcessListeners(job);

		try {
			await this.waitForSpawn(job, options.signal);
		} catch (error) {
			if (options.signal?.aborted && !job.closed) await this.kill(id);
			throw new Error(`Could not start ${id}: ${error instanceof Error ? error.message : String(error)}`);
		}

		if (options.signal?.aborted) {
			await this.kill(id);
			throw new Error(`Background start aborted; ${id} was terminated`);
		}

		if (!job.closed) job.snapshot.status = "running";
		if (options.readiness) {
			this.startReadinessMonitor(job, options.readiness);
			const foregroundWaitMs = Math.min(options.readiness.timeoutMs, this.foregroundReadinessWaitMs);
			const readinessStatus = await this.waitForReadinessForeground(
				job,
				foregroundWaitMs,
				options.signal,
				options.onReadinessProgress,
			);
			if (readinessStatus === "aborted") {
				await this.kill(id);
				throw new Error(`Background start aborted; ${id} was terminated`);
			}
		}

		return {
			job: this.snapshot(job),
			logs: this.readLogs(id, {
				tailLines: Math.min(this.config.maxLogLines, 2000),
				maxBytes: Math.min(this.config.maxLogBytes, 50 * 1024),
			}),
		};
	}

	readLogs(id: string, options: ReadBackgroundLogsOptions = {}): BackgroundLogRead {
		const job = this.requireJob(id);
		const read = job.buffer.read(options.cursor, options.tailLines, options.maxBytes);
		return { job: this.snapshot(job), ...read };
	}

	async kill(id: string): Promise<BackgroundJobSnapshot> {
		const job = this.requireJob(id);
		const statusBeforeKill = job.snapshot.status;
		if (isFinalStatus(statusBeforeKill) && !this.processGroupExists(job)) {
			return this.snapshot(job);
		}
		job.snapshot.status = "stopping";
		job.terminationRequested = true;
		const termSentAt = Date.now();
		this.signalProcessGroup(job, "SIGTERM");
		await Promise.race([job.closePromise, delay(this.config.killGraceMs)]);

		if (this.processGroupExists(job)) {
			const remainingGrace = this.config.killGraceMs - (Date.now() - termSentAt);
			if (remainingGrace > 0) await delay(remainingGrace);
		}
		if (this.processGroupExists(job)) {
			this.signalProcessGroup(job, "SIGKILL");
			const deadline = Date.now() + Math.max(1000, this.config.killGraceMs);
			while (this.processGroupExists(job) && Date.now() < deadline) await delay(50);
		}
		if (this.processGroupExists(job)) {
			job.snapshot.status = "stopping";
			throw new Error(`Failed to terminate background process group ${id}`);
		}
		if (!job.closed) {
			job.child.stdout?.destroy();
			job.child.stderr?.destroy();
			this.finalizeJob(job, null, "SIGKILL");
		} else {
			// Preserve the leader's outcome when only lingering descendants were signalled.
			job.snapshot.status = isFinalStatus(statusBeforeKill) ? statusBeforeKill : "killed";
		}
		return this.snapshot(job);
	}

	clear(id: string): boolean {
		const job = this.requireJob(id);
		if (!isFinalStatus(job.snapshot.status) || this.processGroupExists(job)) {
			throw new Error(`Cannot clear active background job ${id}`);
		}
		this.stopGroupMonitor(job);
		return this.jobs.delete(id);
	}

	clearCompleted(): number {
		let cleared = 0;
		for (const [id, job] of this.jobs) {
			if (isFinalStatus(job.snapshot.status) && !this.processGroupExists(job)) {
				this.stopGroupMonitor(job);
				if (this.jobs.delete(id)) cleared++;
			}
		}
		return cleared;
	}

	async shutdown(): Promise<void> {
		if (!this.shutdownPromise) {
			this.shutdownPromise = Promise.all(
				[...this.jobs.values()]
					.filter((job) => !isFinalStatus(job.snapshot.status) || this.processGroupExists(job))
					.map((job) => this.kill(job.snapshot.id).catch(() => undefined)),
			).then(() => undefined);
		}
		await this.shutdownPromise;
	}

	private snapshot(job: ManagedJob): BackgroundJobSnapshot {
		job.snapshot.logStartCursor = job.buffer.startCursor;
		job.snapshot.logEndCursor = job.buffer.nextCursor;
		job.snapshot.droppedLogBytes = job.buffer.droppedBytes;
		return cloneSnapshot(job.snapshot);
	}

	private requireJob(id: string): ManagedJob {
		const job = this.jobs.get(id);
		if (!job) throw new Error(`Unknown background job: ${id}`);
		return job;
	}

	private attachProcessListeners(job: ManagedJob): void {
		const append = (stream: "stdout" | "stderr", text: string) => {
			const appended = job.buffer.append(stream, text);
			if (!appended) return;
			const matcher = job.readinessMatcher;
			if (
				job.snapshot.readiness.status === "waiting"
				&& matcher
				&& job.readinessMatchedAt === undefined
				&& !matcher.exhausted
			) {
				const candidate = job.readinessWindow + appended;
				if (scanReadinessWindows(matcher, candidate)) {
					job.readinessMatchedAt = Date.now();
				}
				// Retain boundary overlap so each chunk does not rescan prior output.
				job.readinessWindow = matcher.overlap > 0 ? candidate.slice(-matcher.overlap) : "";
			}
			for (const listener of [...job.outputListeners]) listener(appended);
		};
		job.child.stdout?.on("data", (chunk: Buffer) => append("stdout", job.stdoutDecoder.write(chunk)));
		job.child.stderr?.on("data", (chunk: Buffer) => append("stderr", job.stderrDecoder.write(chunk)));
		job.child.on("error", (error) => {
			append("stderr", `\n[background process error: ${error.message}]\n`);
			if (!job.closed) this.finalizeJob(job, null, null);
		});
		job.child.on("close", (code, signal) => {
			append("stdout", job.stdoutDecoder.end());
			append("stderr", job.stderrDecoder.end());
			this.finalizeJob(job, code, signal);
		});
	}

	private waitForSpawn(job: ManagedJob, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				job.child.removeListener("spawn", onSpawn);
				job.child.removeListener("error", onError);
				signal?.removeEventListener("abort", onAbort);
			};
			const onSpawn = () => {
				cleanup();
				resolve();
			};
			const onError = (error: Error) => {
				cleanup();
				reject(error);
			};
			const onAbort = () => {
				cleanup();
				reject(new Error("aborted"));
			};
			job.child.once("spawn", onSpawn);
			job.child.once("error", onError);
			if (signal) signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	private startReadinessMonitor(job: ManagedJob, request: ReadinessRequest): void {
		if (job.readinessPromise) return;
		job.readinessPromise = new Promise((resolve) => {
			let settled = false;
			const finish = (status: ReadinessResult["status"]) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				job.outputListeners.delete(checkOutput);
				job.settleReadiness = undefined;
				if (job.snapshot.readiness.status === "waiting") {
					job.snapshot.readiness.status = status;
					if (status === "ready") {
						job.snapshot.readiness.matchedAt = job.readinessMatchedAt ?? Date.now();
					}
				}
				resolve(status);
			};
			const checkOutput = () => {
				if (job.readinessMatchedAt !== undefined) finish("ready");
				else if (job.readinessMatcher?.exhausted) finish("budget_exceeded");
			};
			const timeout = setTimeout(() => finish("timed_out"), request.timeoutMs);
			timeout.unref();
			job.settleReadiness = finish;
			job.outputListeners.add(checkOutput);
			job.closePromise.then(() => finish("exited"));
			checkOutput();
		});
	}

	private waitForReadinessForeground(
		job: ManagedJob,
		foregroundWaitMs: number,
		signal?: AbortSignal,
		onProgress?: StartBackgroundJobOptions["onReadinessProgress"],
	): Promise<ReadinessResult["status"]> {
		const readinessPromise = job.readinessPromise;
		if (!readinessPromise) return Promise.resolve(job.snapshot.readiness.status);
		const startedAt = Date.now();
		return new Promise((resolve) => {
			let settled = false;
			let lastProgressAt = 0;
			let lastProgressCursor = -1;
			const emitProgress = (force = false) => {
				if (!onProgress || settled || job.snapshot.readiness.status !== "waiting") return;
				const now = Date.now();
				const cursor = job.buffer.nextCursor;
				if (!force && cursor === lastProgressCursor) return;
				if (!force && lastProgressCursor > 0 && now - lastProgressAt < 200) return;
				lastProgressAt = now;
				lastProgressCursor = cursor;
				try {
					onProgress({
						job: this.snapshot(job),
						logs: this.readLogs(job.snapshot.id, { tailLines: 8, maxBytes: 8 * 1024 }),
						elapsedMs: now - startedAt,
						foregroundWaitMs,
					});
				} catch {
					// A progress renderer must not affect process management.
				}
			};
			const progressOutput = () => emitProgress();
			const finish = (status: ReadinessResult["status"]) => {
				if (settled) return;
				settled = true;
				clearTimeout(softTimeout);
				clearInterval(progressInterval);
				job.outputListeners.delete(progressOutput);
				signal?.removeEventListener("abort", onAbort);
				resolve(status);
			};
			const onAbort = () => {
				job.settleReadiness?.("aborted");
				finish("aborted");
			};
			const softTimeout = setTimeout(() => finish(job.snapshot.readiness.status), foregroundWaitMs);
			const progressInterval = setInterval(() => emitProgress(true), 1000);
			softTimeout.unref();
			progressInterval.unref();
			job.outputListeners.add(progressOutput);
			if (signal) signal.addEventListener("abort", onAbort, { once: true });
			readinessPromise.then(finish);
			emitProgress(true);
		});
	}

	private pruneCompletedJobs(targetCount = this.config.maxRetainedJobs): void {
		if (this.jobs.size <= targetCount) return;
		for (const [id, job] of this.jobs) {
			if (this.jobs.size <= targetCount) break;
			if (!isFinalStatus(job.snapshot.status) || this.processGroupExists(job)) continue;
			this.stopGroupMonitor(job);
			this.jobs.delete(id);
		}
	}

	private startGroupMonitor(job: ManagedJob): void {
		if (job.groupKnownGone || job.groupMonitor || !this.processGroupExists(job)) return;
		job.groupMonitor = setInterval(() => {
			if (this.processGroupExists(job)) return;
			this.stopGroupMonitor(job);
			this.pruneCompletedJobs();
		}, 250);
		job.groupMonitor.unref();
	}

	private stopGroupMonitor(job: ManagedJob): void {
		if (!job.groupMonitor) return;
		clearInterval(job.groupMonitor);
		job.groupMonitor = undefined;
	}

	private processGroupExists(job: ManagedJob): boolean {
		if (job.groupKnownGone) return false;
		const pid = job.snapshot.pid;
		if (pid === undefined) return false;
		try {
			process.kill(-pid, 0);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
			job.groupKnownGone = true;
			this.stopGroupMonitor(job);
			return false;
		}
	}

	private signalProcessGroup(job: ManagedJob, signal: NodeJS.Signals): void {
		if (job.groupKnownGone) return;
		const pid = job.snapshot.pid;
		if (pid === undefined) return;
		try {
			process.kill(-pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") {
				job.groupKnownGone = true;
				this.stopGroupMonitor(job);
			}
			if (!job.closed) {
				try {
					job.child.kill(signal);
				} catch {
					/* Child may already have exited. */
				}
			}
		}
	}

	private finalizeJob(job: ManagedJob, code: number | null, signal: NodeJS.Signals | null): void {
		if (job.closed) return;
		job.closed = true;
		job.snapshot.endedAt = Date.now();
		job.snapshot.exitCode = code;
		job.snapshot.exitSignal = signal;
		job.snapshot.status = job.terminationRequested ? "killed" : code === 0 ? "exited" : "failed";
		if (job.snapshot.readiness.status === "waiting") job.snapshot.readiness.status = "exited";
		job.outputListeners.clear();
		job.resolveClose();
		this.startGroupMonitor(job);
		this.pruneCompletedJobs();
	}
}
