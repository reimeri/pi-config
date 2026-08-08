import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadBackgroundTerminalConfig } from "./config.ts";
import { BackgroundProcessManager } from "./process-manager.ts";
import { registerBackgroundPsCommand } from "./ps-command.ts";
import { registerBackgroundTerminalTools } from "./tools.ts";

const FOOTER_STATUS_ID = "background-terminals";

export function formatBackgroundCount(count: number): string | undefined {
	return count > 0 ? `background: ${count}` : undefined;
}

export default function backgroundTerminalsExtension(pi: ExtensionAPI): void {
	const config = loadBackgroundTerminalConfig();
	const manager = new BackgroundProcessManager(config);
	let activeContext: ExtensionContext | undefined;

	const disposeRunningCountListener = manager.onRunningCountChange((count) => {
		if (activeContext?.mode !== "tui") return;
		activeContext.ui.setStatus(FOOTER_STATUS_ID, formatBackgroundCount(count));
	});

	registerBackgroundTerminalTools(pi, manager, config);
	registerBackgroundPsCommand(pi, manager);

	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
		if (ctx.mode === "tui") {
			ctx.ui.setStatus(FOOTER_STATUS_ID, formatBackgroundCount(manager.runningCount));
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (activeContext === ctx) activeContext = undefined;
		if (ctx.mode === "tui") ctx.ui.setStatus(FOOTER_STATUS_ID, undefined);
		disposeRunningCountListener();
		await manager.shutdown();
	});
}
