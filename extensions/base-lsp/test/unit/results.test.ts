import { describe, expect, it } from "vitest";
import { baseDetails, envelope } from "../../src/tools/results.js";

describe("tool result bounds", () => {
  it("bounds structured details as well as rendered text", () => {
    const details = { ...baseDetails("stress", "ok", Date.now()), payload: Array.from({ length: 2_000 }, (_, index) => ({ index, text: "x".repeat(5_000), nested: { data: "y".repeat(5_000) } })) };
    const result = envelope("ok", details);
    expect(Buffer.byteLength(JSON.stringify(result.details))).toBeLessThanOrEqual(50 * 1024);
    expect(result.details.truncated).toBe(true);
    expect(result.details.warnings.length).toBeGreaterThan(0);
  });
});
