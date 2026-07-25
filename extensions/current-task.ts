import {
	CustomEditor,
	type ExtensionAPI,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { type EditorTheme, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX_TASK_LENGTH = 200;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

function normalizeTask(value: string): string {
	return value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
}

function taskLength(value: string): number {
	return Array.from(value).length;
}

function taskBorder(
	task: string,
	width: number,
	border: (text: string) => string,
	accent: (text: string) => string,
): string {
	if (width <= 0) return "";
	if (width === 1) return border("─");

	const label = truncateToWidth(` Task: ${task} `, Math.max(0, width - 2), "…");
	const fillWidth = Math.max(1, width - 1 - visibleWidth(label));
	return `${border("─")}${accent(label)}${border("─".repeat(fillWidth))}`;
}

class CurrentTaskEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly getTask: () => string | undefined,
		private readonly accent: (text: string) => string,
	) {
		super(tui, theme, keybindings);
	}

	render(width: number): string[] {
		const lines = super.render(width);
		const task = normalizeTask(this.getTask() ?? "");
		if (!task || lines.length === 0) return lines;

		lines[0] = taskBorder(task, width, (text) => this.borderColor(text), this.accent);
		return lines;
	}
}

export default function currentTaskExtension(pi: ExtensionAPI) {
	let activeTui: TUI | undefined;

	const requestRender = () => activeTui?.requestRender();

	const setTask = (value: string): string => {
		const task = normalizeTask(value);
		if (!task) throw new Error("Current task cannot be blank");
		if (taskLength(task) > MAX_TASK_LENGTH) {
			throw new Error(`Current task cannot exceed ${MAX_TASK_LENGTH} characters`);
		}
		pi.setSessionName(task);
		return task;
	};

	const clearTask = () => {
		pi.setSessionName("");
	};

	pi.registerTool({
		name: "set_current_task",
		label: "Set Current Task",
		description:
			"Set the concise, session-level task currently being worked on. The task is displayed in the editor border and persisted as the session name.",
		promptSnippet: "Set or update the concise task title for the current session",
		promptGuidelines: [
			"Use set_current_task before beginning substantial work in a session and whenever the overall task changes.",
			"Do not call set_current_task repeatedly when the current task is unchanged; use a concise feature or issue title rather than an implementation step.",
		],
		parameters: Type.Object({
			task: Type.String({
				minLength: 1,
				pattern: "\\S",
				description: `Concise session-level task title (maximum ${MAX_TASK_LENGTH} characters after normalization)`,
			}),
		}),
		async execute(_toolCallId, params) {
			const task = setTask(params.task);
			return {
				content: [{ type: "text", text: `Current session task set to: ${task}` }],
				details: { task },
			};
		},
	});

	pi.registerCommand("task", {
		description: "Show or set the current session task; use /task clear to clear it",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				const current = pi.getSessionName();
				ctx.ui.notify(current ? `Current task: ${current}` : "No current task is set", "info");
				return;
			}

			if (input.toLowerCase() === "clear") {
				clearTask();
				ctx.ui.notify("Current task cleared", "info");
				return;
			}

			try {
				const task = setTask(input);
				ctx.ui.notify(`Current task: ${task}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			activeTui = tui;
			return new CurrentTaskEditor(
				tui,
				theme,
				keybindings,
				() => pi.getSessionName(),
				(text) => ctx.ui.theme.fg("accent", text),
			);
		});
	});

	pi.on("session_info_changed", requestRender);

	pi.on("session_shutdown", () => {
		activeTui = undefined;
	});
}
