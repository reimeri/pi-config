import { StringDecoder } from "node:string_decoder";

/**
 * Assembles newline-delimited lines from raw process output.
 *
 * Two properties matter for a subagent's JSON event stream, and the obvious
 * `buffer += chunk.toString(); buffer.split("\n")` loop has neither:
 *
 * - A chunk boundary may fall inside a multi-byte UTF-8 sequence. Decoding each
 *   chunk on its own replaces that character with U+FFFD. The line still parses,
 *   because non-ASCII only ever appears inside JSON string values, so the damage
 *   is silent: the subagent's text arrives as mojibake. The decoder holds an
 *   incomplete sequence back until its remaining bytes arrive.
 * - Re-splitting an accumulating buffer costs O(buffer) per chunk, so a single
 *   long line — a large tool result, say — is quadratic to receive. Newlines are
 *   searched for within each arriving chunk instead, and the retained fragments
 *   are joined once, when their line completes.
 *
 * Lines are delivered without their trailing newline; a blank line is delivered
 * as an empty string rather than skipped, leaving that policy to the consumer.
 */
export class LineStream {
	private readonly decoder = new StringDecoder("utf8");
	private pending: string[] = [];

	constructor(private readonly onLine: (line: string) => void) {}

	write(chunk: Buffer): void {
		const decoded = this.decoder.write(chunk);
		if (!decoded) return;

		let lineStart = 0;
		let newline = decoded.indexOf("\n");
		while (newline !== -1) {
			this.emit(decoded.slice(lineStart, newline));
			lineStart = newline + 1;
			newline = decoded.indexOf("\n", lineStart);
		}

		// Whatever follows the last newline is the new pending line. When the chunk held no
		// newline at all it merely extends the line already in progress.
		if (lineStart > 0) {
			const tail = decoded.slice(lineStart);
			this.pending = tail ? [tail] : [];
		} else {
			this.pending.push(decoded);
		}
	}

	/** Flush the decoder and deliver any unterminated final line. */
	end(): void {
		const flushed = this.decoder.end();
		if (flushed) this.pending.push(flushed);
		if (this.pending.length === 0) return;
		const line = this.pending.join("");
		this.pending = [];
		if (line) this.onLine(line);
	}

	private emit(tail: string): void {
		const line = this.pending.length === 0 ? tail : this.pending.join("") + tail;
		this.pending = [];
		this.onLine(line);
	}
}
