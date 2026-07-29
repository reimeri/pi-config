import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

async function readIfPresent(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

export function excludeContains(content: string, pattern: string): boolean {
	return content.split(/\r?\n/u).some((line) => line.trim() === pattern);
}

export async function ensureLocalExclude(commonGitDir: string, pattern: string | undefined): Promise<void> {
	if (!pattern) return;
	const excludePath = join(commonGitDir, "info", "exclude");
	const content = await readIfPresent(excludePath);
	if (excludeContains(content, pattern)) return;
	await mkdir(dirname(excludePath), { recursive: true });
	const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
	await appendFile(excludePath, `${separator}${pattern}\n`, "utf8");
}
