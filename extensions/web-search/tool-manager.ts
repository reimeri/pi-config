export interface ToolSetController {
	getActiveTools(): string[];
	setActiveTools(toolNames: string[]): void;
}

export interface ApiModelLike {
	api: string;
}

const URL_CONTEXT_TOOL = "url_context";

function supportsUrlContext(model: ApiModelLike | undefined): boolean {
	return model?.api === "google-generative-ai";
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
	return left.size === right.size && [...left].every((value) => right.has(value));
}

/** Temporarily suppresses URL Context while preserving newly activated tools. */
export function createModelScopedToolManager(controller: ToolSetController) {
	let preferred: Set<string> | undefined;
	let lastApplied: Set<string> | undefined;
	let suppressed = new Set<string>();

	return {
		sync(model: ApiModelLike | undefined): void {
			const current = new Set(controller.getActiveTools());
			if (!preferred) {
				preferred = new Set(current);
			} else if (lastApplied) {
				for (const tool of current) if (!lastApplied.has(tool)) preferred.add(tool);
				for (const tool of lastApplied) {
					if (!current.has(tool) && !suppressed.has(tool)) preferred.delete(tool);
				}
			}

			const desired = new Set(preferred);
			suppressed = new Set<string>();
			if (!supportsUrlContext(model) && desired.delete(URL_CONTEXT_TOOL)) {
				suppressed.add(URL_CONTEXT_TOOL);
			}
			if (!setsEqual(current, desired)) controller.setActiveTools([...desired]);
			lastApplied = desired;
		},
	};
}
