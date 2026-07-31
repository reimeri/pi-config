/**
 * Agent discovery and configuration
 */

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

/**
 * Whether to observe workspace changes around this agent's runs.
 *
 * A concurrency group already marks the agents that mutate the shared checkout — that is what the
 * group exists to serialize — so it is also the right default for which runs are worth observing.
 * `diff:` overrides it in either direction: on for an editing agent that needs no group, off for a
 * grouped agent whose runs are not about files.
 */
function parseCaptureDiff(configured: unknown, concurrencyGroup: string | undefined): boolean {
	// The frontmatter parser resolves YAML scalars, so `diff: true` arrives as a boolean while
	// `diff: maybe` arrives as a string. Both reach here despite the declared string record.
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

	// Trusted extension contributions are invocation-scoped and intentionally win
	// by name while their provider is active.
	for (const contribution of extensionContributions) {
		const agent = loadAgentFromFile(contribution.filePath, "extension", contribution.providerId);
		if (agent) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

/**
 * The installed agents, as one line for the tool description.
 *
 * The description used to name scout, reviewer, and researcher outright, which made it a claim about
 * the user's configuration rather than a description of the tool: an agent added, renamed, or
 * removed left the model choosing from a list that no longer existed, and any agent beyond those
 * three was invisible unless the model guessed its name.
 *
 * Every agent is named, and its description is carried in full. Capping the count or the length
 * would recreate that same failure for whatever fell past the cut, and the cut would land by
 * directory order, since discovery does not sort — so which agents the model could see would depend
 * on the filesystem. The list is built once per start, so its size is paid for in the prefix once
 * rather than per call.
 *
 * Only the name and its own description are included. Model, thinking level, and tools are how an
 * agent is built rather than what it is for, and the caller is choosing between agents.
 */
export function formatAgentCatalog(agents: readonly AgentConfig[]): string {
	if (agents.length === 0) return "No agents are currently installed.";

	const listed = agents.map((agent) => {
		// Descriptions are free-form frontmatter, and a multi-line one would otherwise break up a
		// description that is assembled as a single line.
		const summary = agent.description.replace(/\s+/g, " ").trim();
		return summary ? `${agent.name} — ${summary}` : agent.name;
	});

	return `Available agents: ${listed.join("; ")}.`;
}
