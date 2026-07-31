import { describe, expect, test } from "vitest";
import { validateSafeRegex } from "./readiness.ts";

function accepts(pattern: string): boolean {
	try {
		validateSafeRegex(pattern);
		return true;
	} catch {
		return false;
	}
}

describe("validateSafeRegex", () => {
	test("accepts the readiness patterns servers actually need", () => {
		for (const pattern of [
			"Compiled successfully",
			"\\d{1,6}",
			"listening on port \\d{1,5}",
			"Server started.{0,20}port",
			"ready.?now",
			"^Local:.{0,40}http://localhost:\\d{2,5}$",
			"[a-z]{1,20} ready",
		]) {
			expect(accepts(pattern)).toBe(true);
		}
	});

	test("rejects the structural constructs it always has", () => {
		expect(accepts("a*")).toBe(false);
		expect(accepts("a+")).toBe(false);
		expect(accepts("(a|b)")).toBe(false);
		expect(accepts("a{1,}")).toBe(false);
		expect(accepts("(a)\\1")).toBe(false);
		expect(accepts("a".repeat(1001))).toBe(false);
	});

	// Adjacent bounded quantifiers evade structural checks but can backtrack catastrophically.
	test("rejects patterns whose bounded quantifiers multiply", () => {
		expect(accepts(".{1,900}.{1,900}x")).toBe(false);
		expect(accepts("[a-z]{1,1000}[a-z]{1,1000}!")).toBe(false);
		expect(accepts(`${".?".repeat(20)}x`)).toBe(false);
	});

	test("charges the budget by range width, not by range maximum", () => {
		// 100 * 10 == 1000, at the limit; 100 * 11 is over it.
		expect(accepts("a{1,100}b{1,10}")).toBe(true);
		expect(accepts("a{1,100}b{1,11}")).toBe(false);
		// Fixed repeats have one alternative and add no backtracking cost.
		expect(accepts("a{500}b{500}c{500}")).toBe(true);
	});

	test("rejects an inverted range instead of trusting its arithmetic", () => {
		expect(accepts("a{5,2}")).toBe(false);
	});

	test("still caps the maximum match width to the chunk overlap", () => {
		expect(accepts("a{1000}b{1000}c{1000}")).toBe(false);
	});

	test("worst accepted pattern stays fast over a full window", () => {
		const pattern = "a{1,100}b{1,10}";
		expect(accepts(pattern)).toBe(true);
		const startedAt = performance.now();
		new RegExp(pattern).test("a".repeat(64 * 1024));
		expect(performance.now() - startedAt).toBeLessThan(1000);
	});
});
