# Double-paste expand

Pi collapses large clipboard pastes into markers such as `[paste #1 +123 lines]`.
This extension lets the user paste the same clipboard content again immediately to
replace that marker with the full text in the editor.

## Behavior

- Only pastes Pi considers large (more than 10 lines or more than 1000 characters) participate.
- The second identical paste is consumed; it does not insert a duplicate.
- Any intervening keyboard input cancels the pair.
- Mouse input does not cancel the pair.
- A different paste becomes the first paste of a new possible pair.
- Other paste markers already present in the draft stay collapsed.

The extension decorates the active editor during `resources_discover`, after normal
`session_start` editor setup. This allows it to compose with extensions such as
`current-task.ts` that already provide a custom editor. An editor factory installed
by a later `resources_discover` handler can still replace this wrapper; such an
extension must explicitly wrap the factory returned by `getEditorComponent()`.

## Loading

The extension is auto-discovered from this directory. Run `/reload` after changing it.

## Tests

From `~/.pi/agent/extensions`:

```bash
npm test -- double-paste-expand
```

The implementation uses Pi's public editor operations. Expanding a marker consists
of an atomic marker deletion followed by raw insertion, so those operations may be
separate undo steps.

Paste normalization, the large-paste thresholds, and marker recognition mirror the
active Pi editor implementation (more than 10 lines or more than 1000 characters).
Pi's terminal input buffer delivers a complete bracketed-paste start sequence; the
extension additionally buffers paste content and fragmented end sequences. If a
future Pi release changes its marker format or thresholds, these compatibility
assumptions and their tests must be updated together.
