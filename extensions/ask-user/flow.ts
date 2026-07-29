export interface QuestionOption {
	label: string;
	description?: string;
}

export interface NormalizedQuestion {
	id: string;
	question: string;
	options: QuestionOption[];
	allowOther: boolean;
	placeholder?: string;
}

export interface Answer {
	id: string;
	question: string;
	answer: string;
	selectedOption?: number;
	wasCustom: boolean;
}

export type AskUserStatus = "answered" | "cancelled" | "empty" | "aborted" | "unavailable";

export interface AskUserDetails {
	questions: NormalizedQuestion[];
	answers: Answer[];
	status: AskUserStatus;
	stoppedAt?: string;
}

export interface AskUserSelectOption {
	value: string;
	mutedRanges?: Array<{ start: number; end: number }>;
}

export interface AskUserDialogOptions {
	signal?: AbortSignal;
	cancelLabel: "back" | "cancel";
}

export interface AskUserUI {
	select(
		title: string,
		options: AskUserSelectOption[],
		opts: AskUserDialogOptions,
	): Promise<string | undefined>;
	input(
		title: string,
		placeholder: string | undefined,
		opts: AskUserDialogOptions,
	): Promise<string | undefined>;
}

function selectOption(value: string): AskUserSelectOption {
	return { value };
}

function formatChoice(option: QuestionOption, index: number): string {
	const description = option.description?.trim();
	return `${index + 1}. ${option.label}${description ? ` — ${description}` : ""}`;
}

const MAX_ANSWER_LENGTH = 10_000;

function normalizeAnswer(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length <= MAX_ANSWER_LENGTH) return trimmed;
	return `${trimmed.slice(0, MAX_ANSWER_LENGTH)}\n[Answer truncated to ${MAX_ANSWER_LENGTH} characters]`;
}

export function answerSummary(answer: Answer): string {
	const prefix = answer.selectedOption === undefined ? "wrote" : `selected ${answer.selectedOption}`;
	return `${answer.id}: user ${prefix}: ${answer.answer}`;
}

function orderedAnswers(questions: NormalizedQuestion[], answers: Map<string, Answer>): Answer[] {
	return questions.flatMap((question) => {
		const answer = answers.get(question.id);
		return answer ? [answer] : [];
	});
}

function inlinePreview(value: string, maxLength = 80): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1)}…`;
}

type BackDestination = "cancel" | "previous question" | "review";

type QuestionOutcome =
	| { type: "answer"; answer: Answer }
	| { type: "back" }
	| { type: "cancel" }
	| { type: "empty" }
	| { type: "aborted" };

async function promptQuestion(
	ui: AskUserUI,
	question: NormalizedQuestion,
	index: number,
	total: number,
	backDestination: BackDestination,
	allowBackNavigation: boolean,
	signal?: AbortSignal,
): Promise<QuestionOutcome> {
	const position = total > 1 ? ` (${index + 1}/${total})` : "";
	const title = `Clarification${position}: ${question.question}`;
	const cancelLabel = allowBackNavigation && backDestination !== "cancel" ? "back" : "cancel";

	if (question.options.length === 0) {
		const custom = await ui.input(title, question.placeholder ?? "Type your answer", { signal, cancelLabel });
		if (custom === undefined) {
			return { type: signal?.aborted ? "aborted" : allowBackNavigation ? "back" : "cancel" };
		}
		if (custom.trim() === "") return { type: "empty" };
		return {
			type: "answer",
			answer: {
				id: question.id,
				question: question.question,
				answer: normalizeAnswer(custom),
				wasCustom: true,
			},
		};
	}

	const choices = question.options.map((option, optionIndex) => selectOption(formatChoice(option, optionIndex)));
	const otherChoice = `${choices.length + 1}. Other — type a custom answer`;
	if (question.allowOther) choices.push(selectOption(otherChoice));

	while (true) {
		const selected = await ui.select(title, choices, { signal, cancelLabel });
		if (selected === undefined) {
			return { type: signal?.aborted ? "aborted" : allowBackNavigation ? "back" : "cancel" };
		}

		const selectedIndex = choices.findIndex((choice) => choice.value === selected);
		if (selectedIndex >= 0 && selectedIndex < question.options.length) {
			return {
				type: "answer",
				answer: {
					id: question.id,
					question: question.question,
					answer: question.options[selectedIndex].label,
					selectedOption: selectedIndex + 1,
					wasCustom: false,
				},
			};
		}

		if (selected !== otherChoice) continue;
		const custom = await ui.input(
			`Custom answer${position}: ${question.question}`,
			question.placeholder ?? "Type your answer",
			{ signal, cancelLabel: allowBackNavigation ? "back" : "cancel" },
		);
		if (custom === undefined) {
			if (signal?.aborted) return { type: "aborted" };
			if (!allowBackNavigation) return { type: "cancel" };
			continue;
		}
		if (custom.trim() === "") return { type: "empty" };
		return {
			type: "answer",
			answer: {
				id: question.id,
				question: question.question,
				answer: normalizeAnswer(custom),
				wasCustom: true,
			},
		};
	}
}

export async function runAskUserFlow(
	questions: NormalizedQuestion[],
	ui: AskUserUI,
	signal?: AbortSignal,
	options: { allowBackNavigation?: boolean } = {},
): Promise<AskUserDetails> {
	const answers = new Map<string, Answer>();
	const allowBackNavigation = options.allowBackNavigation !== false;
	let questionIndex = 0;
	let screen: "question" | "review" = "question";
	let returnToReview = false;

	const discardAnswersFrom = (startIndex: number) => {
		for (let index = startIndex; index < questions.length; index++) answers.delete(questions[index].id);
	};

	while (true) {
		if (screen === "review") {
			const submitChoice = "1. Submit answers";
			const editChoices = questions.map((question, index): AskUserSelectOption => {
				const answer = answers.get(question.id);
				const prefix = `${index + 2}. Edit ${index + 1}: `;
				const questionPreview = inlinePreview(question.question);
				const value = `${prefix}${questionPreview} — current: ${inlinePreview(answer?.answer ?? "")}`;
				return {
					value,
					mutedRanges: [{ start: prefix.length, end: prefix.length + questionPreview.length }],
				};
			});
			const selected = await ui.select(
				"Review answers — submit or choose an answer to edit",
				[selectOption(submitChoice), ...editChoices],
				{ signal, cancelLabel: allowBackNavigation ? "back" : "cancel" },
			);

			if (selected === undefined) {
				if (signal?.aborted) {
					return { questions, answers: orderedAnswers(questions, answers), status: "aborted" };
				}
				if (!allowBackNavigation) {
					return { questions, answers: orderedAnswers(questions, answers), status: "cancelled" };
				}
				questionIndex = questions.length - 1;
				discardAnswersFrom(questionIndex);
				returnToReview = false;
				screen = "question";
				continue;
			}
			if (selected === submitChoice) {
				return { questions, answers: orderedAnswers(questions, answers), status: "answered" };
			}

			const editIndex = editChoices.findIndex((choice) => choice.value === selected);
			if (editIndex < 0) continue;
			questionIndex = editIndex;
			returnToReview = true;
			screen = "question";
			continue;
		}

		const question = questions[questionIndex];
		const backDestination: BackDestination = returnToReview
			? "review"
			: questionIndex > 0
				? "previous question"
				: "cancel";
		const outcome = await promptQuestion(
			ui,
			question,
			questionIndex,
			questions.length,
			backDestination,
			allowBackNavigation,
			signal,
		);

		if (outcome.type === "aborted" || outcome.type === "empty" || outcome.type === "cancel") {
			const completedAnswers = new Map(answers);
			completedAnswers.delete(question.id);
			return {
				questions,
				answers: orderedAnswers(questions, completedAnswers),
				status: outcome.type === "cancel" ? "cancelled" : outcome.type,
				stoppedAt: question.id,
			};
		}
		if (outcome.type === "back") {
			if (returnToReview) {
				screen = "review";
				continue;
			}
			if (questionIndex === 0) {
				return {
					questions,
					answers: orderedAnswers(questions, answers),
					status: "cancelled",
					stoppedAt: question.id,
				};
			}
			questionIndex--;
			discardAnswersFrom(questionIndex);
			continue;
		}

		answers.set(question.id, outcome.answer);
		if (returnToReview || questionIndex === questions.length - 1) {
			returnToReview = false;
			screen = "review";
		} else {
			questionIndex++;
		}
	}
}
