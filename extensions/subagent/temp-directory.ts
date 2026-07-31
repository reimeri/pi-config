import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Lazily creates one shared temp directory and removes in-flight creations on dispose. */
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
					// Dispose any directory created after shutdown instead of adopting it.
					if (this.isDisposed) this.remove(dir);
					else this.dir = dir;
					return dir;
				})
				.catch((error) => {
					// Clear only this failed attempt so retries cannot create untracked directories.
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
			/* Ignore cleanup failure. */
		}
	}
}
