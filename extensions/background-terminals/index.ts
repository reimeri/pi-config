import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadBackgroundTerminalConfig } from "./config.ts";
import { BackgroundProcessManager } from "./process-manager.ts";
import { registerBackgroundPsCommand } from "./ps-command.ts";
import { registerBackgroundTerminalTools } from "./tools.ts";

export default function backgroundTerminalsExtension(pi: ExtensionAPI): void {
	const config = loadBackgroundTerminalConfig();
	const manager = new BackgroundProcessManager(config);

	registerBackgroundTerminalTools(pi, manager, config);
	registerBackgroundPsCommand(pi, manager);

	pi.on("session_shutdown", async () => {
		await manager.shutdown();
	});
}
