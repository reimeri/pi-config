import { describe, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import worktreeExtension from "./index.ts";

describe("worktree extension registration", () => {
	test("registers one slash command and no model-callable tools", () => {
		const commands: Array<{ name: string; options: unknown }> = [];
		const registerTool = vi.fn();
		const on = vi.fn();
		const pi = {
			registerCommand(name: string, options: unknown) {
				commands.push({ name, options });
			},
			registerTool,
			on,
		} as unknown as ExtensionAPI;
		worktreeExtension(pi);
		expect(commands).toHaveLength(1);
		expect(commands[0]?.name).toBe("worktree");
		expect(commands[0]?.options).toMatchObject({ description: expect.any(String), handler: expect.any(Function) });
		expect(registerTool).not.toHaveBeenCalled();
		expect(on).not.toHaveBeenCalled();
	});
});
