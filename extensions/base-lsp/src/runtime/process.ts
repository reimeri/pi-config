import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import type { ResolvedCommand } from "../servers/command.js";
import { sanitizeText } from "../util/text.js";

export interface ManagedProcess {
  child: ChildProcessWithoutNullStreams;
  stderr(): string;
  exited(): boolean;
  terminate(graceMs?: number): Promise<void>;
}

export function launchProcess(command: ResolvedCommand, cwd: string, maxStderrBytes: number): ManagedProcess {
  const child = spawn(command.executable, command.args, {
    cwd,
    env: command.env,
    shell: false,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = Buffer.alloc(0);
  let hasExited = false;
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = Buffer.concat([stderr, chunk]);
    if (stderr.length > maxStderrBytes) stderr = stderr.subarray(stderr.length - maxStderrBytes);
  });
  child.once("exit", () => { hasExited = true; });
  child.once("error", () => { hasExited = true; });

  return {
    child,
    stderr: () => sanitizeText(stderr.toString("utf8"), 4_096),
    exited: () => hasExited,
    async terminate(graceMs = 1_000): Promise<void> {
      if (hasExited) return;
      const exited = once(child, "exit").then(() => true, () => true);
      await terminateTree(child.pid, false);
      if (await Promise.race([exited, delay(graceMs).then(() => false)])) return;
      if (!hasExited) await terminateTree(child.pid, true);
      await Promise.race([exited, delay(graceMs)]);
    },
  };
}

async function terminateTree(pid: number | undefined, force: boolean): Promise<void> {
  if (!pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], { shell: false, windowsHide: true, stdio: "ignore" });
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
    return;
  }
  try { process.kill(-pid, force ? "SIGKILL" : "SIGTERM"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); }); }
