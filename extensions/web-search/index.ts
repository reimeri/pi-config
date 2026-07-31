import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createModelScopedToolManager } from "./tool-manager.ts";
import { urlContextTool, webSearchTool } from "./tools.ts";

export default function webSearchExtension(pi: ExtensionAPI) {
	pi.registerTool(webSearchTool);
	pi.registerTool(urlContextTool);
	const toolManager = createModelScopedToolManager(pi);

	pi.on("session_start", (_event, ctx) => toolManager.sync(ctx.model));
	pi.on("session_tree", (_event, ctx) => toolManager.sync(ctx.model));
	pi.on("model_select", (event) => toolManager.sync(event.model));

	// Recheck compatibility if another extension reactivates a tool.
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === "url_context" && ctx.model?.api !== "google-generative-ai") {
			return {
				block: true,
				reason: "url_context requires the current Google Gemini model",
			};
		}
	});
}
