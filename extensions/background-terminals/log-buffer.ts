import type { BackgroundStream } from "./types.ts";

interface LogChunk {
	start: number;
	end: number;
	text: string;
	stream: BackgroundStream;
	newlines: number;
}

export interface LogBufferRead {
	text: string;
	startCursor: number;
	nextCursor: number;
	droppedBefore: boolean;
	truncatedToTail: boolean;
}

const TARGET_CHUNK_BYTES = 64 * 1024;
const OSC_SEQUENCE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu;
const ANSI_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/gu;
const UNSAFE_CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

export function sanitizeBackgroundOutput(text: string): string {
	return text
		.replace(/\r\n/gu, "\n")
		.replace(/\r/gu, "\n")
		.replace(/\t/gu, "    ")
		.replace(OSC_SEQUENCE, "")
		.replace(ANSI_SEQUENCE, "")
		.replace(UNSAFE_CONTROL_CHARACTER, "");
}

function utf8ByteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function utf8Suffix(text: string, maximumBytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maximumBytes) return text;
	let start = buffer.length - maximumBytes;
	while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
	return buffer.subarray(start).toString("utf8");
}

function utf8Prefix(text: string, maximumBytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maximumBytes) return text;
	let end = maximumBytes;
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}

function lineLimitedPrefix(text: string, maximumLines: number): string {
	let lines = 0;
	for (let index = 0; index < text.length; index++) {
		if (text.charCodeAt(index) !== 10) continue;
		lines++;
		if (lines === maximumLines) return text.slice(0, index + 1);
	}
	return text;
}

function lineLimitedSuffix(text: string, maximumLines: number): string {
	const terminated = text.endsWith("\n");
	const lines = text.split("\n");
	if (terminated) lines.pop();
	if (lines.length <= maximumLines) return text;
	const suffix = lines.slice(lines.length - maximumLines).join("\n");
	return terminated ? `${suffix}\n` : suffix;
}

function limitedPrefix(text: string, maximumLines: number, maximumBytes: number): string {
	return utf8Prefix(lineLimitedPrefix(text, maximumLines), maximumBytes);
}

function limitedSuffix(text: string, maximumLines: number, maximumBytes: number): string {
	return utf8Suffix(lineLimitedSuffix(text, maximumLines), maximumBytes);
}

function suffixAfterByteOffset(text: string, byteOffset: number): string {
	if (byteOffset <= 0) return text;
	const buffer = Buffer.from(text, "utf8");
	if (byteOffset >= buffer.length) return "";
	let start = byteOffset;
	while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
	return buffer.subarray(start).toString("utf8");
}

function newlineCount(text: string): number {
	let count = 0;
	for (let index = 0; index < text.length; index++) {
		if (text.charCodeAt(index) === 10) count++;
	}
	return count;
}

function* utf8Segments(text: string, maximumBytes: number): Generator<string> {
	const buffer = Buffer.from(text, "utf8");
	let start = 0;
	while (start < buffer.length) {
		let end = Math.min(buffer.length, start + maximumBytes);
		if (end < buffer.length) {
			while (end > start && (buffer[end] & 0xc0) === 0x80) end--;
		}
		if (end === start) end = Math.min(buffer.length, start + maximumBytes);
		yield buffer.subarray(start, end).toString("utf8");
		start = end;
	}
}

export class BoundedLogBuffer {
	private readonly chunks: LogChunk[] = [];
	private readonly maximumBytes: number;
	private readonly maximumLines: number;
	private readonly targetChunkBytes: number;
	private readonly targetChunkLines: number;
	private nextCursorValue = 0;
	private droppedBytesValue = 0;
	private currentBytes = 0;
	private currentNewlines = 0;

	constructor(maximumBytes: number, maximumLines: number) {
		this.maximumBytes = maximumBytes;
		this.maximumLines = maximumLines;
		this.targetChunkBytes = Math.max(1, Math.min(TARGET_CHUNK_BYTES, Math.ceil(maximumBytes / 16)));
		this.targetChunkLines = Math.max(1, Math.ceil(maximumLines / 16));
		if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
			throw new Error("maximumBytes must be a positive integer");
		}
		if (!Number.isSafeInteger(maximumLines) || maximumLines <= 0) {
			throw new Error("maximumLines must be a positive integer");
		}
	}

	append(stream: BackgroundStream, input: string): string {
		const text = sanitizeBackgroundOutput(input);
		if (!text) return "";

		for (const segment of utf8Segments(text, this.targetChunkBytes)) {
			this.appendSegment(stream, segment);
			this.trimIfNeeded();
		}
		return text;
	}

	get startCursor(): number {
		return this.chunks[0]?.start ?? this.nextCursorValue;
	}

	get nextCursor(): number {
		return this.nextCursorValue;
	}

	get droppedBytes(): number {
		return this.droppedBytesValue;
	}

	get text(): string {
		return this.chunks.map((chunk) => chunk.text).join("");
	}

	read(cursor?: number, tailLines?: number, maximumBytes?: number): LogBufferRead {
		if (cursor === undefined && (tailLines !== undefined || maximumBytes !== undefined)) {
			return this.readBoundedTail(tailLines ?? this.maximumLines, maximumBytes ?? this.maximumBytes);
		}

		const earliest = this.startCursor;
		if (cursor !== undefined && (tailLines !== undefined || maximumBytes !== undefined)) {
			const effectiveCursor = Math.max(earliest, Math.min(cursor, this.nextCursorValue));
			return this.readBoundedAfterCursor(
				effectiveCursor,
				tailLines ?? this.maximumLines,
				maximumBytes ?? this.maximumBytes,
				cursor < earliest,
			);
		}
		// Both bounded forms are handled above, so this is the unbounded read: every
		// retained byte from the cursor onward, with no tail or byte limit to apply.
		const requestedCursor = cursor ?? earliest;
		const effectiveCursor = Math.max(earliest, Math.min(requestedCursor, this.nextCursorValue));
		const droppedBefore = requestedCursor < earliest;
		const selected: string[] = [];
		let startCursor = effectiveCursor;

		for (const chunk of this.chunks) {
			if (chunk.end <= effectiveCursor) continue;
			if (chunk.start < effectiveCursor) {
				const suffix = suffixAfterByteOffset(chunk.text, effectiveCursor - chunk.start);
				if (suffix) {
					selected.push(suffix);
					startCursor = chunk.end - utf8ByteLength(suffix);
				}
			} else {
				selected.push(chunk.text);
			}
		}

		return {
			text: selected.join(""),
			startCursor,
			nextCursor: this.nextCursorValue,
			droppedBefore,
			truncatedToTail: false,
		};
	}

	private readBoundedAfterCursor(
		effectiveCursor: number,
		maximumLines: number,
		maximumBytes: number,
		droppedBefore: boolean,
	): LogBufferRead {
		const selected: string[] = [];
		let selectedBytes = 0;
		let selectedNewlines = 0;
		for (const chunk of this.chunks) {
			if (chunk.end <= effectiveCursor) continue;
			const text = chunk.start < effectiveCursor
				? suffixAfterByteOffset(chunk.text, effectiveCursor - chunk.start)
				: chunk.text;
			if (!text) continue;
			selected.push(text);
			selectedBytes += utf8ByteLength(text);
			selectedNewlines += newlineCount(text);
			if (selectedBytes >= maximumBytes || selectedNewlines >= maximumLines) break;
		}
		const candidate = selected.join("");
		const text = limitedPrefix(candidate, maximumLines, maximumBytes);
		const nextCursor = effectiveCursor + utf8ByteLength(text);
		return {
			text,
			startCursor: effectiveCursor,
			nextCursor,
			droppedBefore,
			truncatedToTail: nextCursor < this.nextCursorValue,
		};
	}

	private readBoundedTail(maximumLines: number, maximumBytes: number): LogBufferRead {
		const selected: string[] = [];
		let selectedBytes = 0;
		let selectedNewlines = 0;
		let firstSelectedIndex = this.chunks.length;
		for (let index = this.chunks.length - 1; index >= 0; index--) {
			const chunk = this.chunks[index];
			selected.unshift(chunk.text);
			selectedBytes += chunk.end - chunk.start;
			selectedNewlines += chunk.newlines;
			firstSelectedIndex = index;
			if (selectedBytes >= maximumBytes || selectedNewlines >= maximumLines) break;
		}
		const candidate = selected.join("");
		const text = limitedSuffix(candidate, maximumLines, maximumBytes);
		const truncatedToTail = firstSelectedIndex > 0 || text !== candidate;
		return {
			text,
			startCursor: this.nextCursorValue - utf8ByteLength(text),
			nextCursor: this.nextCursorValue,
			droppedBefore: false,
			truncatedToTail,
		};
	}

	private appendSegment(stream: BackgroundStream, text: string): void {
		const bytes = utf8ByteLength(text);
		const newlines = newlineCount(text);
		const start = this.nextCursorValue;
		this.nextCursorValue += bytes;
		this.currentBytes += bytes;
		this.currentNewlines += newlines;
		const last = this.chunks.at(-1);
		if (
			last &&
			last.end - last.start + bytes <= this.targetChunkBytes &&
			last.newlines + newlines <= this.targetChunkLines
		) {
			last.end = this.nextCursorValue;
			last.text += text;
			last.newlines += newlines;
			return;
		}
		this.chunks.push({ start, end: this.nextCursorValue, text, stream, newlines });
	}

	private logicalLineCount(): number {
		if (this.currentBytes === 0) return 0;
		return this.currentNewlines + (this.chunks.at(-1)?.text.endsWith("\n") ? 0 : 1);
	}

	private trimIfNeeded(): void {
		while (
			this.chunks.length > 1 &&
			(this.currentBytes > this.maximumBytes || this.logicalLineCount() > this.maximumLines)
		) {
			const removed = this.chunks.shift();
			if (!removed) break;
			const removedBytes = removed.end - removed.start;
			this.currentBytes -= removedBytes;
			this.currentNewlines -= removed.newlines;
			this.droppedBytesValue += removedBytes;
		}
		if (this.currentBytes <= this.maximumBytes && this.logicalLineCount() <= this.maximumLines) return;

		const chunk = this.chunks[0];
		if (!chunk) return;
		const retained = limitedSuffix(chunk.text, this.maximumLines, this.maximumBytes);
		const retainedBytes = utf8ByteLength(retained);
		const removedBytes = this.currentBytes - retainedBytes;
		this.droppedBytesValue += removedBytes;
		chunk.text = retained;
		chunk.start = chunk.end - retainedBytes;
		chunk.newlines = newlineCount(retained);
		this.currentBytes = retainedBytes;
		this.currentNewlines = chunk.newlines;
	}

}
