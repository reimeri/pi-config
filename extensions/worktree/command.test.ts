import { describe, expect, test } from "vitest";
import { parseWorktreeArguments } from "./command.ts";

describe("parseWorktreeArguments", () => {
	test("parses list and branch forms", () => {
		expect(parseWorktreeArguments("")).toEqual({ ok: true, value: { mode: "list" } });
		expect(parseWorktreeArguments("list")).toEqual({ ok: true, value: { mode: "list" } });
		expect(parseWorktreeArguments("feature/auth")).toEqual({ ok: true, value: { mode: "open", branch: "feature/auth" } });
		expect(parseWorktreeArguments("feature/auth --from main")).toEqual({
			ok: true,
			value: { mode: "open", branch: "feature/auth", startRef: "main" },
		});
		expect(parseWorktreeArguments("feature/auth --from=origin/main")).toEqual({
			ok: true,
			value: { mode: "open", branch: "feature/auth", startRef: "origin/main" },
		});
	});

	test("rejects malformed options", () => {
		expect(parseWorktreeArguments("feature --from")).toMatchObject({ ok: false });
		expect(parseWorktreeArguments("feature --from main --from other")).toMatchObject({ ok: false });
		expect(parseWorktreeArguments("feature --unknown")).toMatchObject({ ok: false });
		expect(parseWorktreeArguments("list --from main")).toMatchObject({ ok: false });
	});
});
