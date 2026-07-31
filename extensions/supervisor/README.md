# Supervisor mode

Supervisor mode turns the main Pi agent into a delegation-focused coordinator. The main agent may inspect the project and use Bash for information gathering and independent verification. It delegates code changes and their targeted implementation checks to the conditional `worker` subagent, then inspects or confirms the results itself.

## Usage

- `/supervisor` — toggle supervisor mode.
- `--supervisor` — start enabled when the current session branch has no persisted tool-mode state.

The editor top bar shows `◆ supervisor` while the mode is active.

## Intended workflow

The main agent acts as the senior planner and integrator:

1. Investigate directly or use `scout`; use `researcher` when senior technical or external research is useful.
2. Resolve ambiguity and select the architecture, interfaces, invariants, and sequencing.
3. For high-risk cross-cutting work, ask `reviewer` to critique the implementation specification.
4. Break implementation into TODO items that each represent one leaf worker package.
5. Invoke one worker with one package, inspect its diff, and verify its acceptance criteria before assigning the next package.
6. Review the integrated result and delegate narrow follow-up fixes when needed.

A leaf package has one independently reviewable outcome and one primary responsibility, normally within one subsystem plus focused tests. Split work that combines independently verifiable concerns or several boundaries such as persistence, domain policy, transactions, server integration, UI, migrations, and test infrastructure. Keep tightly coupled code and tests together; decomposition should not become file-by-file delegation.

Worker assignments may include extensive background, but their authority must remain narrow. Each assignment should explicitly provide:

- goal;
- approved design and relevant background;
- preconditions and current repository state;
- in-scope paths and symbols;
- required behavior and invariants;
- out-of-scope work;
- acceptance criteria;
- targeted verification and stop conditions;
- expected completion report.

Do not ask a worker to implement an entire moderate or complex milestone, choose major designs, fix anything else it encounters, or continue into subsequent tasks. TODOs should match worker packages rather than broad feature phases.

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
- has `diff: true`, so every result carries an observed change list;
- is unavailable when supervisor mode is disabled.

## Worker sessions

Successive leaves often land in the same subsystem, and a fresh worker re-reads all of it every time. Passing `sessionKey` on the subagent call resumes the previous worker's context, so it keeps what it already read and the new assignment can cover only what changed.

The supervisor decides per call. Reuse a key while leaves continue on the same code; omit it for unrelated work; start a new key when the plan moves to another subsystem or the reported child context has grown large. Each result ends with the session's run number and context size so that judgement has something to go on.

The full contract still applies to every leaf. A resumed worker knows what it did before, not what it is allowed to do now, and `worker.md` tells it to treat its own history as background and its earlier `Recommended Next Task` as a suggestion rather than an assignment.

## Observed workspace changes

Every worker result ends with an `Observed workspace changes` section produced by the subagent tool from `git` snapshots taken around the run, not by worker itself. It lists the files that actually moved, with line counts, and flags a HEAD move.

This is what turns "inspect the diff after every worker return" from an instruction the supervisor may skip into something it receives by default, and it costs no turn. The supervisor prompt requires reconciling it against worker's reported `Files Changed`: paths the report omits, a report claiming changes when none were observed, and any commit are all worth investigating.

It is a file inventory, not a replacement for reading the diff of consequential edits. See the subagent README for what the observation can and cannot detect.

The worker definition is stored beside the extension rather than in `~/.pi/agent/agents`, so it does not become a normal globally discoverable agent.

Before editing, the worker checks that its assignment is a coherent leaf with every required contract element and resolved design decisions. It reports `Scope Rejected` with every missing assignment element or decision and a suggested split rather than guessing, partially implementing an oversized package, or silently broadening scope.

## Concurrency

The worker declares the `workspace-writer` concurrency group. The subagent extension:

- rejects parallel requests containing multiple agents from that group;
- serializes overlapping worker launches from separate simultaneous tool calls, queuing the second until the first finishes rather than failing it;
- rejects any chain containing an agent from that group;
- allows one worker alongside parallel read-only agents;
- releases the group after success, failure, or abort, but does not pass it to a queued worker when the previous child outlived its run and may still be editing.

Queuing keeps two workers from editing at once; it does not make launching two of them correct. The supervisor is still required to inspect and verify each package before delegating the next, and a queued second worker was written against a workspace the first one has since changed.

The supervisor workflow requires a separate single call for every worker package so the main agent must inspect and verify each result. The subagent tool enforces the no-worker-chain rule: a chain naming `worker` is refused before any child starts, with a message directing the supervisor to separate single calls.

Concurrency protection is process-local. It prevents overlapping and back-to-back chained workers, not oversized assignments or a supervisor that skips its own inspection. Supervisor mode intentionally does not implement worktree allocation, cross-process locking, merging, or concurrent editing. Editing workers should remain sequential in the current checkout.

## Mode composition

Supervisor uses tool-mode priority 50:

- **Plan mode (10):** both modes can remain active, but the supervisor prompt instructs the agent not to delegate implementation while planning.
- **Quarantine (100):** quarantine remains authoritative and removes `subagent`, so delegation is unavailable until quarantine is disabled.

The shared tool-mode coordinator owns baseline restoration and persisted active-mode state. Supervisor restores its state on session start, resume, reload, and tree navigation.
