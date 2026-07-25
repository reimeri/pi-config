# TODO extension

Persistent, branch-aware TODO tracking for multi-step agent work.

## Features

- `todo_update` tool replaces the complete TODO list atomically.
- A compact widget above the editor shows active and pending work, including completed/total progress.
- `/todos` opens the complete list.
- Plan mode can create the canonical execution list through the extension event protocol.
- State is restored from tool-result or event-created snapshots on resume and tree navigation.

TODO state belongs to the current session branch. Starting a new session starts with an empty list. When plan mode requests a replacement, unfinished TODOs require confirmation; empty or fully completed lists are replaced directly.

After changing this extension, run `/reload` in pi.
