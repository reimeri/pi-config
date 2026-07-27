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

  it("clones a value reached twice rather than calling it circular", () => {
    const shared = { uri: "file:///a.ts", version: 3 };
    const details = { ...baseDetails("shared", "ok", Date.now()), locations: [{ target: shared }, { target: shared }] };
    const result = envelope("ok", details) as any;
    expect(result.details.locations[0].target).toEqual(shared);
    expect(result.details.locations[1].target).toEqual(shared);
    expect(result.details.truncated).toBe(false);
    expect(result.details.warnings).toEqual([]);
  });

  it("still omits a genuine cycle", () => {
    const node: Record<string, unknown> = { name: "root" };
    node.self = node;
    const result = envelope("ok", { ...baseDetails("cycle", "ok", Date.now()), node }) as any;
    expect(result.details.node.self).toBe("[omitted: circular value]");
    expect(result.details.truncated).toBe(true);
  });
});
