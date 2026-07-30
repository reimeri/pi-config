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
---

Agent system prompt...
```

Supported `thinking` values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
The model should use `provider/model` syntax. Agent definitions are read fresh for every tool call, so model and prompt edits do not require `/reload`. Changes to the TypeScript extension itself do require `/reload`.

## Tool modes

- Single: `{ "agent": "researcher", "task": "..." }`
- Parallel: `{ "tasks": [{ "agent": "scout", "task": "..." }, { "agent": "researcher", "task": "..." }] }`
- Chain: `{ "chain": [{ "agent": "researcher", "task": "..." }, { "agent": "reviewer", "task": "Review these findings: {previous}" }] }`

Children run as ephemeral JSON-mode Pi processes. The `subagent` tool is explicitly disabled in children to prevent recursive delegation.

## Concurrency groups

An agent may declare `concurrency: <group>` in its frontmatter. Within one parent Pi process:

- only one child from a group may run at a time, including across simultaneous `subagent` tool calls;
- a parallel request containing the same group more than once is rejected before any child starts;
- agents without a group retain normal parallel behavior;
- sequential chain steps may reuse a group;
- the group is released when the child succeeds, fails, or is aborted.

The supervisor worker uses `workspace-writer`, preventing concurrent edits in the same checkout. This is not a cross-process or filesystem lock.
