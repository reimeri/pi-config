import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorktreeRecord } from "./types.ts";

const MAX_DIRECTORY_NAME = 80;

export function sanitizeDirectoryName(branch: string): string {
	const normalized = branch.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "");
	const slug = normalized
		.replace(/[^A-Za-z0-9._-]+/gu, "-")
		.replace(/-+/gu, "-")
		.replace(/^[.-]+|[.-]+$/gu, "")
		.slice(0, MAX_DIRECTORY_NAME);
	return slug || "worktree";
}

function branchHash(branch: string): string {
	return createHash("sha256").update(branch).digest("hex").slice(0, 10);
}

function pathKey(path: string): string {
	return resolve(path).toLocaleLowerCase("en-US");
}

function isWithin(parent: string, child: string): boolean {
	const value = relative(resolve(parent), resolve(child));
	return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

async function rejectRedirectedExistingAncestor(target: string): Promise<void> {
	let current = resolve(target);
	while (true) {
		try {
			await lstat(current);
			const canonical = await realpath(current);
			if (resolve(canonical) !== current) {
				throw new Error(`Worktree root traverses a symbolic link at ${current} (resolves to ${canonical})`);
			}
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(current);
			if (parent === current) return;
			current = parent;
		}
	}
}

async function rejectSymlinkedPathFrom(anchor: string, target: string): Promise<void> {
	const value = relative(resolve(anchor), resolve(target));
	if (value === "" || value === ".." || value.startsWith(`..${sep}`)) return;
	let current = resolve(anchor);
	for (const segment of value.split(sep).filter(Boolean)) {
		current = join(current, segment);
		try {
			const currentStats = await lstat(current);
			if (currentStats.isSymbolicLink()) throw new Error(`Worktree root must not traverse a symbolic link: ${current}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
	}
}

async function canonicalIfExisting(path: string): Promise<string> {
	try {
		return resolve(await realpath(path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(path);
		throw error;
	}
}

function assertNoOverlap(
	primary: string,
	common: string,
	root: string,
	registeredWorktrees: string[],
): void {
	if (root === primary || isWithin(root, primary)) {
		throw new Error(`Worktree root must not contain the primary checkout: ${root}`);
	}
	if (root === common || isWithin(common, root) || isWithin(root, common)) {
		throw new Error(`Worktree root must not overlap Git metadata: ${root}`);
	}
	for (const registered of registeredWorktrees) {
		// Containing registered worktrees is allowed; reject an exact collision here.
		if (root === registered) {
			throw new Error(`Worktree root must not be a registered worktree: ${registered}`);
		}
		if (registered !== primary && isWithin(registered, root)) {
			throw new Error(`Worktree root must not be inside another linked worktree: ${registered}`);
		}
	}
}

export async function validateWorktreeRoot(
	primaryRoot: string,
	commonGitDir: string,
	worktreeRoot: string,
	worktrees: WorktreeRecord[],
): Promise<void> {
	const primary = resolve(primaryRoot);
	const common = resolve(commonGitDir);
	const root = resolve(worktreeRoot);
	const registered = worktrees.map((worktree) => resolve(worktree.path));
	assertNoOverlap(primary, common, root, registered);
	try {
		const rootStats = await lstat(root);
		if (rootStats.isSymbolicLink()) throw new Error(`Worktree root must not be a symbolic link: ${root}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await rejectRedirectedExistingAncestor(root);
	await rejectSymlinkedPathFrom(primary, root);

	const canonicalPrimary = await canonicalIfExisting(primary);
	const canonicalCommon = await canonicalIfExisting(common);
	const canonicalRoot = await canonicalIfExisting(root);
	const canonicalRegistered = await Promise.all(registered.map(canonicalIfExisting));
	assertNoOverlap(canonicalPrimary, canonicalCommon, canonicalRoot, canonicalRegistered);
}

export function chooseWorktreePath(root: string, branch: string, worktrees: WorktreeRecord[]): string {
	const slug = sanitizeDirectoryName(branch);
	const candidate = join(root, slug);
	const occupied = new Set(worktrees.map((worktree) => pathKey(worktree.path)));
	if (!occupied.has(pathKey(candidate)) && !existsSync(candidate)) return candidate;
	const suffix = `--${branchHash(branch)}`;
	const hashed = join(root, `${slug.slice(0, MAX_DIRECTORY_NAME - suffix.length)}${suffix}`);
	if (!occupied.has(pathKey(hashed)) && !existsSync(hashed)) return hashed;
	throw new Error(`No safe worktree path is available for branch ${branch}; conflicting path: ${hashed}`);
}

export function displayPath(path: string, primaryRoot: string): string {
	const absolute = resolve(path);
	const root = resolve(primaryRoot);
	return absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : absolute;
}

export function worktreeLabel(worktree: WorktreeRecord, primaryRoot: string): string {
	const identity = worktree.branch ?? (worktree.detached ? `detached@${worktree.head?.slice(0, 10) ?? "unknown"}` : "bare");
	const flags = [worktree.locked !== undefined ? "locked" : "", worktree.prunable !== undefined ? "missing" : ""]
		.filter(Boolean)
		.join(", ");
	return `${identity} — ${displayPath(worktree.path, primaryRoot)}${flags ? ` [${flags}]` : ""}`;
}

export function rootExcludePattern(primaryRoot: string, worktreeRoot: string): string | undefined {
	const root = resolve(primaryRoot);
	const target = resolve(worktreeRoot);
	if (!target.startsWith(`${root}/`)) return undefined;
	const relative = target.slice(root.length + 1).split("\\").join("/");
	if (!relative || relative.startsWith("../")) return undefined;
	// Escape glob metacharacters so a literal root name matches literally.
	const trimmed = relative.replace(/^\/+|\/+$/gu, "").replace(/[\\[\]*?]/gu, (character) => `\\${character}`);
	return `/${trimmed}/`;
}

export function repositoryDisplayName(primaryRoot: string): string {
	return basename(primaryRoot) || primaryRoot;
}
