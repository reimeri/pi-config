import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type {
	AutocompleteProvider,
	EditorComponent,
	EditorTheme,
	TUI,
} from "@earendil-works/pi-tui";

export const BRACKETED_PASTE_START = "\x1b[200~";
export const BRACKETED_PASTE_END = "\x1b[201~";

const BACKSPACE = "\x7f";
const PASTE_MARKER_AT_CURSOR = /\[paste #\d+(?: (?:\+\d+ lines|\d+ chars))?\]$/;
const SGR_MOUSE_EVENT = /^\x1b\[<\d+;\d+;\d+[Mm]$/;

interface Cursor {
	line: number;
	col: number;
}

interface CursorEditor extends EditorComponent {
	getCursor(): Cursor;
}

interface PasteCandidate {
	rawText: string;
	cleanText: string;
	marker: string;
	markerStart: number;
	cursor: Cursor;
	visibleText: string;
}

interface AppEditorFields {
	actionHandlers?: Map<string, () => void>;
	onEscape?: () => void;
	onCtrlD?: () => void;
	onPasteImage?: () => void;
	onExtensionShortcut?: (data: string) => boolean;
}

/** Apply Pi's paste normalization before deciding whether to collapse. */
export function cleanPastedText(text: string, charBeforeCursor = ""): string {
	const decoded = text.replace(/\x1b\[(\d+);5u/g, (match, code: string) => {
		const codePoint = Number(code);
		if (codePoint >= 97 && codePoint <= 122) return String.fromCharCode(codePoint - 96);
		if (codePoint >= 65 && codePoint <= 90) return String.fromCharCode(codePoint - 64);
		return match;
	});
	const normalized = decoded.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
	let filtered = [...normalized]
		.filter((character) => character === "\n" || character.charCodeAt(0) >= 32)
		.join("");

	if (/^[/~.]/.test(filtered) && charBeforeCursor && /\w/.test(charBeforeCursor)) {
		filtered = ` ${filtered}`;
	}
	return filtered;
}

export function cleanExpandedPastedText(text: string): string {
	return text
		.split("\n")
		.map((line) => line.replace(/ +$/, ""))
		.join("\n");
}

export function isLargePaste(text: string): boolean {
	return text.split("\n").length > 10 || text.length > 1000;
}

export function isMouseInput(data: string): boolean {
	return SGR_MOUSE_EVENT.test(data) || (data.startsWith("\x1b[M") && data.length === 6);
}

function hasCursor(editor: EditorComponent): editor is CursorEditor {
	return typeof (editor as Partial<CursorEditor>).getCursor === "function";
}

function charBeforeCursor(editor: EditorComponent): string {
	if (!hasCursor(editor)) return "";
	const cursor = editor.getCursor();
	const line = editor.getText().split("\n")[cursor.line] ?? "";
	return cursor.col > 0 ? (line[cursor.col - 1] ?? "") : "";
}

function expectedTextWithoutMarker(candidate: PasteCandidate): string {
	const lines = candidate.visibleText.split("\n");
	const line = lines[candidate.cursor.line] ?? "";
	lines[candidate.cursor.line] =
		line.slice(0, candidate.markerStart) + line.slice(candidate.cursor.col);
	return lines.join("\n");
}

/** Wrap Pi's editor while preserving rendering, input, and submission behavior. */
export class DoublePasteEditor implements EditorComponent {
	readonly actionHandlers?: Map<string, () => void>;
	private candidate?: PasteCandidate;
	private pasteBuffer?: string;

	constructor(
		private readonly base: EditorComponent,
		readonly tui: TUI,
		readonly theme: EditorTheme,
		readonly keybindings: KeybindingsManager,
	) {
		const appEditor = base as EditorComponent & AppEditorFields;
		if (appEditor.actionHandlers instanceof Map) {
			this.actionHandlers = appEditor.actionHandlers;
			for (const property of ["onEscape", "onCtrlD", "onPasteImage", "onExtensionShortcut"] as const) {
				Object.defineProperty(this, property, {
					configurable: true,
					get: () => appEditor[property],
					set: (value) => {
						(appEditor as unknown as Record<string, unknown>)[property] = value;
					},
				});
			}
		}
	}

	get focused(): boolean {
		return (this.base as EditorComponent & { focused?: boolean }).focused ?? false;
	}

	set focused(value: boolean) {
		(this.base as EditorComponent & { focused?: boolean }).focused = value;
	}

	get wantsKeyRelease(): boolean | undefined {
		return this.base.wantsKeyRelease;
	}

	get onSubmit(): ((text: string) => void) | undefined {
		return this.base.onSubmit;
	}

	set onSubmit(handler: ((text: string) => void) | undefined) {
		this.base.onSubmit = handler;
	}

	get onChange(): ((text: string) => void) | undefined {
		return this.base.onChange;
	}

	set onChange(handler: ((text: string) => void) | undefined) {
		this.base.onChange = handler;
	}

	get borderColor(): ((text: string) => string) | undefined {
		return this.base.borderColor;
	}

	set borderColor(color: ((text: string) => string) | undefined) {
		this.base.borderColor = color;
	}

	render(width: number): string[] {
		return this.base.render(width);
	}

	invalidate(): void {
		this.base.invalidate();
	}

	handleInput(data: string): void {
		if (this.pasteBuffer !== undefined) {
			this.pasteBuffer += data;
			this.finishBufferedPaste();
			return;
		}

		const startIndex = data.indexOf(BRACKETED_PASTE_START);
		if (startIndex === -1) {
			this.handleNonPasteInput(data);
			return;
		}

		const beforePaste = data.slice(0, startIndex);
		if (beforePaste) this.handleNonPasteInput(beforePaste);
		this.pasteBuffer = data.slice(startIndex + BRACKETED_PASTE_START.length);
		this.finishBufferedPaste();
	}

	private finishBufferedPaste(): void {
		if (this.pasteBuffer === undefined) return;
		const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
		if (endIndex === -1) return;

		const rawText = this.pasteBuffer.slice(0, endIndex);
		const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);
		this.pasteBuffer = undefined;
		this.handlePaste(rawText);
		if (remaining) this.handleInput(remaining);
	}

	private handleNonPasteInput(data: string): void {
		if (!isMouseInput(data)) this.candidate = undefined;
		this.base.handleInput(data);
	}

	private handlePaste(rawText: string): void {
		if (this.candidate?.rawText === rawText && this.expandCandidate(this.candidate)) {
			this.candidate = undefined;
			return;
		}

		this.candidate = undefined;
		const cleanText = cleanPastedText(rawText, charBeforeCursor(this.base));
		this.base.handleInput(`${BRACKETED_PASTE_START}${rawText}${BRACKETED_PASTE_END}`);
		if (!isLargePaste(cleanText) || !hasCursor(this.base) || !this.base.insertTextAtCursor) return;

		const cursor = this.base.getCursor();
		const visibleText = this.base.getText();
		const line = visibleText.split("\n")[cursor.line] ?? "";
		const marker = PASTE_MARKER_AT_CURSOR.exec(line.slice(0, cursor.col))?.[0];
		if (!marker) return;

		this.candidate = {
			rawText,
			cleanText,
			marker,
			markerStart: cursor.col - marker.length,
			cursor: { ...cursor },
			visibleText,
		};
	}

	private expandCandidate(candidate: PasteCandidate): boolean {
		if (!hasCursor(this.base) || !this.base.insertTextAtCursor) return false;
		const cursor = this.base.getCursor();
		if (
			this.base.getText() !== candidate.visibleText ||
			cursor.line !== candidate.cursor.line ||
			cursor.col !== candidate.cursor.col
		) {
			return false;
		}

		const line = candidate.visibleText.split("\n")[cursor.line] ?? "";
		if (line.slice(candidate.markerStart, cursor.col) !== candidate.marker) return false;

		const expectedAfterDelete = expectedTextWithoutMarker(candidate);
		this.base.handleInput(BACKSPACE);
		if (this.base.getText() !== expectedAfterDelete) {
			// Restore one-character deletion when a non-Pi editor does not treat the marker atomically.
			const expectedSingleDelete =
				candidate.visibleText.slice(0, this.absoluteCursorIndex(candidate) - 1) +
				candidate.visibleText.slice(this.absoluteCursorIndex(candidate));
			if (this.base.getText() === expectedSingleDelete) this.base.insertTextAtCursor("]");
			return false;
		}

		this.base.insertTextAtCursor(cleanExpandedPastedText(candidate.cleanText));
		return true;
	}

	private absoluteCursorIndex(candidate: PasteCandidate): number {
		const lines = candidate.visibleText.split("\n");
		let index = candidate.cursor.col;
		for (let line = 0; line < candidate.cursor.line; line++) index += (lines[line]?.length ?? 0) + 1;
		return index;
	}

	getText(): string {
		return this.base.getText();
	}

	getExpandedText(): string {
		return this.base.getExpandedText?.() ?? this.base.getText();
	}

	setText(text: string): void {
		this.candidate = undefined;
		this.pasteBuffer = undefined;
		this.base.setText(text);
	}

	addToHistory(text: string): void {
		this.base.addToHistory?.(text);
	}

	insertTextAtCursor(text: string): void {
		this.candidate = undefined;
		if (this.base.insertTextAtCursor) this.base.insertTextAtCursor(text);
		else this.base.setText(this.base.getText() + text);
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.base.setAutocompleteProvider?.(provider);
	}

	setPaddingX(padding: number): void {
		this.base.setPaddingX?.(padding);
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.base.setAutocompleteMaxVisible?.(maxVisible);
	}
}
