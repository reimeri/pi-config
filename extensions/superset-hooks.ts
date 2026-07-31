/** Send fire-and-forget lifecycle notifications to Superset; elsewhere this is a no-op. */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
	if (!process.env.SUPERSET_TERMINAL_ID) return;

	const supersetHome =
		process.env.SUPERSET_HOME_DIR || join(homedir(), ".superset");
	const notifyScript = join(supersetHome, "hooks", "notify.sh");
	if (!existsSync(notifyScript)) return;

	const fire = (eventName: string) => {
		try {
			const child = spawn(notifyScript, [], {
				stdio: ["pipe", "ignore", "ignore"],
				detached: true,
				env: { ...process.env, SUPERSET_AGENT_ID: "pi" },
			});
			child.on("error", () => {
				/* Ignore hook failures. */
			});
			child.stdin?.on("error", () => {
				/* Ignore hook failures. */
			});
			child.stdin?.end(JSON.stringify({ hook_event_name: eventName }));
			child.unref();
		} catch {
			// spawn() can fail synchronously; keep hook errors out of the agent loop.
		}
	};

	// Skip only when hasUI is explicitly false; preserve compatibility with older Pi versions.
	const skip = (ctx: { hasUI?: boolean }) => ctx.hasUI === false;

	// session_start is the earliest signal that lets Superset bind the pane icon.
	pi.on("session_start", (_event, ctx) => {
		if (skip(ctx)) return;
		fire("SessionStart");
	});

	pi.on("session_end", (_event, ctx) => {
		if (skip(ctx)) return;
		fire("SessionEnd");
	});

	pi.on("before_agent_start", (_event, ctx) => {
		if (skip(ctx)) return;
		fire("UserPromptSubmit");
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		if (skip(ctx)) return;
		fire("PostToolUse");
	});

	pi.on("agent_end", (_event, ctx) => {
		if (skip(ctx)) return;
		fire("Stop");
	});

	// Mark stopped on every shutdown path so the working indicator cannot remain stuck.
	pi.on("session_shutdown", (_event, ctx) => {
		if (skip(ctx)) return;
		fire("Stop");
	});
}
