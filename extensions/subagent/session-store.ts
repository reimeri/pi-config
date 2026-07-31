/**
 * Reusable child sessions.
 *
 * A child normally runs with `--no-session`, so two tasks sent to the same agent share nothing: the
 * second re-reads the files the first read and re-derives what it already worked out, and the parent
 * pays for that re-briefing every time. A `sessionKey` gives the run a session file to resume, so the
 * agent starts where it left off and the request repeats a prefix the provider has already cached.
 *
 * Sessions are scoped to one parent session and one (agent, cwd) pair, and are deliberately
 * ephemeral: they exist to make a sequence of related tasks cheap, not to persist agent memory.
 */

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

	/**
	 * The session for one scope, created on first use.
	 *
	 * Scoping by agent and cwd means a key reused across agents or checkouts starts a separate
	 * session rather than resuming a history written by someone else, which the resuming agent would
	 * read as its own past work.
	 *
	 * Returns undefined when no directory could be made; the caller then runs without a session,
	 * which costs the reuse but never correctness.
	 */
	async resolve(scope: SessionScope): Promise<SubagentSession | undefined> {
		try {
			if (this.temp.disposed) return undefined;
			const dir = await this.temp.ensure();
			if (this.temp.disposed) return undefined;

			const key = scopeKey(scope);
			// A random id rather than the caller's string: the key is model-supplied and ends up as a
			// filename, and pi expects a session id shaped like one it generated.
			const entry = this.sessions.get(key) ?? { id: randomUUID(), runs: 0 };
			this.sessions.set(key, entry);
			// Counting here rather than on resolve keeps a run that is refused before it starts, by
			// the session lock, out of the number the parent is shown.
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

/**
 * A session key used twice in one parallel batch.
 *
 * Two children writing one session file would interleave their histories, so the batch is rejected
 * before any of them starts rather than left to the runtime lock, which would fail the second task
 * only after the first had already run.
 *
 * `defaultCwd` has to be the same fallback the run itself applies to a task that omits `cwd`.
 * Scoping an absent `cwd` to anything else lets an omitted one and an explicit one naming the same
 * directory look like different sessions here and resolve to a single session at run time, which is
 * exactly the mid-batch failure this check exists to prevent.
 */
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
