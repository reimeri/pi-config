import { describe, expect, test } from "vitest";
import { MAX_TASK_ARG_BYTES, planTaskDelivery } from "./task-delivery.ts";

describe("planTaskDelivery", () => {
	test("passes an ordinary task as one argument", () => {
		expect(planTaskDelivery("Fix the queue")).toEqual({ kind: "argument", argument: "Task: Fix the queue" });
	});

	test("writes a task too large to be an argument to a file", () => {
		// Passing this as argv fails the spawn with E2BIG before the child exists, which the parent
		// could do nothing about: the task was already written and the tool was refusing to carry it.
		const task = "x".repeat(MAX_TASK_ARG_BYTES + 1);
		const delivery = planTaskDelivery(task);

		expect(delivery.kind).toBe("file");
		if (delivery.kind !== "file") return;
		expect(delivery.contents).toBe(`Task: ${task}`);
		expect(delivery.fileName).toMatch(/\.md$/);
	});

	test("tells the child the attached file is its task", () => {
		// Pi wraps an @file in <file name="…"> and puts it ahead of the message, so without this the
		// task arrives looking like reference material handed over alongside some other instruction.
		const delivery = planTaskDelivery("x".repeat(MAX_TASK_ARG_BYTES + 1));

		expect(delivery.argument).toContain("Your task is the contents of the file above");
		expect(delivery.argument.length).toBeLessThan(400);
	});

	test("measures bytes rather than characters", () => {
		// A task of mostly non-ASCII text is several times larger than its length suggests, and the
		// OS limit counts bytes.
		const task = "é".repeat(MAX_TASK_ARG_BYTES - 100);
		expect(task.length).toBeLessThan(MAX_TASK_ARG_BYTES);
		expect(planTaskDelivery(task).kind).toBe("file");
	});

	test("counts the prefix it adds, not just the task", () => {
		// "Task: " plus ten characters is exactly sixteen bytes on the wire.
		const task = "y".repeat(10);
		expect(planTaskDelivery(task, 16)).toEqual({ kind: "argument", argument: `Task: ${task}` });
		expect(planTaskDelivery(task, 15).kind).toBe("file");
	});

	test("stays well under the smallest OS limit it has to satisfy", () => {
		// Windows caps the whole command line at 32767 characters, not one argument of it, so the
		// budget has to cover the agent's flags and paths too.
		expect(MAX_TASK_ARG_BYTES).toBeLessThanOrEqual(process.platform === "win32" ? 8 * 1024 : 64 * 1024);
	});
});
