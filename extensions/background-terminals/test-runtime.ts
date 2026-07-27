import { vi } from "vitest";

function truncation(text: string) {
	const lines = text === "" ? 0 : text.split("\n").length;
	const bytes = Buffer.byteLength(text, "utf8");
	return {
		content: text,
		truncated: false,
		outputLines: lines,
		totalLines: lines,
		outputBytes: bytes,
		totalBytes: bytes,
	};
}

vi.mock("@earendil-works/pi-coding-agent", () => ({
	DEFAULT_MAX_BYTES: 50 * 1024,
	DEFAULT_MAX_LINES: 2_000,
	formatSize: (bytes: number) => `${bytes}B`,
	getShellConfig: () => ({ shell: "/bin/bash", args: ["-c"], commandTransport: "arg" }),
	truncateHead: (text: string) => truncation(text),
	truncateTail: (text: string) => truncation(text),
}));

vi.mock("@earendil-works/pi-ai", () => ({
	StringEnum: (values: readonly string[], options: Record<string, unknown> = {}) => ({
		type: "string",
		enum: [...values],
		...options,
	}),
}));

const Type = {
	Object: (properties: Record<string, unknown>) => ({ type: "object", properties }),
	String: (options: Record<string, unknown> = {}) => ({ type: "string", ...options }),
	Number: (options: Record<string, unknown> = {}) => ({ type: "number", ...options }),
	Integer: (options: Record<string, unknown> = {}) => ({ type: "integer", ...options }),
	Optional: (schema: Record<string, unknown>) => ({ ...schema, optional: true }),
};

vi.mock("typebox", () => ({ Type }));
vi.mock("@earendil-works/pi-tui", () => ({
	Text: class Text {
		constructor(public text: string) {}
	},
}));
