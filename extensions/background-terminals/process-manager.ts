import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { BoundedLogBuffer } from "./log-buffer.ts";
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
	readinessMatcher?: (output: string) => boolean;
	readinessWindow: string;
	readinessMatchedAt?: number;
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

const READINESS_MATCH_WINDOW = 64 * 1024;
const READINESS_MATCH_OVERLAP = 2 * 1024;

function validateSafeRegex(pattern: string): void {
	if (pattern.length > 1000) throw new Error("Readiness regex cannot exceed 1000 characters");
	let escaped = false;
	let inCharacterClass = false;
	let maximumMatchWidth = 0;
	let previousTokenWidth = 0;
	for (let index = 0; index < pattern.length; index++) {
		const character = pattern[index];
		if (escaped) {
			if (!inCharacterClass && /[1-9]/u.test(character)) {
				throw new Error("Readiness regex backreferences are not supported");
			}
			if (!inCharacterClass) {
				maximumMatchWidth++;
				previousTokenWidth = 1;
			}
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === "[") {
			inCharacterClass = true;
			maximumMatchWidth++;
			previousTokenWidth = 1;
			continue;
		}
		if (character === "]") {
			inCharacterClass = false;
			continue;
		}
		if (inCharacterClass) continue;
		if (character === "(" || character === ")" || character === "|") {
			throw new Error("Readiness regex groups and alternation are not supported");
		}
		if (character === "*" || character === "+") {
			throw new Error("Readiness regex unbounded quantifiers are not supported; use a bounded range");
		}
		if (character === "?") continue;
		if (character === "{") {
			const closing = pattern.indexOf("}", index + 1);
			if (closing === -1) continue;
			const range = pattern.slice(index + 1, closing);
			if (/^\d+,$/u.test(range)) throw new Error("Readiness regex unbounded ranges are not supported");
			const maximum = range.match(/^\d+,(\d+)$/u)?.[1] ?? range.match(/^\d+$/u)?.[0];
			if (maximum) {
				const maximumValue = Number(maximum);
				if (maximumValue > 1000) {
					throw new Error("Readiness regex bounded ranges cannot exceed 1000");
				}
				maximumMatchWidth += previousTokenWidth * (maximumValue - 1);
				index = closing;
				continue;
			}
		}
		if (character === "^" || character === "$") {
			previousTokenWidth = 0;
			continue;
		}
		maximumMatchWidth++;
		previousTokenWidth = 1;
	}
	if (maximumMatchWidth > READINESS_MATCH_OVERLAP) {
		throw new Error(`Readiness regex maximum match width cannot exceed ${READINESS_MATCH_OVERLAP} characters`);
	}
}

function compileReadinessMatcher(request: ReadinessRequest): (output: string) => boolean {
	if (request.type === "substring") return (output) => output.includes(request.pattern);
	validateSafeRegex(request.pattern);
	const expression = new RegExp(request.pattern);
	return (output) => expression.test(output);
}

function scanReadinessWindows(matcher: (output: string) => boolean, output: string): boolean {
	if (output.length <= READINESS_MATCH_WINDOW) return matcher(output);
	const step = READINESS_MATCH_WINDOW - READINESS_MATCH_OVERLAP;
	for (let start = 0; start < output.length; start += step) {
		if (matcher(output.slice(start, start + READINESS_MATCH_WINDOW))) return true;
	}
	return false;
}

export class BackgroundProcessManager {
	private readonly config: BackgroundTerminalConfig;
	private readonly jobs = new Map<string, ManagedJob>();
	private nextId = 1;
	private shutdownPromise?: Promise<void>;

	constructor(config: BackgroundTerminalConfig) {
		this.config = config;
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
			const readinessStatus = await this.waitForReadiness(job, options.readiness, options.signal);
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
		if (isFinalStatus(job.snapshot.status) && !this.processGroupExists(job)) {
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
			job.snapshot.status = "killed";
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
			if (job.readinessMatcher && job.readinessMatchedAt === undefined) {
				const candidate = job.readinessWindow + appended;
				if (scanReadinessWindows(job.readinessMatcher, candidate)) {
					job.readinessMatchedAt = Date.now();
				}
				job.readinessWindow = candidate.slice(-READINESS_MATCH_WINDOW);
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

	private waitForReadiness(
		job: ManagedJob,
		request: ReadinessRequest,
		signal?: AbortSignal,
	): Promise<ReadinessResult["status"]> {
		return new Promise((resolve) => {
			let settled = false;
			const finish = (status: ReadinessResult["status"]) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				job.outputListeners.delete(checkOutput);
				signal?.removeEventListener("abort", onAbort);
				job.snapshot.readiness.status = status;
				if (status === "ready") {
					job.snapshot.readiness.matchedAt = job.readinessMatchedAt ?? Date.now();
				}
				resolve(status);
			};
			const checkOutput = () => {
				if (job.readinessMatchedAt !== undefined) finish("ready");
			};
			const onAbort = () => finish("aborted");
			const timeout = setTimeout(() => finish("timed_out"), request.timeoutMs);
			job.outputListeners.add(checkOutput);
			job.closePromise.then(() => finish("exited"));
			if (signal) signal.addEventListener("abort", onAbort, { once: true });
			checkOutput();
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
					// The direct child has already exited.
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
