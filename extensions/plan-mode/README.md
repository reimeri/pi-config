# Plan Mode Extension

Read-only exploration mode for safe code analysis.

## Features

- **Mutation tools disabled**: Disables edit, write, and `todo_update` while planning
- **Bash allowlist**: Restricts bash to an allowlist intended for inspection
- **Plan extraction**: Extracts numbered steps from `Plan:` sections
- **TODO handoff**: Creates the canonical execution list in the todos extension
- **Session persistence**: Plan-mode state survives session resume

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
- Other active tools remain available
- Bash commands are filtered through an allowlist
- The agent creates a plan without making changes

### Execution

- Plan mode sends extracted steps to the todos extension
- The first step starts `in_progress`; remaining steps start `pending`
- Normal tool access is restored and `todo_update` is enabled
- The agent updates progress through `todo_update`
- The todos extension owns persistence, branch handling, status, widget, and `/todos`

### Command Allowlist

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
