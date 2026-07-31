export interface MessageLike {
	role?: string;
	content: unknown[];
	[key: string]: unknown;
}

interface ThinkingBlock {
	type: "thinking";
	thinking: string;
	[key: string]: unknown;
}

interface SummaryEntry {
	text: string;
	block: ThinkingBlock;
}

export interface RenderableContainer {
	render(width: number): string[];
}

export interface AssistantComponentLike extends RenderableContainer {
	updateContent(message: MessageLike): unknown;
	lastMessage?: MessageLike;
}

export type OriginalContainerRender = (this: RenderableContainer, width: number) => string[];
export type OriginalUpdateContent = (this: AssistantComponentLike, message: MessageLike) => unknown;

export interface CompactThinkingController {
	isEnabled(): boolean;
	isAssistantComponent(value: unknown): value is AssistantComponentLike;
	transformMessage(message: MessageLike): MessageLike;
	attach(component: AssistantComponentLike): void;
}

export interface ContainerPatchState {
	originalRender: OriginalContainerRender;
	controller?: CompactThinkingController;
	dispatch?: typeof renderContainerWithCompactThinking;
	assistantPatchKey: symbol;
}

export interface AssistantPatchState {
	originalUpdateContent: OriginalUpdateContent;
	controller?: CompactThinkingController;
	transform?: CompactThinkingController["transformMessage"];
}

function isThinkingBlock(value: unknown): value is ThinkingBlock {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return candidate.type === "thinking" && typeof candidate.thinking === "string";
}

function splitParagraphs(text: string): string[] {
	const trimmed = text.trim();
	return trimmed ? trimmed.split(/\r?\n[\t ]*\r?\n+/).map((part) => part.trim()) : [];
}

function isCompleteTitleSummary(text: string): boolean {
	if (!text.startsWith("**") || !text.endsWith("**") || text.length <= 4) return false;
	const inner = text.slice(2, -2);
	return (
		inner.length > 0
		&& inner.trim() === inner
		&& !inner.includes("**")
		&& !/[\r\n]/.test(inner)
	);
}

function isPartialTitleSummary(text: string): boolean {
	if (!text.startsWith("**") || text.endsWith("**")) return false;
	const inner = text.slice(2);
	return (
		inner.length > 0
		&& inner.trimStart() === inner
		&& !inner.includes("**")
		&& !/[\r\n]/.test(inner)
	);
}

function isPendingTitlePrefix(text: string): boolean {
	return text === "*" || text === "**";
}

function compactThinkingRun(run: ThinkingBlock[]): ThinkingBlock[] {
	const entries: SummaryEntry[] = [];
	for (const block of run) {
		for (const paragraph of splitParagraphs(block.thinking)) {
			entries.push({ text: paragraph, block });
		}
	}

	// Avoid flashing the run while a streamed title contains only its opening marker.
	if (entries.length > 1 && isPendingTitlePrefix(entries.at(-1)!.text)) entries.pop();
	if (entries.length < 2) return run;
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index]!;
		const isLast = index === entries.length - 1;
		if (!isCompleteTitleSummary(entry.text) && !(isLast && isPartialTitleSummary(entry.text))) {
			return run;
		}
	}

	const latest = entries.at(-1)!;
	return [{ ...latest.block, thinking: `×${entries.length} ${latest.text}` }];
}

/** Create a presentation-only copy without changing signed provider content. */
export function compactThinkingSummaries(message: MessageLike): MessageLike {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return message;

	const compacted: unknown[] = [];
	let changed = false;
	for (let index = 0; index < message.content.length;) {
		const content = message.content[index];
		if (!isThinkingBlock(content)) {
			compacted.push(content);
			index++;
			continue;
		}

		const run: ThinkingBlock[] = [];
		while (index < message.content.length && isThinkingBlock(message.content[index])) {
			run.push(message.content[index] as ThinkingBlock);
			index++;
		}
		const replacement = compactThinkingRun(run);
		if (replacement !== run) changed = true;
		compacted.push(...replacement);
	}

	return changed ? { ...message, content: compacted } : message;
}

function installAssistantUpdateController(
	component: AssistantComponentLike,
	patchKey: symbol,
	controller: CompactThinkingController,
): void {
	const target = component as AssistantComponentLike & Record<PropertyKey, unknown>;
	let state = target[patchKey] as AssistantPatchState | undefined;
	if (!state) {
		const originalUpdateContent = target.updateContent;
		if (typeof originalUpdateContent !== "function") return;

		state = { originalUpdateContent };
		const stableState = state;
		target.updateContent = function compactThinkingUpdate(message: MessageLike): unknown {
			const activeController = stableState.controller;
			const transform = stableState.transform;
			let presentation = message;
			if (activeController?.isEnabled() && transform) {
				try {
					presentation = transform(message);
				} catch {
					presentation = message;
				}
			}

			const result = stableState.originalUpdateContent.call(this, presentation);
			// Preserve provider content because Pi rebuilds views from lastMessage.
			if (presentation !== message) this.lastMessage = message;
			return result;
		};
		target[patchKey] = state;
	}

	const generationChanged = state.controller !== controller;
	state.controller = controller;
	state.transform = controller.transformMessage;
	controller.attach(component);
	if (generationChanged && component.lastMessage) {
		component.updateContent(component.lastMessage);
	}
}

export function renderContainerWithCompactThinking(
	container: RenderableContainer,
	width: number,
	originalRender: OriginalContainerRender,
	controller: CompactThinkingController,
	assistantPatchKey: symbol,
): string[] {
	if (controller.isEnabled() && controller.isAssistantComponent(container)) {
		installAssistantUpdateController(container, assistantPatchKey, controller);
	}
	return originalRender.call(container, width);
}

export function installContainerController(
	prototype: Record<PropertyKey, unknown>,
	patchKey: symbol,
	assistantPatchKey: symbol,
	controller: CompactThinkingController,
): ContainerPatchState {
	let state = prototype[patchKey] as ContainerPatchState | undefined;
	if (!state) {
		const originalRender = prototype.render;
		if (typeof originalRender !== "function") {
			throw new Error("Pi TUI Container.render is unavailable");
		}

		state = {
			originalRender: originalRender as OriginalContainerRender,
			assistantPatchKey,
		};
		const stableState = state;
		prototype.render = function compactThinkingRender(
			this: RenderableContainer,
			width: number,
		): string[] {
			const activeController = stableState.controller;
			const dispatch = stableState.dispatch;
			if (!activeController || !dispatch) {
				return stableState.originalRender.call(this, width);
			}
			return dispatch(
				this,
				width,
				stableState.originalRender,
				activeController,
				stableState.assistantPatchKey,
			);
		};
		prototype[patchKey] = state;
	}

	// Update the permanent wrapper's generation state without retaining stale controllers.
	state.controller = controller;
	state.dispatch = renderContainerWithCompactThinking;
	state.assistantPatchKey = assistantPatchKey;
	return state;
}

export function detachContainerController(
	state: ContainerPatchState,
	controller: CompactThinkingController,
): void {
	if (state.controller !== controller) return;
	state.controller = undefined;
	state.dispatch = undefined;
}

export function detachAssistantController(
	component: AssistantComponentLike,
	patchKey: symbol,
	controller: CompactThinkingController,
): void {
	const target = component as AssistantComponentLike & Record<PropertyKey, unknown>;
	const state = target[patchKey] as AssistantPatchState | undefined;
	if (!state || state.controller !== controller) return;

	state.controller = undefined;
	state.transform = undefined;
	if (component.lastMessage) {
		state.originalUpdateContent.call(component, component.lastMessage);
	}
}
