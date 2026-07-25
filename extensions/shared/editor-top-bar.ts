import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const EDITOR_TOP_BAR_MODE_EVENT = "editor-top-bar:mode";

export type EditorTopBarModeBorderColor = "warning" | "error";

export interface EditorTopBarMode {
	id: string;
	label: string;
	compactLabel: string;
	priority: number;
	borderColor?: EditorTopBarModeBorderColor;
}

export interface EditorTopBarModeUpdate {
	id: string;
	label?: string;
	compactLabel?: string;
	priority?: number;
	borderColor?: EditorTopBarModeBorderColor;
}

export function setEditorTopBarMode(
	pi: ExtensionAPI,
	id: string,
	label: string | undefined,
	options: {
		compactLabel?: string;
		priority?: number;
		borderColor?: EditorTopBarModeBorderColor;
	} = {},
): void {
	pi.events.emit(EDITOR_TOP_BAR_MODE_EVENT, {
		id,
		label,
		...options,
	} satisfies EditorTopBarModeUpdate);
}
