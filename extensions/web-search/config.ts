import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SearchModelSelection } from "./types.ts";
import { providerKind } from "./providers.ts";

interface DedicatedModelConfig {
	provider: string;
	model: string;
}

export function searchConfigPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return process.env.PI_WEB_SEARCH_CONFIG || join(agentDir, "web-search.json");
}

export async function readDedicatedModelConfig(path = searchConfigPath()): Promise<
	| { status: "missing"; path: string }
	| { status: "configured"; path: string; config: DedicatedModelConfig }
	| { status: "invalid"; path: string; error: string }
> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing", path };
		return { status: "invalid", path, error: error instanceof Error ? error.message : String(error) };
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		return { status: "invalid", path, error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { status: "invalid", path, error: "Expected an object with provider and model fields" };
	}
	const object = value as Record<string, unknown>;
	const provider = typeof object.provider === "string" ? object.provider.trim() : "";
	const model = typeof object.model === "string" ? object.model.trim() : "";
	if (!provider || !model) {
		return { status: "invalid", path, error: "provider and model must be non-empty strings" };
	}
	return { status: "configured", path, config: { provider, model } };
}

export function supportsSearch(model: Model<Api> | undefined): model is Model<Api> {
	return !!model && providerKind(model) !== undefined;
}

export async function selectSearchModel(ctx: ExtensionContext): Promise<SearchModelSelection> {
	const state = await readDedicatedModelConfig();
	if (state.status === "invalid") return { configPath: state.path, error: state.error };
	if (state.status === "configured") {
		const model = ctx.modelRegistry.find(state.config.provider, state.config.model);
		if (!model) {
			return { configPath: state.path, error: `Configured model ${state.config.provider}/${state.config.model} was not found` };
		}
		if (!supportsSearch(model)) {
			return { configPath: state.path, error: `Configured model ${state.config.provider}/${state.config.model} does not support native search` };
		}
		return { configPath: state.path, model };
	}
	if (!supportsSearch(ctx.model)) {
		return { configPath: state.path, error: ctx.model ? `Current model ${ctx.model.provider}/${ctx.model.id} does not support native search` : "No model is selected" };
	}
	return { configPath: state.path, model: ctx.model };
}
