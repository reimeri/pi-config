import { afterEach, describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function findGlobalModules(): string {
	let current = dirname(process.execPath);
	while (true) {
		for (const candidate of [join(current, "node_modules"), join(current, "lib", "node_modules")]) {
			if (existsSync(join(candidate, "@earendil-works", "pi-coding-agent", "package.json"))) {
				return candidate;
			}
		}
		const parent = dirname(current);
		if (parent === current) throw new Error("Could not locate the active Pi installation");
		current = parent;
	}
}

const globalModules = findGlobalModules();
const piPackage = join(globalModules, "@earendil-works", "pi-coding-agent");
const loaderEntry = join(piPackage, "dist", "core", "extensions", "loader.js");
const themeEntry = join(piPackage, "dist", "modes", "interactive", "theme", "theme.js");
const assistantEntry = join(
	piPackage,
	"dist",
	"modes",
	"interactive",
	"components",
	"assistant-message.js",
);
const { loadExtensions } = await import(pathToFileURL(loaderEntry).href);
const { initTheme } = await import(pathToFileURL(themeEntry).href);
const { AssistantMessageComponent } = await import(pathToFileURL(assistantEntry).href);
initTheme("dark", false);
const extensionDir = dirname(fileURLToPath(import.meta.url));

function stripTerminalFormatting(value: string): string {
	return value
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\t ]+$/gm, "");
}

function message(summaries: string[]) {
	return {
		role: "assistant",
		content: summaries.map((summary, index) => ({
			type: "thinking",
			thinking: summary,
			thinkingSignature: `signature-${index}`,
		})),
		stopReason: "stop",
	};
}

function fakeContext() {
	return { mode: "tui", hasUI: true, ui: {} };
}

const shutdowns: Array<(...args: any[]) => unknown> = [];

afterEach(async () => {
	for (const shutdown of shutdowns.splice(0).reverse()) {
		await shutdown({}, fakeContext());
	}
});

describe("compact-thinking extension", () => {
	test("compacts history and live updates, preserves source messages, and restores on shutdown", async () => {
		const loadGeneration = async () => {
			const loaded = await loadExtensions([join(extensionDir, "index.ts")], extensionDir);
			expect(loaded.errors).toEqual([]);
			const extension = loaded.extensions[0];
			expect(extension).toBeDefined();
			const start = extension?.handlers.get("session_start")?.[0];
			const shutdown = extension?.handlers.get("session_shutdown")?.[0];
			expect(typeof start).toBe("function");
			expect(typeof shutdown).toBe("function");
			if (shutdown) shutdowns.push(shutdown);
			return { start, shutdown };
		};

		const source = message([
			"**Analyzing TUI overlay padding behavior**\n\n"
				+ "**Refining header mapping validation logic**\n\n"
				+ "**Planning synthetic overlay padding test**",
			"**Implementing overlay stack presence helper**\n\n"
				+ "**Defining line count compatibility formula**",
		]);
		const component = new AssistantMessageComponent(source as any);
		const first = await loadGeneration();
		await first.start?.({ reason: "startup" }, fakeContext());

		const compactedHistory = stripTerminalFormatting(component.render(100).join("\n"));
		expect(compactedHistory).toContain("×5 Defining line count compatibility formula");
		expect(compactedHistory).not.toContain("Analyzing TUI overlay padding behavior");
		expect(source.content).toHaveLength(2);
		expect(source.content[0]?.thinking).toContain("Analyzing TUI overlay padding behavior");

		const live = message([
			...source.content.map((block) => block.thinking),
			"**Checking the live update path**",
		]);
		component.updateContent(live as any);
		const compactedLive = stripTerminalFormatting(component.render(100).join("\n"));
		expect(compactedLive).toContain("×6 Checking the live update path");
		expect(compactedLive).not.toContain("Defining line count compatibility formula");
		expect(component.lastMessage).toBe(live);

		await first.shutdown?.({ reason: "reload" }, fakeContext());
		shutdowns.pop();
		const restored = stripTerminalFormatting(component.render(100).join("\n"));
		expect(restored).toContain("Analyzing TUI overlay padding behavior");
		expect(restored).toContain("Checking the live update path");
		expect(restored).not.toContain("×6");

		const second = await loadGeneration();
		await second.start?.({ reason: "reload" }, fakeContext());
		expect(stripTerminalFormatting(component.render(100).join("\n"))).toContain(
			"×6 Checking the live update path",
		);

		await second.shutdown?.({ reason: "quit" }, fakeContext());
		shutdowns.pop();
		const restoredAgain = stripTerminalFormatting(component.render(100).join("\n"));
		expect(restoredAgain).toContain("Analyzing TUI overlay padding behavior");
		expect(restoredAgain).not.toContain("×6");
	});
});
