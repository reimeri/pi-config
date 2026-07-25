import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const TODO_CREATE_FROM_PLAN_REQUEST_EVENT = "todos:create-from-plan-request";
export const MAX_TODOS = 30;

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoInput {
	id: string;
	text: string;
	status: TodoStatus;
}

export type PlanTodoCreationResult =
	| { status: "applied" }
	| { status: "cancelled" }
	| { status: "unavailable"; message: string };

export interface PlanTodoCreationRequest {
	steps: string[];
	explanation?: string;
	acknowledge: () => void;
	respond: (result: PlanTodoCreationResult) => void;
}

export function requestTodosFromPlan(
	events: ExtensionAPI["events"],
	steps: string[],
	explanation?: string,
): Promise<PlanTodoCreationResult> {
	return new Promise((resolve) => {
		let acknowledged = false;
		let settled = false;
		const respond = (result: PlanTodoCreationResult): void => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		const request: PlanTodoCreationRequest = {
			steps,
			explanation,
			acknowledge: () => {
				acknowledged = true;
			},
			respond,
		};
		events.emit(TODO_CREATE_FROM_PLAN_REQUEST_EVENT, request);

		queueMicrotask(() => {
			if (!acknowledged) {
				respond({ status: "unavailable", message: "The todos extension is not available." });
			}
		});
	});
}
