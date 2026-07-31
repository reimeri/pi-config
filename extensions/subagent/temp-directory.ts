import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * A temp directory created on first use and removed on dispose.
 *
 * Creation is shared rather than re-tested per caller: two callers that both found no directory
 * would each make one, and only the last would be tracked, leaving the other behind in the temp dir
 * for good. Dispose also chases a creation still in flight, which would otherwise land after the
 * cleanup that was supposed to remove it.
 */
export class LazyTempDirectory {
	private dir: string | null = null;
	private pending: Promise<string> | null = null;
	private isDisposed = false;

	constructor(private readonly prefix: string) {}

	/** The directory, or null before first use and after dispose. */
	get path(): string | null {
		return this.dir;
	}

	get disposed(): boolean {
		return this.isDisposed;
	}

	ensure(): Promise<string> {
		if (!this.pending) {
			const created: Promise<string> = fs.promises
				.mkdtemp(path.join(os.tmpdir(), this.prefix))
				.then((dir) => {
					// Dispose may already have run, either while this creation was in flight or before it
					// started. Adopting the directory now would leave `path` naming something that has been
					// removed, and nothing would ever remove one created after the cleanup.
					if (this.isDisposed) this.remove(dir);
					else this.dir = dir;
					return dir;
				})
				.catch((error) => {
					// A cached rejection would be handed to every later caller, so one transient failure
					// (EMFILE under a wide fan-out, a briefly full tmp) would disable the directory for the
					// rest of the process. Forget it instead so the next call retries — but only while this
					// is still the tracked attempt, since clearing a newer one would let two creations run
					// with only the last of them tracked.
					if (this.pending === created) this.pending = null;
					throw error;
				});
			this.pending = created;
		}
		return this.pending;
	}

	dispose(): void {
		this.isDisposed = true;
		const pending = this.pending;
		this.pending = null;
		this.remove(this.dir);
		this.dir = null;
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
