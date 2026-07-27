import { describe, expect, test } from "bun:test";

import {
	buildGroupPlans,
	detachContainerRenderController,
	installContainerRenderController,
	renderContainerWithGroups,
	summarizeToolArgs,
	toolStatus,
	type ContainerLike,
	type GroupRenderController,
	type ToolLike,
} from "./core.ts";

class FakeContainer implements ContainerLike {
	constructor(public children: FakeComponent[] = []) {}

	render(width: number): string[] {
		return this.children.flatMap((child) => child.render(width));
	}
}

class FakeComponent {
	constructor(
		readonly name: string,
		readonly kind: "tool" | "separator" | "visible",
	) {}

	render(_width: number): string[] {
		return this.kind === "separator" ? [""] : [this.name];
	}
}

function tool(name: string): FakeComponent & ToolLike {
	const component = new FakeComponent(name, "tool") as FakeComponent & ToolLike;
	component.toolName = name;
	component.toolCallId = `id-${name}`;
	component.args = {};
	component.expanded = false;
	component.isPartial = false;
	component.executionStarted = true;
	component.result = { isError: false };
	component.setExpanded = () => {};
	component.updateResult = () => {};
	return component;
}

const isTool = (value: unknown): value is ToolLike =>
	value instanceof FakeComponent && value.kind === "tool";
const isSeparator = (value: unknown): boolean =>
	value instanceof FakeComponent && value.kind === "separator";

function controller(
	enabled = true,
	prefix = "group",
	minimumGroupSize: 1 | 2 = 2,
): GroupRenderController {
	return {
		isEnabled: () => enabled,
		minimumGroupSize: () => minimumGroupSize,
		isTool,
		isIgnorableSeparator: isSeparator,
		renderGroup: (tools) => [`${prefix}:${tools.map((item) => item.toolName).join(",")}`],
	};
}

describe("buildGroupPlans", () => {
	test("groups adjacent tools across any number of invisible separators", () => {
		const children = [
			tool("read"),
			new FakeComponent("", "separator"),
			new FakeComponent("", "separator"),
			tool("bash"),
			new FakeComponent("", "separator"),
			tool("grep"),
		];

		const plans = buildGroupPlans(children, isTool, isSeparator);
		expect(plans).toHaveLength(1);
		expect(plans[0]?.tools.map((item) => item.toolName)).toEqual(["read", "bash", "grep"]);
		expect(plans[0]).toMatchObject({ start: 0, end: 6 });
	});

	test("includes one-tool runs when the minimum group size is one", () => {
		const children = [
			tool("read"),
			new FakeComponent("answer", "visible"),
			tool("bash"),
		];

		const plans = buildGroupPlans(children, isTool, isSeparator, 1);
		expect(plans).toHaveLength(2);
		expect(plans[0]).toMatchObject({ start: 0, end: 1 });
		expect(plans[0]?.tools.map((item) => item.toolName)).toEqual(["read"]);
		expect(plans[1]).toMatchObject({ start: 2, end: 3 });
		expect(plans[1]?.tools.map((item) => item.toolName)).toEqual(["bash"]);
	});

	test("does not consume separators after a one-tool run", () => {
		const children = [
			tool("read"),
			new FakeComponent("", "separator"),
			new FakeComponent("answer", "visible"),
		];

		const [plan] = buildGroupPlans(children, isTool, isSeparator, 1);
		expect(plan).toMatchObject({ start: 0, end: 1 });
	});

	test("visible content breaks a run", () => {
		const children = [
			tool("read"),
			new FakeComponent("answer", "visible"),
			tool("bash"),
			tool("grep"),
		];

		const plans = buildGroupPlans(children, isTool, isSeparator);
		expect(plans).toHaveLength(1);
		expect(plans[0]?.tools.map((item) => item.toolName)).toEqual(["bash", "grep"]);
	});

	test("does not consume a trailing separator after the final tool", () => {
		const children = [
			tool("read"),
			tool("bash"),
			new FakeComponent("", "separator"),
			new FakeComponent("answer", "visible"),
		];

		const [plan] = buildGroupPlans(children, isTool, isSeparator);
		expect(plan).toMatchObject({ start: 0, end: 2 });
	});

	test("keeps intentionally uncapped runs in one group without mutation", () => {
		const children: FakeComponent[] = [];
		for (let index = 0; index < 100; index++) {
			if (index > 0) children.push(new FakeComponent("", "separator"));
			children.push(tool(`tool-${index}`));
		}
		const snapshot = [...children];

		const plans = buildGroupPlans(children, isTool, isSeparator);
		expect(plans).toHaveLength(1);
		expect(plans[0]?.tools).toHaveLength(100);
		expect(plans[0]).toMatchObject({ start: 0, end: children.length });
		expect(children).toEqual(snapshot);
	});
});

describe("renderContainerWithGroups", () => {
	const originalRender = FakeContainer.prototype.render;

	test("renders a group without mutating the component tree", () => {
		const children = [
			new FakeComponent("before", "visible"),
			tool("read"),
			new FakeComponent("", "separator"),
			tool("bash"),
			new FakeComponent("after", "visible"),
		];
		const container = new FakeContainer(children);

		const lines = renderContainerWithGroups(container, 80, originalRender, controller());
		expect(lines).toEqual(["before", "group:read,bash", "after"]);
		expect(container.children).toEqual(children);
	});

	test("renders a one-tool run when the controller includes singles", () => {
		const container = new FakeContainer([
			new FakeComponent("before", "visible"),
			tool("read"),
			new FakeComponent("after", "visible"),
		]);

		expect(renderContainerWithGroups(container, 80, originalRender, controller(true, "group", 1)))
			.toEqual(["before", "group:read", "after"]);
	});

	test("falls back byte-for-byte when disabled or when no run exists", () => {
		const container = new FakeContainer([
			new FakeComponent("before", "visible"),
			tool("read"),
			new FakeComponent("after", "visible"),
		]);
		const expected = originalRender.call(container, 80);

		expect(renderContainerWithGroups(container, 80, originalRender, controller(false))).toEqual(expected);
		expect(renderContainerWithGroups(container, 80, originalRender, controller(true))).toEqual(expected);
	});
});

describe("reload-safe prototype adapter", () => {
	test("routes through only the newest controller and lets stale shutdown detach safely", () => {
		class PatchedContainer extends FakeContainer {}
		const patchKey = Symbol("test-tool-groups");
		const prototype = PatchedContainer.prototype as unknown as Record<PropertyKey, unknown>;
		const first = controller(true, "first");
		const second = controller(true, "second");

		const firstState = installContainerRenderController(prototype, patchKey, first);
		const wrappedRender = PatchedContainer.prototype.render;
		const instance = new PatchedContainer([tool("read"), tool("bash")]);
		expect(instance.render(80)).toEqual(["first:read,bash"]);

		const secondState = installContainerRenderController(prototype, patchKey, second);
		expect(secondState).toBe(firstState);
		expect(PatchedContainer.prototype.render).toBe(wrappedRender);
		expect(instance.render(80)).toEqual(["second:read,bash"]);

		// The previous extension generation shutting down must not disable the new one.
		detachContainerRenderController(firstState, first);
		expect(instance.render(80)).toEqual(["second:read,bash"]);

		detachContainerRenderController(secondState, second);
		expect(instance.render(80)).toEqual(["read", "bash"]);
	});
});

describe("tool status and summaries", () => {
	test("does not misreport unmatched historical calls as done", () => {
		const pending = tool("read");
		pending.result = undefined;
		pending.executionStarted = false;
		pending.isPartial = true;
		expect(toolStatus(pending)).toBe("pending");

		pending.executionStarted = true;
		expect(toolStatus(pending)).toBe("running");
		pending.result = { isError: true };
		expect(toolStatus(pending)).toBe("failed");
	});

	test("creates concise summaries for common and custom tools", () => {
		const read = tool("read");
		read.args = { path: "/tmp/file.ts", offset: 10, limit: 20 };
		expect(summarizeToolArgs(read)).toBe("/tmp/file.ts (offset 10, limit 20)");

		const custom = tool("web_search");
		custom.args = { query: "grouped tool calls" };
		expect(summarizeToolArgs(custom)).toBe("grouped tool calls");
	});

	test("bounds work and output for very large tool arguments", () => {
		const bash = tool("bash");
		bash.args = { command: "x".repeat(1_000_000) };
		const bashSummary = summarizeToolArgs(bash);
		expect(bashSummary.length).toBeLessThan(4_100);
		expect(bashSummary.endsWith("…")).toBe(true);

		const custom = tool("custom");
		custom.args = {
			payload: "y".repeat(1_000_000),
			nested: { enormous: "z".repeat(1_000_000) },
		};
		const customSummary = summarizeToolArgs(custom);
		expect(customSummary.length).toBeLessThan(4_100);
		expect(customSummary).toStartWith("payload=");
	});
});
