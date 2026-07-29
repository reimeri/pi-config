import type { GitRefRecord, Result, WorktreeRecord } from "./types.ts";

function branchName(fullName: string): string | undefined {
	const prefix = "refs/heads/";
	return fullName.startsWith(prefix) ? fullName.slice(prefix.length) : undefined;
}

export function parseWorktreePorcelain(output: string): Result<WorktreeRecord[]> {
	const records: WorktreeRecord[] = [];
	let current: WorktreeRecord | undefined;

	for (const field of output.split("\0")) {
		if (!field) {
			if (current) records.push(current);
			current = undefined;
			continue;
		}
		const separator = field.indexOf(" ");
		const key = separator < 0 ? field : field.slice(0, separator);
		const value = separator < 0 ? "" : field.slice(separator + 1);
		if (key === "worktree") {
			if (current) records.push(current);
			current = { path: value, detached: false, bare: false };
			continue;
		}
		if (!current) return { ok: false, error: `Malformed git worktree output near ${JSON.stringify(field)}` };
		switch (key) {
			case "HEAD":
				current.head = value;
				break;
			case "branch": {
				const branch = branchName(value);
				if (branch) current.branch = branch;
				break;
			}
			case "detached":
				current.detached = true;
				break;
			case "bare":
				current.bare = true;
				break;
			case "locked":
				current.locked = value;
				break;
			case "prunable":
				current.prunable = value;
				break;
		}
	}
	if (current) records.push(current);
	if (records.length === 0) return { ok: false, error: "Git reported no worktrees for this repository" };
	return { ok: true, value: records };
}

export function parseRefListing(output: string, remotes: string[]): GitRefRecord[] {
	const remoteNames = [...remotes].sort((left, right) => right.length - left.length);
	const records: GitRefRecord[] = [];
	for (const line of output.split("\n")) {
		if (!line) continue;
		const [fullName, shortName, objectId, upstream = "", symref = ""] = line.split("\t");
		if (!fullName || !shortName || !objectId || symref) continue;
		if (fullName.startsWith("refs/heads/")) {
			const localName = fullName.slice("refs/heads/".length);
			records.push({ fullName, shortName: localName, objectId, kind: "local", ...(upstream ? { upstream } : {}) });
			continue;
		}
		if (!fullName.startsWith("refs/remotes/")) continue;
		const remoteQualifiedName = fullName.slice("refs/remotes/".length);
		const remote = remoteNames.find((name) => remoteQualifiedName.startsWith(`${name}/`));
		if (!remote) continue;
		const remoteBranch = remoteQualifiedName.slice(remote.length + 1);
		if (!remoteBranch || remoteBranch === "HEAD") continue;
		records.push({
			fullName,
			shortName: `${remote}/${remoteBranch}`,
			objectId,
			kind: "remote",
			remote,
			remoteBranch,
			...(upstream ? { upstream } : {}),
		});
	}
	return records;
}
