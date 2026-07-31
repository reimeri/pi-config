/**
 * How a task reaches the child: as a command-line argument, or as a file when it is too big to be
 * one.
 *
 * A task is one argv entry, and every OS caps how large a single entry may be — 128 KB per argument
 * on Linux, and a hard 32767-character limit on the *whole* command line on Windows. Past that the
 * spawn fails with `E2BIG` before the child exists, which the parent could do nothing about: the
 * task was already written, and the tool was refusing to carry it. Pi accepts `@file` arguments and
 * inlines their contents into the initial message, so an oversized task is written out and handed
 * over that way instead.
 */

/**
 * The largest task carried as an argument.
 *
 * Deliberately well under the OS limit. The margin covers the rest of argv and the whole environment
 * block, which share the budget on Linux, and the fact that the limit counts bytes while a task is
 * counted in characters — a task of mostly non-ASCII text is several times larger than its length
 * suggests. Windows gets a much smaller number because its limit is on the entire command line
 * rather than one argument of it.
 */
export const MAX_TASK_ARG_BYTES = process.platform === "win32" ? 8 * 1024 : 64 * 1024;

export type TaskDelivery =
	/** Passed as one argv entry, which is every ordinary task. */
	| { kind: "argument"; argument: string }
	/** Written to `fileName` and passed as `@path`, with `argument` framing it for the child. */
	| { kind: "file"; fileName: string; contents: string; argument: string };

/**
 * Pi wraps an `@file` in `<file name="...">…</file>` and puts it before the message, so the child
 * receives the task as an attachment rather than as something addressed to it. The framing line
 * says which one it is, so a delivery detail cannot be mistaken for reference material the agent was
 * given alongside some other instruction.
 */
const FILE_FRAMING =
	"Your task is the contents of the file above. It was delivered as a file only because of its size; treat it exactly as if it had been written here directly.";

export function planTaskDelivery(task: string, maxBytes: number = MAX_TASK_ARG_BYTES): TaskDelivery {
	// Identical text on both paths, so what the child reads does not change with the delivery.
	const argument = `Task: ${task}`;
	if (Buffer.byteLength(argument, "utf8") <= maxBytes) return { kind: "argument", argument };
	return { kind: "file", fileName: "task.md", contents: argument, argument: FILE_FRAMING };
}
