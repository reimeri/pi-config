import type { NormalizedCapabilities } from "../protocol/types.js";
import type { Limits } from "../runtime/limits.js";

export type ServerRole = "primary" | "diagnostic";
export type RootMarker = string | { glob: string };

export interface ServerDefinition {
  id: string;
  displayName: string;
  enabled: boolean;
  command: string[];
  env?: Record<string, string>;
  extensions: string[];
  filenames?: string[];
  languageIds: Record<string, string>;
  role: ServerRole;
  priority: number;
  rootMarkers: RootMarker[];
  rootFallback: "none" | "workspace" | "file-directory";
  initializationOptions?: unknown;
  settings?: unknown;
  workspaceConfiguration?: Record<string, unknown>;
  requestTimeoutMs?: number;
  diagnosticPolicy?: { pushFirstMs?: number; settleMs?: number; emptyPullGraceMs?: number; acceptUnversionedEmptyAfterOpen?: boolean };
  capabilityOverrides?: Partial<NormalizedCapabilities>;
  installationHint?: string;
}

export interface BaseLspConfig {
  enabled: boolean;
  allowUntrustedProjects: boolean;
  limits: Limits;
  ignore: string[];
  disabledServers: string[];
  servers: Record<string, ServerDefinition>;
}

export interface ConfigFile {
  enabled?: boolean;
  allowUntrustedProjects?: boolean;
  limits?: Partial<Limits>;
  ignore?: string[];
  disabledServers?: string[];
  serverOverrides?: Record<string, Partial<ServerDefinition> | null>;
  servers?: Record<string, Partial<ServerDefinition> | null>;
}

export interface LoadedConfig {
  config: BaseLspConfig;
  generation: number;
  userPath: string;
  projectPath?: string;
  warnings: string[];
  trusted: boolean;
  authorized: boolean;
}

export function validateConfigFile(value: unknown, source: string, allowUntrusted = true): ConfigFile {
  if (!isRecord(value)) throw new Error(`${source}: top-level value must be an object`);
  const known = new Set(["enabled", "allowUntrustedProjects", "limits", "ignore", "disabledServers", "serverOverrides", "servers"]);
  for (const key of Object.keys(value)) if (!known.has(key)) throw new Error(`${source}: unknown property ${key}`);
  if (!allowUntrusted && "allowUntrustedProjects" in value) throw new Error(`${source}: allowUntrustedProjects is permitted only in user config`);
  optionalBoolean(value, "enabled", source);
  optionalBoolean(value, "allowUntrustedProjects", source);
  optionalStringArray(value, "ignore", source);
  optionalStringArray(value, "disabledServers", source);
  if (value.limits !== undefined && !isRecord(value.limits)) throw new Error(`${source}: limits must be an object`);
  for (const key of ["serverOverrides", "servers"] as const) {
    const section = value[key];
    if (section === undefined) continue;
    if (!isRecord(section)) throw new Error(`${source}: ${key} must be an object`);
    for (const [id, server] of Object.entries(section)) {
      if (server !== null && !isRecord(server)) throw new Error(`${source}: ${key}.${id} must be an object or null`);
      if (server && "command" in server && (!Array.isArray(server.command) || server.command.length === 0 || server.command.some((item) => typeof item !== "string" || item.length === 0))) throw new Error(`${source}: ${key}.${id}.command must be a non-empty string array`);
    }
  }
  return value as ConfigFile;
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function optionalBoolean(value: Record<string, unknown>, key: string, source: string): void { if (value[key] !== undefined && typeof value[key] !== "boolean") throw new Error(`${source}: ${key} must be boolean`); }
function optionalStringArray(value: Record<string, unknown>, key: string, source: string): void { const item = value[key]; if (item !== undefined && (!Array.isArray(item) || item.some((entry) => typeof entry !== "string"))) throw new Error(`${source}: ${key} must be a string array`); }
