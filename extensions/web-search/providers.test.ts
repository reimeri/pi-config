import { afterEach, describe, expect, test } from "vitest";
import { callProvider, providerKind } from "./providers.ts";

const originalFetch = globalThis.fetch;
const SEARCHED_AT = "2026-07-26T18:30:00.000Z";
const OPENAI_CODEX_TOKEN = [
	"eyJhbGciOiJub25lIn0",
	"eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF90ZXN0In19",
	"signature",
].join(".");
afterEach(() => { globalThis.fetch = originalFetch; });

function model(overrides: Record<string, unknown>) {
	return {
		id: "test-model",
		name: "Test Model",
		provider: "test-provider",
		api: "openai-responses",
		baseUrl: "https://api.example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		headers: {},
		...overrides,
	} as any;
}

function context(apiKey: string | undefined = "test-key", headers: Record<string, string | null> = {}, fallbackKey?: string) {
	return {
		modelRegistry: {
			async getApiKeyAndHeaders() { return { ok: true, apiKey, headers }; },
			async getApiKeyForProvider() { return fallbackKey; },
		},
	} as any;
}

function sse(events: unknown[]): Response {
	return new Response(events.map((data) => `data: ${JSON.stringify(data)}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("provider adapters", () => {
	test("detects only supported provider-native APIs", () => {
		expect(providerKind(model({ api: "google-generative-ai" }))).toBe("google");
		expect(providerKind(model({ api: "openai-codex-responses" }))).toBe("openai");
		expect(providerKind(model({ api: "anthropic-messages" }))).toBe("anthropic");
		expect(providerKind(model({ api: "openai-completions" }))).toBeUndefined();
	});

	test("normalizes OpenAI search events without retaining raw payloads", async () => {
		globalThis.fetch = async (url, init) => {
			expect(url).toBe("https://api.example.test/v1/responses");
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
			const body = JSON.parse(String(init?.body));
			expect(body.input).toContain(`Current date and time: ${SEARCHED_AT} (UTC)`);
			expect(body.input).toContain("do not loop on persistently ungrounded results");
			expect(body.tools).toEqual([{ type: "web_search" }]);
			expect(body.include).toEqual(["web_search_call.action.sources", "web_search_call.results"]);
			return sse([
				{ type: "response.web_search_call.searching", item_id: "ws1" },
				{ type: "response.output_item.done", item: { type: "web_search_call", id: "ws1", status: "completed", action: { type: "search", query: "docs", sources: [{ title: "Docs", url: "https://example.com/docs?utm_source=x" }] }, results: [{ type: "web_search_result", title: "API Guide", url: "https://example.com/guide?utm_medium=test", page_age: "2 days" }] } },
				{ type: "response.output_text.delta", delta: "Read docs" },
				{ type: "response.output_text.annotation.added", annotation: { type: "url_citation", end_index: 9, url: "https://example.com/docs", title: "Docs" } },
				{ type: "response.completed", response: { output: [] } },
			]);
		};
		const result = await callProvider(context(), model({}), { query: "docs", urls: [], searchedAt: SEARCHED_AT });
		expect(result.text).toBe("Read docs");
		expect(result.searchUsed).toBe(true);
		expect(result.queries).toEqual(["docs"]);
		expect(result.results[0]?.url).toBe("https://example.com/docs");
		expect(result.results.some((item) => item.title === "API Guide" && item.url === "https://example.com/guide" && item.source === "openai.web_search.results")).toBe(true);
		expect(result.citations[0]?.indexEncoding).toBe("utf16");
		expect(JSON.stringify(result)).not.toContain("utm_source");
	});

	test("propagates temporal context through OpenAI Codex input", async () => {
		globalThis.fetch = async (url, init) => {
			expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
			const headers = new Headers(init?.headers);
			expect(headers.get("chatgpt-account-id")).toBe("acct_test");
			const body = JSON.parse(String(init?.body));
			const prompt = body.input[0].content[0].text;
			expect(prompt).toContain(`Current date and time: ${SEARCHED_AT} (UTC)`);
			expect(prompt).toContain("Do not repeat a grounded search solely because");
			return sse([
				{ type: "response.output_text.delta", delta: "Recent Codex answer" },
				{ type: "response.done", response: { output: [] } },
			]);
		};
		const result = await callProvider(
			context(OPENAI_CODEX_TOKEN),
			model({ id: "gpt-5.5", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", reasoning: true }),
			{ query: "recent news", urls: [], searchedAt: SEARCHED_AT },
		);
		expect(result.text).toBe("Recent Codex answer");
	});

	test("preserves OpenAI api-key header authentication without adding Bearer auth", async () => {
		globalThis.fetch = async (_url, init) => {
			const headers = new Headers(init?.headers);
			expect(headers.get("api-key")).toBe("azure-key");
			expect(headers.get("authorization")).toBeNull();
			return sse([
				{ type: "response.output_text.delta", delta: "Authenticated" },
				{ type: "response.completed", response: { output: [] } },
			]);
		};
		const result = await callProvider(context(undefined, { "api-key": "azure-key" }), model({}), { query: "docs", urls: [] });
		expect(result.text).toBe("Authenticated");
	});

	test("honors resolved header-deletion markers", async () => {
		globalThis.fetch = async (_url, init) => {
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBeNull();
			expect(headers.get("api-key")).toBe("azure-key");
			return sse([
				{ type: "response.output_text.delta", delta: "Authenticated" },
				{ type: "response.completed", response: { output: [] } },
			]);
		};
		const result = await callProvider(
			context(undefined, { authorization: null, "api-key": "azure-key" }),
			model({ headers: { authorization: "Bearer placeholder" } }),
			{ query: "docs", urls: [] },
		);
		expect(result.text).toBe("Authenticated");
	});

	test("bounds and cancels HTTP error bodies", async () => {
		let cancelled = false;
		globalThis.fetch = async () => new Response(new ReadableStream({
			start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(20_000))); },
			cancel() { cancelled = true; },
		}), { status: 500 });
		let message = "";
		try {
			await callProvider(context(), model({}), { query: "docs", urls: [] });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("OpenAI API error (500)");
		expect(message.length).toBeLessThan(4_200);
		expect(cancelled).toBe(true);
	});

	test("rejects incomplete OpenAI responses", async () => {
		globalThis.fetch = async () => sse([
			{ type: "response.output_text.delta", delta: "Partial" },
			{ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] } },
		]);
		await expect(callProvider(context(), model({}), { query: "docs", urls: [] })).rejects.toThrow("max_output_tokens");
	});

	test("retains Anthropic OAuth compatibility headers", async () => {
		globalThis.fetch = async (_url, init) => {
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe("Bearer sk-ant-oat-test");
			const body = JSON.parse(String(init?.body));
			expect(body.messages[0].content).toContain(`Current date and time: ${SEARCHED_AT} (UTC)`);
			expect(headers.get("anthropic-beta")).toContain("claude-code-20250219");
			expect(headers.get("user-agent")).toBe("claude-cli/2.1.75");
			expect(headers.get("x-app")).toBe("cli");
			return sse([
				{ type: "content_block_start", content_block: { type: "server_tool_use", id: "srv1", name: "web_search", input: { query: "news" } } },
				{ type: "content_block_start", content_block: { type: "web_search_tool_result", tool_use_id: "srv1", content: [{ type: "web_search_result", title: "News", url: "https://example.com/news" }] } },
				{ type: "content_block_delta", delta: { type: "text_delta", text: "News answer" } },
			]);
		};
		const result = await callProvider(context("sk-ant-oat-test"), model({ api: "anthropic-messages", maxTokens: 12_000 }), { query: "news", urls: [], searchedAt: SEARCHED_AT });
		expect(result.text).toBe("News answer");
		expect(result.results[0]?.title).toBe("News");
	});

	test("propagates temporal context through Google search contents", async () => {
		globalThis.fetch = async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			const prompt = body.contents[0].parts[0].text;
			expect(prompt).toContain(`Current date and time: ${SEARCHED_AT} (UTC)`);
			expect(prompt).toContain("Do not repeat a grounded search solely because");
			expect(body.tools).toEqual([{ google_search: {} }]);
			return sse([{ candidates: [{ content: { parts: [{ text: "Recent Google answer" }] } }] }]);
		};
		const result = await callProvider(context(), model({ api: "google-generative-ai" }), { query: "recent news", urls: [], searchedAt: SEARCHED_AT });
		expect(result.text).toBe("Recent Google answer");
	});

	test("builds Google URL Context requests and captures retrieval status", async () => {
		globalThis.fetch = async (url, init) => {
			expect(url).toBe("https://api.example.test/v1/models/test-model:streamGenerateContent?alt=sse");
			expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("test-key");
			const body = JSON.parse(String(init?.body));
			const prompt = body.contents[0].parts[0].text;
			expect(prompt).toBe("summarize\n\nURLs:\nhttps://example.com/");
			expect(prompt).not.toContain("Current date and time:");
			expect(prompt).not.toContain("Do not repeat a grounded search");
			expect(body.tools).toEqual([{ url_context: {} }]);
			return sse([{ candidates: [{ content: { parts: [{ text: "Summary" }] }, urlContextMetadata: { urlMetadata: [{ retrievedUrl: "https://example.com/", urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS" }] } }] }]);
		};
		const result = await callProvider(context(), model({ api: "google-generative-ai" }), { query: "summarize", urls: ["https://example.com"], urlContextOnly: true });
		expect(result.text).toBe("Summary");
		expect(result.retrievedUrls).toEqual(["https://example.com/"]);
	});
});
