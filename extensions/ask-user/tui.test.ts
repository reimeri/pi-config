import { initTheme, type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	type Component,
	type KeybindingsManager,
	type TUI,
} from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { createAskUserUI } from "./tui.ts";

initTheme("dark", false);

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

type CustomFactory = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (value: unknown) => void,
) => Component;

function createCustomDialogHarness() {
	let component: Component | undefined;
	let resolveDialog: ((value: unknown) => void) | undefined;
	const tui = { requestRender: vi.fn() } as unknown as TUI;
	const ui = {
		custom: vi.fn(
			async (factory: CustomFactory) =>
				new Promise((resolve) => {
					resolveDialog = resolve;
					component = factory(tui, theme, getKeybindings(), resolve);
				}),
		),
	} as unknown as ExtensionUIContext;

	return {
		ui,
		getComponent: () => {
			if (!component) throw new Error("Custom dialog was not created");
			return component;
		},
		resolveDialog: (value: unknown) => resolveDialog?.(value),
	};
}

describe("createAskUserUI", () => {
	test("custom editor inserts newlines and submits the complete answer", async () => {
		const harness = createCustomDialogHarness();
		const answerPromise = createAskUserUI(harness.ui, true).editor("Question", "Type your answer", {
			cancelLabel: "cancel",
		});
		const component = harness.getComponent();

		for (const character of "First line") component.handleInput?.(character);
		component.handleInput?.("\n");
		for (const character of "Second line") component.handleInput?.(character);
		component.handleInput?.("\r");

		await expect(answerPromise).resolves.toBe("First line\nSecond line");
	});

	test("non-TUI dialogs retain abortable free-form input", async () => {
		const controller = new AbortController();
		const input = vi.fn(
			(_title: string, _placeholder: string | undefined, opts: { signal?: AbortSignal }) =>
				new Promise<string | undefined>((resolve) => {
					opts.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
				}),
		);
		const ui = { input } as unknown as ExtensionUIContext;
		const answerPromise = createAskUserUI(ui, false).editor("Question", "Type your answer", {
			cancelLabel: "cancel",
			signal: controller.signal,
		});

		controller.abort();

		await expect(answerPromise).resolves.toBeUndefined();
		expect(input).toHaveBeenCalledWith("Question", "Type your answer", { signal: controller.signal });
	});
});
