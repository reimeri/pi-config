import { StringDecoder } from "node:string_decoder";

/** Decodes UTF-8 incrementally and emits newline-delimited lines without quadratic buffering. */
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

		// Retain the fragment after the last newline for the next chunk.
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
