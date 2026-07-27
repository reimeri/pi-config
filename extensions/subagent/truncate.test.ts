import { describe, expect, test } from "bun:test";
import { truncateParallelOutput } from "./truncate.ts";

const CAP = 50 * 1024;
const MARKER = "\n\n[Output truncated: ";
/** A high surrogate not followed by a low one, or a low surrogate not preceded by a high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/** The kept portion, with the appended notice removed. */
function kept(result: string): string {
	const index = result.lastIndexOf(MARKER);
	return index === -1 ? result : result.slice(0, index);
}

function omittedBytes(result: string): number {
	return Number(/\[Output truncated: (\d+) bytes omitted/.exec(result)?.[1]);
}

describe("truncateParallelOutput", () => {
	test("returns output at or under the cap untouched", () => {
		for (const text of ["", "hello", "x".repeat(CAP), "世".repeat(CAP / 3)]) {
			expect(truncateParallelOutput(text)).toBe(text);
		}
	});

	test("keeps the kept portion within the byte cap and accounts for every byte", () => {
		for (const unit of ["x", "é", "→", "🙂", "aé→🙂"]) {
			const text = unit.repeat(Math.ceil((CAP * 3) / Buffer.byteLength(unit, "utf8")));
			const result = truncateParallelOutput(text);
			const keptBytes = Buffer.byteLength(kept(result), "utf8");
			expect(keptBytes, unit).toBeLessThanOrEqual(CAP);
			// Within one character of the cap: the only shortfall allowed is the character that
			// would not fit.
			expect(keptBytes, unit).toBeGreaterThan(CAP - 4);
			expect(text.startsWith(kept(result)), unit).toBe(true);
			expect(omittedBytes(result), unit).toBe(Buffer.byteLength(text, "utf8") - keptBytes);
		}
	});

	test("never splits a surrogate pair", () => {
		// The old truncation cut one UTF-16 unit at a time, so whether it left a lone surrogate
		// depended on where the cap happened to fall. Shifting the alignment finds those cases.
		for (let pad = 0; pad < 8; pad++) {
			const text = "a".repeat(pad) + "🙂".repeat(60_000);
			const result = truncateParallelOutput(text);
			expect(LONE_SURROGATE.test(result), `pad ${pad}`).toBe(false);
			expect(Buffer.from(result, "utf8").toString("utf8"), `pad ${pad}`).toBe(result);
		}
	});

	test("agrees with a character-at-a-time reference on the boundary it picks", () => {
		// The reference is the original algorithm, minus its surrogate flaw: step back whole code
		// points instead of code units.
		const reference = (output: string): string => {
			if (Buffer.byteLength(output, "utf8") <= CAP) return output;
			let points = [...output].slice(0, CAP);
			while (Buffer.byteLength(points.join(""), "utf8") > CAP) points.pop();
			return points.join("");
		};
		const units = ["x", "é", "→", "🙂"];
		let seed = 31;
		const rand = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
		for (let trial = 0; trial < 25; trial++) {
			let text = "";
			for (let i = rand(40); i > 0; i--) text += units[rand(units.length)]!.repeat(2_000 + rand(2_000));
			if (Buffer.byteLength(text, "utf8") <= CAP) continue;
			expect(kept(truncateParallelOutput(text)), `trial ${trial}`).toBe(reference(text));
		}
	});

	test("truncates multi-byte output in linear time", () => {
		// Overshooting the byte budget and then re-measuring per removed character cost ~52ms for
		// this input under bun (~800ms under node, whose Buffer.byteLength is far slower), against
		// ~0.14ms here. The work no longer scales with how much gets discarded.
		const text = "这是一个测试用的字符串。".repeat(20_000);
		const started = performance.now();
		const result = truncateParallelOutput(text);
		expect(Buffer.byteLength(kept(result), "utf8")).toBeLessThanOrEqual(CAP);
		expect(performance.now() - started).toBeLessThan(25);
	});
});
