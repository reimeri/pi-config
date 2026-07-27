const PER_TASK_OUTPUT_CAP = 50 * 1024;

/**
 * Trim `output` to the per-task byte cap, cutting only between characters.
 *
 * `encodeInto` fills a buffer of exactly the budget and reports how far into the string it got. It
 * never writes a partial sequence, so the cut lands on a character boundary in a single pass, and
 * `written` is the exact size of what was kept.
 *
 * Slicing to the cap in *characters* and then shortening one at a time was two problems. Multi-byte
 * text makes that first slice overshoot the byte budget — threefold for CJK — and every step then
 * re-measured the whole candidate, so trimming the excess was quadratic. A step that landed between
 * the halves of a surrogate pair also left a lone surrogate behind, which becomes a replacement
 * character once the text is encoded.
 */
export function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	const budget = new Uint8Array(PER_TASK_OUTPUT_CAP);
	const { read, written } = new TextEncoder().encodeInto(output, budget);
	return `${output.slice(0, read)}\n\n[Output truncated: ${byteLength - written} bytes omitted. Full output preserved in tool details.]`;
}
