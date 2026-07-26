import { describe, expect, test } from "bun:test";
import {
	runAskUserFlow,
	type AskUserUI,
	type NormalizedQuestion,
} from "./flow.ts";

type SelectAction = string | undefined | ((title: string, options: string[]) => string | undefined);
type InputAction = string | undefined;

class FakeUI implements AskUserUI {
	readonly selectCalls: Array<{ title: string; options: string[] }> = [];
	readonly inputCalls: Array<{ title: string; placeholder?: string }> = [];

	constructor(
		private readonly selectActions: SelectAction[],
		private readonly inputActions: InputAction[] = [],
	) {}

	async select(title: string, options: string[]): Promise<string | undefined> {
		this.selectCalls.push({ title, options });
		if (this.selectActions.length === 0) throw new Error(`Unexpected select: ${title}`);
		const action = this.selectActions.shift();
		return typeof action === "function" ? action(title, options) : action;
	}

	async input(title: string, placeholder?: string): Promise<string | undefined> {
		this.inputCalls.push({ title, placeholder });
		if (this.inputActions.length === 0) throw new Error(`Unexpected input: ${title}`);
		return this.inputActions.shift();
	}
}

function option(label: string): SelectAction {
	return (_title, options) => {
		const match = options.find((candidate) => candidate.includes(label));
		if (!match) throw new Error(`Could not find option containing: ${label}`);
		return match;
	};
}

const questions: NormalizedQuestion[] = [
	{
		id: "scope",
		question: "Which scope?",
		options: [{ label: "Small" }, { label: "Large" }],
		allowOther: true,
	},
	{
		id: "pace",
		question: "Which pace?",
		options: [{ label: "Fast" }, { label: "Careful" }],
		allowOther: true,
	},
];

describe("runAskUserFlow", () => {
	test("Escape on a later question returns to the previous answered question", async () => {
		const ui = new FakeUI([
			option("Small"),
			undefined,
			option("Large"),
			option("Careful"),
			option("Submit answers"),
		]);

		const result = await runAskUserFlow(questions, ui);

		expect(result.status).toBe("answered");
		expect(result.answers.map((answer) => answer.answer)).toEqual(["Large", "Careful"]);
		expect(ui.selectCalls.filter((call) => call.title.includes("Which scope?")).length).toBe(2);
		expect(ui.selectCalls[1]?.title).toContain("Esc: previous question");
	});

	test("Escape from a custom answer returns to that question's choices", async () => {
		const oneQuestion = [questions[0]!];
		const ui = new FakeUI(
			[option("Other"), option("Small"), option("Submit answers")],
			[undefined],
		);

		const result = await runAskUserFlow(oneQuestion, ui);

		expect(result.status).toBe("answered");
		expect(result.answers[0]?.answer).toBe("Small");
		expect(ui.inputCalls[0]?.title).toContain("Esc: answer choices");
		expect(ui.selectCalls.filter((call) => call.title.includes("Which scope?")).length).toBe(2);
	});

	test("review allows an earlier answer to be edited before submission", async () => {
		const ui = new FakeUI([
			option("Small"),
			option("Fast"),
			option("Edit 1:"),
			option("Large"),
			option("Submit answers"),
		]);

		const result = await runAskUserFlow(questions, ui);

		expect(result.status).toBe("answered");
		expect(result.answers.map((answer) => answer.answer)).toEqual(["Large", "Fast"]);
		expect(ui.selectCalls[2]?.options.join("\n")).toContain("current: Small");
		expect(ui.selectCalls[3]?.title).toContain("Esc: review");
	});

	test("Escape from review returns to the final question", async () => {
		const ui = new FakeUI([
			option("Small"),
			option("Fast"),
			undefined,
			option("Careful"),
			option("Submit answers"),
		]);

		const result = await runAskUserFlow(questions, ui);

		expect(result.status).toBe("answered");
		expect(result.answers.map((answer) => answer.answer)).toEqual(["Small", "Careful"]);
		expect(ui.selectCalls[3]?.title).toContain("Which pace?");
	});

	test("Escape from an answer edit returns to review without discarding the saved answer", async () => {
		const ui = new FakeUI([
			option("Small"),
			option("Fast"),
			option("Edit 1:"),
			undefined,
			option("Submit answers"),
		]);

		const result = await runAskUserFlow(questions, ui);

		expect(result.status).toBe("answered");
		expect(result.answers.map((answer) => answer.answer)).toEqual(["Small", "Fast"]);
	});

	test("backtracking discards stale answers if the flow is then cancelled", async () => {
		const ui = new FakeUI([
			option("Small"),
			option("Fast"),
			undefined,
			undefined,
			undefined,
		]);

		const result = await runAskUserFlow(questions, ui);

		expect(result.status).toBe("cancelled");
		expect(result.stoppedAt).toBe("scope");
		expect(result.answers).toEqual([]);
	});

	test("an empty edited answer does not return the stale prior value", async () => {
		const ui = new FakeUI(
			[option("Small"), option("Fast"), option("Edit 1:"), option("Other")],
			[""],
		);

		const result = await runAskUserFlow(questions, ui);

		expect(result.status).toBe("empty");
		expect(result.stoppedAt).toBe("scope");
		expect(result.answers.map((answer) => answer.answer)).toEqual(["Fast"]);
	});

	test("RPC cancellation while editing omits the stale prior answer", async () => {
		const ui = new FakeUI([
			option("Small"),
			option("Fast"),
			option("Edit 1:"),
			undefined,
		]);

		const result = await runAskUserFlow(questions, ui, undefined, { allowBackNavigation: false });

		expect(result.status).toBe("cancelled");
		expect(result.stoppedAt).toBe("scope");
		expect(result.answers.map((answer) => answer.answer)).toEqual(["Fast"]);
	});

	test("aborting an edit omits the stale prior answer", async () => {
		const controller = new AbortController();
		const abortEdit: SelectAction = () => {
			controller.abort();
			return undefined;
		};
		const ui = new FakeUI([
			option("Small"),
			option("Fast"),
			option("Edit 1:"),
			abortEdit,
		]);

		const result = await runAskUserFlow(questions, ui, controller.signal);

		expect(result.status).toBe("aborted");
		expect(result.stoppedAt).toBe("scope");
		expect(result.answers.map((answer) => answer.answer)).toEqual(["Fast"]);
	});

	test("Escape on the first question still cancels", async () => {
		const result = await runAskUserFlow(questions, new FakeUI([undefined]));

		expect(result.status).toBe("cancelled");
		expect(result.stoppedAt).toBe("scope");
		expect(result.answers).toEqual([]);
	});

	test("RPC cancellation stops instead of navigating backward", async () => {
		const ui = new FakeUI([option("Small"), undefined]);

		const result = await runAskUserFlow(questions, ui, undefined, { allowBackNavigation: false });

		expect(result.status).toBe("cancelled");
		expect(result.stoppedAt).toBe("pace");
		expect(result.answers.map((answer) => answer.answer)).toEqual(["Small"]);
		expect(ui.selectCalls).toHaveLength(2);
		expect(ui.selectCalls[1]?.title).not.toContain("Esc:");
	});

	test("RPC cancellation from custom input does not reopen the choices", async () => {
		const ui = new FakeUI([option("Other")], [undefined]);

		const result = await runAskUserFlow([questions[0]!], ui, undefined, { allowBackNavigation: false });

		expect(result.status).toBe("cancelled");
		expect(ui.selectCalls).toHaveLength(1);
		expect(ui.inputCalls[0]?.title).not.toContain("Esc:");
	});

	test("an aborted dialog is not mistaken for back navigation", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await runAskUserFlow(questions, new FakeUI([undefined]), controller.signal);

		expect(result.status).toBe("aborted");
		expect(result.stoppedAt).toBe("scope");
	});
});
