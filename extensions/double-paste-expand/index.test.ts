import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import doublePasteExpandExtension from "./index.ts";
import {
	BRACKETED_PASTE_END,
	BRACKETED_PASTE_START,
	cleanPastedText,
	DoublePasteEditor,
	isLargePaste,
	isMouseInput,
} from "./core.ts";

const MARKER = /\[paste #(\d+)(?: (?:\+\d+ lines|\d+ chars))?\]/g;

class FakePiEditor implements EditorComponent {
	focused = false;
	actionHandlers = new Map<string, () => void>();
	onEscape?: () => void;
	onCtrlD?: () => void;
	onPasteImage?: () => void;
	onExtensionShortcut?: (data: string) => boolean;
	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;
	borderColor = (text: string) => text;
	readonly history: string[] = [];
	readonly autocompleteProviders: unknown[] = [];
	padding = 0;
	maxVisible = 0;

	private text = "";
	private cursor = 0;
	private pasteCounter = 0;
	private readonly pastes = new Map<number, string>();

	constructor(private readonly rendered = "base editor") {}

	render(): string[] {
		return [this.rendered];
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (data.startsWith(BRACKETED_PASTE_START) && data.endsWith(BRACKETED_PASTE_END)) {
			const raw = data.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length);
			const before = this.cursor > 0 ? (this.text[this.cursor - 1] ?? "") : "";
			const clean = cleanPastedText(raw, before);
			if (!clean) return;
			if (isLargePaste(clean)) {
				const id = ++this.pasteCounter;
				this.pastes.set(id, clean);
				const lines = clean.split("\n").length;
				const marker = lines > 10
					? `[paste #${id} +${lines} lines]`
					: `[paste #${id} ${clean.length} chars]`;
				this.insert(marker);
			} else {
				this.insert(clean);
			}
			return;
		}

		if (data === "\x7f") {
			const before = this.text.slice(0, this.cursor);
			const matches = [...before.matchAll(MARKER)];
			const marker = matches.at(-1);
			if (marker && marker.index !== undefined && marker.index + marker[0].length === this.cursor) {
				this.text = this.text.slice(0, marker.index) + this.text.slice(this.cursor);
				this.cursor = marker.index;
				this.pastes.delete(Number(marker[1]));
				this.onChange?.(this.text);
				return;
			}
			if (this.cursor > 0) {
				this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
				this.cursor--;
				this.onChange?.(this.text);
			}
			return;
		}

		if (isMouseInput(data)) return;
		this.insert(data);
	}

	private insert(value: string): void {
		this.text = this.text.slice(0, this.cursor) + value + this.text.slice(this.cursor);
		this.cursor += value.length;
		this.onChange?.(this.text);
	}

	getText(): string {
		return this.text;
	}

	getExpandedText(): string {
		return this.text.replace(MARKER, (marker, id: string) => this.pastes.get(Number(id)) ?? marker);
	}

	getCursor(): { line: number; col: number } {
		const before = this.text.slice(0, this.cursor);
		const lines = before.split("\n");
		return { line: lines.length - 1, col: lines.at(-1)?.length ?? 0 };
	}

	setText(text: string): void {
		this.text = text;
		this.cursor = text.length;
		this.pastes.clear();
		this.pasteCounter = 0;
	}

	insertTextAtCursor(text: string): void {
		this.insert(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    "));
	}

	addToHistory(text: string): void {
		this.history.push(text);
	}

	setAutocompleteProvider(provider: unknown): void {
		this.autocompleteProviders.push(provider);
	}

	setPaddingX(value: number): void {
		this.padding = value;
	}

	setAutocompleteMaxVisible(value: number): void {
		this.maxVisible = value;
	}
}

const tui = { requestRender: vi.fn() } as any;
const theme = {} as any;
const keybindings = {} as any;

function wrap(base = new FakePiEditor()): { base: FakePiEditor; editor: DoublePasteEditor } {
	return { base, editor: new DoublePasteEditor(base, tui, theme, keybindings) };
}

function paste(editor: DoublePasteEditor, text: string): void {
	editor.handleInput(`${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`);
}

function multiline(label: string, lines = 11): string {
	return Array.from({ length: lines }, (_, index) => `${label}-${index}`).join("\n");
}

describe("paste normalization", () => {
	test("mirrors Pi line ending, tab, control, tmux, and path cleanup", () => {
		expect(cleanPastedText("a\r\nb\rc\td\x00e")).toBe("a\nb\nc    de");
		expect(cleanPastedText("a\x1b[106;5ub")).toBe("a\nb");
		expect(cleanPastedText("/tmp/file", "x")).toBe(" /tmp/file");
	});

	test("uses Pi's strict large-paste thresholds", () => {
		expect(isLargePaste(multiline("x", 10))).toBe(false);
		expect(isLargePaste(multiline("x", 11))).toBe(true);
		expect(isLargePaste("x".repeat(1000))).toBe(false);
		expect(isLargePaste("x".repeat(1001))).toBe(true);
	});

	test("recognizes SGR and legacy mouse packets", () => {
		expect(isMouseInput("\x1b[<35;20;5M")).toBe(true);
		expect(isMouseInput("\x1b[<0;20;5m")).toBe(true);
		expect(isMouseInput("\x1b[Mabc")).toBe(true);
		expect(isMouseInput("left")).toBe(false);
	});
});

describe("DoublePasteEditor", () => {
	test("expands an immediate identical large paste without duplicating it", () => {
		const { editor } = wrap();
		const content = multiline("same");
		paste(editor, content);
		expect(editor.getText()).toBe("[paste #1 +11 lines]");
		paste(editor, content);
		expect(editor.getText()).toBe(content);
		expect(editor.getExpandedText()).toBe(content);
	});

	test("works with Pi's real CustomEditor marker bookkeeping", () => {
		const base = new CustomEditor(tui, theme, { matches: () => false } as any);
		const editor = new DoublePasteEditor(base, tui, theme, keybindings);
		const content = multiline("real");
		paste(editor, content);
		expect(editor.getText()).toBe("[paste #1 +11 lines]");
		paste(editor, content);
		expect(editor.getText()).toBe(content);
		expect(editor.getExpandedText()).toBe(content);
	});

	test("does not pair short pastes", () => {
		const { editor } = wrap();
		paste(editor, "short");
		paste(editor, "short");
		expect(editor.getText()).toBe("shortshort");
	});

	test("makes a different paste the next candidate", () => {
		const { editor } = wrap();
		const first = multiline("first");
		const second = multiline("second");
		paste(editor, first);
		paste(editor, second);
		paste(editor, second);
		expect(editor.getText()).toBe(`[paste #1 +11 lines]${second}`);
		expect(editor.getExpandedText()).toBe(first + second);
	});

	test("preserves older paste markers when expanding the repeated one", () => {
		const { editor } = wrap();
		const older = multiline("older");
		const repeated = multiline("repeated");
		paste(editor, older);
		paste(editor, repeated);
		paste(editor, repeated);
		expect(editor.getText()).toBe(`[paste #1 +11 lines]${repeated}`);
		expect(editor.getExpandedText()).toBe(older + repeated);
	});

	test("keyboard input breaks the pair", () => {
		const { editor } = wrap();
		const content = multiline("same");
		paste(editor, content);
		editor.handleInput("x");
		paste(editor, content);
		expect(editor.getText()).toBe("[paste #1 +11 lines]x[paste #2 +11 lines]");
	});

	test("SGR and legacy mouse input do not break the pair", () => {
		for (const mouse of ["\x1b[<35;20;5M", "\x1b[Mabc"]) {
			const { editor } = wrap();
			const content = multiline("same");
			paste(editor, content);
			editor.handleInput(mouse);
			paste(editor, content);
			expect(editor.getText()).toBe(content);
		}
	});

	test("buffers paste content and a split end delimiter", () => {
		const { editor } = wrap();
		const content = multiline("fragmented");
		const split = Math.floor(content.length / 2);
		editor.handleInput(BRACKETED_PASTE_START + content.slice(0, split));
		expect(editor.getText()).toBe("");
		editor.handleInput(content.slice(split) + BRACKETED_PASTE_END.slice(0, -1));
		expect(editor.getText()).toBe("");
		editor.handleInput(BRACKETED_PASTE_END.slice(-1));
		expect(editor.getText()).toBe("[paste #1 +11 lines]");
		paste(editor, content);
		expect(editor.getText()).toBe(content);
	});

	test("handles consecutive complete pastes in one input call", () => {
		const { editor } = wrap();
		const content = multiline("batched");
		editor.handleInput(
			`${BRACKETED_PASTE_START}${content}${BRACKETED_PASTE_END}` +
			`${BRACKETED_PASTE_START}${content}${BRACKETED_PASTE_END}`,
		);
		expect(editor.getText()).toBe(content);
	});

	test("treats input trailing a paste as intervening keyboard input", () => {
		const { editor } = wrap();
		const content = multiline("trailing");
		editor.handleInput(`${BRACKETED_PASTE_START}${content}${BRACKETED_PASTE_END}x`);
		paste(editor, content);
		expect(editor.getText()).toBe("[paste #1 +11 lines]x[paste #2 +11 lines]");
	});

	test("fails safely when the editor changes outside keyboard input", () => {
		const { base, editor } = wrap();
		const content = multiline("same");
		paste(editor, content);
		base.insertTextAtCursor("changed");
		paste(editor, content);
		expect(editor.getText()).toBe("[paste #1 +11 lines]changed[paste #2 +11 lines]");
	});

	test("forwards editor rendering, focus, callbacks, and app handler fields", () => {
		const base = new FakePiEditor("custom editor");
		const editor = new DoublePasteEditor(base, tui, theme, keybindings) as DoublePasteEditor & {
			onEscape?: () => void;
		};
		const submit = vi.fn();
		const escape = vi.fn();
		editor.focused = true;
		editor.onSubmit = submit;
		editor.onEscape = escape;
		editor.addToHistory?.("history");
		editor.setPaddingX?.(2);
		editor.setAutocompleteMaxVisible?.(8);
		expect(editor.render(80)).toEqual(["custom editor"]);
		expect(base.focused).toBe(true);
		expect(base.onSubmit).toBe(submit);
		expect(base.onEscape).toBe(escape);
		expect(editor.actionHandlers).toBe(base.actionHandlers);
		expect(base.history).toEqual(["history"]);
		expect(base.padding).toBe(2);
		expect(base.maxVisible).toBe(8);
	});
});

describe("extension lifecycle", () => {
	test("wraps the final active editor once during resource discovery", () => {
		const handlers = new Map<string, (event: unknown, ctx: any) => void>();
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: any) => void) => handlers.set(event, handler),
		} as unknown as ExtensionAPI;
		const base = new FakePiEditor("existing custom editor");
		const previousFactory = vi.fn(() => base);
		let activeFactory: any = previousFactory;
		const setEditorComponent = vi.fn((factory) => {
			activeFactory = factory;
		});
		const ctx = {
			mode: "tui",
			ui: {
				getEditorComponent: () => activeFactory,
				setEditorComponent,
			},
		};

		doublePasteExpandExtension(pi);
		handlers.get("resources_discover")?.({}, ctx);
		expect(setEditorComponent).toHaveBeenCalledTimes(1);
		const wrapped = activeFactory(tui, theme, keybindings);
		expect(previousFactory).toHaveBeenCalledWith(tui, theme, keybindings);
		expect(wrapped).toBeInstanceOf(DoublePasteEditor);
		expect(wrapped.render(80)).toEqual(["existing custom editor"]);

		handlers.get("resources_discover")?.({}, ctx);
		expect(setEditorComponent).toHaveBeenCalledTimes(1);
	});
});
