# Background terminals

Global Pi extension for session-scoped background shell processes. It is intended for long-running web servers, file watchers, and similar commands that the agent must leave running while it uses normal foreground tools to test them.

The extension captures stdout and stderr through pipes. It does not allocate a PTY or provide stdin interaction.

## Agent tools

### `background_start`

Starts a command in the current Pi working directory.

Parameters:

- `command` — shell command to run. The command should keep the server in the foreground; do not add `&` or daemonize it.
- `name` — optional short label.
- `ready_pattern` — optional output substring or safe regular expression.
- `ready_pattern_type` — `substring` (default) or `regex`.
- `ready_timeout_seconds` — optional readiness timeout, defaulting to 10 seconds.

Without a readiness pattern, the tool returns after the process spawns. With a pattern, it returns when the pattern is observed, the process exits, the wait is aborted, or the timeout expires.

A readiness timeout leaves the process running so the agent can inspect its logs or test it directly. Aborting the tool while it waits for readiness terminates the newly started process.

Regex readiness intentionally supports a safe subset: groups, alternation, backreferences, all unbounded quantifiers, and unbounded ranges are rejected. Use bounded forms such as `\\d{1,6}` instead of `\\d+`. The maximum possible match width is limited to the rolling-window overlap so cross-chunk matches remain reliable and readiness checks cannot grow with total log size.

### `background_list`

Lists all jobs in the current Pi session. Completed jobs remain listed until they are cleared or the session ends. An optional `status` parameter filters the result.

### `background_logs`

Reads retained output for one job.

Parameters:

- `id` — job ID such as `bg-1`.
- `cursor` — optional opaque `next_cursor` from an earlier call. Supplying it returns the next bounded page of newer output; continue with each returned cursor until caught up.
- `tail_lines` — optional number of trailing lines to return.

The result reports when the requested cursor predates retained output.

### `background_kill`

Stops a job's Unix process group. It sends `SIGTERM`, waits for the configured grace period, and then sends `SIGKILL` if necessary.

## `/ps` command

- `/ps` — open the interactive job manager.
- `/ps bg-1` — inspect a particular job and view its logs.
- `/ps kill bg-1` — confirm and stop a running job.
- `/ps clear bg-1` — remove a completed job record.
- `/ps clear completed` — remove all completed job records (`exited` remains an alias).

The interactive manager displays active and completed jobs, provides a static scrollable log viewer, and offers kill or clear actions as appropriate. `/ps` is TUI-only; use the background tools in RPC, JSON, or print modes.

## Configuration

Configuration uses optional environment variables. Invalid or out-of-range values fall back to defaults.

| Variable | Default | Meaning |
|---|---:|---|
| `PI_BACKGROUND_TERMINAL_MAX_BYTES` | `1048576` | Maximum retained log bytes per job |
| `PI_BACKGROUND_TERMINAL_MAX_LINES` | `10000` | Maximum retained log lines per job |
| `PI_BACKGROUND_TERMINAL_MAX_ACTIVE_JOBS` | `16` | Maximum concurrently active process groups |
| `PI_BACKGROUND_TERMINAL_MAX_RETAINED_JOBS` | `100` | Maximum active and completed job records retained together |
| `PI_BACKGROUND_TERMINAL_READY_TIMEOUT_MS` | `10000` | Default readiness timeout |
| `PI_BACKGROUND_TERMINAL_KILL_GRACE_MS` | `2000` | Delay between `SIGTERM` and `SIGKILL` |

Every individual tool result is additionally limited to Pi's standard 50KB or 2000 lines, whichever is reached first. Larger retained output remains available through later `background_logs` calls until it ages out of the bounded buffer.

Background commands receive the Pi process environment plus current `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL` values when available.

## Lifecycle

Jobs belong to the current Pi session runtime. All active jobs are terminated during `session_shutdown`, including:

- Pi exit
- `/reload`
- `/new`
- `/resume`
- `/fork` and `/clone`

Jobs are not persisted or reattached across sessions. When the retained-record limit is reached, the oldest safely completed records are evicted; a new start is rejected if no completed record can be evicted. Closed shell leaders with a still-live process group are monitored until the group disappears or is killed.

## Platform and process limitations

- Version 1 supports Linux and macOS only.
- Processes use captured stdout/stderr pipes, not a pseudo-terminal.
- Interactive programs and commands requiring stdin are unsupported.
- Commands must remain in the foreground. A process that daemonizes or creates a new process group can escape management.
- Output from stdout and stderr is merged in arrival order. ANSI terminal sequences and unsafe control characters are removed; carriage returns are normalized and tabs are expanded for stable rendering.

## Reloading

The extension is auto-discovered from `~/.pi/agent/extensions/background-terminals/index.ts`. Run `/reload` after changing its TypeScript files. Reloading also terminates any jobs owned by the previous extension runtime.
