/** Manages ephemeral reusable child sessions scoped by parent session, agent, and cwd. */

import { randomUUID } from "node:crypto";
import { LazyTempDirectory } from "./temp-directory.ts";

export interface SubagentSession {
	/** Session id passed to `--session-id`. */
	id: string;
	/** Directory passed to `--session-dir`. */
	dir: string;
	/** Counts this run and returns its number. Call once the run is going ahead. */
	begin: () => number;
}

export interface SessionScope {
	agent: string;
	cwd: string;
	sessionKey: string;
}

function scopeKey({ agent, cwd, sessionKey }: SessionScope): string {
	return `${agent}\0${cwd}\0${sessionKey}`;
}

export class SubagentSessionStore {
	private readonly temp = new LazyTempDirectory("pi-subagent-sessions-");
	private readonly sessions = new Map<string, { id: string; runs: number }>();

	/** The session directory, or null before the first session. Exposed for tests. */
	get directory(): string | null {
		return this.temp.path;
	}

	/** Resolves or creates a scoped session; returns undefined if its temp directory is unavailable. */
	async resolve(scope: SessionScope): Promise<SubagentSession | undefined> {
		try {
			if (this.temp.disposed) return undefined;
			const dir = await this.temp.ensure();
			if (this.temp.disposed) return undefined;

			const key = scopeKey(scope);
			// Avoid using model-supplied key text as a filename.
			const entry = this.sessions.get(key) ?? { id: randomUUID(), runs: 0 };
			this.sessions.set(key, entry);
			// Increment only after the session lock permits the run.
			return { id: entry.id, dir, begin: () => ++entry.runs };
		} catch {
			return undefined;
		}
	}

	dispose(): void {
		this.sessions.clear();
		this.temp.dispose();
	}
}

/** Finds session keys duplicated within a batch after applying the run's cwd fallback. */
export function findDuplicateSessionKey(
	items: readonly { agent: string; cwd?: string; sessionKey?: string }[],
	defaultCwd: string,
): string | undefined {
	const seen = new Set<string>();
	for (const item of items) {
		if (!item.sessionKey) continue;
		const key = scopeKey({ agent: item.agent, cwd: item.cwd ?? defaultCwd, sessionKey: item.sessionKey });
		if (seen.has(key)) return item.sessionKey;
		seen.add(key);
	}
	return undefined;
}
