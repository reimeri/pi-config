import { describe, expect, test } from "vitest";
import { MAX_TASK_ARG_BYTES, planTaskDelivery } from "./task-delivery.ts";

describe("planTaskDelivery", () => {
	test("passes an ordinary task as one argument", () => {
		expect(planTaskDelivery("Fix the queue")).toEqual({ kind: "argument", argument: "Task: Fix the queue" });
	});

	test("writes a task too large to be an argument to a file", () => {
		// Oversized argv tasks fail before spawn, so deliver them through a file.
		const task = "x".repeat(MAX_TASK_ARG_BYTES + 1);
		const delivery = planTaskDelivery(task);

		expect(delivery.kind).toBe("file");
		if (delivery.kind !== "file") return;
		expect(delivery.contents).toBe(`Task: ${task}`);
		expect(delivery.fileName).toMatch(/\.md$/);
	});

	test("tells the child the attached file is its task", () => {
		// Framing makes @file content the task rather than reference material.
		const delivery = planTaskDelivery("x".repeat(MAX_TASK_ARG_BYTES + 1));

		expect(delivery.argument).toContain("Your task is the contents of the file above");
		expect(delivery.argument.length).toBeLessThan(400);
	});

	test("measures bytes rather than characters", () => {
		// The OS limit is byte-based, so non-ASCII tasks consume more budget.
		const task = "é".repeat(MAX_TASK_ARG_BYTES - 100);
		expect(task.length).toBeLessThan(MAX_TASK_ARG_BYTES);
		expect(planTaskDelivery(task).kind).toBe("file");
	});

	test("counts the prefix it adds, not just the task", () => {
		// “Task: ” plus ten characters is exactly sixteen bytes.
		const task = "y".repeat(10);
		expect(planTaskDelivery(task, 16)).toEqual({ kind: "argument", argument: `Task: ${task}` });
		expect(planTaskDelivery(task, 15).kind).toBe("file");
	});

	test("stays well under the smallest OS limit it has to satisfy", () => {
		// Windows needs headroom for the complete command line, not only the task.
		expect(MAX_TASK_ARG_BYTES).toBeLessThanOrEqual(process.platform === "win32" ? 8 * 1024 : 64 * 1024);
	});
});
