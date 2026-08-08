import { expect, test, vi } from "vitest";
import "./test-runtime.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const { default: backgroundTerminalsExtension, formatBackgroundCount } = await import("./index.ts");

type Handler = (event: any, ctx: any) => any;

function setup() {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, any>();
	const pi = {
		on(event: string, handler: Handler) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		registerCommand: vi.fn(),
	} as unknown as ExtensionAPI;
	backgroundTerminalsExtension(pi);

	const setStatus = vi.fn();
	const ctx = {
		mode: "tui",
		cwd: process.cwd(),
		ui: { setStatus },
		sessionManager: {
			getSessionId: () => "session-test",
			getSessionFile: () => undefined,
		},
		model: undefined,
		thinkingLevel: undefined,
	};

	return { handlers, tools, setStatus, ctx };
}

async function emit(state: ReturnType<typeof setup>, event: string): Promise<void> {
	for (const handler of state.handlers.get(event) ?? []) {
		await handler({ reason: event === "session_shutdown" ? "quit" : "startup" }, state.ctx);
	}
}

test("formats only nonzero background counts", () => {
	expect(formatBackgroundCount(0)).toBeUndefined();
	expect(formatBackgroundCount(1)).toBe("background: 1");
	expect(formatBackgroundCount(3)).toBe("background: 3");
});

test("shows the running count in the footer and clears it on shutdown", async () => {
	const state = setup();
	await emit(state, "session_start");
	try {
		expect(state.setStatus).toHaveBeenLastCalledWith("background-terminals", undefined);

		await state.tools.get("background_start").execute(
			"call-1",
			{ command: "sleep 30" },
			undefined,
			undefined,
			state.ctx,
		);
		expect(state.setStatus).toHaveBeenLastCalledWith("background-terminals", "background: 1");
	} finally {
		await emit(state, "session_shutdown");
	}
	expect(state.setStatus).toHaveBeenLastCalledWith("background-terminals", undefined);
});

test("clears the footer count after a background process exits naturally", async () => {
	const state = setup();
	await emit(state, "session_start");
	try {
		await state.tools.get("background_start").execute(
			"call-1",
			{ command: "sleep 0.05" },
			undefined,
			undefined,
			state.ctx,
		);
		expect(state.setStatus).toHaveBeenCalledWith("background-terminals", "background: 1");

		await vi.waitFor(() => {
			expect(state.setStatus).toHaveBeenLastCalledWith("background-terminals", undefined);
		});
	} finally {
		await emit(state, "session_shutdown");
	}
});
