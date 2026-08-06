import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Resolve Pi from the host installation under Node and Bun layouts.
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
const tuiEntry = join(
	globalModules,
	"@earendil-works",
	"pi-coding-agent",
	"node_modules",
	"@earendil-works",
	"pi-tui",
	"dist",
	"index.js",
);
const piPackage = join(globalModules, "@earendil-works", "pi-coding-agent");
const loaderEntry = join(piPackage, "dist", "core", "extensions", "loader.js");
const themeEntry = join(piPackage, "dist", "modes", "interactive", "theme", "theme.js");
const { Container, Spacer } = await import(pathToFileURL(tuiEntry).href);
const { loadExtensions } = await import(pathToFileURL(loaderEntry).href);
const { initTheme } = await import(pathToFileURL(themeEntry).href);
initTheme("dark", false);
const extensionDir = dirname(fileURLToPath(import.meta.url));

let fakeToolSequence = 0;

function fakeTool(name: string, args: Record<string, unknown>) {
	return {
		toolName: name,
		toolCallId: `id-${++fakeToolSequence}`,
		args,
		expanded: false,
		isPartial: false,
		executionStarted: true,
		result: { isError: false },
		setExpanded(expanded: boolean) {
			this.expanded = expanded;
		},
		updateResult() {},
		invalidate() {},
		render() {
			return [`FULL:${name}`];
		},
	};
}

function fakeTheme(colors: string[]) {
	return {
		fg: (color: string, text: string) => {
			colors.push(color);
			return text;
		},
		bold: (text: string) => text,
	};
}

function fakeContext(notices: string[], colors: string[]) {
	let expanded = false;
	return {
		mode: "tui",
		hasUI: true,
		ui: {
			theme: fakeTheme(colors),
			notify(message: string) {
				notices.push(message);
			},
			getToolsExpanded() {
				return expanded;
			},
			setToolsExpanded(value: boolean) {
				expanded = value;
			},
		},
	};
}

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

describe("tool-groups extension", () => {
	test("switches grouping modes, persists all mode, migrates legacy config, and detaches cleanly", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-tool-groups-test-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const notices: string[] = [];
		const colors: string[] = [];
		const ctx = fakeContext(notices, colors);
		const shutdowns: Array<(...args: any[]) => unknown> = [];

		const loadGeneration = async () => {
			const loaded = await loadExtensions([join(extensionDir, "index.ts")], extensionDir);
			expect(loaded.errors).toEqual([]);
			const extension = loaded.extensions[0];
			expect(extension).toBeDefined();
			const start = extension?.handlers.get("session_start")?.[0];
			const tree = extension?.handlers.get("session_tree")?.[0];
			const compact = extension?.handlers.get("session_compact")?.[0];
			const shutdown = extension?.handlers.get("session_shutdown")?.[0];
			const command = extension?.commands.get("tool-groups");
			const toolCommand = extension?.commands.get("tool");
			expect(typeof start).toBe("function");
			expect(typeof tree).toBe("function");
			expect(typeof compact).toBe("function");
			expect(typeof shutdown).toBe("function");
			expect(command).toBeDefined();
			expect(toolCommand).toBeDefined();
			if (shutdown) shutdowns.push(shutdown);
			return { start, tree, compact, shutdown, command, toolCommand };
		};

		const root = new Container();
		const readTool = fakeTool("read", { path: "/tmp/a.ts" });
		const bashTool = fakeTool("bash", { command: "printf ok" });
		root.addChild(readTool as any);
		root.addChild(new Spacer(1));
		root.addChild({
			hasToolCalls: true,
			contentContainer: { children: [] },
			render: () => [],
			invalidate() {},
		} as any);
		root.addChild(bashTool as any);

		const singleRoot = new Container();
		singleRoot.addChild(fakeTool("read", { path: "/tmp/single.ts" }) as any);

		const subagentRoot = new Container();
		subagentRoot.addChild(fakeTool("subagent", { agent: "scout", task: "Explore" }) as any);
		subagentRoot.addChild(fakeTool("subagent", {
			tasks: [
				{ agent: "scout", task: "Explore one" },
				{ agent: "reviewer", task: "Review" },
				{ agent: "scout", task: "Explore two" },
			],
		}) as any);

		try {
			const first = await loadGeneration();
			await first.start?.({}, ctx);
			const grouped = root.render(100).join("\n");
			expect(grouped).toContain("Tools × 2");
			expect(grouped).toContain("[1] Read /tmp/a.ts");
			expect(grouped).toContain("[2] Bash printf ok");
			expect(grouped).not.toContain("FULL:read");

			expect(first.toolCommand.getArgumentCompletions("")).toEqual([
				{ value: "open ", label: "open" },
				{ value: "close ", label: "close" },
				{ value: "toggle ", label: "toggle" },
				{ value: "close-all", label: "close-all" },
			]);
			expect(first.toolCommand.getArgumentCompletions("open ")).toEqual([
				{ value: "open 1", label: "1", description: "Read /tmp/a.ts" },
				{ value: "open 2", label: "2", description: "Bash printf ok" },
			]);

			await first.toolCommand.handler("open 2", ctx);
			expect(readTool.expanded).toBe(false);
			expect(bashTool.expanded).toBe(true);
			expect(root.render(100)).toEqual(["FULL:read", "", "FULL:bash"]);
			expect(notices.at(-1)).toBe("Tool 2 opened");

			await first.toolCommand.handler("close 2", ctx);
			expect(bashTool.expanded).toBe(false);
			expect(root.render(100).join("\n")).toContain("[2] Bash printf ok");

			await first.toolCommand.handler("open 1", ctx);
			await first.toolCommand.handler("open 2", ctx);
			ctx.ui.setToolsExpanded(true);
			await first.toolCommand.handler("close-all", ctx);
			expect(readTool.expanded).toBe(false);
			expect(bashTool.expanded).toBe(false);
			expect(ctx.ui.getToolsExpanded()).toBe(false);
			expect(root.render(100).join("\n")).toContain("Tools × 2");
			expect(notices.at(-1)).toBe("All tool output closed");

			await first.toolCommand.handler("toggle 1", ctx);
			expect(readTool.expanded).toBe(true);
			await first.toolCommand.handler("toggle 1", ctx);
			expect(readTool.expanded).toBe(false);
			expect(notices.at(-1)).toBe("Tool 1 closed");
			await first.toolCommand.handler("open 999", ctx);
			expect(notices.at(-1)).toBe("Unknown tool ID: 999");
			await first.toolCommand.handler("open nope", ctx);
			expect(notices.at(-1)).toBe(
				"Usage: /tool close-all or /tool open|close|toggle <id>",
			);

			const groupedSubagents = subagentRoot.render(100).join("\n");
			expect(groupedSubagents).toContain("Subagent (scout) Explore");
			expect(groupedSubagents).toContain("Subagent (2 scouts, reviewer)");
			expect(colors).toContain("thinkingLow");
			expect(colors).not.toContain("success");
			expect(singleRoot.render(100)).toEqual(["FULL:read"]);
			expect(root.render(0)).toEqual([]);

			// Expanded groups omit off-screen headers to avoid full transcript repaint.
			readTool.expanded = true;
			bashTool.expanded = true;
			expect(root.render(100)).toEqual(["FULL:read", "", "FULL:bash"]);
			readTool.expanded = false;
			bashTool.expanded = false;
			expect(root.render(100).join("\n")).toContain("Tools × 2");

			await first.command.handler("all", ctx);
			const groupedSingle = singleRoot.render(100).join("\n");
			expect(groupedSingle).toContain("Read × 1");
			expect(groupedSingle).toContain("Read /tmp/single.ts");
			expect(groupedSingle).not.toContain("FULL:read");
			expect(JSON.parse(readFileSync(join(agentDir, "tool-groups.json"), "utf8"))).toEqual({
				version: 2,
				mode: "all",
			});

			// Match Pi's reload order: shutdown, load, start.
			await first.shutdown?.({ reason: "reload" }, ctx);
			const second = await loadGeneration();
			await second.start?.({ reason: "reload" }, ctx);
			const reloadedGroup = root.render(100).join("\n");
			expect(reloadedGroup).toContain("[1] Read /tmp/a.ts");
			expect(reloadedGroup).toContain("[2] Bash printf ok");
			expect(singleRoot.render(100).join("\n")).toContain("Read × 1");

			await second.compact?.({}, ctx);
			const compactedRoot = new Container();
			compactedRoot.addChild(bashTool as any);
			expect(compactedRoot.render(100).join("\n")).toContain("[1] Bash printf ok");
			expect(second.toolCommand.getArgumentCompletions("open ")).toEqual([
				{ value: "open 1", label: "1", description: "Bash printf ok" },
			]);

			await second.command.handler("status", ctx);
			expect(notices.at(-1)).toBe("Tool grouping: all");

			await second.command.handler("consecutive", ctx);
			expect(singleRoot.render(100)).toEqual(["FULL:read"]);
			expect(root.render(100).join("\n")).toContain("Tools × 2");

			await second.command.handler("toggle", ctx);
			expect(root.render(100)).toEqual(["FULL:read", "", "FULL:bash"]);
			readTool.expanded = true;
			bashTool.expanded = true;
			ctx.ui.setToolsExpanded(true);
			await second.toolCommand.handler("close-all", ctx);
			expect(readTool.expanded).toBe(false);
			expect(bashTool.expanded).toBe(false);
			expect(ctx.ui.getToolsExpanded()).toBe(false);
			expect(notices.at(-1)).toBe("All tool output closed");

			await second.command.handler("toggle", ctx);
			expect(root.render(100).join("\n")).toContain("Tools × 2");
			expect(singleRoot.render(100)).toEqual(["FULL:read"]);
			expect(notices.at(-1)).toBe("Tool grouping: consecutive");

			await second.tree?.({}, ctx);
			const renumberedGroup = root.render(100).join("\n");
			expect(renumberedGroup).toContain("[1] Read /tmp/a.ts");
			expect(renumberedGroup).toContain("[2] Bash printf ok");

			await second.shutdown?.({ reason: "reload" }, ctx);
			writeFileSync(
				join(agentDir, "tool-groups.json"),
				`${JSON.stringify({ version: 1, enabled: false }, null, 2)}\n`,
			);
			const third = await loadGeneration();
			await third.start?.({ reason: "reload" }, ctx);
			expect(root.render(100)).toEqual(["FULL:read", "", "FULL:bash"]);
			await third.toolCommand.handler("open 1", ctx);
			expect(notices.at(-1)).toBe(
				"Tool grouping is off; enable it with /tool-groups consecutive or all",
			);
			expect(JSON.parse(readFileSync(join(agentDir, "tool-groups.json"), "utf8"))).toEqual({
				version: 2,
				mode: "off",
			});

			await third.command.handler("on", ctx);
			expect(root.render(100).join("\n")).toContain("Tools × 2");
			expect(JSON.parse(readFileSync(join(agentDir, "tool-groups.json"), "utf8"))).toEqual({
				version: 2,
				mode: "consecutive",
			});
		} finally {
			for (const shutdown of shutdowns.reverse()) await shutdown({}, ctx);
			rmSync(agentDir, { recursive: true, force: true });
		}

		// Shutdown removes only this generation's controller and restores normal rendering.
		expect(root.render(100)).toEqual(["FULL:read", "", "FULL:bash"]);
	});
});
