import {
	DynamicBorder,
	keyHint,
	rawKeyHint,
	type ExtensionUIContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Focusable,
	Input,
	type KeybindingsManager,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import type {
	AskUserDialogOptions,
	AskUserSelectOption,
	AskUserUI,
} from "./flow.ts";

function styleOption(option: AskUserSelectOption, selected: boolean, theme: Theme): string {
	const ranges = [...(option.mutedRanges ?? [])]
		.map(({ start, end }) => ({
			start: Math.max(0, Math.min(option.value.length, start)),
			end: Math.max(0, Math.min(option.value.length, end)),
		}))
		.filter(({ start, end }) => end > start)
		.sort((left, right) => left.start - right.start);
	const normalColor = selected ? "accent" : "text";
	let cursor = 0;
	let output = "";

	for (const range of ranges) {
		const start = Math.max(cursor, range.start);
		if (start > cursor) output += theme.fg(normalColor, option.value.slice(cursor, start));
		if (range.end > start) output += theme.fg("muted", option.value.slice(start, range.end));
		cursor = Math.max(cursor, range.end);
	}
	if (cursor < option.value.length) output += theme.fg(normalColor, option.value.slice(cursor));
	return output;
}

class AskUserSelector extends Container {
	private selectedIndex = 0;

	constructor(
		private readonly title: string,
		private readonly options: AskUserSelectOption[],
		private readonly cancelLabel: AskUserDialogOptions["cancelLabel"],
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly requestRender: () => void,
		private readonly onSelect: (value: string) => void,
		private readonly onCancel: () => void,
	) {
		super();
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new DynamicBorder((text: string) => this.theme.fg("border", text)));
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.theme.fg("accent", this.theme.bold(this.title)), 1, 0));
		this.addChild(new Spacer(1));
		for (let index = 0; index < this.options.length; index++) {
			const selected = index === this.selectedIndex;
			const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
			this.addChild(new Text(`${prefix}${styleOption(this.options[index]!, selected, this.theme)}`, 1, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				`${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "select")}  ${keyHint(
					"tui.select.cancel",
					this.cancelLabel,
				)}`,
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((text: string) => this.theme.fg("border", text)));
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.rebuild();
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			this.rebuild();
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm") || data === "\n") {
			const selected = this.options[this.selectedIndex];
			if (selected) this.onSelect(selected.value);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) this.onCancel();
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}
}

class AskUserInput extends Container implements Focusable {
	private readonly input = new Input();
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		private readonly title: string,
		private readonly placeholder: string | undefined,
		private readonly cancelLabel: AskUserDialogOptions["cancelLabel"],
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly requestRender: () => void,
		private readonly onSubmit: (value: string) => void,
		private readonly onCancel: () => void,
	) {
		super();
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new DynamicBorder((text: string) => this.theme.fg("border", text)));
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.theme.fg("accent", this.title), 1, 0));
		this.addChild(new Spacer(1));
		if (this.placeholder && this.input.getValue() === "") {
			this.addChild(new Text(this.theme.fg("dim", this.placeholder), 1, 0));
		}
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				`${keyHint("tui.select.confirm", "submit")}  ${keyHint("tui.select.cancel", this.cancelLabel)}`,
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((text: string) => this.theme.fg("border", text)));
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.confirm") || data === "\n") {
			this.onSubmit(this.input.getValue());
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel();
			return;
		}
		this.input.handleInput(data);
		this.rebuild();
		this.requestRender();
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}
}

async function showAbortableDialog<T>(
	ui: ExtensionUIContext,
	signal: AbortSignal | undefined,
	create: (
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (value: T | undefined) => void,
	) => AskUserSelector | AskUserInput,
): Promise<T | undefined> {
	if (signal?.aborted) return undefined;
	let close: ((value: T | undefined) => void) | undefined;
	const onAbort = () => close?.(undefined);
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		return await ui.custom<T | undefined>((tui, theme, keybindings, done) => {
			close = done;
			const component = create(tui, theme, keybindings, done);
			if (signal?.aborted) done(undefined);
			return component;
		});
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

export function createAskUserUI(ui: ExtensionUIContext, customDialogs: boolean): AskUserUI {
	if (!customDialogs) {
		return {
			select: async (title, options, opts) =>
				ui.select(
					title,
					options.map((option) => option.value),
					{ signal: opts.signal },
				),
			input: (title, placeholder, opts) => ui.input(title, placeholder, { signal: opts.signal }),
		};
	}

	return {
		select: (title, options, opts) =>
			showAbortableDialog<string>(ui, opts.signal, (tui, theme, keybindings, done) =>
				new AskUserSelector(
					title,
					options,
					opts.cancelLabel,
					theme,
					keybindings,
					() => tui.requestRender(),
					done,
					() => done(undefined),
				),
			),
		input: (title, placeholder, opts) =>
			showAbortableDialog<string>(ui, opts.signal, (tui, theme, keybindings, done) =>
				new AskUserInput(
					title,
					placeholder,
					opts.cancelLabel,
					theme,
					keybindings,
					() => tui.requestRender(),
					done,
					() => done(undefined),
				),
			),
	};
}
