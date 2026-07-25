import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TITLE = "Pi";
const QUESTION_MESSAGE = "Your input is needed";
const COMPLETION_MESSAGE = "Task complete";

function notify(body: string): void {
	process.stdout.write(`\x1b]777;notify;${TITLE};${body}\x07`);
}

export default function attentionNotify(pi: ExtensionAPI) {
	pi.on("tool_execution_start", (event, ctx) => {
		if (ctx.mode !== "tui" || event.toolName !== "ask_user") return;
		notify(QUESTION_MESSAGE);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		notify(COMPLETION_MESSAGE);
	});
}
