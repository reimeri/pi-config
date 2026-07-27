import { access, readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { ServerDefinition } from "../config/schema.js";

export interface ResolvedCommand { executable: string; args: string[]; env: NodeJS.ProcessEnv }

export async function resolveServerCommand(server: ServerDefinition, inherited: NodeJS.ProcessEnv = process.env): Promise<ResolvedCommand | undefined> {
  const executable = await resolveExecutable(server.command[0]!, inherited);
  if (!executable) return undefined;
  const env = { ...inherited, ...server.env };
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)) {
    const shim = await resolveNpmCmdShim(executable);
    if (!shim) throw new Error(`Unsupported Windows batch shim: ${executable}. Configure a directly executable server command.`);
    return { executable: process.execPath, args: [shim, ...server.command.slice(1)], env };
  }
  return { executable, args: server.command.slice(1), env };
}

export async function resolveExecutable(command: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) return (await canExecute(command)) ? command : undefined;
  const path = env.PATH ?? "";
  const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const directory of path.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, extname(command) ? command : command + extension.toLowerCase());
      if (await canExecute(candidate)) return candidate;
    }
  }
  return undefined;
}
export async function resolveNpmCmdShim(path: string): Promise<string | undefined> {
  let source: string;
  try { source = await readFile(path, "utf8"); } catch { return undefined; }
  if (!/^@ECHO off\r?$/im.test(source) || !source.includes("%dp0%") || !source.includes("%*")) return undefined;
  const matches = [...source.matchAll(/["']%dp0%\\([^"'\r\n]+\.(?:[cm]?js))["']\s+%\*/gi)];
  if (matches.length !== 1) return undefined;
  const relativeScript = matches[0]![1]!.replaceAll("\\", "/");
  const candidate = resolve(dirname(path), relativeScript);
  try {
    const canonical = await realpath(candidate);
    return (await canExecute(canonical)) ? canonical : undefined;
  } catch { return undefined; }
}
async function canExecute(path: string): Promise<boolean> { try { await access(path, process.platform === "win32" ? 0 : 1); return true; } catch { return false; } }
