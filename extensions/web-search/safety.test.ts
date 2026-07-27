import { describe, expect, test } from "vitest";
import {
	assertSafeBaseUrl,
	escapeMarkdown,
	markdownLink,
	normalizeInputUrls,
	normalizePublicUrl,
	normalizeQuery,
	safeProviderUrl,
} from "./safety.ts";

describe("URL and output safety", () => {
	test("normalizes public URLs and removes tracking", () => {
		expect(normalizePublicUrl("https://Example.com/docs?utm_source=x&a=1#part")).toBe("https://example.com/docs?a=1");
		expect(normalizeInputUrls(["https://example.com", "https://example.com/"])).toEqual(["https://example.com/"]);
	});

	test("rejects unsafe URL forms", () => {
		for (const url of [
			"javascript:alert(1)",
			"file:///etc/passwd",
			"https://user:password@example.com/",
			"http://localhost:3000/",
			"http://127.0.0.1/",
			"http://10.1.2.3/",
			"http://192.168.1.1/",
			"http://[::1]/",
			"http://[::ffff:7f00:1]/",
			"http://[::ffff:a00:1]/",
		]) expect(() => normalizePublicUrl(url)).toThrow();
		expect(safeProviderUrl("data:text/plain,hello")).toBeUndefined();
	});

	test("bounds and cleans queries", () => {
		expect(normalizeQuery("  hello\u0000 world  ")).toBe("hello  world");
		expect(() => normalizeQuery("   ")).toThrow("blank");
	});

	test("escapes Markdown labels and destinations", () => {
		expect(escapeMarkdown("[x](y)\\z")).toBe("\\[x\\]\\(y\\)\\\\z");
		expect(markdownLink({ title: "[click](bad)", url: "https://example.com/a%3Eb" })).toBe("[\\[click\\]\\(bad\\)](<https://example.com/a%3Eb>)");
	});

	test("requires secure remote model endpoints", () => {
		expect(assertSafeBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
		expect(assertSafeBaseUrl("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080/v1");
		expect(() => assertSafeBaseUrl("http://api.example.com/v1")).toThrow("HTTPS");
	});
});
