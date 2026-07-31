import { existsSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { findDuplicateSessionKey, SubagentSessionStore } from "./session-store.ts";

const stores: SubagentSessionStore[] = [];

function store(): SubagentSessionStore {
	const created = new SubagentSessionStore();
	stores.push(created);
	return created;
}

afterEach(() => {
	for (const created of stores.splice(0)) created.dispose();
});

describe("SubagentSessionStore", () => {
	test("returns the same session id for repeated use of one key", async () => {
		// Concurrent resumes must share one session file.
		const sessions = store();

		const first = await sessions.resolve({ agent: "worker", cwd: "/repo", sessionKey: "auth" });
		const second = await sessions.resolve({ agent: "worker", cwd: "/repo", sessionKey: "auth" });

		expect(first?.id).toBe(second?.id);
		expect(first?.dir).toBe(second?.dir);
	});

	test("counts runs so the parent can see how far a session has gone", async () => {
		const sessions = store();
		const scope = { agent: "worker", cwd: "/repo", sessionKey: "auth" };

		expect((await sessions.resolve(scope))?.begin()).toBe(1);
		expect((await sessions.resolve(scope))?.begin()).toBe(2);
		expect((await sessions.resolve(scope))?.begin()).toBe(3);
	});

	test("does not count a resolved session whose run never starts", async () => {
		// Count only runs that acquire the session lock.
		const sessions = store();
		const scope = { agent: "worker", cwd: "/repo", sessionKey: "auth" };

		await sessions.resolve(scope);
		await sessions.resolve(scope);

		expect((await sessions.resolve(scope))?.begin()).toBe(1);
	});

	test("separates keys, agents, and working directories", async () => {
		// Reusing a key across agents or checkouts must not resume another history.
		const sessions = store();

		const base = await sessions.resolve({ agent: "worker", cwd: "/repo", sessionKey: "auth" });
		const otherKey = await sessions.resolve({ agent: "worker", cwd: "/repo", sessionKey: "billing" });
		const otherAgent = await sessions.resolve({ agent: "scout", cwd: "/repo", sessionKey: "auth" });
		const otherCwd = await sessions.resolve({ agent: "worker", cwd: "/other", sessionKey: "auth" });

		const ids = [base?.id, otherKey?.id, otherAgent?.id, otherCwd?.id];
		expect(new Set(ids).size).toBe(4);
	});

	test("shares one directory across sessions that start together", async () => {
		const sessions = store();

		const resolved = await Promise.all([
			sessions.resolve({ agent: "a", cwd: "/repo", sessionKey: "one" }),
			sessions.resolve({ agent: "b", cwd: "/repo", sessionKey: "two" }),
		]);

		expect(resolved[0]?.dir).toBe(sessions.directory);
		expect(resolved[1]?.dir).toBe(sessions.directory);
	});

	test("dispose removes the session directory and forgets the keys", async () => {
		const sessions = store();
		const resolved = await sessions.resolve({ agent: "worker", cwd: "/repo", sessionKey: "auth" });
		expect(existsSync(resolved?.dir ?? "")).toBe(true);

		sessions.dispose();

		expect(existsSync(resolved?.dir ?? "")).toBe(false);
		expect(sessions.directory).toBeNull();
		expect(await sessions.resolve({ agent: "worker", cwd: "/repo", sessionKey: "auth" })).toBeUndefined();
	});
});

describe("findDuplicateSessionKey", () => {
	test("catches one key used twice for the same agent", async () => {
		expect(
			findDuplicateSessionKey(
				[
					{ agent: "scout", sessionKey: "api" },
					{ agent: "scout", sessionKey: "api" },
				],
				"/repo",
			),
		).toBe("api");
	});

	test("catches an omitted cwd against one naming the default explicitly", () => {
		// Omitted and equivalent explicit cwd values must collide during duplicate detection.
		expect(
			findDuplicateSessionKey(
				[
					{ agent: "scout", sessionKey: "api" },
					{ agent: "scout", cwd: "/repo", sessionKey: "api" },
				],
				"/repo",
			),
		).toBe("api");
	});

	test("allows the same key for different agents, which are different sessions", () => {
		expect(
			findDuplicateSessionKey(
				[
					{ agent: "scout", sessionKey: "api" },
					{ agent: "researcher", sessionKey: "api" },
				],
				"/repo",
			),
		).toBeUndefined();
	});

	test("allows the same key in different working directories", () => {
		expect(
			findDuplicateSessionKey(
				[
					{ agent: "scout", cwd: "/a", sessionKey: "api" },
					{ agent: "scout", cwd: "/b", sessionKey: "api" },
				],
				"/repo",
			),
		).toBeUndefined();
	});

	test("ignores tasks that asked for no session", () => {
		expect(findDuplicateSessionKey([{ agent: "scout" }, { agent: "scout" }], "/repo")).toBeUndefined();
	});
});
