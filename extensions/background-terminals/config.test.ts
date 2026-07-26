import { expect, test } from "bun:test";
import { loadBackgroundTerminalConfig } from "./config.ts";

const ENV_NAME = "PI_BACKGROUND_TERMINAL_READY_TIMEOUT_MS";

test("readiness timeout defaults to 10 seconds and never configures above 60 seconds", () => {
	const previous = process.env[ENV_NAME];
	try {
		delete process.env[ENV_NAME];
		expect(loadBackgroundTerminalConfig().defaultReadinessTimeoutMs).toBe(10_000);

		process.env[ENV_NAME] = "60000";
		expect(loadBackgroundTerminalConfig().defaultReadinessTimeoutMs).toBe(60_000);

		process.env[ENV_NAME] = "60001";
		expect(loadBackgroundTerminalConfig().defaultReadinessTimeoutMs).toBe(10_000);
	} finally {
		if (previous === undefined) delete process.env[ENV_NAME];
		else process.env[ENV_NAME] = previous;
	}
});
