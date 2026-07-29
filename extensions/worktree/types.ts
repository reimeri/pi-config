export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const PI_RESOURCE_ENTRIES = [
	"settings.json",
	"skills",
	"prompts",
	"themes",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
	"extensions",
] as const;

export type PiResourceEntry = (typeof PI_RESOURCE_ENTRIES)[number];

export interface ResourceCopyConfig {
	mode: "none" | "copy";
	entries: PiResourceEntry[];
}

export interface WorktreeConfig {
	root: string;
	resources: ResourceCopyConfig;
}

export interface LoadedWorktreeConfig {
	config: WorktreeConfig;
	warnings: string[];
}

export interface WorktreeRecord {
	path: string;
	head?: string;
	branch?: string;
	detached: boolean;
	bare: boolean;
	locked?: string;
	prunable?: string;
}

export interface GitRefRecord {
	fullName: string;
	shortName: string;
	objectId: string;
	upstream?: string;
	kind: "local" | "remote";
	remote?: string;
	remoteBranch?: string;
}

export interface RepositorySnapshot {
	currentRoot: string;
	primaryRoot: string;
	commonGitDir: string;
	worktreeRoot: string;
	worktrees: WorktreeRecord[];
	refs: GitRefRecord[];
}

export type BranchResolution =
	| { kind: "open"; branch: string; worktree: WorktreeRecord }
	| { kind: "local"; branch: string; ref: GitRefRecord }
	| { kind: "remote"; branch: string; ref: GitRefRecord }
	| { kind: "new"; branch: string; startRef: string };

export interface WorktreeOpenResult {
	status: "created" | "reused";
	branch?: string;
	worktreePath: string;
	worktree: WorktreeRecord;
	warnings: string[];
}

export interface ResourceCopySummary {
	copied: PiResourceEntry[];
	skipped: PiResourceEntry[];
	failed: Array<{ entry: PiResourceEntry; error: string }>;
}
