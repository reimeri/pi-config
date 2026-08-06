import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { keyHint, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth } from "@earendil-works/pi-tui";

import {
	detachContainerRenderController,
	humanizeToolName,
	installContainerRenderController,
	sanitizeSummary,
	summarizeToolArgs,
	toolStatus,
	ToolAddressBook,
	type ContainerRenderPatchState,
	type GroupRenderController,
	type ToolLike,
	type ToolStatus,
} from "./core.ts";

const PATCH_KEY = Symbol.for("pi-global-tool-groups:container-render-v1");
const CONFIG_VERSION = 2;

type ToolGroupingMode = "off" | "consecutive" | "all";

interface ToolGroupsConfig {
	version: typeof CONFIG_VERSION;
	mode: ToolGroupingMode;
}

interface LoadedConfig {
	config: ToolGroupsConfig;
	warning?: string;
}

function configPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(agentDir, "tool-groups.json");
}

function defaultConfig(): ToolGroupsConfig {
	return { version: CONFIG_VERSION, mode: "consecutive" };
}

function isGroupingMode(value: unknown): value is ToolGroupingMode {
	return value === "off" || value === "consecutive" || value === "all";
}

function loadConfig(): LoadedConfig {
	const path = configPath();
	if (!existsSync(path)) return { config: defaultConfig() };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		if (parsed.version === CONFIG_VERSION && isGroupingMode(parsed.mode)) {
			return { config: { version: CONFIG_VERSION, mode: parsed.mode } };
		}
		if (parsed.version === 1 && typeof parsed.enabled === "boolean") {
			const config: ToolGroupsConfig = {
				version: CONFIG_VERSION,
				mode: parsed.enabled ? "consecutive" : "off",
			};
			try {
				saveConfig(config);
				return { config };
			} catch (error) {
				return {
					config,
					warning: `Could not migrate tool-group config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}
		return {
			config: defaultConfig(),
			warning: `Ignoring invalid tool-group config at ${path}`,
		};
	} catch (error) {
		return {
			config: defaultConfig(),
			warning: `Could not read tool-group config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function saveConfig(config: ToolGroupsConfig): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporaryPath, path);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

function isToolComponent(value: unknown): value is ToolLike {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.toolName === "string"
		&& typeof candidate.toolCallId === "string"
		&& typeof candidate.render === "function"
		&& typeof candidate.setExpanded === "function"
		&& typeof candidate.updateResult === "function"
	);
}

function isIgnorableSeparator(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	const constructorName = (candidate.constructor as { name?: unknown } | undefined)?.name;
	if (constructorName === "Spacer" && typeof candidate.render === "function") return true;

	const contentContainer = candidate.contentContainer as { children?: unknown } | undefined;
	return (
		(constructorName === "AssistantMessageComponent" || "hasToolCalls" in candidate)
		&& Array.isArray(contentContainer?.children)
		&& contentContainer.children.length === 0
	);
}

function statusDot(status: ToolStatus, theme: Theme): string {
	if (status === "failed") return theme.fg("error", "●");
	if (status === "done") return theme.fg("thinkingLow", "●");
	if (status === "running") return theme.fg("warning", "●");
	return theme.fg("muted", "○");
}

function aggregateStatus(tools: ToolLike[]): ToolStatus {
	const statuses = tools.map(toolStatus);
	if (statuses.includes("failed")) return "failed";
	if (statuses.includes("running")) return "running";
	if (statuses.includes("pending")) return "pending";
	return "done";
}

function groupLabel(tools: ToolLike[]): string {
	const firstName = tools[0]?.toolName;
	if (firstName && tools.every((tool) => tool.toolName === firstName)) {
		return `${humanizeToolName(firstName)} × ${tools.length}`;
	}
	return `Tools × ${tools.length}`;
}

function statusCounts(tools: ToolLike[], theme: Theme): string {
	const counts: Record<ToolStatus, number> = { running: 0, pending: 0, done: 0, failed: 0 };
	for (const tool of tools) counts[toolStatus(tool)]++;

	const parts: string[] = [];
	if (counts.running) parts.push(theme.fg("warning", `${counts.running} running`));
	if (counts.pending) parts.push(theme.fg("muted", `${counts.pending} pending`));
	if (counts.done) parts.push(theme.fg("thinkingLow", `${counts.done} done`));
	if (counts.failed) parts.push(theme.fg("error", `${counts.failed} failed`));
	return parts.join(theme.fg("dim", " · "));
}

function formatHeader(tools: ToolLike[], width: number, theme: Theme): string {
	const label = theme.fg("toolTitle", theme.bold(groupLabel(tools)));
	const counts = statusCounts(tools, theme);
	const hint = keyHint("app.tools.expand", "to expand");
	return truncateToWidth(
		` ${statusDot(aggregateStatus(tools), theme)} ${label} ${theme.fg("dim", "—")} ${counts} ${theme.fg("dim", "·")} ${hint}`,
		Math.max(1, width),
		"",
	);
}

function formatCompactTool(
	tool: ToolLike,
	id: number,
	index: number,
	total: number,
	width: number,
	theme: Theme,
): string {
	const branch = index === total - 1 ? "└" : "├";
	const label = humanizeToolName(tool.toolName);
	const summary = sanitizeSummary(summarizeToolArgs(tool));
	const body = summary
		? `${theme.fg("toolTitle", label)} ${theme.fg("dim", summary)}`
		: theme.fg("toolTitle", label);
	return truncateToWidth(
		` ${theme.fg("dim", branch)} ${statusDot(toolStatus(tool), theme)} ${theme.fg("muted", `[${id}]`)} ${body}`,
		Math.max(1, width),
		"",
	);
}

function renderCollapsedGroup(
	tools: ToolLike[],
	width: number,
	theme: Theme,
	addressBook: ToolAddressBook,
): string[] {
	return [
		"",
		formatHeader(tools, width, theme),
		...tools.map((tool, index) =>
			formatCompactTool(tool, addressBook.register(tool), index, tools.length, width, theme)),
	];
}

const TOOL_ACTIONS = ["open", "close", "toggle"] as const;
type ToolAction = typeof TOOL_ACTIONS[number];

function isToolAction(value: string): value is ToolAction {
	return TOOL_ACTIONS.includes(value as ToolAction);
}

function toolArgumentCompletions(prefix: string, addressBook: ToolAddressBook) {
	const actionMatch = /^(\S*)$/.exec(prefix);
	if (actionMatch) {
		const actionPrefix = actionMatch[1]!.toLowerCase();
		return TOOL_ACTIONS
			.filter((action) => action.startsWith(actionPrefix))
			.map((action) => ({ value: `${action} `, label: action }));
	}

	const idMatch = /^(\S+)\s+(\S*)$/.exec(prefix);
	if (!idMatch) return [];
	const action = idMatch[1]!.toLowerCase();
	if (!isToolAction(action)) return [];
	const idPrefix = idMatch[2]!;
	return addressBook.entries()
		.filter(({ id }) => String(id).startsWith(idPrefix))
		.map(({ id, tool }) => {
			const summary = summarizeToolArgs(tool);
			return {
				value: `${action} ${id}`,
				label: String(id),
				description: `${humanizeToolName(tool.toolName)}${summary ? ` ${summary}` : ""}`,
			};
		});
}

export default function toolGroupsExtension(pi: ExtensionAPI) {
	let mode = loadConfig().config.mode;
	const addressBook = new ToolAddressBook();
	let active = false;
	let activeTheme: (() => Theme) | undefined;
	let patchState: ContainerRenderPatchState | undefined;

	const controller: GroupRenderController = {
		isEnabled: () => active && mode !== "off" && activeTheme !== undefined,
		minimumGroupSize: () => mode === "all" ? 1 : 2,
		isTool(value): value is ToolLike {
			if (!isToolComponent(value)) return false;
			addressBook.register(value);
			return true;
		},
		isIgnorableSeparator,
		renderGroup(tools, width) {
			if (!Number.isFinite(width) || width <= 0) return [];
			const theme = activeTheme?.();
			if (!theme) return undefined;
			// Avoid differential updates when expanded headers may be off-screen.
			if (tools.some((tool) => tool.expanded === true)) return undefined;
			return renderCollapsedGroup(tools, Math.floor(width), theme, addressBook);
		},
	};

	pi.registerCommand("tool", {
		description: "Open, close, or toggle one numbered tool call",
		getArgumentCompletions(prefix) {
			return toolArgumentCompletions(prefix, addressBook);
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const action = parts[0]?.toLowerCase() ?? "";
			const idText = parts[1] ?? "";
			if (
				parts.length !== 2
				|| !isToolAction(action)
				|| !/^[1-9]\d*$/.test(idText)
			) {
				ctx.ui.notify("Usage: /tool open|close|toggle <id>", "error");
				return;
			}
			if (mode === "off") {
				ctx.ui.notify("Tool grouping is off; enable it with /tool-groups consecutive or all", "error");
				return;
			}

			const id = Number(idText);
			const tool = Number.isSafeInteger(id) ? addressBook.getTool(id) : undefined;
			if (!tool || !tool.setExpanded) {
				ctx.ui.notify(`Unknown tool ID: ${idText}`, "error");
				return;
			}

			const expanded = action === "open"
				? true
				: action === "close"
					? false
					: tool.expanded !== true;
			tool.setExpanded(expanded);
			ctx.ui.notify(`Tool ${id} ${expanded ? "opened" : "closed"}`, "info");
		},
	});

	pi.registerCommand("tool-groups", {
		description: "Set tool grouping to consecutive, all (including singles), or off",
		getArgumentCompletions(prefix) {
			return ["consecutive", "all", "off", "status", "on", "toggle"]
				.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase() || "status";
			if (command === "status") {
				ctx.ui.notify(`Tool grouping: ${mode}`, "info");
				return;
			}

			let nextMode: ToolGroupingMode;
			if (isGroupingMode(command)) nextMode = command;
			else if (command === "on") nextMode = "consecutive";
			else if (command === "toggle") nextMode = mode === "off" ? "consecutive" : "off";
			else {
				ctx.ui.notify(
					"Usage: /tool-groups consecutive|all|off|status (aliases: on, toggle)",
					"error",
				);
				return;
			}

			try {
				saveConfig({ version: CONFIG_VERSION, mode: nextMode });
				mode = nextMode;
				ctx.ui.setToolsExpanded(ctx.ui.getToolsExpanded());
				ctx.ui.notify(`Tool grouping: ${mode}`, "info");
			} catch (error) {
				ctx.ui.notify(
					`Could not save tool-group setting: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		const loaded = loadConfig();
		mode = loaded.config.mode;
		addressBook.clear();
		if (ctx.mode !== "tui") return;

		active = true;
		activeTheme = () => ctx.ui.theme;
		patchState = installContainerRenderController(
			Container.prototype as unknown as Record<PropertyKey, unknown>,
			PATCH_KEY,
			controller,
		);
		if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");
	});

	pi.on("session_tree", () => {
		addressBook.clear();
	});

	pi.on("session_compact", () => {
		addressBook.clear();
	});

	pi.on("session_shutdown", () => {
		active = false;
		activeTheme = undefined;
		addressBook.clear();
		if (patchState) detachContainerRenderController(patchState, controller);
		patchState = undefined;
	});
}
