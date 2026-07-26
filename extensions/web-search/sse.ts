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
	return new TextEncoder().encode(value).byteLength;
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
	let buffer = "";
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

	try {
		while (true) {
			if (options.signal?.aborted) throw options.signal.reason ?? new Error("Request was aborted");
			const { done, value } = await reader.read();
			if (done) {
				reachedEof = true;
				buffer += decoder.decode();
				break;
			}
			totalBytes += value.byteLength;
			if (totalBytes > maxStreamBytes) throw new Error("Provider SSE stream exceeded the size limit");
			buffer += decoder.decode(value, { stream: true });
			if (byteLength(buffer) + eventBytes > maxEventBytes) {
				throw new Error("Provider SSE event exceeded the size limit");
			}
			const lines = buffer.split(/\r?\n/u);
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (line === "") {
					if (await dispatch()) return;
				} else if (line.startsWith("data:")) {
					const data = line.slice(5).trimStart();
					eventBytes += byteLength(data) + (dataLines.length > 0 ? 1 : 0);
					if (eventBytes > maxEventBytes) throw new Error("Provider SSE event exceeded the size limit");
					dataLines.push(data);
				} else if (line.startsWith("event:")) {
					eventName = line.slice(6).trim();
				}
			}
		}
		if (buffer) {
			if (buffer.startsWith("data:")) {
				const data = buffer.slice(5).trimStart();
				eventBytes += byteLength(data) + (dataLines.length > 0 ? 1 : 0);
				if (eventBytes > maxEventBytes) throw new Error("Provider SSE event exceeded the size limit");
				dataLines.push(data);
			} else if (buffer.startsWith("event:")) eventName = buffer.slice(6).trim();
		}
		await dispatch();
	} finally {
		if (!reachedEof) {
			try {
				await reader.cancel();
			} catch {
				// Best-effort stream cleanup.
			}
		}
		reader.releaseLock();
	}
}

export function deadlineSignal(signal: AbortSignal | undefined, timeoutMs = 120_000): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
