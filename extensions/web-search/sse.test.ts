import { describe, expect, test } from "bun:test";
import { readJsonSse } from "./sse.ts";

function response(body: string): Response {
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("readJsonSse", () => {
	test("parses CRLF, event names, multiline data, and EOF dispatch", async () => {
		const values: unknown[] = [];
		await readJsonSse(response(
			"event: first\r\ndata: {\"a\":\r\ndata: 1}\r\n\r\ndata: {\"b\":2}",
		), ({ event, data }) => values.push({ event, data }));
		expect(values).toEqual([
			{ event: "first", data: { a: 1 } },
			{ event: "", data: { b: 2 } },
		]);
	});

	test("rejects malformed JSON", async () => {
		await expect(readJsonSse(response("data: nope\n\n"), () => {})).rejects.toThrow("malformed JSON");
	});

	test("enforces stream and incremental event limits", async () => {
		await expect(readJsonSse(response(`data: ${JSON.stringify({ text: "x".repeat(100) })}\n\n`), () => {}, { maxEventBytes: 20 })).rejects.toThrow("event exceeded");
		await expect(readJsonSse(response(`data: ${JSON.stringify({ text: "x".repeat(100) })}\n\n`), () => {}, { maxStreamBytes: 20 })).rejects.toThrow("stream exceeded");
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: {\"text\":\"" + "x".repeat(30)));
				controller.enqueue(new TextEncoder().encode("x".repeat(30) + "\"}"));
				controller.close();
			},
		});
		await expect(readJsonSse(new Response(stream), () => {}, { maxEventBytes: 40 })).rejects.toThrow("event exceeded");
	});

	test("stops and cancels the reader when requested", async () => {
		let cancelled = false;
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: {\"done\":true}\n\n"));
			},
			cancel() { cancelled = true; },
		});
		await readJsonSse(new Response(stream), () => true);
		expect(cancelled).toBe(true);
	});
});
