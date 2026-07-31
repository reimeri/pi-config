import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatTruncationNotice, truncateAgentOutput } from "./truncate.ts";

/**
 * Caps the agent output that reaches the parent's context, keeping the remainder reachable.
 *
 * The tool details already hold every child message, but the model cannot read those, so a cap on
 * its own turns long output into silent data loss. Spilling the full text to a file and naming it in
 * the notice makes the cap non-lossy: the parent reads the rest only when it actually needs it.
 *
 * One directory per store, created on first overflow and removed by `dispose`, so the files outlive
 * the tool call that produced them — the parent may read them several turns later — without
 * accumulating across sessions.
 *
 * Parallel mode caps every task's output at once, so the creation has to be shared rather than
 * re-tested per call: two spills that both found no directory would each make one, and only the
 * last would be tracked, leaving the other behind in the temp dir for good.
 */
export class OutputOverflowStore {
	private dir: string | null = null;
	private dirPromise: Promise<string> | null = null;
	private disposed = false;
	private counter = 0;

	constructor(private readonly capBytes?: number) {}

	/** The spill directory, or null before the first overflow. Exposed for tests. */
	get directory(): string | null {
		return this.dir;
	}

	async capForParent(agentName: string, text: string): Promise<string> {
		const { text: kept, omittedBytes } = truncateAgentOutput(text, this.capBytes);
		if (omittedBytes === 0) return text;
		return kept + formatTruncationNotice(omittedBytes, await this.write(agentName, text));
	}

	private ensureDir(): Promise<string> {
		this.dirPromise ??= fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-output-")).then((dir) => {
			this.dir = dir;
			return dir;
		});
		return this.dirPromise;
	}

	private async write(agentName: string, text: string): Promise<string | undefined> {
		try {
			if (this.disposed) return undefined;
			const dir = await this.ensureDir();
			// Shutdown may have landed while the directory was being created; the file would then
			// outlive the cleanup that was supposed to remove it.
			if (this.disposed) return undefined;
			const safeName = agentName.replace(/[^\w.-]+/g, "_") || "agent";
			const filePath = path.join(dir, `${safeName}-${++this.counter}.md`);
			await fs.promises.writeFile(filePath, text, { encoding: "utf-8", mode: 0o600 });
			return filePath;
		} catch {
			// The cap still has to apply. The notice falls back to pointing at the tool details.
			return undefined;
		}
	}

	dispose(): void {
		this.disposed = true;
		const pending = this.dirPromise;
		this.dirPromise = null;
		this.remove(this.dir);
		this.dir = null;
		// A mkdtemp still in flight owes a directory that this call cannot see yet.
		pending?.then(
			(dir) => this.remove(dir),
			() => {},
		);
	}

	private remove(dir: string | null): void {
		if (!dir) return;
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* a leftover temp directory is not worth failing shutdown over */
		}
	}
}
