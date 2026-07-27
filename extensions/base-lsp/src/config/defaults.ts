import type { BaseLspConfig } from "./schema.js";
import { BUILTIN_SERVERS } from "../servers/catalog.js";
import { DEFAULT_LIMITS } from "../runtime/limits.js";

export function defaultConfig(): BaseLspConfig {
  return {
    enabled: true,
    allowUntrustedProjects: false,
    limits: { ...DEFAULT_LIMITS },
    ignore: [".git/**", "node_modules/**", "dist/**", "build/**", "coverage/**", "vendor/**", "target/**"],
    disabledServers: [],
    servers: structuredClone(BUILTIN_SERVERS),
  };
}
