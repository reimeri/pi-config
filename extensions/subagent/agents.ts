
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

import type { ExtensionAgentContribution } from "./protocol.ts";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "user" | "project" | "extension";
export type AgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const THINKING_LEVELS = new Set<AgentThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: AgentThinkingLevel;
	concurrencyGroup?: string;
	/** Snapshot the working tree around the run and report what actually changed. */
	captureDiff: boolean;
	systemPrompt: string;
	source: AgentSource;
	sourceId?: string;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

const CONCURRENCY_GROUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const TRUE_VALUES = new Set(["true", "on", "yes"]);
const FALSE_VALUES = new Set(["false", "off", "no"]);

/** Whether to capture workspace changes; grouped agents default to true. */
function parseCaptureDiff(configured: unknown, concurrencyGroup: string | undefined): boolean {
	// YAML boolean scalars arrive as booleans; other values remain strings.
	if (typeof configured === "boolean") return configured;
	const value = typeof configured === "string" ? configured.trim().toLowerCase() : undefined;
	if (value && TRUE_VALUES.has(value)) return true;
	if (value && FALSE_VALUES.has(value)) return false;
	return Boolean(concurrencyGroup);
}

export function loadAgentFromFile(
	filePath: string,
	source: AgentSource,
	sourceId?: string,
): AgentConfig | undefined {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}

	const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
	if (!frontmatter.name || !frontmatter.description) return undefined;

	const tools = frontmatter.tools
		?.split(",")
		.map((tool: string) => tool.trim())
		.filter(Boolean);
	const configuredThinking = frontmatter.thinking?.trim() as AgentThinkingLevel | undefined;
	const thinking = configuredThinking && THINKING_LEVELS.has(configuredThinking) ? configuredThinking : undefined;
	const configuredConcurrencyGroup = frontmatter.concurrency?.trim();
	const concurrencyGroup =
		configuredConcurrencyGroup && CONCURRENCY_GROUP_PATTERN.test(configuredConcurrencyGroup)
			? configuredConcurrencyGroup
			: undefined;

	return {
		name: frontmatter.name,
		description: frontmatter.description,
		tools: tools && tools.length > 0 ? tools : undefined,
		model: frontmatter.model?.trim() || undefined,
		thinking,
		concurrencyGroup,
		captureDiff: parseCaptureDiff(frontmatter.diff, concurrencyGroup),
		systemPrompt: body,
		source,
		sourceId,
		filePath,
	};
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const agent = loadAgentFromFile(path.join(dir, entry.name), source);
		if (agent) agents.push(agent);
	}
	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(
	cwd: string,
	scope: AgentScope,
	extensionContributions: readonly ExtensionAgentContribution[] = [],
): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	// Active trusted extension contributions override agents with the same name.
	for (const contribution of extensionContributions) {
		const agent = loadAgentFromFile(contribution.filePath, "extension", contribution.providerId);
		if (agent) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

/** Formats the complete discovered agent catalog for the tool description. */
export function formatAgentCatalog(agents: readonly AgentConfig[]): string {
	if (agents.length === 0) return "No agents are currently installed.";

	const listed = agents.map((agent) => {
		// Normalize descriptions so the catalog remains one line.
		const summary = agent.description.replace(/\s+/g, " ").trim();
		return summary ? `${agent.name} — ${summary}` : agent.name;
	});

	return `Available agents: ${listed.join("; ")}.`;
}
