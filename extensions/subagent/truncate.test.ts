import { describe, expect, test } from "vitest";
import { AGENT_OUTPUT_CAP, formatTruncationNotice, truncateAgentOutput } from "./truncate.ts";

const CAP = AGENT_OUTPUT_CAP;
/** A high surrogate not followed by a low one, or a low surrogate not preceded by a high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

describe("truncateAgentOutput", () => {
	test("returns output at or under the cap untouched", () => {
		for (const text of ["", "hello", "x".repeat(CAP), "世".repeat(CAP / 3)]) {
			expect(truncateAgentOutput(text)).toEqual({ text, omittedBytes: 0 });
		}
	});

	test("honours a caller-supplied cap", () => {
		expect(truncateAgentOutput("abcdef", 4)).toEqual({ text: "abcd", omittedBytes: 2 });
	});

	test("keeps the kept portion within the byte cap and accounts for every byte", () => {
		for (const unit of ["x", "é", "→", "🙂", "aé→🙂"]) {
			const text = unit.repeat(Math.ceil((CAP * 3) / Buffer.byteLength(unit, "utf8")));
			const { text: kept, omittedBytes } = truncateAgentOutput(text);
			const keptBytes = Buffer.byteLength(kept, "utf8");
			expect(keptBytes, unit).toBeLessThanOrEqual(CAP);
			// Unused capacity is smaller than one maximum-width character.
			expect(keptBytes, unit).toBeGreaterThan(CAP - 4);
			expect(text.startsWith(kept), unit).toBe(true);
			expect(omittedBytes, unit).toBe(Buffer.byteLength(text, "utf8") - keptBytes);
		}
	});

	test("never splits a surrogate pair", () => {
		// Test cap alignments that previously left lone UTF-16 surrogates.
		for (let pad = 0; pad < 8; pad++) {
			const text = "a".repeat(pad) + "🙂".repeat(60_000);
			const { text: kept } = truncateAgentOutput(text);
			expect(LONE_SURROGATE.test(kept), `pad ${pad}`).toBe(false);
			expect(Buffer.from(kept, "utf8").toString("utf8"), `pad ${pad}`).toBe(kept);
		}
	});

	test("agrees with a character-at-a-time reference on the boundary it picks", () => {
		// Compare with the original algorithm corrected to remove whole code points.
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
			expect(truncateAgentOutput(text).text, `trial ${trial}`).toBe(reference(text));
		}
	});

	test("truncates multi-byte output in linear time", () => {
		// Ensure trimming cost depends on retained output, not discarded output.
		const text = "这是一个测试用的字符串。".repeat(20_000);
		const started = performance.now();
		const result = truncateAgentOutput(text);
		expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(CAP);
		expect(performance.now() - started).toBeLessThan(25);
	});
});

describe("formatTruncationNotice", () => {
	test("points the parent agent at the overflow file when one was written", () => {
		const notice = formatTruncationNotice(2048, "/tmp/pi-subagent-output-x/worker-1.md");
		expect(notice).toContain("2048 bytes omitted");
		expect(notice).toContain("/tmp/pi-subagent-output-x/worker-1.md");
		expect(notice).toContain("read that file for the rest");
	});

	test("falls back to the tool details when the overflow file could not be written", () => {
		const notice = formatTruncationNotice(2048);
		expect(notice).toContain("2048 bytes omitted");
		expect(notice).toContain("preserved in tool details");
	});
});
