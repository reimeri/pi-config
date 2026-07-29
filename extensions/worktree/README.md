# Worktree extension

Global Pi extension for creating, listing, and opening Git worktrees without leaving the current Pi process.

## Commands

- `/worktree` — interactively list repository worktrees or create one.
- `/worktree list` — open the same interactive list.
- `/worktree <branch>` — open an existing worktree, create one for a local branch, track a uniquely matching remote branch, or create a new branch from `HEAD`.
- `/worktree <branch> --from <ref>` — create a new branch from an explicit commit-ish.

`list` is reserved as the list subcommand. Branch and ref names cannot contain whitespace.

The extension registers only a slash command. It does not expose model-callable worktree tools.

## Behavior

The extension uses `git worktree list --porcelain -z` as its source of truth. If a requested branch is already checked out anywhere in the repository, that worktree is opened rather than duplicated. Existing linked worktrees outside the managed directory are also recognized.

By default, managed worktrees live in `.worktrees/` under the repository's primary checkout. Invoking the command from a linked worktree still resolves this same canonical directory. If a readable branch-derived directory name collides, a stable short hash is added rather than overwriting or adopting the existing path.

For an in-repository worktree root, the extension adds an anchored pattern to `.git/info/exclude`. It does not modify the tracked `.gitignore`.

After creation or selection, Pi switches to a fresh persisted session rooted in the target worktree. The new session:

- records the previous persisted session as `parentSession` when available;
- does not copy the previous conversation;
- includes a hidden model-context message identifying the worktree, branch or detached HEAD, and primary checkout;
- is named after the worktree branch;
- does not submit a prompt or trigger an agent response.

Detached existing worktrees can be opened through the interactive list. This version does not create new detached worktrees.

## Branch resolution

For `/worktree <branch>`, resolution order is:

1. An existing non-stale worktree for the local branch.
2. An existing local branch.
3. A uniquely matching `<remote>/<branch>` remote-tracking ref.
4. A new local branch from `HEAD`.

If multiple remotes contain the branch, the interactive creation flow asks which remote to track. The direct command reports the ambiguity so it cannot silently choose the wrong remote. `--from` is valid only when the requested local branch does not already exist.

Stale worktree registrations are never pruned automatically. The command reports them and asks the user to repair or run `git worktree prune` manually.

## Configuration

Optional global configuration:

```text
~/.pi/agent/worktree.json
```

Optional project configuration, read only when the current project is trusted:

```text
<current-checkout>/.pi/worktree.json
```

Project values override global values. Example:

```json
{
  "root": ".worktrees",
  "resources": {
    "mode": "copy",
    "entries": [
      "settings.json",
      "skills",
      "prompts",
      "themes",
      "SYSTEM.md",
      "APPEND_SYSTEM.md"
    ]
  }
}
```

`root` may be absolute or relative to the primary checkout. The default is `.worktrees`.

### Pi resource copying

Resource copying is **off by default**. Tracked `.pi` files already appear naturally in a Git worktree; copying is intended only for ignored or untracked project resources.

Set `resources.mode` to `copy` to opt in. Supported entries are:

- `settings.json`
- `skills`
- `prompts`
- `themes`
- `SYSTEM.md`
- `APPEND_SYSTEM.md`
- `extensions`

Copying never overwrites an existing top-level target entry, rejects symlinked `.pi` roots, does not follow nested symlinks, skips special files, and stages each entry through a temporary path before publishing it with no-overwrite semantics. Copying `extensions` is executable configuration and should be enabled only for trusted source projects.

## Safety and failure behavior

- Git commands use executable/argument arrays, not interpolated shell strings.
- Branch names and start refs are validated by Git before creation.
- Operations are serialized per common Git directory and state is refreshed after user selections.
- Managed roots cannot traverse symlinks or overlap Git metadata and registered worktrees.
- Unrelated existing paths are never overwritten.
- Worktrees, branches, and stale registrations are not removed automatically.
- If resource copying fails, opening continues with a warning.
- If session switching is cancelled, the extension-created session file is removed; a successfully created worktree is retained.

## Development

Tests use the shared extension harness:

```bash
cd ~/.pi/agent/extensions
npm test -- worktree
```

After changes, run `/reload` in Pi. Reloading this extension does not own or terminate external processes.
