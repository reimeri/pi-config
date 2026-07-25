import {
	CustomEditor,
	type ExtensionAPI,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { type EditorTheme, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	EDITOR_TOP_BAR_MODE_EVENT,
	type EditorTopBarMode,
	type EditorTopBarModeUpdate,
} from "./shared/editor-top-bar.ts";

const MAX_TASK_LENGTH = 200;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

function normalizeTask(value: string): string {
	return value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
}

function taskLength(value: string): number {
	return Array.from(value).length;
}

function modeBorderColor(
	modes: EditorTopBarMode[],
	warning: (text: string) => string,
	error: (text: string) => string,
): ((text: string) => string) | undefined {
	if (modes.some((mode) => mode.borderColor === "error")) return error;
	if (modes.some((mode) => mode.borderColor === "warning")) return warning;
	return undefined;
}

function modesForWidth(modes: EditorTopBarMode[], width: number): string {
	if (modes.length === 0 || width <= 0) return "";

	const full = ` ${modes.map((mode) => mode.label).join("  ")} `;
	if (visibleWidth(full) <= width) return full;

	const compact = ` ${modes.map((mode) => mode.compactLabel).join(" ")} `;
	if (visibleWidth(compact) <= width) return compact;

	const selected = new Set<string>();
	for (const mode of [...modes].sort((left, right) => right.priority - left.priority)) {
		const candidate = modes
			.filter((item) => selected.has(item.id) || item.id === mode.id)
			.map((item) => item.compactLabel)
			.join(" ");
		if (visibleWidth(candidate) <= width) selected.add(mode.id);
	}

	const selectedText = modes
		.filter((mode) => selected.has(mode.id))
		.map((mode) => mode.compactLabel)
		.join(" ");
	if (selectedText) return selectedText;

	const highestPriority = [...modes].sort((left, right) => right.priority - left.priority)[0];
	return highestPriority ? truncateToWidth(highestPriority.compactLabel, width, "") : "";
}

function editorTopBar(
	task: string,
	modes: EditorTopBarMode[],
	width: number,
	border: (text: string) => string,
	accent: (text: string) => string,
	warning: (text: string) => string,
): string {
	if (width <= 0) return "";
	if (width === 1) return border("─");

	const innerWidth = width - 2;
	const modeText = modesForWidth(modes, innerWidth);
	const modeWidth = visibleWidth(modeText);
	const taskWidth = Math.max(0, innerWidth - modeWidth - (modeText ? 1 : 0));
	const taskText = task
		? truncateToWidth(` Task: ${task} `, taskWidth, taskWidth > 0 ? "…" : "")
		: "";
	const taskTextWidth = visibleWidth(taskText);
	const fillWidth = Math.max(0, innerWidth - taskTextWidth - modeWidth);

	return [
		border("─"),
		taskText ? accent(taskText) : "",
		border("─".repeat(fillWidth)),
		modeText ? warning(modeText) : "",
		border("─"),
	].join("");
}

class CurrentTaskEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly getTask: () => string | undefined,
		private readonly getModes: () => EditorTopBarMode[],
		private readonly accent: (text: string) => string,
		private readonly warning: (text: string) => string,
		private readonly error: (text: string) => string,
	) {
		super(tui, theme, keybindings);
	}

	render(width: number): string[] {
		const task = normalizeTask(this.getTask() ?? "");
		const modes = this.getModes();
		const defaultBorderColor = this.borderColor;
		const activeBorderColor = modeBorderColor(modes, this.warning, this.error) ?? defaultBorderColor;

		this.borderColor = activeBorderColor;
		let lines: string[];
		try {
			lines = super.render(width);
		} finally {
			this.borderColor = defaultBorderColor;
		}

		if ((!task && modes.length === 0) || lines.length === 0) return lines;

		lines[0] = editorTopBar(
			task,
			modes,
			width,
			activeBorderColor,
			this.accent,
			this.warning,
		);
		return lines;
	}
}

export default function currentTaskExtension(pi: ExtensionAPI) {
	let activeTui: TUI | undefined;
	const activeModes = new Map<string, EditorTopBarMode>();

	const requestRender = () => activeTui?.requestRender();

	const disposeModeListener = pi.events.on(EDITOR_TOP_BAR_MODE_EVENT, (data) => {
		const update = data as EditorTopBarModeUpdate;
		if (!update || typeof update.id !== "string") return;
		if (typeof update.label === "string" && update.label.trim()) {
			const label = normalizeTask(update.label);
			const compactLabel = normalizeTask(update.compactLabel ?? label);
			const borderColor =
				update.borderColor === "warning" || update.borderColor === "error"
					? update.borderColor
					: undefined;
			activeModes.set(update.id, {
				id: update.id,
				label,
				compactLabel: compactLabel || label,
				priority: Number.isFinite(update.priority) ? (update.priority ?? 0) : 0,
				borderColor,
			});
		} else {
			activeModes.delete(update.id);
		}
		requestRender();
	});

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

	const getActiveModes = (): EditorTopBarMode[] =>
		[...activeModes.values()].sort((left, right) => left.id.localeCompare(right.id));

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			activeTui = tui;
			return new CurrentTaskEditor(
				tui,
				theme,
				keybindings,
				() => pi.getSessionName(),
				getActiveModes,
				(text) => ctx.ui.theme.fg("accent", text),
				(text) => ctx.ui.theme.fg("warning", text),
				(text) => ctx.ui.theme.fg("error", text),
			);
		});
	});

	pi.on("session_info_changed", requestRender);

	pi.on("session_shutdown", () => {
		disposeModeListener();
		activeModes.clear();
		activeTui = undefined;
	});
}
