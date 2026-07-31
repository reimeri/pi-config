import { describe, expect, test } from "vitest";
import { shouldRestoreEnabled, type LoadedState } from "./index.ts";

const enabledState: LoadedState = {
	status: "valid",
	state: { version: 1, enabled: true, toolsBeforeQuarantine: ["read", "bash", "edit"] },
};
const disabledState: LoadedState = {
	status: "valid",
	state: { version: 1, enabled: false, restoredTools: ["read", "bash", "edit"] },
};

describe("shouldRestoreEnabled", () => {
	test("restores quarantine when the coordinator entry records it", () => {
		expect(shouldRestoreEnabled(disabledState, { activeModeIds: ["quarantine"] }, false)).toBe(true);
	});

	test("stays disabled when neither source records quarantine", () => {
		expect(shouldRestoreEnabled(disabledState, { activeModeIds: ["plan"] }, false)).toBe(false);
	});

	test("follows the legacy entry when no coordinator entry exists", () => {
		expect(shouldRestoreEnabled(enabledState, undefined, true)).toBe(true);
		expect(shouldRestoreEnabled(disabledState, undefined, false)).toBe(false);
	});

	// Legacy-only activation must override stale coordinator state on resume.
	test("keeps quarantine on when only the legacy entry records it", () => {
		expect(shouldRestoreEnabled(enabledState, { activeModeIds: [] }, true)).toBe(true);
		expect(shouldRestoreEnabled(enabledState, { activeModeIds: ["plan"] }, true)).toBe(true);
	});

	test("fails closed on unparseable state regardless of the coordinator entry", () => {
		expect(shouldRestoreEnabled({ status: "invalid" }, { activeModeIds: [] }, false)).toBe(true);
		expect(shouldRestoreEnabled({ status: "invalid" }, undefined, false)).toBe(true);
	});

	test("treats a fresh session with no state as disabled", () => {
		expect(shouldRestoreEnabled({ status: "none" }, undefined, false)).toBe(false);
	});
});
