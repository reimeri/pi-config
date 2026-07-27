import { describe, expect, test } from "vitest";
import { createModelScopedToolManager } from "./tool-manager.ts";

describe("model-scoped URL Context visibility", () => {
	test("suppresses URL Context, preserves dynamic tools, and restores it for Gemini", () => {
		let active = ["read", "web_search", "url_context"];
		const manager = createModelScopedToolManager({
			getActiveTools: () => [...active],
			setActiveTools: (names) => { active = [...names]; },
		});

		manager.sync({ api: "openai-responses" });
		expect(active).toEqual(["read", "web_search"]);
		active.push("dynamic_tool");
		manager.sync({ api: "openai-responses" });
		expect(active).toEqual(["read", "web_search", "dynamic_tool"]);
		manager.sync({ api: "google-generative-ai" });
		expect(active).toEqual(["read", "web_search", "url_context", "dynamic_tool"]);
	});

	test("respects a user's explicit tool removal", () => {
		let active = ["read", "web_search", "url_context"];
		const manager = createModelScopedToolManager({
			getActiveTools: () => [...active],
			setActiveTools: (names) => { active = [...names]; },
		});
		manager.sync({ api: "google-generative-ai" });
		active = ["read", "url_context"];
		manager.sync({ api: "google-generative-ai" });
		manager.sync({ api: "openai-responses" });
		manager.sync({ api: "google-generative-ai" });
		expect(active).toEqual(["read", "url_context"]);
	});
});
