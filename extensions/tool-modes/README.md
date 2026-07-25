# Tool Mode Coordinator

Coordinates extensions that restrict Pi's active tools.

The coordinator captures one unconstrained baseline when the first mode is enabled, applies active mode policies in ascending priority order, and restores the baseline only after the last mode is disabled. This prevents modes from restoring stale snapshots over one another.

## Adding a Mode

Import `setToolMode` and define a policy:

```ts
const mode = {
  id: "my-mode",
  priority: 20,
  apply: (tools: string[]) => tools.filter(isAllowed),
};

await setToolMode(pi.events, mode, true, { persist: true });  // enable
await setToolMode(pi.events, mode, false, { persist: true }); // disable
```

Each request includes the policy so extension load order does not matter. Only `tool-modes/index.ts` calls `pi.setActiveTools()` during normal coordinated operation.

Policies compose from lowest to highest priority. An absolute policy can ignore its input and return a fixed set. Quarantine uses priority 100 and an absolute policy, so it overrides plan mode at priority 10.

Use a baseline patch when disabling a mode must intentionally change normal access. Plan execution uses this to ensure `todo_update` is present:

```ts
await setToolMode(pi.events, mode, false, {
  baselinePatch: { add: ["todo_update"] },
  persist: true,
});
```

When `persist` is requested, the coordinator atomically records the shared baseline and active mode IDs as the canonical restoration state. It reapplies active policies before agent runs and after turns, and restores the baseline during session shutdown. Before every model turn it also appends hidden context with the reconciled active modes and tools, including locally reported fail-closed modes, preventing stale conversation history from making the model treat a disabled mode as active. Individual modes remain responsible for their prompts, UI, tool-call guards, and any legacy-compatible state entries.
