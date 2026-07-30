# Supervisor mode

Supervisor mode turns the main Pi agent into a delegation-focused coordinator. The main agent may inspect the project and use Bash for information gathering, but it should delegate code changes and implementation verification to the conditional `worker` subagent.

## Usage

- `/supervisor` — toggle supervisor mode.
- `--supervisor` — start enabled when the current session branch has no persisted tool-mode state.

The editor top bar shows `◆ supervisor` while the mode is active.

## Main-agent tools

Supervisor mode softly removes these direct mutation tools from the main agent:

- `edit`
- `write`
- `lsp_code_actions`
- `lsp_rename`

Other baseline tools remain available, including `bash`, `subagent`, read/search tools, diagnostics, TODO tools, and background-process tools.

This is a behavioral mode, **not a security boundary**. Bash and custom tools can still cause side effects. The system prompt tells the main agent to use Bash for inspection and verification rather than file edits, dependency installation, mutating Git operations, or other implementation work. There is deliberately no default-deny `tool_call` gate.

## Conditional worker

While supervisor mode is enabled, the extension contributes `worker.md` to the subagent extension at invocation time. The agent:

- uses the configured implementation model and tools;
- edits and verifies work in the supplied `cwd` (the main checkout by default);
- cannot recursively invoke subagents;
- reports changed files, verification, and blockers;
- is unavailable when supervisor mode is disabled.

The worker definition is stored beside the extension rather than in `~/.pi/agent/agents`, so it does not become a normal globally discoverable agent.

## Concurrency

The worker declares the `workspace-writer` concurrency group. The subagent extension:

- rejects parallel requests containing multiple agents from that group;
- rejects overlapping worker launches from separate simultaneous tool calls;
- allows one worker alongside parallel read-only agents;
- allows repeated worker steps in a chain because chain steps are sequential;
- releases the group after success, failure, or abort.

This protection is process-local. Supervisor mode intentionally does not implement worktree allocation, cross-process locking, merging, or concurrent editing. Editing workers should remain sequential in the current checkout.

## Mode composition

Supervisor uses tool-mode priority 50:

- **Plan mode (10):** both modes can remain active, but the supervisor prompt instructs the agent not to delegate implementation while planning.
- **Quarantine (100):** quarantine remains authoritative and removes `subagent`, so delegation is unavailable until quarantine is disabled.

The shared tool-mode coordinator owns baseline restoration and persisted active-mode state. Supervisor restores its state on session start, resume, reload, and tree navigation.
