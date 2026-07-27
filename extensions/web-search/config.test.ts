import { describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDedicatedModelConfig } from "./config.ts";

describe("dedicated model config", () => {
	test("distinguishes missing, valid, and invalid files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-global-web-search-"));
		const path = join(dir, "web-search.json");
		try {
			expect((await readDedicatedModelConfig(path)).status).toBe("missing");
			await writeFile(path, JSON.stringify({ provider: " openai ", model: " gpt-test " }));
			expect(await readDedicatedModelConfig(path)).toEqual({
				status: "configured",
				path,
				config: { provider: "openai", model: "gpt-test" },
			});
			await writeFile(path, "{broken");
			const invalid = await readDedicatedModelConfig(path);
			expect(invalid.status).toBe("invalid");
			if (invalid.status === "invalid") expect(invalid.error).toContain("Invalid JSON");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
