# Plan Mode Extension

Exploration mode that steers the agent toward planning instead of implementing.

## Plan mode is not a security boundary

Plan mode is a **nudge, not a sandbox**. Its purpose is to keep the agent thinking and
writing a plan at a point where it would otherwise start editing. It is not designed to
contain an agent that is actively trying to make changes, and it is not hardened against
prompt injection or adversarial repository content.

Concretely, plan mode does not stop:

- **Other tools that reach a shell.** Only `bash` is allowlisted. Tools such as
  `background_start` and `subagent` stay active and run commands the allowlist never sees.
- **Allowlisted commands with side effects.** The allowlist matches the leading command of
  the string, so chained and piped forms (`grep x . ; ...`, `curl … | sh`,
  `find . -delete`, `cat f && python -c …`) can slip through.
- **Tools registered by other extensions**, which are left active by design so planning can
  use them.

Use **quarantine** (`/quarantine`) when you need an actual restriction. Quarantine is the
hardened mode: it applies an absolute policy that allows only the built-in `read`, `grep`,
`find`, and `ls` tools, verifies each one is a genuine built-in, and backs that with a
default-deny `tool_call` gate that blocks every other tool regardless of what is active.
Quarantine runs at a higher priority than plan mode, so it stays authoritative when both
are enabled.

## Features

- **Mutation tools disabled**: Disables edit, write, and `todo_update` while planning
- **Bash allowlist**: Steers bash toward an allowlist intended for inspection (best effort)
- **Plan extraction**: Extracts numbered steps from `Plan:` sections
- **TODO handoff**: Creates the canonical execution list in the todos extension
- **Session persistence**: Plan-mode state survives session resume
- **Mode composition**: Shares a coordinated baseline with quarantine and future tool modes

## Commands

- `/plan` - Toggle plan mode
- `Ctrl+Alt+P` - Toggle plan mode (shortcut)

## Usage

1. Enable plan mode with `/plan` or the `--plan` flag
2. Ask the agent to analyze code and create a plan
3. The agent outputs up to 30 numbered steps under a `Plan:` header:

```
Plan:
1. First step description
2. Second step description
3. Third step description
```

4. Choose "Execute the plan" when prompted
5. Plan mode creates the canonical TODO list, restores normal tool access, and enables `todo_update`
6. Follow execution progress in the todos extension widget or with `/todos`

If unfinished TODOs already exist, the todos extension asks before replacing them. Completed lists are replaced without prompting.

## How It Works

### Plan Mode (Read-Only)

- Built-in edit/write and `todo_update` are disabled
- Other baseline tools remain available, including tools registered by other extensions
- Tool access is composed by the shared tool-mode coordinator; higher-priority modes such as quarantine remain authoritative
- Bash commands are filtered through an allowlist
- The agent creates a plan without making changes

Plan mode composes with quarantine rather than replacing it. If you need the read-only
guarantee enforced, enable quarantine as well — see
[Plan mode is not a security boundary](#plan-mode-is-not-a-security-boundary).

### Execution

- Plan mode sends extracted steps to the todos extension
- The first step starts `in_progress`; remaining steps start `pending`
- Normal tool access is restored and `todo_update` is enabled
- The agent updates progress through `todo_update`
- The todos extension owns persistence, branch handling, status, widget, and `/todos`

### Command Allowlist

The allowlist is a guardrail against the agent casually reaching for a mutating command,
not a sandbox. It matches patterns against the command string, so a determined or
injected command can get past it. See
[Plan mode is not a security boundary](#plan-mode-is-not-a-security-boundary).

Safe commands include:

- File inspection: `cat`, `head`, `tail`, `less`, `more`
- Search: `grep`, `find`, `rg`, `fd`
- Directory: `ls`, `pwd`, `tree`
- Git read: `git status`, `git log`, `git diff`, `git branch`
- Package info: `npm list`, `npm outdated`, `yarn info`
- System info: `uname`, `whoami`, `date`, `uptime`

Blocked commands include:

- File modification: `rm`, `mv`, `cp`, `mkdir`, `touch`
- Git write: `git add`, `git commit`, `git push`
- Package installation: `npm install`, `yarn add`, `pip install`
- System mutation: `sudo`, `kill`, `reboot`
- Editors: `vim`, `nano`, `code`
