import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { ResourceCopyConfig, ResourceCopySummary } from "./types.ts";

async function stats(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function isWithin(parent: string, child: string): boolean {
	const value = relative(resolve(parent), resolve(child));
	return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

async function safeDirectoryRoot(checkout: string, directory: string, create: boolean): Promise<string | undefined> {
	const checkoutReal = await realpath(checkout);
	let directoryStats = await stats(directory);
	if (!directoryStats && create) {
		try {
			await mkdir(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		directoryStats = await stats(directory);
	}
	if (!directoryStats) return undefined;
	if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
		throw new Error(`Pi resource directory must be a real directory, not a symlink or special file: ${directory}`);
	}
	const directoryReal = await realpath(directory);
	if (!isWithin(checkoutReal, directoryReal)) {
		throw new Error(`Pi resource directory escapes its checkout: ${directory}`);
	}
	return directoryReal;
}

async function copyWithoutSymlinks(sourceRoot: string, source: string, target: string): Promise<boolean> {
	const sourceStats = await stats(source);
	if (!sourceStats || sourceStats.isSymbolicLink()) return false;
	const sourceReal = await realpath(source);
	if (!isWithin(sourceRoot, sourceReal)) throw new Error(`Pi resource escapes its source root: ${source}`);
	if (sourceStats.isFile()) {
		await copyFile(source, target);
		return true;
	}
	if (!sourceStats.isDirectory()) return false;
	await mkdir(target);
	for (const entry of await readdir(source)) {
		await copyWithoutSymlinks(sourceRoot, join(source, entry), join(target, entry));
	}
	return true;
}

async function publishWithoutOverwrite(staged: string, target: string, root = true): Promise<void> {
	const stagedStats = await lstat(staged);
	if (stagedStats.isFile()) {
		try {
			await copyFile(staged, target, constants.COPYFILE_EXCL);
		} catch (error) {
			if (!root && (error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new Error(`A destination entry appeared while publishing Pi resources: ${target}`);
			}
			throw error;
		}
		return;
	}
	if (!stagedStats.isDirectory()) throw new Error(`Unsupported staged resource: ${staged}`);
	try {
		await mkdir(target);
	} catch (error) {
		if (!root && (error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error(`A destination directory appeared while publishing Pi resources: ${target}`);
		}
		throw error;
	}
	// Publish without overwriting; on races, do not delete files another process may have added.
	for (const entry of await readdir(staged)) {
		await publishWithoutOverwrite(join(staged, entry), join(target, entry), false);
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function copyProjectResources(
	sourceCheckout: string,
	targetWorktree: string,
	config: ResourceCopyConfig,
): Promise<ResourceCopySummary> {
	const summary: ResourceCopySummary = { copied: [], skipped: [], failed: [] };
	if (config.mode === "none") {
		summary.skipped.push(...config.entries);
		return summary;
	}

	const sourceRootPath = join(sourceCheckout, CONFIG_DIR_NAME);
	const targetRootPath = join(targetWorktree, CONFIG_DIR_NAME);
	const sourceRoot = await safeDirectoryRoot(sourceCheckout, sourceRootPath, false);
	if (!sourceRoot) {
		summary.skipped.push(...config.entries);
		return summary;
	}
	await safeDirectoryRoot(targetWorktree, targetRootPath, true);

	for (const entry of config.entries) {
		const source = join(sourceRootPath, entry);
		const target = join(targetRootPath, entry);
		try {
			await safeDirectoryRoot(targetWorktree, targetRootPath, false);
			if ((await stats(target)) || !(await stats(source))) {
				summary.skipped.push(entry);
				continue;
			}
			const tempRoot = await mkdtemp(join(targetWorktree, ".pi-worktree-copy-"));
			try {
				const tempTarget = join(tempRoot, entry);
				const copied = await copyWithoutSymlinks(sourceRoot, source, tempTarget);
				if (!copied) {
					summary.skipped.push(entry);
					continue;
				}
				await safeDirectoryRoot(targetWorktree, targetRootPath, false);
				await publishWithoutOverwrite(tempTarget, target);
				summary.copied.push(entry);
			} finally {
				await rm(tempRoot, { recursive: true, force: true });
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST" || (error as NodeJS.ErrnoException).code === "ENOTEMPTY") {
				summary.skipped.push(entry);
			} else {
				summary.failed.push({ entry, error: errorText(error) });
			}
		}
	}
	return summary;
}

export function resourceSummaryWarnings(summary: ResourceCopySummary): string[] {
	const warnings: string[] = [];
	if (summary.failed.length > 0) {
		warnings.push(`Could not copy Pi resources: ${summary.failed.map((item) => `${item.entry} (${item.error})`).join(", ")}`);
	}
	return warnings;
}
