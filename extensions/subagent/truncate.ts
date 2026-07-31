export const AGENT_OUTPUT_CAP = 50 * 1024;

export interface TruncatedOutput {
	/** The kept prefix, cut on a character boundary. */
	text: string;
	/** Bytes dropped from the end. Zero when the output fit. */
	omittedBytes: number;
}

/** Truncates in one pass to a UTF-8 byte cap without splitting characters. */
export function truncateAgentOutput(output: string, cap: number = AGENT_OUTPUT_CAP): TruncatedOutput {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= cap) return { text: output, omittedBytes: 0 };

	const budget = new Uint8Array(cap);
	const { read, written } = new TextEncoder().encodeInto(output, budget);
	return { text: output.slice(0, read), omittedBytes: byteLength - written };
}

/** Describes omitted output and where the complete text remains available. */
export function formatTruncationNotice(omittedBytes: number, overflowPath?: string): string {
	const where = overflowPath
		? `Full output: ${overflowPath} — read that file for the rest.`
		: "Full output preserved in tool details.";
	return `\n\n[Output truncated: ${omittedBytes} bytes omitted. ${where}]`;
}
