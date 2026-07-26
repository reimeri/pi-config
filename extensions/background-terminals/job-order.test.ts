import { describe, expect, test } from "bun:test";
import { prioritizeActiveJobs } from "./job-order.ts";

describe("prioritizeActiveJobs", () => {
	test("places active jobs first without changing order within either group", () => {
		const jobs = ["bg-1", "bg-2", "bg-3", "bg-4", "bg-5"];
		const active = new Set(["bg-2", "bg-4"]);

		expect(prioritizeActiveJobs(jobs, (job) => active.has(job))).toEqual([
			"bg-2",
			"bg-4",
			"bg-1",
			"bg-3",
			"bg-5",
		]);
		expect(jobs).toEqual(["bg-1", "bg-2", "bg-3", "bg-4", "bg-5"]);
	});

	test("classifies each job once", () => {
		const jobs = ["bg-1", "bg-2", "bg-3"];
		const calls: string[] = [];

		prioritizeActiveJobs(jobs, (job) => {
			calls.push(job);
			return job === "bg-3";
		});

		expect(calls).toEqual(jobs);
	});
});
