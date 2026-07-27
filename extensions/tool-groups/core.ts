export interface RenderableComponent {
	render(width: number): string[];
}

export interface ContainerLike extends RenderableComponent {
	children?: RenderableComponent[];
}

export interface ToolLike extends RenderableComponent {
	toolName: string;
	toolCallId: string;
	args?: unknown;
	expanded?: boolean;
	isPartial?: boolean;
	executionStarted?: boolean;
	result?: { isError?: boolean };
	setExpanded?: (expanded: boolean) => void;
	updateResult?: (...args: unknown[]) => void;
	callRendererComponent?: unknown;
}

export type OriginalContainerRender = (this: ContainerLike, width: number) => string[];

export interface GroupRenderController {
	isEnabled(): boolean;
	isTool(component: unknown): component is ToolLike;
	isIgnorableSeparator(component: unknown): boolean;
	renderGroup(tools: ToolLike[], width: number): string[];
}

export interface GroupPlan {
	start: number;
	end: number;
	tools: ToolLike[];
}

export interface ContainerRenderPatchState {
	originalRender: OriginalContainerRender;
	controller?: GroupRenderController;
	dispatch?: typeof renderContainerWithGroups;
}

export function buildGroupPlans(
	children: readonly unknown[],
	isTool: GroupRenderController["isTool"],
	isIgnorableSeparator: GroupRenderController["isIgnorableSeparator"],
): GroupPlan[] {
	const plans: GroupPlan[] = [];
	let index = 0;

	while (index < children.length) {
		const first = children[index];
		if (!isTool(first)) {
			index++;
			continue;
		}

		const tools: ToolLike[] = [first];
		let cursor = index + 1;
		let end = cursor;

		while (cursor < children.length) {
			const bridgeStart = cursor;
			while (cursor < children.length && isIgnorableSeparator(children[cursor])) cursor++;

			const candidate = children[cursor];
			if (!isTool(candidate)) {
				cursor = bridgeStart;
				break;
			}

			tools.push(candidate);
			cursor++;
			end = cursor;
		}

		if (tools.length >= 2) {
			plans.push({ start: index, end, tools });
			index = end;
		} else {
			index++;
		}
	}

	return plans;
}

export function renderContainerWithGroups(
	container: ContainerLike,
	width: number,
	originalRender: OriginalContainerRender,
	controller: GroupRenderController,
): string[] {
	if (!controller.isEnabled() || !Array.isArray(container.children) || container.children.length < 2) {
		return originalRender.call(container, width);
	}

	const plans = buildGroupPlans(
		container.children,
		controller.isTool,
		controller.isIgnorableSeparator,
	);
	if (plans.length === 0) return originalRender.call(container, width);

	const lines: string[] = [];
	let childIndex = 0;
	let planIndex = 0;

	while (childIndex < container.children.length) {
		const plan = plans[planIndex];
		if (plan && childIndex === plan.start) {
			lines.push(...controller.renderGroup(plan.tools, width));
			childIndex = plan.end;
			planIndex++;
			continue;
		}

		lines.push(...container.children[childIndex]!.render(width));
		childIndex++;
	}

	return lines;
}

export function installContainerRenderController(
	prototype: Record<PropertyKey, unknown>,
	patchKey: symbol,
	controller: GroupRenderController,
): ContainerRenderPatchState {
	let state = prototype[patchKey] as ContainerRenderPatchState | undefined;
	if (!state) {
		const originalRender = prototype.render;
		if (typeof originalRender !== "function") {
			throw new Error("Pi TUI Container.render is unavailable");
		}

		state = { originalRender: originalRender as OriginalContainerRender };
		const stableState = state;
		prototype.render = function groupedContainerRender(this: ContainerLike, width: number): string[] {
			const activeController = stableState.controller;
			const dispatch = stableState.dispatch;
			if (!activeController || !dispatch) {
				return stableState.originalRender.call(this, width);
			}
			return dispatch(this, width, stableState.originalRender, activeController);
		};
		prototype[patchKey] = state;
	}

	// Both fields are replaced on every extension generation. The tiny permanent
	// routing wrapper remains, but it retains no stale controller or dispatch code.
	state.controller = controller;
	state.dispatch = renderContainerWithGroups;
	return state;
}

export function detachContainerRenderController(
	state: ContainerRenderPatchState,
	controller: GroupRenderController,
): void {
	if (state.controller !== controller) return;
	state.controller = undefined;
	state.dispatch = undefined;
}

export type ToolStatus = "running" | "pending" | "done" | "failed";

export function toolStatus(tool: ToolLike): ToolStatus {
	if (tool.result?.isError) return "failed";
	if (tool.result && tool.isPartial !== true) return "done";
	if (tool.executionStarted === true && tool.isPartial === true) return "running";
	return "pending";
}

export function humanizeToolName(name: string): string {
	const words = name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.trim();
	if (!words) return "Tool";
	return words.charAt(0).toUpperCase() + words.slice(1);
}

const MAX_SUMMARY_SOURCE_CHARS = 4_096;
const MAX_FALLBACK_FIELDS = 6;

function scalar(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value.length > MAX_SUMMARY_SOURCE_CHARS
			? `${value.slice(0, MAX_SUMMARY_SOURCE_CHARS)}…`
			: value;
	}
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

export function sanitizeSummary(value: unknown): string {
	const source = String(value ?? "");
	const bounded = source.length > MAX_SUMMARY_SOURCE_CHARS
		? `${source.slice(0, MAX_SUMMARY_SOURCE_CHARS)}…`
		: source;
	return bounded
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function fallbackArgSummary(args: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const key in args) {
		if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
		const value = args[key];
		const text = scalar(value)
			?? (Array.isArray(value)
				? `[${value.length} item${value.length === 1 ? "" : "s"}]`
				: value && typeof value === "object"
					? "{…}"
					: String(value));
		parts.push(`${key}=${text}`);
		if (parts.length >= MAX_FALLBACK_FIELDS) break;
	}
	return sanitizeSummary(parts.join(", "));
}

export function summarizeToolArgs(tool: ToolLike): string {
	const args = tool.args && typeof tool.args === "object"
		? tool.args as Record<string, unknown>
		: {};
	const name = tool.toolName.toLowerCase();

	if (name === "bash") return sanitizeSummary(scalar(args.command));
	if (name === "read" || name === "write" || name === "edit") {
		const path = scalar(args.path) ?? scalar(args.file_path);
		const range = [
			scalar(args.offset) ? `offset ${scalar(args.offset)}` : "",
			scalar(args.limit) ? `limit ${scalar(args.limit)}` : "",
		].filter(Boolean).join(", ");
		return sanitizeSummary(`${path ?? ""}${range ? ` (${range})` : ""}`);
	}
	if (name === "grep") {
		const pattern = scalar(args.pattern) ?? "";
		const path = scalar(args.path);
		return sanitizeSummary(`${pattern ? `“${pattern}”` : ""}${path ? ` in ${path}` : ""}`);
	}
	if (name === "find") {
		const pattern = scalar(args.pattern) ?? "";
		const path = scalar(args.path);
		return sanitizeSummary(`${pattern}${path ? ` in ${path}` : ""}`);
	}
	if (name === "ls") return sanitizeSummary(scalar(args.path) ?? ".");
	if (name === "apply_patch") {
		const patch = scalar(args.patch) ?? scalar(args.input) ?? "";
		const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
			.map((match) => match[1]!.trim());
		if (files.length === 1) return files[0]!;
		if (files.length > 1) return `${files.length} files`;
	}

	for (const key of [
		"path",
		"file_path",
		"command",
		"query",
		"pattern",
		"url",
		"description",
		"subject",
		"name",
		"task",
		"prompt",
	]) {
		const value = scalar(args[key]);
		if (value) return sanitizeSummary(value);
	}

	return fallbackArgSummary(args);
}
