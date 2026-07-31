/** Delivers normal tasks as argv and oversized tasks through a temporary @file. */

/** Leaves room for Linux argv/environment bytes and Windows' complete command-line limit. */
export const MAX_TASK_ARG_BYTES = process.platform === "win32" ? 8 * 1024 : 64 * 1024;

export type TaskDelivery =
	/** Passed as one argv entry. */
	| { kind: "argument"; argument: string }
	/** Written to `fileName` and passed as `@path`, with `argument` framing it for the child. */
	| { kind: "file"; fileName: string; contents: string; argument: string };

/** Frames @file input so the child treats it as the task itself. */
const FILE_FRAMING =
	"Your task is the contents of the file above. It was delivered as a file only because of its size; treat it exactly as if it had been written here directly.";

export function planTaskDelivery(task: string, maxBytes: number = MAX_TASK_ARG_BYTES): TaskDelivery {
	// Both delivery modes preserve the same task text.
	const argument = `Task: ${task}`;
	if (Buffer.byteLength(argument, "utf8") <= maxBytes) return { kind: "argument", argument };
	return { kind: "file", fileName: "task.md", contents: argument, argument: FILE_FRAMING };
}
