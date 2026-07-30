import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { DoublePasteEditor } from "./core.ts";

const WRAPPED_FACTORY = Symbol.for("pi.double-paste-expand.editor-factory");
type EditorFactory = Exclude<Parameters<ExtensionUIContext["setEditorComponent"]>[0], undefined>;
type TaggedEditorFactory = EditorFactory & { [WRAPPED_FACTORY]?: boolean };

export default function doublePasteExpandExtension(pi: ExtensionAPI) {
	// Resource discovery follows session_start, where editor-customizing extensions
	// normally install their factories. Wrapping here preserves the final active editor.
	pi.on("resources_discover", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const previous = ctx.ui.getEditorComponent() as TaggedEditorFactory | undefined;
		if (previous?.[WRAPPED_FACTORY]) return;

		const factory: TaggedEditorFactory = (tui, theme, keybindings) => {
			const base = previous
				? previous(tui, theme, keybindings)
				: new CustomEditor(tui, theme, keybindings);
			return new DoublePasteEditor(base, tui, theme, keybindings);
		};
		factory[WRAPPED_FACTORY] = true;
		ctx.ui.setEditorComponent(factory);
	});
}
