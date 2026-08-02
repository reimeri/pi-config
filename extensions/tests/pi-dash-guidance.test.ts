import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import piDashGuidance, {
	isPiDashManagedEnvironment,
	PI_DASH_WORKTREE_GUIDANCE,
} from "../pi-dash-guidance.ts";

const VALID_ENV = {
	PI_DASH_WORKTREE_ID: "e50d4ed3-baa5-4530-bd06-fb36849c0843",
	PI_DASH_RUNTIME_ID: "c50d4ed3-baa5-4530-bd06-fb36849c0843",
	PI_DASH_STATUS_SOCKET: "/run/user/1000/pi-dash/status.sock",
	PI_DASH_STATUS_TOKEN: "a".repeat(32),
};

afterEach(() => {
	vi.unstubAllEnvs();
});

function registeredHandler() {
	let handler: ((event: { systemPrompt: string }) => unknown) | undefined;
	const pi = {
		on(event: string, candidate: typeof handler) {
			if (event === "before_agent_start") handler = candidate;
		},
	} as unknown as ExtensionAPI;
	piDashGuidance(pi);
	if (!handler) throw new Error("before_agent_start handler was not registered");
	return handler;
}

describe("Pi Dash guidance", () => {
	test("recognizes the complete managed runtime environment", () => {
		expect(isPiDashManagedEnvironment(VALID_ENV)).toBe(true);
		expect(isPiDashManagedEnvironment({ ...VALID_ENV, PI_DASH_RUNTIME_ID: "invalid" })).toBe(false);
		expect(isPiDashManagedEnvironment({ ...VALID_ENV, PI_DASH_STATUS_TOKEN: undefined })).toBe(false);
	});

	test("adds managed worktree guidance inside Pi Dash", () => {
		for (const [name, value] of Object.entries(VALID_ENV)) vi.stubEnv(name, value);
		const result = registeredHandler()({ systemPrompt: "base prompt" }) as {
			systemPrompt: string;
		};
		expect(result.systemPrompt).toBe(`base prompt\n\n${PI_DASH_WORKTREE_GUIDANCE}`);
		expect(result.systemPrompt).toContain("If a matching pull request is open");
	});

	test("does not add guidance outside Pi Dash", () => {
		for (const name of Object.keys(VALID_ENV)) vi.stubEnv(name, "");
		expect(registeredHandler()({ systemPrompt: "base prompt" })).toBeUndefined();
	});

	test("does not duplicate guidance already added by another instance", () => {
		for (const [name, value] of Object.entries(VALID_ENV)) vi.stubEnv(name, value);
		expect(
			registeredHandler()({ systemPrompt: `base prompt\n\n${PI_DASH_WORKTREE_GUIDANCE}` }),
		).toBeUndefined();
	});
});
