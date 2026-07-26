import { describe, expect, mock, test } from "bun:test";
import type { ProviderResult } from "./types.ts";

mock.module("@earendil-works/pi-coding-agent", () => ({
	DEFAULT_MAX_BYTES: 50 * 1024,
	DEFAULT_MAX_LINES: 2_000,
	truncateHead(text: string, options: { maxLines: number; maxBytes: number }) {
		const lines = text.split("\n");
		let content = lines.slice(0, options.maxLines).join("\n");
		let truncated = lines.length > options.maxLines;
		while (Buffer.byteLength(content) > options.maxBytes) {
			content = content.slice(0, -1);
			truncated = true;
		}
		return { content, truncated };
	},
}));
import {
	buildWebSearchPrompt,
	WEB_SEARCH_TEMPORAL_GUIDELINE,
	webSearchContext,
} from "./temporal.ts";

const SEARCHED_AT = "2026-07-26T18:30:00.000Z";

describe("web search temporal context", () => {
	test("adds the timestamp and bounded verification guidance to provider prompts", () => {
		const prompt = buildWebSearchPrompt("What happened today?", ["https://example.com/news"], SEARCHED_AT);
		expect(prompt).toContain(`Current date and time: ${SEARCHED_AT} (UTC)`);
		expect(prompt).toContain("Use this as the reference point for relative dates and recent events");
		expect(prompt).toContain("Do not repeat a grounded search solely because");
		expect(prompt).toContain("do not loop on persistently ungrounded results");
		expect(prompt).toContain("Also analyze these public URLs:\nhttps://example.com/news");
	});

	test("preserves one timestamp across the provider prompt, truncated visible output, and details", async () => {
		const prompt = buildWebSearchPrompt("What happened today?", [], SEARCHED_AT);
		const providerResult: ProviderResult = {
			text: "x".repeat(100_000),
			provider: "openai",
			searchUsed: false,
			events: [],
			calls: [],
			queries: [],
			results: [],
			citations: [],
			retrievedUrls: [],
			failedUrls: [],
		};
		const { formatProviderResult } = await import("./format.ts");
		const formatted = formatProviderResult(providerResult, "gpt-test", SEARCHED_AT);
		expect(prompt).toContain(`Current date and time: ${SEARCHED_AT} (UTC)`);
		expect(formatted.text).toStartWith(`## Web Search Context\nSearch performed at ${SEARCHED_AT}.`);
		expect(formatted.text).toContain("[Answer truncated;");
		expect(formatted.details.searchedAt).toBe(SEARCHED_AT);
	});

	test("provides calling-agent guidance for post-cutoff dates", () => {
		expect(WEB_SEARCH_TEMPORAL_GUIDELINE).toContain("Use web_search's search timestamp as the temporal reference");
		expect(WEB_SEARCH_TEMPORAL_GUIDELINE).toContain("Do not repeat a grounded search solely because");
		expect(WEB_SEARCH_TEMPORAL_GUIDELINE).toContain("do not loop on persistently ungrounded results");
		expect(webSearchContext(SEARCHED_AT)).toContain(`Search performed at ${SEARCHED_AT}`);
	});
});
