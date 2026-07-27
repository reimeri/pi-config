import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { BaseLspConfig, ConfigFile, LoadedConfig, ServerDefinition } from "./schema.js";
import { validateConfigFile } from "./schema.js";
import { defaultConfig } from "./defaults.js";
import { clampLimits } from "../runtime/limits.js";
import { isContained } from "../workspace/boundary.js";

let generation = 0;

export async function loadConfig(cwd: string, boundary: string, trusted: boolean): Promise<LoadedConfig> {
  const warnings: string[] = [];
  const userPath = join(getAgentDir(), "base-lsp.json");
  const base = defaultConfig();
  const user = await readConfig(userPath, true, warnings);
  let merged = base;
  if (user) {
    try { merged = mergeConfig(base, user); }
    catch (error) { warnings.push(`${userPath}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  let projectPath: string | undefined;
  if (trusted) {
    projectPath = await findProjectConfig(cwd, boundary);
    if (projectPath) {
      const project = await readConfig(projectPath, false, warnings);
      if (project) {
        try { merged = mergeConfig(merged, project); }
        catch (error) { warnings.push(`${projectPath}: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
  }
  for (const id of merged.disabledServers) if (merged.servers[id]) merged.servers[id].enabled = false;
  return {
    config: merged,
    generation: ++generation,
    userPath,
    ...(projectPath ? { projectPath } : {}),
    warnings,
    trusted,
    authorized: merged.enabled && (trusted || merged.allowUntrustedProjects),
  };
}

async function readConfig(path: string, user: boolean, warnings: string[]): Promise<ConfigFile | undefined> {
  let source: string;
  try {
    const info = await stat(path);
    if (info.size > 1024 * 1024) { warnings.push(`${path}: configuration exceeds the 1 MiB limit`); return undefined; }
    source = await readFile(path, "utf8");
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  try { return validateConfigFile(JSON.parse(source), path, user); }
  catch (error) { warnings.push(error instanceof Error ? error.message : String(error)); return undefined; }
}

async function findProjectConfig(cwd: string, boundary: string): Promise<string | undefined> {
  let current = resolve(cwd);
  const stop = resolve(boundary);
  while (isContained(stop, current)) {
    const candidate = join(current, CONFIG_DIR_NAME, "base-lsp.json");
    try { if ((await stat(candidate)).isFile()) return candidate; } catch { /* absent */ }
    if (current === stop) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

export function mergeConfig(base: BaseLspConfig, layer?: ConfigFile): BaseLspConfig {
  if (!layer) return structuredClone(base);
  const result = structuredClone(base);
  if (layer.enabled !== undefined) result.enabled = layer.enabled;
  if (layer.allowUntrustedProjects !== undefined) result.allowUntrustedProjects = layer.allowUntrustedProjects;
  if (layer.ignore) result.ignore = [...layer.ignore];
  if (layer.disabledServers) result.disabledServers = [...layer.disabledServers];
  result.limits = clampLimits({ ...result.limits, ...layer.limits });
  applyServers(result.servers, layer.serverOverrides, false);
  applyServers(result.servers, layer.servers, true);
  return result;
}

function applyServers(target: Record<string, ServerDefinition>, source: ConfigFile["servers"], custom: boolean): void {
  if (!source) return;
  for (const [id, patch] of Object.entries(source)) {
    if (patch === null) { delete target[id]; continue; }
    const existing = target[id];
    if (!existing && !custom) continue;
    const merged = deepMerge(existing ?? { id }, patch) as ServerDefinition;
    merged.id = id;
    validateServer(merged, `servers.${id}`);
    target[id] = merged;
  }
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === null) return undefined;
  if (Array.isArray(patch)) return [...patch];
  if (!isRecord(patch)) return patch;
  const output: Record<string, unknown> = isRecord(base) ? structuredClone(base) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete output[key];
    else output[key] = deepMerge(output[key], value);
  }
  return output;
}

function validateServer(server: Partial<ServerDefinition>, path: string): asserts server is ServerDefinition {
  if (!server.displayName || typeof server.displayName !== "string") throw new Error(`${path}.displayName is required`);
  if (!Array.isArray(server.command) || !server.command.length || server.command.some((item) => typeof item !== "string" || !item)) throw new Error(`${path}.command must be a non-empty string array`);
  if (!Array.isArray(server.extensions) || !server.extensions.every((item) => typeof item === "string")) throw new Error(`${path}.extensions must be a string array`);
  if (!isRecord(server.languageIds)) throw new Error(`${path}.languageIds is required`);
  if (!Array.isArray(server.rootMarkers)) throw new Error(`${path}.rootMarkers must be an array`);
  if (!["none", "workspace", "file-directory"].includes(String(server.rootFallback))) throw new Error(`${path}.rootFallback is invalid`);
  if (!["primary", "diagnostic"].includes(String(server.role))) throw new Error(`${path}.role is invalid`);
  if (server.diagnosticPolicy !== undefined) {
    if (!isRecord(server.diagnosticPolicy)) throw new Error(`${path}.diagnosticPolicy must be an object`);
    const allowed = new Set(["pushFirstMs", "settleMs", "emptyPullGraceMs", "acceptUnversionedEmptyAfterOpen"]);
    for (const key of Object.keys(server.diagnosticPolicy)) if (!allowed.has(key)) throw new Error(`${path}.diagnosticPolicy.${key} is unknown`);
    for (const key of ["pushFirstMs", "settleMs", "emptyPullGraceMs"] as const) {
      const value = server.diagnosticPolicy[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 120_000)) throw new Error(`${path}.diagnosticPolicy.${key} must be an integer from 0 to 120000`);
    }
    if (server.diagnosticPolicy.acceptUnversionedEmptyAfterOpen !== undefined && typeof server.diagnosticPolicy.acceptUnversionedEmptyAfterOpen !== "boolean") throw new Error(`${path}.diagnosticPolicy.acceptUnversionedEmptyAfterOpen must be boolean`);
  }
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

export function redactConfig(config: BaseLspConfig): unknown {
  return {
    ...config,
    servers: Object.fromEntries(Object.entries(config.servers).map(([id, server]) => [id, {
      ...server,
      ...(server.env ? { env: Object.fromEntries(Object.keys(server.env).map((key) => [key, "<redacted>"])) } : {}),
      ...(server.settings !== undefined ? { settings: "<redacted>" } : {}),
      ...(server.initializationOptions !== undefined ? { initializationOptions: "<redacted>" } : {}),
      ...(server.workspaceConfiguration !== undefined ? { workspaceConfiguration: "<redacted>" } : {}),
    }])),
  };
}
