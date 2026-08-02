import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const GUIDANCE_MARKER = "<pi_dash_managed_worktree>";

export const PI_DASH_WORKTREE_GUIDANCE = `${GUIDANCE_MARKER}
This session is running in a Pi Dash-managed worktree. Its checked-out branch is part of the managed worktree identity.

- Keep the managed branch checked out for the lifetime of this worktree. Do not create or switch to another branch with git switch, git checkout, or equivalent commands here.
- Before creating a pull request, check whether the current branch already has a pull request for the intended base branch.
- If a matching pull request is open, commit and push the new changes to the same branch so they update that pull request. Update its title or description when the scope changed; do not create a duplicate pull request or a new branch.
- If the prior pull request was merged or closed and the user requests another pull request, continue using the same managed branch. Before starting follow-up work, fetch the intended base and rebase the clean managed branch onto its latest commit. Then commit, push, and create the new pull request from that same branch.
- Use separate Pi Dash-managed worktrees for independent simultaneous pull requests that require different branches. Never repurpose this worktree by changing its branch.
- If follow-up work already modified this worktree before the pull-request state was known, preserve the changes and branch identity. Do not switch branches or discard, stash, reset, or rewrite work before choosing a safe workflow with the user.
</pi_dash_managed_worktree>`;

export function isPiDashManagedEnvironment(env: NodeJS.ProcessEnv): boolean {
	const worktreeId = env.PI_DASH_WORKTREE_ID;
	const runtimeId = env.PI_DASH_RUNTIME_ID;
	const socketPath = env.PI_DASH_STATUS_SOCKET;
	const token = env.PI_DASH_STATUS_TOKEN;
	return Boolean(
		worktreeId
		&& UUID_PATTERN.test(worktreeId)
		&& runtimeId
		&& UUID_PATTERN.test(runtimeId)
		&& socketPath
		&& socketPath.length <= 4_096
		&& token
		&& token.length >= 32
		&& token.length <= 512,
	);
}

export default function piDashGuidance(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		if (!isPiDashManagedEnvironment(process.env)) return;
		if (event.systemPrompt.includes(GUIDANCE_MARKER)) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${PI_DASH_WORKTREE_GUIDANCE}`,
		};
	});
}
