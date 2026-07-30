import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("typebox", () => ({
	Type: {
		Object: (shape: unknown) => shape,
		String: (options: unknown) => options,
	},
}));

vi.mock("@earendil-works/pi-tui", () => ({
	truncateToWidth: (text: string, width: number, ellipsis = "…") =>
		text.length <= width ? text : `${text.slice(0, Math.max(0, width - ellipsis.length))}${ellipsis}`,
	visibleWidth: (text: string) => text.length,
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		CustomEditor: class {
			borderColor = (text: string) => text;

			constructor(..._args: unknown[]) {}

			render(width: number): string[] {
				const border = "─".repeat(width);
				return [this.borderColor(border), this.borderColor(border)];
			}
		},
	};
});

class FakeEventBus {
	private readonly listeners = new Map<string, Array<(data: unknown) => void>>();

	on(event: string, handler: (data: unknown) => void): () => void {
		const handlers = this.listeners.get(event) ?? [];
		handlers.push(handler);
		this.listeners.set(event, handlers);
		return () => this.listeners.set(event, handlers.filter((item) => item !== handler));
	}

	emit(event: string, data: unknown): void {
		for (const handler of this.listeners.get(event) ?? []) handler(data);
	}
}

beforeEach(() => {
	vi.resetModules();
});

describe("current task editor mode colors", () => {
	test("renders thinkingLow modes in dim blue and preserves alert-color precedence", async () => {
		const { default: currentTaskExtension } = await import("../current-task.ts");
		const events = new FakeEventBus();
		const handlers = new Map<string, Array<(event: unknown, ctx: any) => void>>();
		let editorFactory: ((tui: any, theme: any, keybindings: any) => any) | undefined;
		const pi = {
			events,
			on: (event: string, handler: (event: unknown, ctx: any) => void) => {
				const current = handlers.get(event) ?? [];
				current.push(handler);
				handlers.set(event, current);
			},
			registerTool: vi.fn(),
			registerCommand: vi.fn(),
			getSessionName: () => "Color test",
			setSessionName: vi.fn(),
		} as unknown as ExtensionAPI;
		const ctx = {
			mode: "tui",
			ui: {
				theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
				setEditorComponent: (factory: typeof editorFactory) => {
					editorFactory = factory;
				},
			},
		};

		currentTaskExtension(pi);
		handlers.get("session_start")?.[0]?.({}, ctx);
		const editor = editorFactory?.({ requestRender: vi.fn() }, {}, {});
		expect(editor).toBeDefined();

		events.emit("editor-top-bar:mode", {
			id: "supervisor",
			label: "◆ supervisor",
			borderColor: "thinkingLow",
		});
		const thinkingLowLines = editor.render(40);
		expect(thinkingLowLines.every((line: string) => line.includes("<thinkingLow>"))).toBe(true);

		events.emit("editor-top-bar:mode", {
			id: "plan-mode",
			label: "⏸️ plan",
			borderColor: "warning",
		});
		const warningLines = editor.render(40);
		expect(warningLines.every((line: string) => line.includes("<warning>"))).toBe(true);

		events.emit("editor-top-bar:mode", {
			id: "quarantine",
			label: "⚠ quarantine",
			borderColor: "error",
		});
		const errorLines = editor.render(40);
		expect(errorLines.every((line: string) => line.includes("<error>"))).toBe(true);
	});
});
