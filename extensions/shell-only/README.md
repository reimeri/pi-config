# Shell-only mode

Shell-only mode removes every active built-in tool except `bash`. Extension tools, SDK-provided custom tools, and custom overrides of built-in tool names remain available.

The mode is intended for workflows and benchmarks where the agent should use shell commands to inspect and modify files instead of Pi's built-in `read`, `write`, and `edit` tools.

## Usage

- `/shell-only` — toggle shell-only mode after the agent becomes idle.
- `--shell-only` — start enabled when the current session branch has no persisted tool-mode state.

The editor top bar shows `$ shell only` while the mode is active. Changes made with `/shell-only` are persisted in the current session and restored according to the active branch on resume, reload, and tree navigation. The startup flag supplies the default only when that branch has no persisted tool-mode state.

## Tool behavior

When enabled, shell-only mode keeps:

- the built-in `bash` tool;
- active tools registered by extensions;
- active SDK-provided custom tools;
- active custom overrides, even when they use a built-in name such as `read`.

It removes all other active built-ins, including `read`, `write`, `edit`, `grep`, `find`, and `ls`.

As with other coordinated modes, “active” refers to the baseline captured when the first restrictive mode is enabled. Tools registered but inactive at that point are not enabled by shell-only, and later dynamic activation remains subject to coordinator reconciliation.

The extension does not add system-prompt instructions or block tool calls with a hard gate. The active tool definitions are the only behavioral signal. This is not a security boundary: Bash and custom tools can read, modify, or delete files and perform other side effects.

## Mode composition

Shell-only mode uses tool-mode priority 20. The shared tool-mode coordinator composes it with other restrictive modes and owns baseline restoration and persisted state. Higher-priority modes such as supervisor and quarantine remain authoritative.
