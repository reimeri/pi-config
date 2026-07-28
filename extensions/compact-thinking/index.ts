import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

import {
	compactThinkingSummaries,
	detachAssistantController,
	detachContainerController,
	installContainerController,
	type AssistantComponentLike,
	type CompactThinkingController,
	type ContainerPatchState,
} from "./core.ts";

const CONTAINER_PATCH_KEY = Symbol.for("pi-global-compact-thinking:container-render-v1");
const ASSISTANT_PATCH_KEY = Symbol.for("pi-global-compact-thinking:assistant-update-v1");

function isAssistantComponent(value: unknown): value is AssistantComponentLike {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	const constructorName = (candidate.constructor as { name?: unknown } | undefined)?.name;
	return (
		constructorName === "AssistantMessageComponent"
		&& typeof candidate.render === "function"
		&& typeof candidate.updateContent === "function"
		&& candidate.contentContainer !== null
		&& typeof candidate.contentContainer === "object"
		&& "lastMessage" in candidate
	);
}

export default function compactThinkingExtension(pi: ExtensionAPI) {
	let active = false;
	let patchState: ContainerPatchState | undefined;
	// Pi rebuilds the whole chat from session messages on /thinking, theme, output-pad and
	// settings changes, on auto-compaction and on session switch, discarding every component
	// without emitting an extension event. Hold them weakly and drop the discarded ones as
	// new ones arrive, so a long session neither retains them nor re-renders them on shutdown.
	let tracked = new WeakSet<AssistantComponentLike>();
	let components: Array<WeakRef<AssistantComponentLike>> = [];

	const controller: CompactThinkingController = {
		isEnabled: () => active,
		isAssistantComponent,
		transformMessage: compactThinkingSummaries,
		attach(component) {
			if (tracked.has(component)) return;
			tracked.add(component);
			components = components.filter((ref) => ref.deref() !== undefined);
			components.push(new WeakRef(component));
		},
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		active = true;
		patchState = installContainerController(
			Container.prototype as unknown as Record<PropertyKey, unknown>,
			CONTAINER_PATCH_KEY,
			ASSISTANT_PATCH_KEY,
			controller,
		);
	});

	pi.on("session_shutdown", () => {
		active = false;
		if (patchState) detachContainerController(patchState, controller);
		patchState = undefined;
		for (const ref of components) {
			const component = ref.deref();
			if (component) detachAssistantController(component, ASSISTANT_PATCH_KEY, controller);
		}
		components = [];
		tracked = new WeakSet();
	});
}
