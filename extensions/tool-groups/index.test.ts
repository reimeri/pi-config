import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Global extensions rely on Pi's loader aliases rather than a local node_modules, so the test's
// direct TUI import is resolved against the active installation. Both layouts are checked at each
// level: node keeps global packages under `lib/node_modules`, while a bun binary is itself installed
// inside `node_modules` and so reaches it by walking up alone.
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

function fakeTool(name: string, args: Record<string, unknown>) {
	return {
		toolName: name,
		toolCallId: `id-${name}`,
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
			const shutdown = extension?.handlers.get("session_shutdown")?.[0];
			const command = extension?.commands.get("tool-groups");
			expect(typeof start).toBe("function");
			expect(typeof shutdown).toBe("function");
			expect(command).toBeDefined();
			if (shutdown) shutdowns.push(shutdown);
			return { start, shutdown, command };
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

		try {
			const first = await loadGeneration();
			await first.start?.({}, ctx);
			const grouped = root.render(100).join("\n");
			expect(grouped).toContain("Tools × 2");
			expect(grouped).toContain("Read /tmp/a.ts");
			expect(grouped).toContain("Bash printf ok");
			expect(grouped).not.toContain("FULL:read");
			expect(colors).toContain("thinkingLow");
			expect(colors).not.toContain("success");
			expect(singleRoot.render(100)).toEqual(["FULL:read"]);
			expect(root.render(0)).toEqual([]);

			readTool.expanded = true;
			bashTool.expanded = true;
			const expanded = root.render(100).join("\n");
			expect(expanded).toContain("FULL:read");
			expect(expanded).toContain("FULL:bash");
			readTool.expanded = false;
			bashTool.expanded = false;

			await first.command.handler("all", ctx);
			const groupedSingle = singleRoot.render(100).join("\n");
			expect(groupedSingle).toContain("Read × 1");
			expect(groupedSingle).toContain("Read /tmp/single.ts");
			expect(groupedSingle).not.toContain("FULL:read");
			expect(JSON.parse(readFileSync(join(agentDir, "tool-groups.json"), "utf8"))).toEqual({
				version: 2,
				mode: "all",
			});

			// Match Pi's real reload order: old shutdown, new module load, new start.
			await first.shutdown?.({ reason: "reload" }, ctx);
			const second = await loadGeneration();
			await second.start?.({ reason: "reload" }, ctx);
			expect(singleRoot.render(100).join("\n")).toContain("Read × 1");
			await second.command.handler("status", ctx);
			expect(notices.at(-1)).toBe("Tool grouping: all");

			await second.command.handler("consecutive", ctx);
			expect(singleRoot.render(100)).toEqual(["FULL:read"]);
			expect(root.render(100).join("\n")).toContain("Tools × 2");

			await second.command.handler("toggle", ctx);
			expect(root.render(100)).toEqual(["FULL:read", "", "FULL:bash"]);

			await second.command.handler("toggle", ctx);
			expect(root.render(100).join("\n")).toContain("Tools × 2");
			expect(singleRoot.render(100)).toEqual(["FULL:read"]);
			expect(notices.at(-1)).toBe("Tool grouping: consecutive");

			await second.shutdown?.({ reason: "reload" }, ctx);
			writeFileSync(
				join(agentDir, "tool-groups.json"),
				`${JSON.stringify({ version: 1, enabled: false }, null, 2)}\n`,
			);
			const third = await loadGeneration();
			await third.start?.({ reason: "reload" }, ctx);
			expect(root.render(100)).toEqual(["FULL:read", "", "FULL:bash"]);
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

		// The stable global wrapper remains, but shutdown removes this generation's
		// controller so normal Container rendering is restored byte-for-byte.
		expect(root.render(100)).toEqual(["FULL:read", "", "FULL:bash"]);
	});
});
