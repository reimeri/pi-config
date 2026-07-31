import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { discoverAgents, loadAgentFromFile } from "./agents.ts";

const tempDirs: string[] = [];

function tempAgent(name = "worker", concurrency = "workspace-writer"): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-agent-discovery-"));
	tempDirs.push(dir);
	const filePath = join(dir, `${name}.md`);
	writeFileSync(
		filePath,
		`---\nname: ${name}\ndescription: Test agent\nthinking: high\nconcurrency: ${concurrency}\ntools: read, edit\n---\n\nTest prompt.\n`,
	);
	return filePath;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("agent file loading", () => {
	test("loads extension metadata and concurrency group", () => {
		const filePath = tempAgent();
		const agent = loadAgentFromFile(filePath, "extension", "supervisor");

		expect(agent).toMatchObject({
			name: "worker",
			source: "extension",
			sourceId: "supervisor",
			concurrencyGroup: "workspace-writer",
			thinking: "high",
			tools: ["read", "edit"],
		});
	});

	test("ignores an invalid concurrency group", () => {
		const agent = loadAgentFromFile(tempAgent("worker", "not valid!"), "extension", "supervisor");
		expect(agent?.concurrencyGroup).toBeUndefined();
	});
});

describe("workspace diff capture", () => {
	function agentWith(frontmatter: string): ReturnType<typeof loadAgentFromFile> {
		const dir = mkdtempSync(join(tmpdir(), "pi-agent-diff-"));
		tempDirs.push(dir);
		const filePath = join(dir, "agent.md");
		writeFileSync(filePath, `---\nname: a\ndescription: d\n${frontmatter}---\n\nPrompt.\n`);
		return loadAgentFromFile(filePath, "user");
	}

	test("defaults to on for a grouped agent, which is the marker for mutating the checkout", () => {
		expect(agentWith("concurrency: workspace-writer\n")?.captureDiff).toBe(true);
	});

	test("defaults to off for an ungrouped agent", () => {
		expect(agentWith("")?.captureDiff).toBe(false);
	});

	test("lets an ungrouped agent opt in", () => {
		for (const value of ["true", "on", "yes", "TRUE"]) {
			expect(agentWith(`diff: ${value}\n`)?.captureDiff, value).toBe(true);
		}
	});

	test("lets a grouped agent opt out", () => {
		for (const value of ["false", "off", "no"]) {
			expect(agentWith(`concurrency: workspace-writer\ndiff: ${value}\n`)?.captureDiff, value).toBe(false);
		}
	});

	test("falls back to the group default when the value is not recognized", () => {
		expect(agentWith("concurrency: workspace-writer\ndiff: maybe\n")?.captureDiff).toBe(true);
		expect(agentWith("diff: maybe\n")?.captureDiff).toBe(false);
	});
});

describe("extension agent discovery", () => {
	test("adds invocation-scoped extension agents even with project-only scope", () => {
		const filePath = tempAgent();
		const cwd = mkdtempSync(join(tmpdir(), "pi-agent-cwd-"));
		tempDirs.push(cwd);

		const result = discoverAgents(cwd, "project", [{ providerId: "supervisor", filePath }]);

		expect(result.agents).toHaveLength(1);
		expect(result.agents[0]).toMatchObject({ name: "worker", source: "extension", sourceId: "supervisor" });
	});

	test("later extension contributions deterministically override by agent name", () => {
		const first = tempAgent("worker", "first-group");
		const second = tempAgent("worker", "second-group");
		const cwd = mkdtempSync(join(tmpdir(), "pi-agent-cwd-"));
		tempDirs.push(cwd);

		const result = discoverAgents(cwd, "project", [
			{ providerId: "first", filePath: first },
			{ providerId: "second", filePath: second },
		]);

		expect(result.agents).toHaveLength(1);
		expect(result.agents[0]).toMatchObject({ sourceId: "second", concurrencyGroup: "second-group" });
	});
});
