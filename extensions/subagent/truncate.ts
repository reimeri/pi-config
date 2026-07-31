export const AGENT_OUTPUT_CAP = 50 * 1024;

export interface TruncatedOutput {
	/** The kept prefix, cut on a character boundary. */
	text: string;
	/** Bytes dropped from the end. Zero when the output fit. */
	omittedBytes: number;
}

/**
 * Trim `output` to the byte cap, cutting only between characters.
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
export function truncateAgentOutput(output: string, cap: number = AGENT_OUTPUT_CAP): TruncatedOutput {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= cap) return { text: output, omittedBytes: 0 };

	const budget = new Uint8Array(cap);
	const { read, written } = new TextEncoder().encodeInto(output, budget);
	return { text: output.slice(0, read), omittedBytes: byteLength - written };
}

/**
 * The notice appended in place of what was cut.
 *
 * `overflowPath` is what makes the cap non-lossy for the parent agent: the tool details hold the
 * full text for the UI, but the model cannot read those, so without a path on disk the remainder is
 * unreachable to it and truncation becomes silent data loss.
 */
export function formatTruncationNotice(omittedBytes: number, overflowPath?: string): string {
	const where = overflowPath
		? `Full output: ${overflowPath} — read that file for the rest.`
		: "Full output preserved in tool details.";
	return `\n\n[Output truncated: ${omittedBytes} bytes omitted. ${where}]`;
}
