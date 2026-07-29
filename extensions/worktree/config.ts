import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	PI_RESOURCE_ENTRIES,
	type LoadedWorktreeConfig,
	type PiResourceEntry,
	type WorktreeConfig,
} from "./types.ts";

const DEFAULT_RESOURCE_ENTRIES: PiResourceEntry[] = [
	"settings.json",
	"skills",
	"prompts",
	"themes",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
];

export const DEFAULT_WORKTREE_CONFIG: WorktreeConfig = {
	root: ".worktrees",
	resources: { mode: "none", entries: DEFAULT_RESOURCE_ENTRIES },
};

interface RawConfig {
	root?: unknown;
	resources?: {
		mode?: unknown;
		entries?: unknown;
	};
}

async function readJson(path: string, warnings: string[]): Promise<RawConfig | undefined> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		warnings.push(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}

	try {
		const value = JSON.parse(content) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			warnings.push(`Ignoring ${path}: expected a JSON object`);
			return undefined;
		}
		return value as RawConfig;
	} catch (error) {
		warnings.push(`Ignoring invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

function applyConfig(base: WorktreeConfig, raw: RawConfig | undefined, source: string, warnings: string[]): WorktreeConfig {
	if (!raw) return base;
	let root = base.root;
	let mode = base.resources.mode;
	let entries = [...base.resources.entries];

	if (raw.root !== undefined) {
		if (typeof raw.root === "string" && raw.root.trim() && !/[\u0000-\u001f\u007f]/u.test(raw.root)) {
			root = raw.root.trim();
		} else {
			warnings.push(`Ignoring invalid root in ${source}`);
		}
	}

	if (raw.resources !== undefined) {
		if (!raw.resources || typeof raw.resources !== "object" || Array.isArray(raw.resources)) {
			warnings.push(`Ignoring invalid resources configuration in ${source}`);
		} else {
			if (raw.resources.mode !== undefined) {
				if (raw.resources.mode === "none" || raw.resources.mode === "copy") mode = raw.resources.mode;
				else warnings.push(`Ignoring invalid resources.mode in ${source}`);
			}
			if (raw.resources.entries !== undefined) {
				if (Array.isArray(raw.resources.entries)) {
					const allowed = new Set<string>(PI_RESOURCE_ENTRIES);
					const valid = raw.resources.entries.filter(
						(entry): entry is PiResourceEntry => typeof entry === "string" && allowed.has(entry),
					);
					const invalid = raw.resources.entries.filter((entry) => typeof entry !== "string" || !allowed.has(entry));
					if (invalid.length > 0) warnings.push(`Ignoring unknown resource entries in ${source}: ${invalid.map(String).join(", ")}`);
					entries = [...new Set(valid)];
				} else {
					warnings.push(`Ignoring invalid resources.entries in ${source}`);
				}
			}
		}
	}

	return { root, resources: { mode, entries } };
}

export async function loadWorktreeConfig(
	checkoutRoot: string,
	projectTrusted: boolean,
	agentDir = getAgentDir(),
): Promise<LoadedWorktreeConfig> {
	const warnings: string[] = [];
	const globalPath = join(agentDir, "worktree.json");
	const projectPath = join(checkoutRoot, CONFIG_DIR_NAME, "worktree.json");
	let config = applyConfig(DEFAULT_WORKTREE_CONFIG, await readJson(globalPath, warnings), globalPath, warnings);
	if (projectTrusted) {
		config = applyConfig(config, await readJson(projectPath, warnings), projectPath, warnings);
	}
	return { config, warnings };
}

export function resolveWorktreeRoot(primaryRoot: string, configuredRoot: string): string {
	return isAbsolute(configuredRoot) ? resolve(configuredRoot) : resolve(primaryRoot, configuredRoot);
}
