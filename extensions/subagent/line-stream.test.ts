import { describe, expect, test } from "vitest";
import { LineStream } from "./line-stream.ts";

function collect(chunks: Array<Buffer | string>): string[] {
	const lines: string[] = [];
	const stream = new LineStream((line) => lines.push(line));
	for (const chunk of chunks) stream.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
	stream.end();
	return lines;
}

/** Split `text` into byte-level chunks of exactly `size`, ignoring character boundaries. */
function byteChunks(text: string, size: number): Buffer[] {
	const bytes = Buffer.from(text, "utf8");
	const chunks: Buffer[] = [];
	for (let offset = 0; offset < bytes.length; offset += size) {
		chunks.push(bytes.subarray(offset, offset + size));
	}
	return chunks;
}

describe("LineStream", () => {
	test("splits complete lines and reports blank lines", () => {
		expect(collect(["a\nb\n\nc\n"])).toEqual(["a", "b", "", "c"]);
	});

	test("delivers an unterminated final line on end", () => {
		expect(collect(["a\nb"])).toEqual(["a", "b"]);
	});

	test("emits nothing for an empty stream or a bare trailing newline", () => {
		expect(collect([])).toEqual([]);
		expect(collect([""])).toEqual([]);
		expect(collect(["a\n"])).toEqual(["a"]);
	});

	test("joins a line delivered across many chunks", () => {
		expect(collect(["{\"a\"", ":", "1}", "\n"])).toEqual(['{"a":1}']);
	});

	test("preserves multi-byte characters split across chunk boundaries", () => {
		// Independent chunk decoding corrupts multibyte text while leaving JSON valid.
		const payload = JSON.stringify({ text: "héllo → 𝔘 🙂 世界" });
		for (const size of [1, 2, 3, 5, 7]) {
			expect(collect(byteChunks(`${payload}\n`, size))).toEqual([payload]);
		}
	});

	test("matches a naive splitter across randomized chunkings", () => {
		let seed = 987;
		const rand = (n: number): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed % n;
		};
		const alphabet = ["a", "é", "→", "𝔘", "🙂", "\n", " ", "}"];

		for (let trial = 0; trial < 200; trial++) {
			let text = "";
			for (let i = rand(60); i > 0; i--) text += alphabet[rand(alphabet.length)];

			// Match whole-text splitting while omitting only the final newline segment.
			const expected = text.split("\n");
			if (expected.at(-1) === "") expected.pop();

			for (const size of [1, 2, 3, 8, 64]) {
				expect(collect(byteChunks(text, size))).toEqual(expected);
			}
		}
	});

	test("receives one long line in linear time", () => {
		// Re-splitting accumulated input would make long-line processing quadratic.
		const line = `${"x".repeat(8_000_000)}\n`;
		const chunks = byteChunks(line, 16 * 1024);
		const started = performance.now();
		const lines = collect(chunks);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toHaveLength(8_000_000);
		expect(performance.now() - started).toBeLessThan(1_500);
	});
});
