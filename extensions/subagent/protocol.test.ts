import { describe, expect, test } from "vitest";
import { discoverExtensionAgents, SUBAGENT_AGENT_DISCOVERY_EVENT } from "./protocol.ts";

type Handler = (data: any) => void;

class FakeEvents {
	private readonly handlers: Handler[] = [];

	on(event: string, handler: Handler): () => void {
		if (event === SUBAGENT_AGENT_DISCOVERY_EVENT) this.handlers.push(handler);
		return () => {};
	}

	emit(event: string, data: unknown): void {
		if (event !== SUBAGENT_AGENT_DISCOVERY_EVENT) return;
		for (const handler of this.handlers) handler(data);
	}
}

describe("discoverExtensionAgents", () => {
	test("returns no agents when no extension contributes", () => {
		expect(discoverExtensionAgents(new FakeEvents() as any, "/repo")).toEqual([]);
	});

	test("collects, validates, and deduplicates contributions", () => {
		const events = new FakeEvents();
		events.on(SUBAGENT_AGENT_DISCOVERY_EVENT, (request) => {
			request.add({ providerId: "supervisor", filePath: "/agent/worker.md" });
			request.add({ providerId: "supervisor", filePath: "/agent/worker.md" });
			request.add({ providerId: "", filePath: "/invalid.md" });
		});

		expect(discoverExtensionAgents(events as any, "/repo")).toEqual([
			{ providerId: "supervisor", filePath: "/agent/worker.md" },
		]);
	});

	test("isolates contributor failures", () => {
		const events = new FakeEvents();
		events.on(SUBAGENT_AGENT_DISCOVERY_EVENT, () => {
			throw new Error("broken contributor");
		});

		expect(discoverExtensionAgents(events as any, "/repo")).toEqual([]);
	});
});
