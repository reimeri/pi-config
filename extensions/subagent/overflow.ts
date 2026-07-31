import * as fs from "node:fs";
import * as path from "node:path";
import { LazyTempDirectory } from "./temp-directory.ts";
import { formatTruncationNotice, truncateAgentOutput } from "./truncate.ts";

/** Spills capped output to files that survive the tool call and are removed at session shutdown. */
export class OutputOverflowStore {
	private readonly temp = new LazyTempDirectory("pi-subagent-output-");
	private counter = 0;

	constructor(private readonly capBytes?: number) {}

	/** The spill directory, or null before the first overflow. Exposed for tests. */
	get directory(): string | null {
		return this.temp.path;
	}

	async capForParent(agentName: string, text: string): Promise<string> {
		const { text: kept, omittedBytes } = truncateAgentOutput(text, this.capBytes);
		if (omittedBytes === 0) return text;
		return kept + formatTruncationNotice(omittedBytes, await this.write(agentName, text));
	}

	private async write(agentName: string, text: string): Promise<string | undefined> {
		try {
			if (this.temp.disposed) return undefined;
			const dir = await this.temp.ensure();
			// Do not create a file after shutdown cleanup has completed.
			if (this.temp.disposed) return undefined;
			const safeName = agentName.replace(/[^\w.-]+/g, "_") || "agent";
			const filePath = path.join(dir, `${safeName}-${++this.counter}.md`);
			await fs.promises.writeFile(filePath, text, { encoding: "utf-8", mode: 0o600 });
			return filePath;
		} catch {
			// Apply the cap even if spilling fails; fall back to tool details.
			return undefined;
		}
	}

	dispose(): void {
		this.temp.dispose();
	}
}
