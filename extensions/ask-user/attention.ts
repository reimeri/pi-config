import { randomUUID } from "node:crypto";

const PI_DASH_ATTENTION_EVENT = "pi-dash:attention";

export interface AttentionEventBus {
	emit(event: string, payload: unknown): void;
}

function emitAttention(
	events: AttentionEventBus,
	phase: "start" | "end",
	interactionId: string,
): void {
	try {
		events.emit(PI_DASH_ATTENTION_EVENT, {
			phase,
			interactionId,
			reason: "ask_user",
		});
	} catch {
		// Dashboard status integration must never interfere with the question UI.
	}
}

export async function withPiDashAttention<T>(
	events: AttentionEventBus,
	waitForUser: () => Promise<T>,
	createInteractionId: () => string = randomUUID,
): Promise<T> {
	let interactionId: string;
	try {
		interactionId = createInteractionId();
	} catch {
		return await waitForUser();
	}

	emitAttention(events, "start", interactionId);
	try {
		return await waitForUser();
	} finally {
		emitAttention(events, "end", interactionId);
	}
}
