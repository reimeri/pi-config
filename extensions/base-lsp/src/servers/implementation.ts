import { basename } from "node:path";
import type { ServerDefinition } from "../config/schema.js";

export function isTypeScriptLanguageServer(server: ServerDefinition, serverInfo?: { name: string; version?: string }): boolean {
  if (server.id !== "typescript") return false;
  if (serverInfo) return serverInfo.name === "typescript-language-server";
  const commandName = basename(server.command[0] ?? "").replace(/\.(?:cmd|exe)$/i, "");
  return commandName === "typescript-language-server";
}
