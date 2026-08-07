# Subagent extension

Globally installed Pi extension for isolated codebase exploration, review, and web research.

## Installed agents

Agent definitions are discovered on every invocation from:

- `~/.pi/agent/agents/*.md` (default)
- `<project>/.pi/agents/*.md` when `agentScope` is `project` or `both`
- trusted extensions that contribute invocation-scoped agent Markdown files

Extension-contributed agents are loaded after user/project discovery and override the same name only for that invocation. Their result source is reported as `extension`; project-agent confirmation still applies only to repo-controlled project agents.

Current user agents:

| Agent | Model | Thinking | Tools |
|---|---|---|---|
| `scout` | `openai-codex/gpt-5.6-luna` | `medium` | `read, grep, find, ls, lsp_navigation` |
| `reviewer` | `openai-codex/gpt-5.6-sol` | `medium` | `read, grep, find, ls, bash, lsp_navigation, lsp_diagnostics` |
| `researcher` | `openai-codex/gpt-5.6-sol` | `medium` | `read, grep, find, ls, web_search` |

Supervisor mode conditionally contributes a `worker` implementation agent. It is discoverable and callable only while `/supervisor` is enabled; it is not installed in the normal user-agent directory.

The reviewer prompt restricts `bash` to read-only Git commands. This is an instruction, not an OS-level sandbox.

### How the model learns which agents exist

The tool description names every installed user agent and carries each one's own `description:` line in full, so the list the model chooses from is the list on disk. It used to name `scout`, `reviewer`, and `researcher` outright, which made the description a claim about a particular configuration: a renamed agent left the model calling something that no longer existed, and a fourth agent was uncallable unless the model guessed it was there.

Neither the number of agents nor the length of a description is capped. A cap would recreate exactly that failure for whatever fell past it, and since discovery does not sort, the cut would land by directory order — which agents the model could see would depend on the filesystem.

The list is built **once, when the extension loads**, not per call. A tool description is part of the request prefix, so rebuilding it from a fresh discovery on every invocation would rewrite the parent's cached prefix whenever an agent file was touched mid-conversation — re-sending the whole context to describe agents the model is not choosing between. The trade-off is that a newly added agent is callable immediately but unlisted until the next start or `/reload`. Everything else still reads agent files per call, so models and prompts stay live.

Two kinds of agent are deliberately absent from that list:

- **project agents**, which are opt-in per call via `agentScope` and gated on a trust prompt — advertising them from whatever directory Pi started in would be wrong on both counts;
- **mode-contributed agents** such as the supervisor's `worker`, which exist only while their mode is active. The description says a mode may add agents; the mode's own instructions describe them.

Calling an agent that does not exist returns the agents in scope for that call, which is the escape hatch for a mode's agents. It is not one for project agents: the scope defaults to `user`, so they are listed only once `agentScope` is already set. The tool description names that parameter instead.

## Configure an agent

Edit its Markdown frontmatter, for example:

```markdown
---
name: scout
description: Fast codebase exploration
model: openai-codex/gpt-5.6-luna
thinking: medium
tools: read, grep, find, ls
# Optional: prevent overlap with agents using the same group
concurrency: workspace-writer
# Optional: observe working-tree changes around each run
diff: true
---

Agent system prompt...
```

Supported `thinking` values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
`diff` accepts `true`/`false` (also `on`/`off`, `yes`/`no`) and defaults to on for agents that declare a `concurrency` group.
The model should use `provider/model` syntax. Agent definitions are read fresh for every tool call, so model and prompt edits do not require `/reload`. Changes to the TypeScript extension itself do require `/reload`.

## Tool modes

- Single: `{ "agent": "researcher", "task": "..." }`
- Parallel: `{ "tasks": [{ "agent": "scout", "task": "..." }, { "agent": "researcher", "task": "..." }] }`
- Chain: `{ "chain": [{ "agent": "researcher", "task": "..." }, { "agent": "reviewer", "task": "Review these findings: {previous}" }] }`

Chain mode rejects any agent that declares a concurrency group, including a chain containing only one. Editing agents run as separate single calls so the parent inspects each result before the next task starts.

Children run as ephemeral JSON-mode Pi processes. By default, every unkeyed invocation starts with fresh context and does not automatically receive the parent conversation or context from prior subagent invocations. Context must be supplied explicitly in an unkeyed task, including through chain mode's `{previous}` placeholder. A keyed resumption retains the child's earlier context as described below, but still needs a handoff for parent-side changes and evidence. The `subagent` tool is explicitly disabled in children to prevent recursive delegation.

## Reusable sessions

By default a child runs with `--no-session`, so two tasks sent to the same agent share nothing and the second re-reads what the first read. An optional `sessionKey` on any mode's item gives the run a session file to resume:

```json
{ "agent": "worker", "task": "...", "sessionKey": "queue-refactor" }
```

The next call with the same key resumes that child's conversation, so it starts already holding what it read and concluded, and the new task can be a delta instead of a full re-briefing. Every result carrying a session ends with a note giving the run number and the child's context size:

```
[Subagent session "queue-refactor", run 3, child context ~48k tokens.]
```

Sessions are:

- **scoped** to one agent, one working directory, and one parent session. A key reused across agents or checkouts starts a separate session rather than resuming a history the resuming agent would read as its own past work;
- **ephemeral**, living in a temp directory removed at session shutdown. They make a sequence of related tasks cheap; they are not agent memory;
- **exclusive**, since two children writing one session file would interleave their histories. A parallel batch repeating a key is rejected before any child starts, and a second run of a session already in use waits for the first to finish. A child that outlives its run — one that survived termination, or whose run was abandoned after a handle error — keeps its key for the rest of the conversation, because the file is still open to it; runs asking for that key are refused immediately rather than made to wait for a child that will not exit.

A key the tool cannot honour, because no temp directory could be made, does not fail the run: the child runs without a session, and the note says the session was unavailable instead of giving a run number. That matters to the parent rather than to the child, since the task was likely written as a delta against context the child now does not have.

Reuse trades isolation for cost. A resumed agent arrives holding its earlier assignments, its own suggestions about what to do next, and any wrong turns it took, so it suits successive tasks on the same code and not unrelated work. Context also accumulates across runs, and a session left to grow will eventually stop against the output limit — which is reported as a `length` failure. The run number and context size in the note are there to show when to start a new key.

### Review workflow

Call `reviewer` when the user asks for independent review or the specification/change affects runtime behavior, public or cross-component contracts, security/authentication/permissions/secrets, persistence/migrations/data-loss risk, concurrency/process lifecycle, compatibility, or multiple components. Skip it only when deterministic checks establish that every change is non-behavioral, such as formatting or comments, or generated output/metadata cleanup proven not to affect runtime behavior or compatibility. Documentation that defines behavior, APIs, operations, or requirements meets the contract trigger and must not use this skip exception.

A qualifying implementation review cycle has this default shape:

1. Give the initial full review a stable `sessionKey`.
2. Validate its findings against the requirements and current code before editing; suggestions and scope-expanding warnings are not automatic assignments.
3. Reuse the same reviewer, cwd, and key for one targeted follow-up. Name the prior findings, fixes, changed paths, and verification evidence, and ask only whether those findings remain or their fixes introduced regressions.
4. Stop delegating and verify directly. A third, blocker-only review is reserved for an unresolved critical release blocker involving security/authentication, data loss/persistence/migration, concurrency/process lifecycle, or compatibility, and reuses the same key.

The follow-up reviewer uses its retained context to avoid rediscovering unchanged files and contracts. It does not see parent-side edits or test results automatically, which is why the delta handoff remains required.

### Prompt caching

Reuse only pays off if the repeated prefix stays byte-identical, so the tool keeps its own inputs stable: the model, thinking level, tool list, and agent prompt all come from the agent Markdown, and the session flags are the only arguments that differ between a fresh run and a resumed one. Pi's own system prompt is built from the tool list, agent prompt, context files, and cwd, with no clock or environment block in it, so it does not vary on its own between calls.

What does change the prefix, and so costs a cache read: editing the agent's Markdown, editing `AGENTS.md`/`CLAUDE.md`, or changing the agent's tools. Those are real changes to what the child is, and re-sending is correct. Nothing that happens in the *parent* conversation between two calls affects a child's prefix.

## Concurrency groups

An agent may declare `concurrency: <group>` in its frontmatter. Within one parent Pi process:

- only one child from a group may run at a time, including across simultaneous `subagent` tool calls;
- a second run of a busy group **waits** for it rather than failing, and starts as soon as the group comes free;
- a parallel request containing the same group more than once is rejected before any child starts;
- a chain containing a grouped agent is rejected before any child starts;
- agents without a group retain normal parallel behavior;
- the group is released when the child succeeds, fails, or is aborted.

The supervisor worker uses `workspace-writer`, preventing concurrent edits in the same checkout. This is not a cross-process or filesystem lock.

The chain rule is about checkpoints rather than overlap. Chain steps are sequential, so they never race; the problem is that a chain would run several editing packages back to back with the parent seeing only the last one's output, skipping the diff inspection and verification that are supposed to happen between them.

### Waiting rather than refusing

A busy group used to fail the run outright, telling the parent to wait for the current worker. That reads as reasonable and behaves badly, because the caller is a model: it has no way to sleep, so its only move is to spend a turn and try again blind. Two workers launched in one turn made the second one fail instead of following the first.

The gate now queues. A run that finds its group held stays pending until the holder finishes, and the key is passed straight to the longest-waiting caller in the same tick, so arrivals cannot barge ahead of a caller that has been waiting minutes. While queued, the tool shows `(waiting for concurrency group "…"...)` rather than looking like a child that has not spoken yet.

Two things bound the wait:

- **abort** ends it immediately, so escape on a queued worker is not held hostage by a run it never started;
- a **10-minute timeout**, for the key nobody will release. Timing out is reported as a failure that says how long it waited and that the holder may be stuck, since by then the interesting problem is the other run rather than this one.

A run whose child outlived it is the other bound on the queue: the group is still released, as it always was, but it is not handed to whoever was queued behind it. That child is still alive and may still be editing, and inheriting its group would put a second worker in the same tree; the queued run is failed with a message saying so, and a later run the parent chooses to launch — having read why the first was given up on — can take the group normally.

The same queue governs `sessionKey`, whose keys are session ids rather than groups, so unrelated sessions never wait on each other. A session whose child outlived its run is a special case: that child still has the session file open and is never coming back, so the key is *abandoned* rather than left busy, and later runs asking for it fail at once — with a message telling the parent to pick another key — instead of sitting through a timeout that cannot help them.

Parallel mode no longer rejects a whole batch because one of its tasks names a busy group. That task queues; its read-only siblings, which are the reason the batch was parallel, run immediately.

## Task delivery

A task is normally one command-line argument. Every OS caps how large a single argument may be — 128 KB on Linux, and a hard 32767-character limit on the *whole* command line on Windows — and past that the spawn fails with `E2BIG` before the child exists. That was a failure the parent could do nothing about: the task had already been written, and the tool was simply refusing to carry it.

Tasks over 64 KB (8 KB on Windows) are written to a file in the run's temp directory and passed as an `@file` argument, which Pi inlines into the child's initial message. The threshold is deliberately well under the OS limit: on Linux the rest of the argument list and the entire environment share the same budget, and the limit counts bytes while a task is counted in characters, so mostly non-ASCII text is several times larger than its length suggests.

The file carries exactly the text the argument would have, so what the child reads does not change with the delivery. Because Pi presents an `@file` as `<file name="…">…</file>` ahead of the message, a short line follows it saying the file *is* the task rather than reference material handed over beside one. The file is removed when the run ends, except when the run gave up on a child that never exited: that child may still be starting, and pi exits on an `@file` it cannot find.

This matters most for chain mode, whose `{previous}` placeholder substitutes an uncapped previous step's output into the next step's task, and for long handoffs to a resumed session.

## Output caps

Every mode caps the text handed back to the parent at 50 KB per agent. The kept portion is cut on a character boundary and followed by a notice giving the byte count that was dropped and the path to a file holding the full output. That file lives in a per-session temp directory and is removed at session shutdown, so the parent can read the remainder on a later turn but the text does not accumulate across sessions. If the file cannot be written the cap still applies and the notice points at the tool details instead.

Chain mode's `{previous}` placeholder passes the previous step's output uncapped: it feeds the next child, not the parent's context.

## Observed workspace changes

For agents with `diff` enabled, the tool snapshots the working tree immediately before the child starts and again after it exits, and appends what changed to the result:

```
Observed workspace changes (git, /repo):
- src/queue.ts — modified (+24 -6)
- src/queue.test.ts — added
- HEAD moved: a1b2c3d → e4f5a6b
```

This is produced by the tool, not by the agent, so it is a check on the agent's own report rather than a repeat of it. It catches a completion report that names files it never touched, a report that names none of the files it did, a run that changed nothing at all, and a commit made by an agent that was not asked to commit. The section is appended after the output cap, so it is never the part that gets truncated.

Details:

- snapshots are `git status --porcelain -uall` plus `git diff --numstat`, run with `GIT_OPTIONAL_LOCKS=0` so observing cannot interfere with the checkout;
- the closing snapshot counts lines against the commit the run started from, not the current one, so a child that commits its own work still has its files listed — as `committed` rather than `modified`;
- renames are reported as a delete plus an add;
- line counts are the delta attributable to the run, so a tree that was already dirty does not inflate them;
- a file already dirty before the run is still detected by its line counts, but a rewrite that adds and removes exactly as much as the edit it replaced does not register. A clean tree before the run — the normal case — has no such blind spot;
- the report is captured even when the child fails or is aborted, which is when it matters most;
- outside a git repository, or when git is unavailable or times out, the section says so explicitly rather than implying nothing changed;
- observation happens while the agent's concurrency group is still held, so another run of that group cannot move the tree between the two snapshots. Two capture-enabled agents in *different* groups running in parallel would each attribute the other's changes to itself.

## What a result stores

The tool result carries the child's assistant turns so the collapsed and expanded views, and the HTML export, can be re-rendered later from the session file. Only what those renderers read is kept: assistant text and tool calls. Reasoning blocks and tool results are dropped as the stream arrives, since nothing reads them and they were 94% of the stored bytes — in one set of real sessions, 85 MB of 91 MB. A tool *call* is still recorded with its arguments, so a run that was aborted mid-edit still shows which files it had open.

None of this reaches the model, which receives only the result text. It is a session-file, load-time, and export-time cost rather than a token one.

## Failure reporting

A run is a failure when the child exits non-zero, or its final stop reason is `error`, `aborted`, or `length`. `length` means the child was cut off by its output limit mid-run, which exits 0 and would otherwise be reported as a completed task.

Aborted and truncated runs keep whatever the child produced. Their trailing text is labelled as partial rather than returned as the agent's report, because a child that stops mid-run ends on whatever it was narrating and that reads exactly like a completion report. Aborting no longer discards the run: an editing agent may already have changed files, and its message list is the only record of which ones. In parallel mode one task's failure or abort no longer discards its siblings' finished work.
