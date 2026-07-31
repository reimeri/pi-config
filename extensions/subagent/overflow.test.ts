import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { OutputOverflowStore } from "./overflow.ts";
import { AGENT_OUTPUT_CAP } from "./truncate.ts";

const stores: OutputOverflowStore[] = [];

function store(capBytes?: number): OutputOverflowStore {
	const created = new OutputOverflowStore(capBytes);
	stores.push(created);
	return created;
}

afterEach(() => {
	for (const created of stores.splice(0)) created.dispose();
});

/** The path named in the truncation notice, which is what the parent agent would read. */
function overflowPath(output: string): string {
	const match = /Full output: (\S+) —/.exec(output);
	expect(match, `no overflow path in: ${output.slice(-200)}`).not.toBeNull();
	return match![1];
}

describe("OutputOverflowStore", () => {
	test("passes output under the cap through untouched and writes nothing", async () => {
		const overflow = store();
		const text = "## Completed\nAll good.";

		expect(await overflow.capForParent("worker", text)).toBe(text);
		expect(overflow.directory).toBeNull();
	});

	test("caps long output and keeps every omitted byte readable on disk", async () => {
		// The point of the cap: the parent's context stays bounded, but nothing becomes unreachable
		// to it. The tool details hold the full text for the UI; the model can only read a file.
		const overflow = store();
		const text = `HEAD${"x".repeat(AGENT_OUTPUT_CAP * 2)}TAIL`;

		const output = await overflow.capForParent("worker", text);

		expect(Buffer.byteLength(output, "utf8")).toBeLessThan(AGENT_OUTPUT_CAP + 512);
		expect(output).toContain("bytes omitted");
		expect(readFileSync(overflowPath(output), "utf-8")).toBe(text);
	});

	test("gives each capped run its own file", async () => {
		const overflow = store(16);

		const first = overflowPath(await overflow.capForParent("worker", "first".repeat(20)));
		const second = overflowPath(await overflow.capForParent("worker", "second".repeat(20)));

		expect(first).not.toBe(second);
		expect(readFileSync(first, "utf-8")).toBe("first".repeat(20));
		expect(readFileSync(second, "utf-8")).toBe("second".repeat(20));
	});

	test("shares one directory across spills that start together", async () => {
		// Parallel mode caps every task's output in one Promise.all, so both can reach the store
		// before either has a directory. A directory per spill would leave all but the last one in
		// the temp dir forever, since dispose only knows about the one it recorded last.
		const overflow = store(16);

		const outputs = await Promise.all([
			overflow.capForParent("a", "a".repeat(200)),
			overflow.capForParent("b", "b".repeat(200)),
		]);
		const spilled = outputs.map(overflowPath);

		expect(spilled.map(dirname)).toEqual([overflow.directory, overflow.directory]);
		overflow.dispose();
		expect(spilled.filter((p) => existsSync(p))).toEqual([]);
	});

	test("keeps a path-traversing agent name inside the spill directory", async () => {
		// Agent names come from Markdown frontmatter, so a separator in one must not escape the
		// directory. Dots survive sanitizing; only the separators have to go.
		const overflow = store(16);

		const spilled = overflowPath(await overflow.capForParent("../../etc/passwd", "y".repeat(200)));

		expect(dirname(spilled)).toBe(overflow.directory);
		expect(readFileSync(spilled, "utf-8")).toBe("y".repeat(200));
	});

	test("dispose removes the spilled files", async () => {
		const overflow = store(16);
		const spilled = overflowPath(await overflow.capForParent("worker", "z".repeat(200)));
		expect(existsSync(spilled)).toBe(true);

		overflow.dispose();

		expect(existsSync(spilled)).toBe(false);
		expect(overflow.directory).toBeNull();
	});

	test("dispose is safe before any overflow and when repeated", async () => {
		const overflow = store(16);
		expect(() => overflow.dispose()).not.toThrow();

		await overflow.capForParent("worker", "z".repeat(200));
		overflow.dispose();
		expect(() => overflow.dispose()).not.toThrow();
	});
});
