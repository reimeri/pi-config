export interface SseEvent {
	event: string;
	data: unknown;
}

export interface ReadSseOptions {
	signal?: AbortSignal;
	maxEventBytes?: number;
	maxStreamBytes?: number;
}

const DEFAULT_MAX_EVENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_STREAM_BYTES = 20 * 1024 * 1024;

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

export async function readJsonSse(
	response: Response,
	onEvent: (event: SseEvent) => boolean | void | Promise<boolean | void>,
	options: ReadSseOptions = {},
): Promise<void> {
	if (!response.body) throw new Error("Provider returned no response body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
	const maxStreamBytes = options.maxStreamBytes ?? DEFAULT_MAX_STREAM_BYTES;
	/** Keep line fragments separate so large streamed lines are joined only once. */
	let pending: string[] = [];
	/** Track pending bytes incrementally. */
	let pendingBytes = 0;
	let eventName = "";
	let dataLines: string[] = [];
	let eventBytes = 0;
	let totalBytes = 0;
	let reachedEof = false;

	const dispatch = async (): Promise<boolean> => {
		if (dataLines.length === 0) {
			eventName = "";
			return false;
		}
		const raw = dataLines.join("\n").trim();
		dataLines = [];
		eventBytes = 0;
		const currentName = eventName;
		eventName = "";
		if (!raw || raw === "[DONE]") return false;
		if (byteLength(raw) > maxEventBytes) throw new Error("Provider SSE event exceeded the size limit");
		let data: unknown;
		try {
			data = JSON.parse(raw);
		} catch {
			throw new Error("Provider returned malformed JSON in its SSE stream");
		}
		return (await onEvent({ event: currentName, data })) === true;
	};

	/** Complete a line using CRLF semantics; lone CR is data. */
	const takeLine = (tail: string): string => {
		const line = pending.length === 0 ? tail : pending.join("") + tail;
		pending = [];
		pendingBytes = 0;
		return line.endsWith("\r") ? line.slice(0, -1) : line;
	};

	/** Returns true when the consumer asked to stop. */
	const handleLine = async (line: string): Promise<boolean> => {
		if (line === "") return await dispatch();
		if (line.startsWith("data:")) {
			const data = line.slice(5).trimStart();
			eventBytes += byteLength(data) + (dataLines.length > 0 ? 1 : 0);
			if (eventBytes > maxEventBytes) throw new Error("Provider SSE event exceeded the size limit");
			dataLines.push(data);
		} else if (line.startsWith("event:")) {
			eventName = line.slice(6).trim();
		}
		return false;
	};

	try {
		while (true) {
			if (options.signal?.aborted) throw options.signal.reason ?? new Error("Request was aborted");
			const { done, value } = await reader.read();
			if (done) {
				reachedEof = true;
				const flushed = decoder.decode();
				if (flushed) {
					pending.push(flushed);
					pendingBytes += byteLength(flushed);
				}
				break;
			}
			totalBytes += value.byteLength;
			if (totalBytes > maxStreamBytes) throw new Error("Provider SSE stream exceeded the size limit");
			const decoded = decoder.decode(value, { stream: true });
			pendingBytes += byteLength(decoded);
			if (pendingBytes + eventBytes > maxEventBytes) {
				throw new Error("Provider SSE event exceeded the size limit");
			}
			let lineStart = 0;
			let newline = decoded.indexOf("\n");
			while (newline !== -1) {
				if (await handleLine(takeLine(decoded.slice(lineStart, newline)))) return;
				lineStart = newline + 1;
				newline = decoded.indexOf("\n", lineStart);
			}
			if (lineStart > 0) {
				const tail = decoded.slice(lineStart);
				pending = tail ? [tail] : [];
				pendingBytes = byteLength(tail);
			} else {
				pending.push(decoded);
			}
		}
		const trailing = takeLine("");
		if (trailing) await handleLine(trailing);
		await dispatch();
	} finally {
		if (!reachedEof) {
			try {
				await reader.cancel();
			} catch {
				// Ignore cleanup failure.
			}
		}
		reader.releaseLock();
	}
}

export function deadlineSignal(signal: AbortSignal | undefined, timeoutMs = 120_000): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
