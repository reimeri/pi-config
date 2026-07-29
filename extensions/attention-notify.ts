import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FALLBACK_TITLE = "Pi";
const QUESTION_MESSAGE = "Pi is waiting for your input";
const COMPLETION_MESSAGE = "Pi has completed the task";
const NOTIFY_SEND_TIMEOUT_MS = 2_000;
const NOTIFICATION_ICON_PATH = fileURLToPath(
	new URL("./assets/pi-notification.png", import.meta.url),
);
const UNSAFE_OSC_CHARACTERS = /[;\u0000-\u001f\u007f-\u009f]/g;

function sanitizeTitle(title: string | undefined): string {
	return title?.replace(UNSAFE_OSC_CHARACTERS, " ").replace(/\s+/gu, " ").trim()
		|| FALLBACK_TITLE;
}

export function nativeNotificationArguments(
	title: string,
	body: string,
	iconPath?: string,
): string[] {
	return [
		"--app-name=Pi",
		...(iconPath ? ["--icon", iconPath] : []),
		"--",
		title,
		body,
	];
}

function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function notify(pi: ExtensionAPI, title: string | undefined, body: string): void {
	const safeTitle = sanitizeTitle(title);
	if (process.platform === "linux" && process.env.DBUS_SESSION_BUS_ADDRESS) {
		const iconPath = existsSync(NOTIFICATION_ICON_PATH) ? NOTIFICATION_ICON_PATH : undefined;
		try {
			void pi
				.exec(
					"notify-send",
					nativeNotificationArguments(safeTitle, body, iconPath),
					{ timeout: NOTIFY_SEND_TIMEOUT_MS },
				)
				.then((result) => {
					if (result.code !== 0 || result.killed) notifyOSC777(safeTitle, body);
				})
				.catch(() => notifyOSC777(safeTitle, body));
			return;
		} catch {
			// Fall through to the terminal protocol when native notifications cannot start.
		}
	}
	notifyOSC777(safeTitle, body);
}

export default function attentionNotify(pi: ExtensionAPI) {
	pi.on("tool_execution_start", (event, ctx) => {
		if (ctx.mode !== "tui" || event.toolName !== "ask_user") return;
		notify(pi, pi.getSessionName(), QUESTION_MESSAGE);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		notify(pi, pi.getSessionName(), COMPLETION_MESSAGE);
	});
}
