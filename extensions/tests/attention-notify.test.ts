import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import attentionNotify, { nativeNotificationArguments } from "../attention-notify.ts";

type Handler = (event: any, context: any) => unknown;
type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };
type ExecImplementation = (
	command: string,
	args: string[],
	options?: { timeout?: number },
) => Promise<ExecResult>;

const successfulExecResult: ExecResult = {
	stdout: "",
	stderr: "",
	code: 0,
	killed: false,
};

function loadExtension(
	getSessionName: () => string | undefined,
	exec: ExecImplementation = async () => successfulExecResult,
) {
	const handlers = new Map<string, Handler>();
	const pi = {
		exec,
		getSessionName,
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
	};
	attentionNotify(pi as unknown as ExtensionAPI);
	return handlers;
}

async function invoke(handler: Handler | undefined, event: any, context: any): Promise<void> {
	await handler?.(event, context);
}

function captureOutput(): { output: string[]; restore: () => void } {
	const output: string[] = [];
	const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		output.push(String(chunk));
		return true;
	});
	return { output, restore: () => write.mockRestore() };
}

function useLinuxDesktopBus(): void {
	vi.spyOn(process, "platform", "get").mockReturnValue("linux");
	vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus");
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("nativeNotificationArguments", () => {
	test("works without an icon", () => {
		expect(nativeNotificationArguments("Task", "Body")).toEqual([
			"--app-name=Pi",
			"--",
			"Task",
			"Body",
		]);
	});

	test("adds an icon when one is available", () => {
		expect(nativeNotificationArguments("Task", "Body", "/config/pi.png")).toEqual([
			"--app-name=Pi",
			"--icon",
			"/config/pi.png",
			"--",
			"Task",
			"Body",
		]);
	});
});

describe("attention-notify extension", () => {
	test("uses native notifications with the latest session title", async () => {
		useLinuxDesktopBus();
		let sessionTitle = "Initial task";
		const calls: Array<{ command: string; args: string[]; timeout?: number }> = [];
		const handlers = loadExtension(
			() => sessionTitle,
			async (command, args, options) => {
				calls.push({ command, args, timeout: options?.timeout });
				return successfulExecResult;
			},
		);
		const capture = captureOutput();
		try {
			sessionTitle = "Fix authentication";
			await invoke(
				handlers.get("tool_execution_start"),
				{ toolName: "ask_user" },
				{ mode: "tui" },
			);
		} finally {
			capture.restore();
		}

		expect(calls).toHaveLength(1);
		expect(calls[0]?.command).toBe("notify-send");
		expect(calls[0]?.timeout).toBe(2_000);
		expect(calls[0]?.args[0]).toBe("--app-name=Pi");
		expect(calls[0]?.args.slice(-3)).toEqual([
			"--",
			"Fix authentication",
			"Pi is waiting for your input",
		]);
		expect(capture.output).toEqual([]);
	});

	test("does not block the event while notify-send is pending", async () => {
		useLinuxDesktopBus();
		let finishExec: ((result: ExecResult) => void) | undefined;
		const pendingExec = new Promise<ExecResult>((resolve) => {
			finishExec = resolve;
		});
		const handlers = loadExtension(() => "Task", () => pendingExec);

		const handlerResult = handlers.get("agent_settled")?.({}, { mode: "tui" });

		expect(handlerResult).toBeUndefined();
		finishExec?.(successfulExecResult);
		await pendingExec;
	});

	test("uses OSC 777 when no desktop session bus is available", async () => {
		vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "");
		const handlers = loadExtension(() => "Improve notifications");
		const capture = captureOutput();
		try {
			await invoke(handlers.get("agent_settled"), {}, { mode: "tui" });
		} finally {
			capture.restore();
		}

		expect(capture.output).toEqual([
			"\x1b]777;notify;Improve notifications;Pi has completed the task\x07",
		]);
	});

	test.each<{
		failure: string;
		exec: ExecImplementation;
	}>([
		{
			failure: "a nonzero exit code",
			exec: async () => ({ ...successfulExecResult, code: 1 }),
		},
		{
			failure: "a killed process",
			exec: async () => ({ ...successfulExecResult, killed: true }),
		},
		{
			failure: "a rejected execution",
			exec: async () => {
				throw new Error("notify-send unavailable");
			},
		},
		{
			failure: "a synchronous execution error",
			exec: () => {
				throw new Error("extension runtime unavailable");
			},
		},
	])("falls back to OSC 777 after $failure", async ({ exec }) => {
		useLinuxDesktopBus();
		const handlers = loadExtension(() => "Fallback task", exec);
		const capture = captureOutput();
		try {
			await invoke(handlers.get("agent_settled"), {}, { mode: "tui" });
			await vi.waitFor(() => expect(capture.output).toHaveLength(1));
		} finally {
			capture.restore();
		}

		expect(capture.output).toEqual([
			"\x1b]777;notify;Fallback task;Pi has completed the task\x07",
		]);
	});

	test("falls back to Pi and sanitizes OSC delimiters in session titles", async () => {
		vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "");
		let sessionTitle: string | undefined = "   ";
		const handlers = loadExtension(() => sessionTitle);
		const capture = captureOutput();
		try {
			await invoke(handlers.get("agent_settled"), {}, { mode: "tui" });
			sessionTitle = "Deploy; production\nnow";
			await invoke(handlers.get("agent_settled"), {}, { mode: "tui" });
		} finally {
			capture.restore();
		}

		expect(capture.output).toEqual([
			"\x1b]777;notify;Pi;Pi has completed the task\x07",
			"\x1b]777;notify;Deploy production now;Pi has completed the task\x07",
		]);
	});

	test("does not notify outside the relevant TUI events", async () => {
		const exec = vi.fn(async () => successfulExecResult);
		const handlers = loadExtension(() => "Task", exec);
		const capture = captureOutput();
		try {
			await invoke(
				handlers.get("tool_execution_start"),
				{ toolName: "bash" },
				{ mode: "tui" },
			);
			await invoke(
				handlers.get("tool_execution_start"),
				{ toolName: "ask_user" },
				{ mode: "rpc" },
			);
			await invoke(handlers.get("agent_settled"), {}, { mode: "print" });
		} finally {
			capture.restore();
		}

		expect(exec).not.toHaveBeenCalled();
		expect(capture.output).toEqual([]);
	});
});
