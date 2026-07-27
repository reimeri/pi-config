# Subagent extension

Globally installed Pi extension for isolated codebase exploration, review, and web research.

## Installed agents

Agent definitions are discovered on every invocation from:

- `~/.pi/agent/agents/*.md` (default)
- `<project>/.pi/agents/*.md` when `agentScope` is `project` or `both`

Current user agents:

| Agent | Model | Thinking | Tools |
|---|---|---|---|
| `scout` | `openai-codex/gpt-5.6-luna` | `medium` | `read, grep, find, ls, lsp_navigation` |
| `reviewer` | `openai-codex/gpt-5.6-sol` | `medium` | `read, grep, find, ls, bash, lsp_navigation, lsp_diagnostics` |
| `researcher` | `openai-codex/gpt-5.6-sol` | `medium` | `read, grep, find, ls, web_search` |

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
