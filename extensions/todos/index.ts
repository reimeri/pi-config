import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	MAX_TODOS,
	TODO_CREATE_FROM_PLAN_REQUEST_EVENT,
	type PlanTodoCreationRequest,
	type TodoStatus,
} from "./protocol.ts";
import {
	counts,
	formatTodoReminder,
	formatTodosForAgent,
	shouldRemindTodos,
	TODO_TOOL_NAME,
	type Todo,
} from "./core.ts";

const TODO_STATE_ENTRY_TYPE = "todos-state";
const TODO_STATE_VERSION = 1;
const MAX_WIDGET_ITEMS = 4;
const MAX_DIALOG_ITEMS = 12;
const MAX_TODO_TEXT_LENGTH = 300;
const MAX_EXPLANATION_LENGTH = 300;
const TODO_STATUSES = new Set<TodoStatus>(["pending", "in_progress", "completed"]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const CONTROL_CHARACTERS_GLOBAL = /[\u0000-\u001f\u007f]/g;

interface TodoDetails {
	version: typeof TODO_STATE_VERSION;
	todos: Todo[];
	explanation?: string;
}

const TodoSchema = Type.Object({
	id: Type.String({
		minLength: 1,
		maxLength: 64,
		pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
		description: "Stable unique ID using letters, digits, dots, underscores, or hyphens",
	}),
	text: Type.String({
		minLength: 1,
		maxLength: MAX_TODO_TEXT_LENGTH,
		pattern: "\\S",
		description: "Concise description of one verifiable work item",
	}),
	status: StringEnum(["pending", "in_progress", "completed"] as const),
});

const TodoUpdateParams = Type.Object({
	todos: Type.Array(TodoSchema, {
		maxItems: MAX_TODOS,
		description: "The complete canonical TODO list. This replaces the previous list atomically.",
	}),
	explanation: Type.Optional(
		Type.String({
			maxLength: MAX_EXPLANATION_LENGTH,
			description: "Brief reason for this update, especially when scope or ordering changed",
		}),
	),
});

function cloneTodos(todos: Todo[]): Todo[] {
	return todos.map((todo) => ({ ...todo }));
}

function normalizeTodos(input: unknown): Todo[] {
	if (!Array.isArray(input)) throw new Error("TODOs must be an array");
	if (input.length > MAX_TODOS) throw new Error(`A maximum of ${MAX_TODOS} TODOs is allowed`);

	const ids = new Set<string>();
	let activeCount = 0;
	const normalized: Todo[] = [];

	for (let index = 0; index < input.length; index++) {
		const value = input[index];
		if (!value || typeof value !== "object") throw new Error(`TODO at index ${index} must be an object`);
		const candidate = value as { id?: unknown; text?: unknown; status?: unknown };
		if (typeof candidate.id !== "string") throw new Error(`TODO at index ${index} requires a string ID`);
		if (typeof candidate.text !== "string") throw new Error(`TODO ${candidate.id} requires string text`);
		if (typeof candidate.status !== "string" || !TODO_STATUSES.has(candidate.status as TodoStatus)) {
			throw new Error(`TODO ${candidate.id} has invalid status: ${String(candidate.status)}`);
		}

		const todo: Todo = {
			id: candidate.id.trim(),
			text: candidate.text.trim(),
			status: candidate.status as TodoStatus,
		};
		if (!todo.id) throw new Error("TODO IDs cannot be blank");
		if (!todo.text) throw new Error(`TODO ${todo.id} has blank text`);
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(todo.id)) throw new Error(`Invalid TODO ID: ${todo.id}`);
		if (todo.text.length > MAX_TODO_TEXT_LENGTH) {
			throw new Error(`TODO ${todo.id} exceeds ${MAX_TODO_TEXT_LENGTH} characters`);
		}
		if (CONTROL_CHARACTERS.test(todo.text)) throw new Error(`TODO ${todo.id} contains control characters`);
		if (ids.has(todo.id)) throw new Error(`Duplicate TODO ID: ${todo.id}`);
		ids.add(todo.id);
		if (todo.status === "in_progress") activeCount++;
		normalized.push(todo);
	}

	if (activeCount > 1) throw new Error("At most one TODO may be in_progress");
	return normalized;
}

function normalizeExplanation(input: unknown): string | undefined {
	if (input === undefined) return undefined;
	if (typeof input !== "string") throw new Error("TODO update explanation must be a string");
	const explanation = input.trim() || undefined;
	if (explanation && explanation.length > MAX_EXPLANATION_LENGTH) {
		throw new Error(`TODO update explanation exceeds ${MAX_EXPLANATION_LENGTH} characters`);
	}
	if (explanation && CONTROL_CHARACTERS.test(explanation)) {
		throw new Error("TODO update explanation contains control characters");
	}
	return explanation;
}

function isTodoDetails(value: unknown): value is TodoDetails {
	if (!value || typeof value !== "object") return false;
	const details = value as Partial<TodoDetails>;
	return details.version === TODO_STATE_VERSION && Array.isArray(details.todos);
}

function isPlanTodoCreationRequest(value: unknown): value is PlanTodoCreationRequest {
	if (!value || typeof value !== "object") return false;
	const request = value as Partial<PlanTodoCreationRequest>;
	return (
		Array.isArray(request.steps) &&
		typeof request.acknowledge === "function" &&
		typeof request.respond === "function"
	);
}

function themedTodoLine(todo: Todo, theme: Theme): string {
	const id = theme.fg("accent", todo.id);
	switch (todo.status) {
		case "completed":
			return `${theme.fg("success", "✓")} ${id} ${theme.fg("dim", theme.strikethrough(todo.text))}`;
		case "in_progress":
			return `${theme.fg("warning", "▶")} ${id} ${theme.fg("text", todo.text)}`;
		case "pending":
			return `${theme.fg("muted", "○")} ${id} ${theme.fg("muted", todo.text)}`;
	}
}

class TodoWidget {
	constructor(
		private readonly todos: Todo[],
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		if (width <= 0) return [];
		const { completed, remaining } = counts(this.todos);
		const header =
			this.theme.fg("accent", this.theme.bold("TODO")) +
			this.theme.fg("dim", ` ${completed}/${this.todos.length}`) +
			this.theme.fg("dim", " · /todos");
		const lines = [truncateToWidth(header, width)];

		if (remaining === 0) {
			lines.push(truncateToWidth(this.theme.fg("success", "✓ All tracked work completed"), width));
			return lines;
		}

		const visible = this.todos
			.filter((todo) => todo.status !== "completed")
			.sort((left, right) => Number(right.status === "in_progress") - Number(left.status === "in_progress"));
		for (const todo of visible.slice(0, MAX_WIDGET_ITEMS)) {
			lines.push(truncateToWidth(themedTodoLine(todo, this.theme), width));
		}
		if (visible.length > MAX_WIDGET_ITEMS) {
			lines.push(truncateToWidth(this.theme.fg("dim", `… ${visible.length - MAX_WIDGET_ITEMS} more`), width));
		}
		return lines;
	}

	invalidate(): void {}
}

class TodoListComponent {
	private offset = 0;

	constructor(
		private readonly todos: Todo[],
		private readonly theme: Theme,
		private readonly onClose: () => void,
		private readonly onChange: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
			return;
		}
		const maxOffset = Math.max(0, this.todos.length - MAX_DIALOG_ITEMS);
		if (matchesKey(data, "up") && this.offset > 0) {
			this.offset--;
			this.onChange();
		} else if (matchesKey(data, "down") && this.offset < maxOffset) {
			this.offset++;
			this.onChange();
		}
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const { completed, remaining } = counts(this.todos);
		const lines: string[] = [
			"",
			truncateToWidth(this.theme.fg("accent", this.theme.bold("TODOs")), width),
			truncateToWidth(
				this.theme.fg("muted", `${completed}/${this.todos.length} completed · ${remaining} remaining`),
				width,
			),
			"",
		];

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(this.theme.fg("dim", "No TODOs are currently tracked."), width));
		} else {
			const visible = this.todos.slice(this.offset, this.offset + MAX_DIALOG_ITEMS);
			for (const todo of visible) lines.push(truncateToWidth(themedTodoLine(todo, this.theme), width));
			if (this.todos.length > MAX_DIALOG_ITEMS) {
				const first = this.offset + 1;
				const last = this.offset + visible.length;
				lines.push(truncateToWidth(this.theme.fg("dim", `Items ${first}–${last} of ${this.todos.length}`), width));
			}
		}

		const help = this.todos.length > MAX_DIALOG_ITEMS ? "↑↓ scroll · Escape or Ctrl+C to close" : "Escape or Ctrl+C to close";
		lines.push("", truncateToWidth(this.theme.fg("dim", help), width), "");
		return lines;
	}

	invalidate(): void {}
}

export default function todoExtension(pi: ExtensionAPI): void {
	let todos: Todo[] = [];
	let currentCtx: ExtensionContext | undefined;

	function updateUI(ctx: ExtensionContext): void {
		// Clear footer progress left by older versions; the widget already shows it.
		ctx.ui.setStatus("todos", undefined);
		if (todos.length === 0) {
			ctx.ui.setWidget("todos", undefined);
			return;
		}

		const snapshot = cloneTodos(todos);
		ctx.ui.setWidget("todos", (_tui, theme) => new TodoWidget(snapshot, theme));
	}

	function reconstructState(ctx: ExtensionContext): void {
		todos = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			let details: TodoDetails | undefined;
			if (entry.type === "message") {
				const message = entry.message;
				if (message.role === "toolResult" && message.toolName === TODO_TOOL_NAME && isTodoDetails(message.details)) {
					details = message.details;
				}
			} else if (entry.type === "custom" && entry.customType === TODO_STATE_ENTRY_TYPE && isTodoDetails(entry.data)) {
				details = entry.data;
			}
			if (!details) continue;
			try {
				todos = normalizeTodos(details.todos);
			} catch {
				// Ignore malformed snapshots rather than breaking session restoration.
			}
		}
		updateUI(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		reconstructState(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		currentCtx = ctx;
		reconstructState(ctx);
	});

	const unsubscribePlanTodoCreation = pi.events.on(TODO_CREATE_FROM_PLAN_REQUEST_EVENT, async (data) => {
		if (!isPlanTodoCreationRequest(data)) return;
		data.acknowledge();

		try {
			const ctx = currentCtx;
			if (!ctx) {
				data.respond({ status: "unavailable", message: "The todos extension has no active session." });
				return;
			}
			const nextTodos = normalizeTodos(
				data.steps.map((text, index) => ({
					id: `plan-${index + 1}`,
					text,
					status: index === 0 ? "in_progress" : "pending",
				})),
			);
			const hasUnfinishedTodos = todos.some((todo) => todo.status !== "completed");
			if (hasUnfinishedTodos) {
				const replace = await ctx.ui.confirm(
					"Replace unfinished TODOs?",
					"Executing this plan will replace the current unfinished TODO list.",
				);
				if (!replace) {
					data.respond({ status: "cancelled" });
					return;
				}
			}

			const details: TodoDetails = {
				version: TODO_STATE_VERSION,
				todos: cloneTodos(nextTodos),
				explanation: normalizeExplanation(data.explanation),
			};
			pi.appendEntry(TODO_STATE_ENTRY_TYPE, details);
			todos = nextTodos;
			updateUI(ctx);
			data.respond({ status: "applied" });
		} catch (error) {
			data.respond({
				status: "unavailable",
				message: error instanceof Error ? error.message : "Unable to create TODOs from the plan.",
			});
		}
	});

	pi.on("session_shutdown", () => {
		currentCtx = undefined;
		unsubscribePlanTodoCreation();
	});

	pi.on("context", (event) => {
		if (!shouldRemindTodos(todos, event.messages)) return;
		return {
			messages: [
				...event.messages,
				{
					role: "custom",
					customType: "todo-state",
					content: formatTodoReminder(todos),
					display: false,
					timestamp: Date.now(),
				},
			],
		};
	});

	pi.registerTool({
		name: TODO_TOOL_NAME,
		label: "Update TODOs",
		description:
			"Replace the complete canonical TODO list used to track multi-step implementation work. Include every current item on every call. Use stable IDs and statuses pending, in_progress, or completed. At most one item may be in_progress.",
		promptSnippet: "Create and update a visible TODO list for multi-step implementation work",
		promptGuidelines: [
			"Use todo_update for work with multiple substantive implementation or verification steps; do not use it for trivial single-step requests.",
			"Call todo_update once requirements are clear and before beginning multi-step implementation. Do not use it merely to restate a read-only plan.",
			"When plan mode creates the initial TODO list, use todo_update for all subsequent execution progress.",
			"Pass the complete canonical list to todo_update on every call, preserving stable IDs and replacing stale completed lists when a new task begins.",
			"Keep at most one todo_update item in_progress, and mark an item completed immediately after its work is verified before advancing to the next item.",
			"Do not mark todo_update items completed before verification. At the end, leave the fully completed list visible rather than clearing it.",
		],
		parameters: TodoUpdateParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const normalized = normalizeTodos(params.todos);
			const explanation = normalizeExplanation(params.explanation);
			todos = normalized;
			updateUI(ctx);
			const details: TodoDetails = {
				version: TODO_STATE_VERSION,
				todos: cloneTodos(todos),
				explanation,
			};
			return {
				content: [{ type: "text", text: formatTodosForAgent(todos) }],
				details,
			};
		},

		renderCall(args, theme) {
			const count = Array.isArray(args.todos) ? args.todos.length : 0;
			let text = theme.fg("toolTitle", theme.bold("todo_update "));
			text += theme.fg("muted", `${count} item${count === 1 ? "" : "s"}`);
			if (args.explanation) {
				const explanation = args.explanation.replace(CONTROL_CHARACTERS_GLOBAL, "�");
				text += ` ${theme.fg("dim", `— ${explanation}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "", 0, 0);
			}

			const { completed, remaining } = counts(details.todos);
			let text = theme.fg(
				remaining === 0 ? "success" : "accent",
				remaining === 0
					? `✓ ${completed}/${details.todos.length} TODOs completed`
					: `TODOs updated · ${completed}/${details.todos.length} completed`,
			);
			const visible = expanded
				? details.todos
				: details.todos.filter((todo) => todo.status !== "completed").slice(0, 4);
			for (const todo of visible) text += `\n${themedTodoLine(todo, theme)}`;
			if (!expanded) {
				const hidden = details.todos.length - visible.length;
				if (hidden > 0) text += `\n${theme.fg("dim", `… ${hidden} more`)}`;
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "Show the complete agent TODO list for the current session branch",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify(formatTodosForAgent(todos), "info");
				return;
			}
			const snapshot = cloneTodos(todos);
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				return new TodoListComponent(snapshot, theme, () => done(), () => tui.requestRender());
			});
		},
	});
}
