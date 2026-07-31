import * as fs from "node:fs";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LazyTempDirectory } from "./temp-directory.ts";

const dirs: LazyTempDirectory[] = [];

function tempDir(): LazyTempDirectory {
	const created = new LazyTempDirectory("pi-subagent-test-");
	dirs.push(created);
	return created;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) dir.dispose();
	vi.restoreAllMocks();
});

describe("LazyTempDirectory", () => {
	test("creates nothing until asked", () => {
		expect(tempDir().path).toBeNull();
	});

	test("hands concurrent callers the same directory", async () => {
		// Two callers that both found no directory would each make one, and only the last would be
		// tracked — leaving the other in the temp dir for good.
		const dir = tempDir();

		const [first, second] = await Promise.all([dir.ensure(), dir.ensure()]);

		expect(first).toBe(second);
		expect(dir.path).toBe(first);
		expect(existsSync(first)).toBe(true);
	});

	test("removes a directory whose creation landed after dispose", async () => {
		// Shutdown can arrive while mkdtemp is still in flight, and the directory it returns would
		// otherwise outlive the cleanup that was supposed to remove it.
		const dir = tempDir();
		const pending = dir.ensure();
		dir.dispose();
		const created = await pending;

		// The removal is chained onto the same promise, so it runs on a later microtask.
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(existsSync(created)).toBe(false);
		expect(dir.path).toBeNull();
		expect(dir.disposed).toBe(true);
	});

	test("does not leave a directory behind when created after dispose", async () => {
		const dir = tempDir();
		dir.dispose();

		const created = await dir.ensure();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(existsSync(created)).toBe(false);
		expect(dir.path).toBeNull();
	});

	test("retries after a failed creation instead of caching the rejection", async () => {
		// A cached rejected promise would be handed to every later caller, so one transient EMFILE
		// under a wide fan-out would disable spill files and sessions for the rest of the process.
		const dir = tempDir();
		const mkdtemp = vi.spyOn(fs.promises, "mkdtemp");
		mkdtemp.mockRejectedValueOnce(Object.assign(new Error("EMFILE"), { code: "EMFILE" }));

		await expect(dir.ensure()).rejects.toThrow("EMFILE");

		const created = await dir.ensure();
		expect(existsSync(created)).toBe(true);
		expect(dir.path).toBe(created);
	});

	test("dispose is safe before creation and when repeated", async () => {
		const dir = tempDir();
		expect(() => dir.dispose()).not.toThrow();

		await dir.ensure();
		dir.dispose();
		expect(() => dir.dispose()).not.toThrow();
	});
});
