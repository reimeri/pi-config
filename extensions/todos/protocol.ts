export const MAX_TODOS = 30;

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoInput {
	id: string;
	text: string;
	status: TodoStatus;
}
