import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { copyProjectResources } from "./resources.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-worktree-resources-"));
	roots.push(root);
	const source = join(root, "source");
	const target = join(root, "target");
	await mkdir(join(source, ".pi", "skills", "safe"), { recursive: true });
	await mkdir(join(target, ".pi"), { recursive: true });
	await writeFile(join(source, ".pi", "settings.json"), "source");
	await writeFile(join(source, ".pi", "skills", "safe", "SKILL.md"), "safe");
	await symlink("/etc/passwd", join(source, ".pi", "skills", "unsafe-link"));
	return { root, source, target };
}

describe("Pi resource copying", () => {
	test("is disabled by default policy", async () => {
		const { target, source } = await fixture();
		const result = await copyProjectResources(source, target, { mode: "none", entries: ["settings.json"] });
		expect(result.skipped).toEqual(["settings.json"]);
		await expect(lstat(join(target, ".pi", "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("copies missing allowlisted entries without following symlinks", async () => {
		const { target, source } = await fixture();
		const result = await copyProjectResources(source, target, { mode: "copy", entries: ["settings.json", "skills"] });
		expect(result.copied).toEqual(["settings.json", "skills"]);
		expect(await readFile(join(target, ".pi", "settings.json"), "utf8")).toBe("source");
		expect(await readFile(join(target, ".pi", "skills", "safe", "SKILL.md"), "utf8")).toBe("safe");
		await expect(lstat(join(target, ".pi", "skills", "unsafe-link"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("never overwrites existing target entries", async () => {
		const { target, source } = await fixture();
		await writeFile(join(target, ".pi", "settings.json"), "target");
		const result = await copyProjectResources(source, target, { mode: "copy", entries: ["settings.json"] });
		expect(result.skipped).toEqual(["settings.json"]);
		expect(await readFile(join(target, ".pi", "settings.json"), "utf8")).toBe("target");
	});

	test("rejects symlinked source and target Pi roots", async () => {
		const sourceCase = await fixture();
		const externalSource = join(sourceCase.root, "external-source");
		await mkdir(externalSource);
		await rm(join(sourceCase.source, ".pi"), { recursive: true });
		await symlink(externalSource, join(sourceCase.source, ".pi"));
		await expect(copyProjectResources(sourceCase.source, sourceCase.target, { mode: "copy", entries: ["settings.json"] }))
			.rejects.toThrow(/not a symlink/u);

		const targetCase = await fixture();
		const externalTarget = join(targetCase.root, "external-target");
		await mkdir(externalTarget);
		await rm(join(targetCase.target, ".pi"), { recursive: true });
		await symlink(externalTarget, join(targetCase.target, ".pi"));
		await expect(copyProjectResources(targetCase.source, targetCase.target, { mode: "copy", entries: ["settings.json"] }))
			.rejects.toThrow(/not a symlink/u);
		expect(await readdir(externalTarget)).toEqual([]);
	});
});
