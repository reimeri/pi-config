# TODO extension

Persistent, branch-aware TODO tracking for multi-step agent work.

## Features

- `todo_update` tool replaces the complete TODO list atomically.
- A compact widget above the editor shows active and pending work, including completed/total progress.
- `/todos` opens the complete list.
- State is restored from tool-result snapshots on resume and tree navigation.

TODO state belongs to the current session branch. Starting a new session starts with an empty list.

After changing this extension, run `/reload` in pi.
