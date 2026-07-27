# Base LSP Extension — Comprehensive Implementation Plan

## 1. Purpose

Build a new, focused Pi extension that gives the coding agent reliable Language Server Protocol (LSP) diagnostics, semantic navigation, code actions, and safe refactoring support across a broad range of repositories.

This is a new implementation. Use `@narumitw/pi-lsp` as a behavioral reference and source of lessons, not as a codebase to copy. Adopt the strongest lifecycle, root-detection, cancellation, process-cleanup, and diagnostic-truthfulness ideas from `pi-lens`, while deliberately excluding its formatter, linter, scanner, project-intelligence, read-guard, test-runner, and automatic context-injection systems.

The extension should feel like a compact semantic toolbox for the agent, not an IDE UI and not an autonomous code-quality framework.

Working name: **base-lsp**.

Target location:

```text
~/.pi/agent/extensions/base-lsp/
```

If needed you can find pi-lsp in the following location:

```text
/tmp/pi-extensions/extensions/pi-lsp
```

and pi-lens in the following location:

```text
/tmp/pi-lens
```

## 2. Goals

1. Expose high-value LSP capabilities through a small, agent-friendly tool surface.
2. Reuse persistent language-server processes within a Pi session so navigation is fast after initial indexing.
3. Select the correct server and workspace root for each file, including nested projects and monorepos.
4. Keep server state synchronized with files changed by Pi tools and with external changes observed before a request.
5. Distinguish confirmed diagnostics from missing, stale, timed-out, or unavailable results.
6. Make every request cancellable and bounded by deadlines and output limits.
7. Handle server processes and descendants safely on Linux/macOS and Windows.
8. Make all mutation operations preview-first, workspace-confined, validated, serialized, and as atomic as practical.
9. Support project-local configuration only when the project is trusted.
10. Work correctly in TUI, RPC, JSON, and print modes.
11. Provide broad language support without automatically downloading or installing language servers.
12. Have enough deterministic fixture and integration testing that adding a new server does not destabilize existing ones.

## 3. Non-goals

Do **not** add these systems:

- Source formatting or an LSP formatting tool.
- Automatic format-on-write or fix-on-write.
- Non-LSP linters, scanners, security tools, AST search, tree-sitter analysis, tests, dependency graphs, or project reports.
- Automatic installation of language servers or package-manager tools.
- Automatic findings injected into model context.
- Editor completion, inline UI, code lenses, semantic-token rendering, inlay-hint rendering, document colors, folding ranges, or linked editing.
- A general `workspace/executeCommand` tool. Server commands can run arbitrary behavior and are too broad for the expected value.
- Unsolicited server-requested edits. `workspace/applyEdit` must be declined unless a future tightly scoped transaction explicitly authorizes it.
- A cross-process daemon or cross-session language-server registry in the first implementation.
- Supporting remote SSH/container filesystems in v1. All paths and server processes are local.

## 4. Lessons to carry forward

### 4.1 From pi-lsp

Keep:

- JSON-only declarative server configuration.
- Extension-based routing with explicit server override.
- Broad built-in server catalog, but lazy startup.
- Diagnostics and code-action behavior implemented through a shared client.
- Preview-by-default mutations.
- Workspace containment and symlink-escape checks.
- Fake-server protocol tests and real-server smoke tests.

Improve:

- Do not start and stop a server for every tool call.
- Infer roots from language-specific project markers rather than defaulting blindly to CWD.
- Bound stdout protocol buffers, stderr, tool text, and structured details.
- Kill process trees, not only direct children.
- Use LSP request cancellation rather than killing a shared server for every cancelled tool call.
- Synchronize document versions and changed contents.
- Use a complete, safe workspace-edit engine rather than single-file extraction and direct `writeFileSync()`.
- Use Pi's file mutation queue for writes.
- Normalize all LSP result variants, including `LocationLink`, hierarchical symbols, and resource operations.
- Treat external server output as untrusted text.
- Keep runtime Pi packages in `peerDependencies`, per Pi package guidance.

### 4.2 From pi-lens

Adopt in simplified form:

- Persistent clients keyed by server and normalized root.
- In-flight spawn/root-detection deduplication.
- Per-server root marker strategies, including glob markers.
- Full-content `didChange` synchronization with monotonically increasing versions.
- Process-group/tree cleanup and graceful-to-forceful shutdown escalation.
- Per-request cancellation, deadlines, cooldown after repeated failure, and idempotent shutdown.
- Honest diagnostic states: confirmed clean is not the same as silence or timeout.
- Server-affine concurrency and bounded workspace sweeps.
- Compact tool output with structured metadata and explicit truncation.
- Agent-friendly 1-based positions and optional symbol-column resolution.

Defer:

- On-disk diagnostic caches.
- Reverse-dependency invalidation.
- Cross-process budgets, instance registries, and orphan reapers.
- Automatic installers and prewarming unrelated servers.
- Adaptive performance telemetry beyond basic timings and failure counters.
- Auxiliary scanners disguised as LSP sources.

## 5. Design principles

1. **Explicit tools, quiet background behavior.** Keep clients synchronized in the background, but only send findings to the model when a tool is called.
2. **Semantic operations should outperform grep, not duplicate it.** Include operations where language semantics materially improve precision.
3. **Read-only first.** Navigation and diagnostics are low risk. Mutation paths require a separate safety layer and separate tools.
4. **One semantic server per file by default.** Query auxiliary servers only for diagnostics/code actions, never silently merge competing navigation answers.
5. **No shell command strings.** Store commands as executable plus argv. Never interpolate paths, symbols, or model input into shell source.
6. **Every extension-controlled await is bounded.** Startup, initialization, requests, diagnostic settling, shutdown, and process-kill escalation all need deadlines. Pi's non-abortable per-file mutation queue is the documented exception: once queued, wait for acquisition, immediately recheck cancellation inside the callback, and unwind without writing.
7. **Every list is bounded.** Files, diagnostics, locations, symbols, edits, stderr, and rendered output need limits.
8. **No false certainty.** Return state and evidence, not merely an empty array.
9. **Deterministic output.** Stable ordering makes results easier for the agent and tests.
10. **Configuration is privileged code by another form.** A configured server command executes with user permissions, so project configuration requires Pi project trust.

## 6. Feature scope and decisions

### 6.1 Include

| Capability | LSP methods | Why it is valuable |
|---|---|---|
| Document/workspace diagnostics | `textDocument/publishDiagnostics`, `textDocument/diagnostic`, optionally `workspace/diagnostic` | Compiler/type/language feedback with semantic context. |
| Declaration | `textDocument/declaration` | Finds declarations distinct from implementations in languages that model both. |
| Definition | `textDocument/definition` | High-value precise navigation to implementation/definition. |
| Type definition | `textDocument/typeDefinition` | Resolves inferred variable/expression types to their declarations. |
| Implementation | `textDocument/implementation` | Finds concrete implementations of interfaces, traits, and abstract members. |
| References | `textDocument/references` | Semantic impact analysis and caller/test discovery. |
| Hover | `textDocument/hover` | Gives inferred types, overload information, and concise docs without reading dependencies. |
| Document symbols | `textDocument/documentSymbol` | Produces a cheap semantic outline and exact ranges for targeted reads. |
| Workspace symbols | `workspace/symbol`, optionally `workspaceSymbol/resolve` | Finds named semantic entities when the file is unknown. |
| Call hierarchy | `textDocument/prepareCallHierarchy`, `callHierarchy/incomingCalls`, `callHierarchy/outgoingCalls` | Traces callers/callees and unfamiliar control flow. |
| Code actions | `textDocument/codeAction`, `codeAction/resolve` | Exposes server-native quick fixes and refactors without adding a formatter subsystem. |
| Prepare rename and rename | `textDocument/prepareRename`, `textDocument/rename` | Safe semantic multi-file renaming with preview. |
| Server capabilities/status | initialize result and internal manager state | Needed for correct routing and useful user diagnostics. Expose through `/lsp`, not another model tool. |

### 6.2 Exclude initially

| Capability | Reason |
|---|---|
| Completion | Large/noisy result sets; the agent can write code and use diagnostics/hover afterward. |
| Signature help | Mostly cursor-editor UX and substantially overlaps hover/definition. Reconsider only if real workflows demonstrate value. |
| Document highlights | References is more useful and works across files. |
| Type hierarchy | Useful mainly in inheritance-heavy repositories; implementation/references cover most agent needs. Keep as a future extension point. |
| Selection ranges | The agent already has line-based reads and document-symbol ranges. |
| Formatting and range formatting | Explicit non-goal. Use project formatters through existing shell tooling. |
| Folding ranges | Editor presentation concern. |
| Semantic tokens | Editor rendering concern and potentially huge. |
| Inlay hints | Editor presentation; hover gives targeted type information. |
| Code lens | Often command-backed and UI-oriented. |
| Document links/colors/linked editing/monikers | Niche and poor value relative to tool/schema complexity. |
| General execute-command | Side effects are server-defined and difficult to constrain. |
| File rename notifications | Valuable but more complex and less universal than symbol rename. Add only after the workspace-edit engine is proven. |

Document excluded capabilities in the README so future contributors do not gradually turn the extension into an IDE clone.

## 7. Agent-facing tool surface

Register exactly four tools initially. Use `StringEnum` from `@earendil-works/pi-ai` for operation enums so schemas remain compatible with Google providers.

All public lines and columns are **1-based**. Public columns count **UTF-16 code units**, matching LSP's default encoding and JavaScript string indexing. Internally convert between public UTF-16 columns and the server-negotiated encoding. For position-based operations, allow a `symbol` locator so the agent rarely needs to count columns. A numeric `character` takes precedence when supplied. The `symbol` form supports `name#N` for the Nth exact occurrence on the selected line.

All tools return a common envelope whose routing fields can represent single-server, multi-server, unavailable, and ambiguous operations:

```ts
{
  content: [{ type: "text", text: string }],
  details: {
    operation: string,
    status: "ok" | "partial" | "no_results" | "unsupported" |
            "unavailable" | "ambiguous" | "untrusted" |
            "timed_out" | "cancelled" | "error",
    server?: string,
    root?: string,
    servers?: Array<{
      server: string;
      root?: string;
      status: string;
      durationMs: number;
    }>;
    durationMs: number,
    truncated: boolean,
    warnings: string[],
    // operation-specific bounded data
  }
}
```

Each tool defines a typed operation-specific `details` extension. Diagnostics additionally carries per-file evidence states (`diagnostics`, `clean`, `unconfirmed`, `timed_out`, `unavailable`, `cancelled`, `error`); those evidence states are not collapsed into the generic top-level status. Aggregate diagnostics status is `ok` only when every requested in-scope server/file result is affirmative (`clean` or `diagnostics`), `partial` when affirmative and non-affirmative states are mixed, and the corresponding failure state when no affirmative result exists.

Throw only for invalid input, violated safety invariants, or genuine execution failures that should mark the Pi tool result as `isError`. Expected states such as unsupported capability, no results, ambiguity, untrusted project, or unavailable default server should return a normal structured result.

### 7.1 `lsp_diagnostics`

Purpose: obtain truthful file or bounded workspace diagnostics.

Schema:

```ts
{
  paths?: string[];                    // files/directories; default current workspace root
  root?: string;                       // optional override within session boundary
  server?: string | string[];          // default primary + enabled diagnostic-role matches
  severity?: "error" | "warning" | "information" | "hint" | "all";
  mode?: "changed" | "paths" | "workspace"; // default paths if paths given, otherwise workspace
  maxFiles?: number;                   // clamped to configured hard limit
  maxDiagnostics?: number;             // clamped to configured hard limit
  waitMs?: number;                     // clamped to request timeout ceiling
  refresh?: boolean;                   // bypass confirmed in-memory result cache
}
```

Behavior:

- `changed` checks files synchronized or observed as changed during the session.
- `paths` checks explicit files/directories.
- `workspace` uses `workspace/diagnostic` if advertised and reliable for a selected server/root; otherwise performs a bounded, server-affine file sweep.
- Candidate discovery and server selection are deterministic:
  1. For `changed`, inventory the bounded changed-file set. For `paths`, inventory only explicit files/directories. For default/workspace mode, perform one deterministic sorted walk of the session boundary, honoring ignores, file-size limits, a separate hard `maxDiscoveryEntries`, and `maxFiles`; report `partial` if discovery is capped.
  2. If `server` is explicit, retain only files matching those server definitions and resolve roots from them.
  3. Otherwise route every inventoried file using normal filename/extension/root/priority rules, then group by `(server, root)`. Include the selected primary and enabled diagnostic-role matches; deduplicate groups.
  4. Start/query only groups backed by at least one inventoried matching file. Never launch every configured server merely because no path was supplied.
  5. Invoke native `workspace/diagnostic` once per selected `(server, root)` group when supported; otherwise sweep that group's bounded files. No matching files means `no_results`, not an arbitrary server choice.
- Return per-server results separately before producing a merged display. Do not let an auxiliary result redefine whether the primary server confirmed a clean file.
- Report each file/server result as one of:
  - `diagnostics`: affirmative response with findings;
  - `clean`: affirmative response with no findings;
  - `unconfirmed`: push server was silent;
  - `timed_out`;
  - `unavailable`;
  - `cancelled`;
  - `error`.
- Never turn timeout or silence into `clean`.
- Include explicit counts for omitted files and diagnostics.

### 7.2 `lsp_navigation`

Purpose: group related read-only semantic operations without registering many tool schemas.

Schema:

```ts
{
  operation:
    | "declaration"
    | "definition"
    | "type_definition"
    | "implementation"
    | "references"
    | "hover"
    | "document_symbols"
    | "workspace_symbols"
    | "incoming_calls"
    | "outgoing_calls";

  path?: string;               // required except workspace_symbols
  line?: number;               // required for position-based operations
  character?: number;          // 1-based; optional when symbol is supplied
  symbol?: string;             // exact symbol on line, optionally name#N
  query?: string;              // required for workspace_symbols
  includeDeclaration?: boolean;// references only; default true
  itemId?: string;             // call hierarchy identity returned when preparation is ambiguous
  server?: string;             // optional explicit semantic server
  root?: string;
  limit?: number;              // bounded by operation-specific maximum
}
```

Operation behavior:

- Normalize `Location`, `Location[]`, and `LocationLink[]` into one location representation.
- `document_symbols` accepts hierarchical `DocumentSymbol[]` and flat `SymbolInformation[]`; preserve hierarchy depth and selection/range data.
- `workspace_symbols` uses explicit `server` if supplied. Otherwise use a contextual `path` when supplied, then the configured primary server for the root. If multiple unrelated primary servers remain, return a clear ambiguity response rather than querying all silently.
- Resolve workspace symbols only when the server advertises resolve support and resolution adds missing location data.
- `incoming_calls` and `outgoing_calls` internally call `prepareCallHierarchy`; do not require the model to pass opaque hierarchy objects between tool calls. If preparation returns multiple items and `itemId` is absent, return bounded choices whose `itemId` hashes server/root/source content hash plus normalized item name/kind/URI/range/selectionRange/data fingerprint. If `itemId` is supplied, rerun preparation and proceed only when exactly one fresh item has the same identity. Never rely on array order across requests.
- Hover normalizes plaintext, Markdown `MarkupContent`, deprecated `MarkedString`, and arrays. Sanitize control sequences and bound text.
- Return `possiblyIncomplete: true` when server indexing/work-done progress is still active.

Normalized location:

```ts
{
  uri: string;
  path?: string;               // workspace-relative when file URI is within root
  external: boolean;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  selectionRange?: ...;
  originSelectionRange?: ...;
  positionEncoding: "utf-8" | "utf-16" | "utf-32";
  rawRange?: ...;               // server-native 0-based range when public conversion is unavailable
}
```

External and non-file URIs may be displayed for read-only navigation, clearly marked `external`, but must never be passed to mutation code. Convert returned columns to public 1-based UTF-16 only when target text is already available or the target is a local file inside the session boundary. Do not read external targets merely to convert a column. When text is unavailable, omit the public `character`, preserve `rawRange` plus `positionEncoding`, and render `URI:line` without inventing a column.

### 7.3 `lsp_code_actions`

Purpose: list, preview, or apply server-provided quick fixes/refactors. Formatting is not a supported objective.

Schema:

```ts
{
  path: string;
  line: number;
  character?: number;
  endLine?: number;
  endCharacter?: number;
  symbol?: string;
  kind?: string;                 // e.g. quickfix or refactor.extract
  title?: string;                // exact selected action title; must be unique on apply
  actionId?: string;             // identity returned by a required prior preview; required for apply
  server?: string;
  root?: string;
  apply?: boolean;               // default false
}
```

Behavior:

1. Synchronize the document and obtain current diagnostics for the selected range.
2. Request code actions with optional `context.only`.
3. Resolve actions only when the server advertises `resolveProvider`.
4. Expose title, kind, preferred/disabled state, diagnostics, and whether an edit or command is present.
5. Preview edit-bearing actions through the workspace-edit engine.
6. Never execute command-only actions. Return them as unsupported with a reason.
7. Reject applying actions that contain both an edit and command. Applying only the edit is an unsafe partial action. A future server-specific policy may permit an action only when documented tests prove its command is optional.
8. A preview returns `actionId`, a hash over server/root/source snapshot, title, kind, and the normalized edit/command fingerprint. `apply: true` requires an `actionId`, performs a fresh request and resolution, then requires exactly one exact identity match. `title` may narrow/select an action for preview but never authorizes apply. Never reuse a list index across requests and never apply every matching action implicitly.
9. Reject formatting-only action kinds by default (`source.format*` or server-specific configured formatting kinds). Permit general quick fixes, refactors, organize-imports, and source fixes only when explicitly selected.

### 7.4 `lsp_rename`

Purpose: preview or apply a semantic symbol rename.

Schema:

```ts
{
  path: string;
  line: number;
  character?: number;
  symbol?: string;
  newName: string;
  renameId?: string;             // identity returned by a required prior preview; required for apply
  server?: string;
  root?: string;
  apply?: boolean;               // default false
}
```

Behavior:

1. Resolve and synchronize the source document.
2. Check `renameProvider`.
3. If `prepareProvider` is advertised, call `textDocument/prepareRename` and reject invalid positions/names before rename.
4. Request rename and normalize the full `WorkspaceEdit`.
5. Preview all affected files with bounded unified diffs. Retain a complete normalized edit manifest only when it falls within hard transaction limits; otherwise return a bounded summary with omitted counts and mark the transaction non-applicable. Return `renameId`, hashing server/root/source snapshot/new name plus the complete normalized workspace-edit fingerprint.
6. Apply only when `apply: true` and `renameId` is supplied. Rerun prepare/rename against a fresh synchronized snapshot and require an exact identity match before workspace transaction validation. A direct apply without prior preview identity is rejected.
7. Never silently discard edits for other files.
8. If the edit contains unsupported or unsafe resource operations, preview them but reject apply with a precise explanation.

## 8. User-facing commands and UI

Register one slash command with subcommands:

```text
/lsp                     # concise status for all configured servers
/lsp status [server]     # command, availability, roots, capabilities, state, failures
/lsp restart [server]    # gracefully restart matching session clients
/lsp stop [server]       # stop matching clients; lazy restart on next request
/lsp config              # show effective config paths and validation warnings, not secrets
```

Requirements:

- Commands must work without an active model turn.
- Guard interactive notifications with `ctx.hasUI`; return useful textual notifications in RPC-compatible form where supported.
- Never print environment values or full initialization settings that may contain secrets.
- Use a single status key such as `base-lsp`, showing only short states like `LSP: starting typescript` or `LSP: references`.
- Clear status in `finally` blocks and during `session_shutdown`.
- Do not add a persistent widget or inject context messages.
- Custom tool renderers are optional. If implemented, keep collapsed output to one summary line and use fallback raw text when rendering fails.

## 9. Proposed package and source layout

```text
base-lsp/
├── index.ts                        # auto-discovery shim; re-exports src/index.ts default
├── PLAN.md
├── README.md
├── LICENSE
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                    # extension factory and registrations
│   ├── extension.ts                # lifecycle wiring, commands, tool construction
│   ├── config/
│   │   ├── schema.ts               # config types and validation
│   │   ├── loader.ts               # trusted layered loading and notices
│   │   └── defaults.ts             # global limits and default catalog composition
│   ├── servers/
│   │   ├── registry.ts             # declarative server definitions
│   │   ├── catalog.ts              # built-in server catalog
│   │   ├── roots.ts                # root marker strategies and cache
│   │   ├── routing.ts              # extension/language/role/capability selection
│   │   ├── command.ts              # PATH resolution and safe spawning metadata
│   │   └── language-ids.ts
│   ├── protocol/
│   │   ├── client.ts               # JSON-RPC/LSP request and notification wrapper
│   │   ├── capabilities.ts         # static + dynamic capability registry
│   │   ├── types.ts                # minimal protocol types used by this extension
│   │   ├── positions.ts            # position-encoding conversion
│   │   ├── locations.ts            # URI/location/symbol normalization
│   │   ├── diagnostics.ts           # pull/push state machine
│   │   ├── progress.ts              # work-done/partial-result tracking
│   │   └── errors.ts
│   ├── runtime/
│   │   ├── client-manager.ts        # persistent clients keyed by server/root
│   │   ├── document-store.ts        # open docs, versions, hashes, sync queues
│   │   ├── process.ts               # spawn and process-tree termination
│   │   ├── request.ts               # timeout/AbortSignal/cancellation bridge
│   │   ├── cooldown.ts              # bounded failure backoff
│   │   └── limits.ts                # centralized hard limits
│   ├── workspace/
│   │   ├── boundary.ts              # realpath containment and trust boundary
│   │   ├── files.ts                 # bounded discovery and ignores
│   │   ├── edits.ts                 # workspace-edit parsing and validation
│   │   ├── transaction.ts           # queueing, staging, atomic writes, rollback
│   │   └── diff.ts                  # bounded preview generation
│   ├── tools/
│   │   ├── diagnostics.ts
│   │   ├── navigation.ts
│   │   ├── code-actions.ts
│   │   ├── rename.ts
│   │   ├── schemas.ts
│   │   ├── results.ts               # standard result envelope and truncation
│   │   └── rendering.ts             # optional compact TUI renderers
│   └── util/
│       ├── async.ts
│       ├── logging.ts               # bounded, redacted debug log support
│       └── text.ts                   # control sanitization and stable sorting
└── test/
    ├── fixtures/
    │   └── lsp-server.mjs           # configurable deterministic fake server
    ├── unit/
    ├── integration/
    ├── smoke/
    └── helpers/
```

Keep modules small and make protocol/data normalization independently testable. Do not put the implementation in one large `index.ts`.

## 10. Package metadata and dependencies

Use a Pi package manifest even though the extension initially lives in the global extension directory:

```json
{
  "name": "base-lsp",
  "private": true,
  "type": "module",
  "keywords": ["pi-package", "pi-extension", "lsp"],
  "pi": { "extensions": ["./index.ts"] },
  "dependencies": {
    "ignore": "<current-reviewed-version>",
    "vscode-jsonrpc": "<current-reviewed-version>"
  },
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  }
}
```

Guidance:

- The top-level `index.ts` is required because Pi auto-discovers `~/.pi/agent/extensions/base-lsp/index.ts`. It should contain only `export { default } from "./src/index.js";`. Test both top-level auto-discovery and explicit package loading through the `pi` manifest.
- Use `vscode-jsonrpc` for JSON-RPC request/response bookkeeping, but provide the bounded transport described in Section 17 rather than using its default unbounded stream reader. Keep process lifecycle, limits, and Pi abort semantics under extension control.
- Use `ignore` for `.gitignore`-compatible traversal. If a smaller audited implementation is preferred, remove the dependency only after equivalent tests exist.
- Pi-provided packages belong in `peerDependencies` and must not be bundled.
- Initial compatibility target: Node.js `>=24` and Pi coding-agent `>=0.82.1`, the first explicitly tested Pi baseline for the required lifecycle APIs, typed result guards, truncation helpers, `CONFIG_DIR_NAME`, and `withFileMutationQueue`. This extension is currently intended for personal use on Node 24, so older Node releases are out of scope. Keep Pi peer ranges as `"*"` per Pi package guidance, but document the tested minimum, run package-load tests against it, and fail with a clear startup error when a required runtime export is unavailable. Raise the minimum deliberately when APIs change.
- Put test/build tooling in `devDependencies`.
- Prefer source TypeScript loaded by Pi/Jiti for the local extension. If publishing later, add a `dist` build and installation self-test.
- Pin a lockfile and review lifecycle scripts. Runtime dependencies should not require install scripts if avoidable.

## 11. Configuration model

### 11.1 Locations and precedence

Load, lowest to highest:

1. Built-in defaults and server catalog.
2. User config: `~/.pi/agent/base-lsp.json` using Pi's resolved agent directory, not a hard-coded home path.
3. Trusted project config: after deriving the VCS/session boundary independently, walk from `ctx.cwd` upward to that boundary and load the nearest `<directory>/<CONFIG_DIR_NAME>/base-lsp.json`.
4. Explicit CLI flags registered by the extension, limited to safe booleans and limits; do not accept arbitrary JSON on the command line in v1.

Rules:

- Derive the initial boundary from `ctx.cwd` and the nearest VCS root before looking for extension config; config contents never determine where config is searched.
- Read project configuration only when `ctx.isProjectTrusted()` is true.
- By default, refuse to start any language server when `ctx.isProjectTrusted()` is false. Return `untrusted` and instruct the user to trust the project and restart. User-global config may set `allowUntrustedProjects: true` as an explicit blanket opt-in; project config cannot set it. This matters because built-in servers may load repository-controlled plugins, compiler hooks, build files, or macros even when no project LSP config is read.
- Pi project trust is not a sandbox. It authorizes loading project resources and, for this extension, server startup; server processes still run with full user permissions.
- Use `CONFIG_DIR_NAME` from Pi for project config paths.
- JSON only; never evaluate JS/TS configuration.
- Validate the whole file and report path-specific errors. Do not silently coerce malformed server commands or limits.
- Layer server definitions by server id. Objects deep-merge, arrays replace, and `null` explicitly clears optional values. Document this rule.
- Redact `env` values and settings from UI/status output.
- Cache by path + mtime, but reload at `session_start` and `/reload`.

### 11.2 Example

```json
{
  "enabled": true,
  "allowUntrustedProjects": false,
  "limits": {
    "requestTimeoutMs": 20000,
    "initializeTimeoutMs": 30000,
    "shutdownTimeoutMs": 2000,
    "idleClientMs": 300000,
    "maxClients": 6,
    "maxDiscoveryEntries": 10000,
    "maxFiles": 100,
    "maxDiagnostics": 300,
    "maxLocations": 200,
    "maxSymbols": 300
  },
  "ignore": ["generated/**", "vendor/**"],
  "disabledServers": ["biome"],
  "serverOverrides": {
    "rust-analyzer": {
      "initializationOptions": {
        "cargo": { "allFeatures": true }
      }
    }
  },
  "servers": {
    "custom-foo": {
      "command": ["foo-language-server", "--stdio"],
      "extensions": [".foo"],
      "languageIds": { ".foo": "foo" },
      "role": "primary",
      "priority": 100,
      "rootMarkers": ["foo.mod", ".git"],
      "rootFallback": "workspace"
    }
  }
}
```

### 11.3 Server definition

```ts
interface ServerDefinition {
  id: string;
  displayName: string;
  enabled: boolean;
  command: string[];                    // non-empty argv; no shell string
  env?: Record<string, string>;
  extensions: string[];
  filenames?: string[];                 // e.g. Dockerfile
  languageIds: Record<string, string>;
  role: "primary" | "diagnostic";
  priority: number;
  rootMarkers: Array<string | { glob: string }>;
  rootFallback: "none" | "workspace" | "file-directory";
  initializationOptions?: unknown;
  settings?: unknown;
  workspaceConfiguration?: Record<string, unknown>;
  requestTimeoutMs?: number;
  diagnosticPolicy?: {
    pushFirstMs?: number;
    settleMs?: number;
    emptyPullGraceMs?: number;
  };
  capabilityOverrides?: Partial<NormalizedServerCapabilities>;
}
```

`capabilityOverrides` are an escape hatch for known server mis-advertising. Built-in overrides require a comment and a regression/smoke test.

## 12. Built-in server catalog

Ship a declarative catalog, but never install servers. `/lsp` should report missing commands and installation hints from documentation without trying to fix them.

Minimum catalog groups:

| Language/ecosystem | Primary server candidates | Typical root markers |
|---|---|---|
| JavaScript/TypeScript | `typescript-language-server`; Deno when `deno.json*` is nearest | `tsconfig.json`, `jsconfig.json`, `package.json`, `deno.json`, `deno.jsonc`, `.git` |
| Vue/Svelte | Vue language server, Svelte language server | framework config, `package.json`, TS config |
| Python | basedpyright or pyright; optional Ruff LSP as diagnostic role | `pyproject.toml`, `setup.py`, requirements files, `.git` |
| Rust | rust-analyzer | `Cargo.toml`, `Cargo.lock` |
| Go | gopls | `go.work`, `go.mod`, `.git` |
| C/C++/Objective-C | clangd | `compile_commands.json`, `.clangd`, CMake/Meson markers, `.git` |
| Java | JDT LS | Maven/Gradle markers, `.classpath`, `.project` |
| Kotlin | Kotlin language server | Gradle/Maven markers |
| C# | Roslyn language server or csharp-ls | `*.sln`, `*.slnx`, `*.csproj`, `global.json` |
| F# | fsautocomplete | `*.sln`, `*.fsproj` |
| Swift | sourcekit-lsp | `Package.swift`, Xcode project/workspace markers |
| Ruby | ruby-lsp | `Gemfile`, `.ruby-version`, `*.gemspec` |
| PHP | intelephense | `composer.json`, `.git` |
| Lua | lua-language-server | `.luarc.json*`, `.git` |
| Elixir | ElixirLS | `mix.exs` |
| Zig | zls | `build.zig`, `build.zig.zon` |
| Dart | Dart analysis server | `pubspec.yaml` |
| OCaml | ocamllsp | `dune-project`, `dune-workspace`, `*.opam` |
| Haskell | HLS | `hie.yaml`, `cabal.project`, `stack.yaml`, `*.cabal` |
| Bash | bash-language-server | `.git` or workspace |
| Clojure | clojure-lsp | `deps.edn`, `project.clj`, `bb.edn` |
| Gleam | gleam lsp | `gleam.toml` |
| Nix | nixd | `flake.nix`, `shell.nix`, `.git` |
| Terraform | terraform-ls | `.terraform.lock.hcl`, `.terraform`, workspace |
| YAML | yaml-language-server | schema/config markers, `.git` or workspace |
| JSON/HTML/CSS | VS Code extracted language servers | package/config markers or workspace |
| Prisma | Prisma language server | `schema.prisma`, `package.json` |

Before merging each built-in entry, verify its actual stdio command, language IDs, initialization requirements, and root behavior against the server's current documentation. Catalog correctness must be enforced by table-driven tests.

Routing rules:

1. Match exact filename, then extension.
2. Find the nearest valid root for each candidate.
3. Prefer the candidate with the nearest language-specific marker.
4. Then prefer role `primary`, higher priority, and more specific filename/extension match.
5. Diagnostics may include enabled `diagnostic` role candidates.
6. Navigation/rename/code actions choose one primary candidate unless `server` is explicit.
7. If equal candidates remain, return ambiguity rather than guessing.
8. Deno vs TypeScript must be marker-driven so both do not claim the same file.

## 13. Workspace boundary and path safety

Establish a session project boundary at `session_start`, independently of extension configuration:

1. Start at `realpath(ctx.cwd)`.
2. Walk upward and find the nearest containing VCS root (`.git`).
3. If found before the user's home directory or filesystem root, use it as the maximum boundary; otherwise use `ctx.cwd`.
4. After the boundary is fixed, trusted project-config discovery may walk from `ctx.cwd` up to that boundary, but config cannot widen it.
5. Never broaden the boundary to the home directory or filesystem root merely because a server has no marker.
6. A detected LSP root may equal or be nested inside the boundary, never outside it.
7. An explicit `root` must resolve inside the boundary.

For every input file:

- Resolve relative to `ctx.cwd` or the explicit root as documented.
- Require existence and regular-file status for read/navigation operations.
- Compare lexical and real paths.
- Reject symlinks resolving outside the boundary.
- Track real directory paths during traversal to prevent cycles.
- Reject non-file URI schemes for mutation.

Read-only LSP results may point outside the boundary. Mark those results as external and show a sanitized URI/path, but do not automatically read them or mutate them.

Project configuration can add ignore patterns but cannot widen the session boundary. Multiple or additional workspace boundaries are out of scope for v1; start a separate Pi session in another root instead.

## 14. Root detection

Implement asynchronous, cached, in-flight-deduplicated root detection:

```ts
findRoot(server, filePath, sessionBoundary): Promise<RootResolution>
```

Requirements:

- Walk upward from the file's directory to the session boundary.
- Support exact markers and bounded single-directory glob markers such as `*.sln` or `*.csproj`.
- Prefer the nearest marker; allow ordered marker priority when two appear in the same directory.
- Record the matched marker and fallback reason for status/debugging.
- `rootFallback: none` means do not launch a heavy server without a project marker.
- `workspace` falls back to the session boundary.
- `file-directory` is reserved for lightweight single-file servers.
- Cache by server id, starting directory, boundary, and config generation.
- Deduplicate concurrent root walks.
- Invalidate on config reload. Marker changes can be handled by TTL or explicit `/lsp restart`; filesystem watching is not required in v1.

## 15. Persistent client manager

Create one manager per extension/session instance, held in the extension factory closure rather than module-global state.

Key clients by:

```text
config-generation + server-id + canonical-root
```

Client states:

```text
new → starting → initializing → ready → stopping → stopped
                         ↘ failed/cooldown
```

Requirements:

- Lazy start only when a tool or synchronization event needs the server.
- Deduplicate concurrent acquisition/spawn.
- Enforce `maxClients`; evict the least-recently-used idle client before starting another.
- Use idle shutdown timers started only after `session_start`, never in the extension factory.
- Do not shut down a client with active requests.
- Track active request count, opened documents, last use, progress state, capabilities, recent bounded stderr, failure count, and cooldown deadline.
- After repeated fatal failures, disable the client for the session until `/lsp restart` or cooldown expiry.
- A cancelled request should send `$/cancelRequest` and reject only that request. LSP cancellation has no acknowledgement requirement, so lack of a response is not evidence that the server is unhealthy. Restart only after a fatal transport/process error or a configured number of consecutive request timeouts while no other request is making progress; restarting fails all affected callers explicitly.
- Initialization failure must close streams and kill the entire process tree.
- `session_shutdown` must await idempotent manager shutdown with a global deadline, then force-kill remaining process trees.
- Reload/new/resume/fork creates a fresh extension instance and manager. Never reuse stale Pi contexts across replacement.

## 16. Process launch and cleanup

### 16.1 Launch

- Resolve executable against effective `PATH`/`PATHEXT` in the workspace environment.
- Spawn directly without a shell on POSIX.
- On POSIX, create a detached process group so wrapper descendants can be terminated together.
- On Windows v1, launch `.exe` files directly and recognize only tested npm-generated `.cmd`/`.bat` shim templates that can be resolved to their underlying Node script and launched as `node <script> ...args`. Reject unknown batch/shim formats with an actionable error asking for a directly executable command. Do not retain a generic `cmd.exe` fallback and never concatenate caller-tainted text into shell source.
- Inherit the user environment and overlay only validated server `env` keys.
- Keep stdin/stdout/stderr piped. Do not inherit server output into Pi's terminal or JSON stream.
- Bound stderr with a ring buffer, for example 64 KiB total and 4 KiB in any tool error.
- Redact configured secret-like environment values from logs.

### 16.2 Shutdown

1. If initialized, send `shutdown` with a short deadline.
2. Send `exit` notification.
3. Close streams and wait briefly.
4. Send SIGTERM to the process group/tree.
5. Escalate to SIGKILL after grace.
6. On Windows, use tree termination while the event loop is alive; avoid spawning helper processes during final process exit.
7. Wait for child exit and record the outcome.
8. Make all cleanup paths idempotent.

Test direct child, wrapper child, grandchildren, initialization failure, hung shutdown, and concurrent shutdown.

## 17. Protocol client and capabilities

Use LSP 3.17 as the compatibility baseline.

Initialization must include:

- `processId`, `rootUri`, and one workspace folder.
- Client info and extension version.
- `capabilities.general.positionEncodings: ["utf-16", "utf-8", "utf-32"]`, preferring UTF-16. Read `ServerCapabilities.positionEncoding`; default to UTF-16 when omitted and fail initialization on an advertised unsupported encoding.
- Static capabilities for diagnostics, navigation, symbols, code actions, rename, call hierarchy, synchronization, workspace folders/configuration, progress, and cancellation.
- Advertise `workspace.applyEdit: false`. Separately advertise only workspace-edit response structures the extension can consume: `documentChanges: true`, supported `resourceOperations` (none for v1 apply; parsed preview support is not advertised as apply support), and the exact supported failure/change-annotation fields. Do not imply that server-initiated edits will be accepted.
- `initializationOptions` from the server definition.

After initialize:

- Normalize server capabilities into typed predicates such as `supportsDefinition()` and `supportsRename()`.
- Send `initialized`.
- Send `workspace/didChangeConfiguration` only when settings exist.
- Track server-selected position encoding.

Handle server requests/notifications:

- `workspace/configuration`: return scoped configured values.
- `workspace/workspaceFolders`: return current root.
- `client/registerCapability` / `client/unregisterCapability`: track registrations when supported; otherwise acknowledge safely and retain static capability state.
- `window/workDoneProgress/create` and `$/progress`: track active indexing/progress tokens with bounded metadata.
- `window/logMessage` / `window/showMessage`: store only bounded sanitized debug entries; do not interrupt the user.
- `workspace/applyEdit`: respond `{ applied: false, failureReason: "Unsolicited edits are disabled" }`.
- Unknown requests: JSON-RPC method-not-found response.

The request layer must:

- Map each request id to timeout, `AbortSignal`, cancellation state, and method.
- Send `$/cancelRequest` on abort/timeout when the connection is alive.
- Ignore late responses to cancelled requests without corrupting later requests.
- Bound partial-result collection.
- Treat malformed protocol messages and impossible content lengths as fatal to that client.
- Implement a `BoundedStreamMessageReader` compatible with `vscode-jsonrpc`'s `MessageReader` interface. It must parse and cap header bytes and `Content-Length` before buffering a body, reject frames over the configured body limit, and cap the number of buffered incomplete frames. Do not use the library's default stream reader unless an audited version exposes equivalent pre-allocation limits. Add memory-oriented tests for oversized headers, declared bodies, and fragmented floods.

## 18. Document synchronization

Maintain a document record per client/URI:

```ts
interface OpenDocument {
  uri: string;
  canonicalPath: string;
  languageId: string;
  version: number;
  contentHash: string;
  text: string;
  mtimeMs: number;
}
```

Synchronization rules:

1. Before every file-scoped request, read authoritative file contents and metadata.
2. If unopened, send `didOpen` version 1.
3. Normalize `ServerCapabilities.textDocumentSync` whether it is a numeric kind or `TextDocumentSyncOptions`.
4. If content changed, increment version. For `Full`, send a full-content change. For `Incremental`, send one valid whole-old-document range replacement computed from the prior snapshot; do not send a full change shape to an incremental-only server. If synchronization is `None`, do not claim synchronized semantics and reject operations that require an open current document unless a tested server policy permits them.
5. After an extension-observed write/transaction, send `textDocument/didSave` when the server's save options request it, including text only when `includeText` is true.
6. If the file disappeared, on LRU eviction, and during client shutdown, send `didClose` before removing the record while the connection is alive.
7. Serialize sync/save and requests per URI so a request never races an older `didChange`.
8. Keep different clients independently versioned.
9. Close least-recently-used documents when a configurable open-document cap is reached.

Pi integration:

- Observe successful `tool_result` events for built-in `write` and `edit` using Pi's `isWriteToolResult` and `isEditToolResult` guards. Require `event.isError === false`, normalize a leading `@`, and resolve the input path against the event/session CWD before canonicalization. Synchronize the authoritative post-result file, not the proposed tool patch, to already-running matching clients.
- Do not start a new server merely because a file was written; sync only clients already active for that server/root.
- Code-action and rename writes synchronize directly after transaction commit.
- Bash or external edits cannot be inferred reliably; the pre-request authoritative reread catches them.
- Do not retain old `ExtensionContext` objects in timers. Store plain path/server data and let manager methods operate without stale Pi contexts.

## 19. Position handling

Position bugs can corrupt edits, so centralize conversion.

Requirements:

- Public tool lines and UTF-16 columns are 1-based; LSP lines and server-encoded characters are 0-based.
- Send `capabilities.general.positionEncodings`, read `ServerCapabilities.positionEncoding`, and default to UTF-16 when omitted.
- Negotiate and support UTF-8, UTF-16, and UTF-32 position encodings.
- Convert offsets per line, preserving CRLF/LF behavior.
- Validate line and character against current text.
- Reject invalid or mid-code-unit positions rather than clamping silently.
- `symbol` lookup operates on the exact requested line, uses literal matching, supports `name#N`, and reports ambiguity with candidate UTF-16 columns.
- Normalize returned positions to public 1-based UTF-16 only when target text is safely available. Otherwise preserve raw server positions and encoding as specified in Section 7.2.
- Text edits use offsets computed from the exact snapshot for which the request was made.

Tests must include ASCII, tabs, combining marks, emoji/astral characters, mixed newline styles, empty final lines, and positions at line/document end.

## 20. Diagnostics state machine

Support both push and pull diagnostics.

### Pull

- Use `textDocument/diagnostic` only when advertised.
- Support full and unchanged reports, `resultId`, related documents, and bounded partial results.
- Cache the complete previous full report by client/document/result id, not only the id.
- A full report with no diagnostics is `clean`.
- An `UnchangedDocumentDiagnosticReport` means reuse the matching cached full report; it does not mean clean. Reuse its prior diagnostics. If no matching cached report exists, return `unconfirmed`/protocol error and force a subsequent fresh request without `previousResultId`.
- Apply the same full/unchanged rule to each item in workspace diagnostics.

### Push

- Track `publishDiagnostics` by URI and document version when supplied.
- Clear or mark prior diagnostics stale when sending a new document version.
- Wait for the first relevant publication, then use a configurable quiet/settle period.
- If no publication arrives before a configured grace/timeout, return `unconfirmed`, not `clean`.
- Ignore publications older than the current document version when the server supplies versions.
- For unversioned publications, non-empty findings may be returned as `diagnostics` with `possiblyStale: true`. An empty unversioned publication after a change is provisional and remains `unconfirmed` unless a documented per-server policy and real-server test establish a causal post-change barrier.

### Hybrid servers

- Preserve non-empty push diagnostics that arrive around a pull request.
- If an early empty pull is known to be provisional for a server, optionally wait for a newer push publication using a catalog policy.
- All such server-specific policies need tests and comments.

### Workspace diagnostics

- When `workspace/diagnostic` is advertised, send bounded `previousResultIds`, consume full and unchanged document reports plus related-document and partial-result data, and preserve a complete cached full report for every reused result id.
- Handle `workspace/diagnostic/refresh` by invalidating affected confirmed caches and result ids; do not launch an automatic sweep.
- Enforce file/diagnostic caps while consuming partial results. Mark omitted items and `partial`; never silently stop collection and report complete.
- Fallback sweep: deterministically discover regular files inside the selected root that match the server's configured extensions/filenames, honor `.gitignore`, extension ignores, size limits, and `maxFiles`, then synchronize/open and request each file sequentially for that client. Record evidence state independently per file. LRU-close documents normally after the sweep. Report eligible, checked, ignored, oversized, and omitted counts.

### Cache

Use only an in-memory cache in v1, keyed by server, root, URI, content hash, and requested scope. Cache only confirmed `clean` or `diagnostics` results and the full report behind each pull `resultId`. Never cache timeout, cancellation, error, unconfirmed silence, or provisional unversioned empties. Invalidate on document changes, diagnostic-refresh requests, and config/client generation changes.

## 21. Result normalization and output limits

Use Pi's `truncateHead`, `truncateTail`, `truncateLine`, `DEFAULT_MAX_BYTES`, and `DEFAULT_MAX_LINES` utilities.

Hard requirements:

- Text output never exceeds Pi's 50 KiB/2,000-line convention.
- Structured `details` must also be bounded; truncating only display text is insufficient.
- Default and hard caps should be centralized. Suggested defaults:
  - 10,000 discovery entries per workspace inventory, hard max 100,000.
  - 100 files per diagnostic sweep, hard max 500.
  - 300 diagnostics, hard max 1,000.
  - 100 references/locations, hard max 500.
  - 200 document symbols, hard max 1,000.
  - 100 workspace symbols, hard max 500.
  - 50 edits per file and 500 total edits unless user config deliberately raises them within hard safety ceilings.
- Truncate individual server messages/hover blocks and strip terminal control sequences.
- Preserve totals and omitted counts whenever data is truncated.
- Save no full output to world-readable predictable paths. If debug spill files are added later, use mode `0600`, random names, explicit user opt-in, and lifecycle cleanup.
- Sort locations by internal path, line, and column; symbols by path/range/name; diagnostics by severity/path/range/source.
- Render workspace-relative paths when inside root, absolute sanitized paths only when external.

## 22. Workspace edit engine

This is shared by code actions and rename and must be implemented before either tool can apply changes.

### 22.1 Parse and normalize

Support:

- `WorkspaceEdit.changes`.
- `WorkspaceEdit.documentChanges` with `TextDocumentEdit`.
- Versioned text documents.
- Change annotations.
- `CreateFile`, `RenameFile`, and `DeleteFile` as parsed preview entries.

For v1 apply behavior:

- Apply only edits to existing regular files.
- Parse and preview `CreateFile`, `RenameFile`, and `DeleteFile`, but reject applying the entire transaction when any resource operation is present. This avoids undefined nonexistent-path canonicalization, overwrite, permission, and rollback semantics in v1.
- Never partially apply only the supported subset of a workspace edit.

### 22.2 Validate

Before staging:

- Accept only `file:` URIs for mutation.
- Resolve and enforce realpath containment under the session boundary.
- Reject symlink escapes and special files.
- Reject external files.
- Verify document versions when present. If the server uses `null`, rely on content snapshot checks.
- Validate every range against the snapshot and negotiated position encoding.
- Detect overlapping edits, duplicate conflicting edits, invalid insertion order, and multiple incompatible operations on one path.
- Enforce per-file and transaction-wide edit limits.
- Reject target collisions and unsafe overwrite options.
- Recheck the abort signal before publication.

### 22.3 Stage and preview

- Read every affected file once and capture canonical path, inode/device when available, size, mtime, mode, and content hash.
- Apply edits in descending offset order to staged copies.
- Generate bounded unified diffs with affected-file and edit counts.
- Retain the complete normalized manifest only when every hard file/edit/byte limit is satisfied. If normalization exceeds a hard limit, retain only a bounded summary with omitted counts, set `applicable: false`, and require narrower input/config rather than pretending the manifest is complete.
- Do not trust preview data as an apply token. `apply: true` makes a fresh LSP request and fresh validation rather than applying stale edits copied from an earlier tool result.

### 22.4 Publish

- Serialize extension transactions with an extension-local transaction mutex.
- Deduplicate existing target files by the same canonical absolute path key used for validation, sort those keys lexicographically, and acquire Pi's exported `withFileMutationQueue()` recursively in that order:

  ```ts
  async function withAllMutationQueues<T>(paths: string[], index: number, fn: () => Promise<T>): Promise<T> {
    if (index === paths.length) return fn();
    return withFileMutationQueue(paths[index]!, () =>
      withAllMutationQueues(paths, index + 1, fn),
    );
  }
  ```

  Nested callbacks keep every outer queue held until the innermost transaction finishes. Deterministic ordering prevents deadlock between base-lsp transactions; built-in `edit`/`write` acquire only one queue and therefore coordinate on the shared target. Pin/test a Pi version whose exported helper has this per-path callback-holding behavior. Resource operations/new paths remain non-applicable in v1, avoiding mismatched nonexistent-path keys.
- Pi's helper does not support aborting queue acquisition. Do not race and abandon it, because the registered callback would still run later. After each queue is acquired and again after all are held, check the tool signal; if cancelled, return through the nested callbacks without writing.
- Once all queues are held, reread/re-stat every source and compare to snapshots. Abort before the first write on any mismatch.
- Write each modified file to a same-directory temporary file with restrictive permissions, preserve relevant mode bits, fsync where practical, then atomically rename.
- True multi-file atomicity is not available on normal filesystems. Keep original snapshots and perform best-effort rollback if a later file publication fails.
- If rollback fails, throw a high-severity error listing exactly which files may be changed and which were restored.
- Clean temporary files in every path.
- After commit, synchronize changed documents to active clients and invalidate diagnostics.

Do not run `git`, create commits, or modify user history as part of a transaction.

## 23. Concurrency and cancellation

- Different server/root clients may process requests concurrently.
- Document synchronization is serialized per URI/client.
- Default diagnostic sweeps group files by client. Process one file at a time per client unless real-server tests establish safe bounded parallelism; run distinct clients concurrently.
- Workspace symbol and navigation requests may coexist if the server supports it, but cap active requests per client.
- Mutation requests acquire a workspace transaction lock and affected file queues.
- Tool `AbortSignal` must cancel manager acquisition, sync, request, settle waits, diff generation, and pre-publication validation. Pi file-mutation queue acquisition is non-abortable; cancellation is checked inside each acquired callback and before publication as specified in Section 22.4.
- Once atomic publication of one file begins, cancellation should stop before the next file and trigger rollback rather than leave an undocumented partial state.
- Session shutdown prevents new acquisitions, cancels requests, waits a short drain period, then terminates clients.

## 24. Logging and observability

Default logging should be minimal and local.

Track in memory:

- startup/initialization/request/shutdown durations;
- request method and status;
- client state and last-use time;
- bounded recent stderr;
- failure count and cooldown;
- active work-done progress titles after sanitization.

Do not log:

- full file contents;
- hover text or diagnostics by default;
- environment values;
- initialization settings without redaction;
- raw protocol traffic unless an explicit debug option is enabled.

If debug file logging is implemented:

- user config only, never project config;
- mode `0600`;
- bounded rotating files;
- redaction and control-character sanitization;
- `/lsp config` reports its path;
- disabled by default.

## 25. Pi lifecycle integration

Extension factory:

- Register tools, commands, flags, and event handlers.
- Do not spawn servers, start timers, or create watchers in the factory.
- Keep mutable runtime state in the extension instance closure.

`session_start`:

- Derive the session boundary, load user config, check `ctx.isProjectTrusted()`, and load project config only when trusted.
- Record whether startup is authorized (`trusted` or user-global `allowUntrustedProjects`). If not authorized, keep tools loaded but make every acquisition return `untrusted` without launching a process.
- Construct/reset manager state.
- Clear stale UI status.
- Validate catalog/config and notify only concise warnings.
- Do not launch servers.

`tool_result`:

- Narrow with `isWriteToolResult`/`isEditToolResult`; require a successful result, normalize the typed input path, resolve against `ctx.cwd`, canonicalize, and reread authoritative content.
- Sync only already-active matching clients and serialize that sync through each client's per-URI queue.
- Ignore failed results.
- Parallel sibling tools may legitimately produce an LSP result for the pre-mutation snapshot before a write result is emitted. Include document version/content hash in LSP tool details, then sync the post-write state when the mutation result arrives; do not relabel the earlier result as current.
- Avoid blocking the event loop for large files; enforce a maximum synchronized file size and let the next explicit request explain oversize refusal.

`session_shutdown`:

- Clear UI status and idle timers.
- Stop manager acquisition.
- Cancel/drain requests.
- Gracefully then forcibly stop all process trees.
- Be idempotent for quit, reload, new, resume, and fork.

Modes:

- Tools must not depend on TUI APIs.
- Slash command notifications should honor `ctx.hasUI` and `ctx.mode`.
- Custom renderers execute only in TUI and must have fallback output.
- Print/JSON mode must not hang because of idle timers; unref timers and shut down cleanly when Pi ends the session.

## 26. Testing strategy

### 26.1 Unit tests

Configuration:

- precedence, deep merge, array replacement, null clearing;
- project trust gating;
- malformed JSON and schema errors;
- secret redaction;
- disabled/custom/overridden servers.

Routing and roots:

- exact filename vs extension;
- nearest markers and glob markers;
- monorepo nested roots;
- Deno vs TypeScript;
- primary vs diagnostic role;
- ambiguity;
- no-root heavy-server behavior;
- cache and in-flight deduplication.

Paths:

- lexical escape;
- symlink file/directory escape;
- cycles;
- external read-only result marking;
- file URI decoding on POSIX and Windows;
- non-file URIs;
- boundary never broadens to home/root.

Positions:

- UTF-8/16/32;
- emoji, combining characters, tabs, CRLF;
- symbol occurrence selection;
- invalid ranges and end positions.

Normalization:

- `Location`, arrays, and `LocationLink`;
- hierarchical/flat document symbols;
- workspace symbol variants and resolve;
- hover content variants;
- call hierarchy preparation and calls;
- diagnostic full/unchanged/related reports;
- every workspace-edit shape.

Output:

- deterministic sort;
- text and details limits;
- omitted counts;
- ANSI/control sanitization;
- no secret leakage.

Workspace edits:

- ascending/descending edits;
- overlap/conflict detection;
- version mismatch;
- stale file after preview;
- multi-file staging;
- atomic per-file publication;
- queue serialization with built-in edit/write;
- rollback success/failure;
- unsupported resource operation rejects whole apply;
- cancellation before and during publication.

### 26.2 Deterministic fake-server integration tests

Build a configurable fixture LSP server capable of:

- fragmented and combined JSON-RPC frames;
- malformed/oversized frames;
- delayed initialize and request responses;
- process descendants;
- static and dynamic capabilities;
- UTF position encoding selection;
- push, pull, hybrid, late, stale, and silent diagnostics;
- every navigation result variant;
- hierarchical symbols;
- code action resolve;
- prepare rename and multi-file rename;
- call hierarchy with zero/one/multiple prepared items;
- server requests (`configuration`, folders, register capability, apply edit);
- work-done and partial-result progress;
- ignored cancellation and hung shutdown;
- stderr floods and process crashes.

Test:

- client reuse;
- concurrent acquisition dedupe;
- document versions/full sync;
- request cancellation without killing healthy shared client;
- timeout and late response isolation;
- cooldown/restart;
- graceful and forced process-tree cleanup;
- session shutdown races;
- no timers keeping the process alive.

### 26.3 Pi extension integration tests

- Final release: exactly four tools and one command register. Earlier milestones register only completed tools; inactive mutation tools are absent rather than exposed as placeholders.
- Tool schemas validate and use Google-compatible enums.
- Prompt snippets/guidelines name their tools explicitly.
- `session_start` does not spawn servers.
- `tool_result` uses typed guards, resolves paths against `ctx.cwd`, syncs successful write/edit, ignores failures, and remains correct when sibling LSP and mutation calls execute in parallel.
- Untrusted sessions refuse server startup unless user-global policy explicitly permits it; trusted sessions and trust-denied non-UI modes are tested.
- `/reload`, new/resume/fork lifecycle tears down old clients and reloads config/source through the top-level shim.
- TUI/RPC/JSON/print mode behavior.
- Tool abort signal propagates.
- Structured details remain serializable and bounded.

### 26.4 Real-server smoke tests

Maintain pinned real-server tests for representative protocol families rather than claiming every catalog entry works because it exists:

1. TypeScript language server — definitions, references, hover, symbols, rename.
2. Pyright/basedpyright — pull/push diagnostics and navigation.
3. rust-analyzer — slow indexing, progress, definition/references/rename.
4. gopls — module root and multi-file rename.
5. clangd — compile database root and call hierarchy.
6. JDT LS or a Java server — heavy startup and workspace symbols.
7. YAML or JSON language server — push diagnostics and configuration requests.
8. One Windows CI server — shim launch and process-tree cleanup.

Use pinned fixture projects and pinned server versions. Release-gating Linux smoke tests are TypeScript language server, basedpyright/pyright, and gopls because they cover navigation, pull/push diagnostics, and multi-file edits at manageable CI cost. A Windows npm-shim launch/cleanup smoke is also release-gating. Rust-analyzer, clangd, JDT LS, YAML/JSON, and the wider catalog run nightly or before catalog-affecting releases. Keep ordinary unit tests independent of network and installed servers.

### 26.5 CI matrix

- Linux on Node 24.
- Windows on Node 24 for path, recognized npm-shim, and process-tree behavior.
- macOS where practical.
- Typecheck, lint, unit tests, fake-server integration, package-load smoke.
- Release-gating pinned real-server smokes listed in Section 26.4; wider catalog and long resource-leak suites may remain nightly.

## 27. Documentation deliverables

`README.md` must include:

- purpose and non-goals;
- install/local-load instructions;
- required external language servers;
- four tool contracts with examples;
- 1-based UTF-16 column and `symbol` locator behavior, including raw-position behavior for unreadable external targets;
- configuration locations, trust behavior, and precedence;
- built-in server table and verified commands;
- preview/apply safety model;
- diagnostics state meanings;
- `/lsp` commands;
- resource usage and persistent-client behavior;
- troubleshooting missing server, wrong root, timeout, stale diagnostics, and restart;
- security warning that configured commands and built-in language servers execute with user permissions and may load repository-controlled plugins/build logic;
- default refusal behavior for untrusted projects and the user-global override;
- explicitly excluded LSP features.

Add `docs/architecture.md` only if the README becomes unwieldy; keep protocol invariants near the code as comments and tests.

## 28. Phased implementation

### Phase 0 — Scaffold and contracts (1–2 days)

- Create package metadata, source layout, test runner, README skeleton, and license.
- Define configuration schema, result envelope, centralized limits, server definition, and tool schemas.
- Add a minimal catalog with one fake server and TypeScript entry.
- Register `/lsp` only. Do not register placeholder model tools; add each tool only when its phase meets its exit criteria.

Exit criteria:

- The top-level `index.ts` auto-discovers from `~/.pi/agent/extensions/base-lsp/`, and explicit package-manifest loading also works in all Pi modes.
- Production install/load succeeds with dev dependencies omitted.
- Typecheck and tests run.
- No process starts during factory/session startup.

### Phase 1 — Paths, roots, routing, positions (3–5 days)

- Implement deterministic boundary derivation, trust/authorization policy, trusted project config loading, and trust-denied behavior.
- Implement containment, file discovery, ignores, root detection, registry, and routing.
- Implement position encoding and symbol-column resolution.
- Add comprehensive unit tests before protocol work depends on these utilities.

Exit criteria:

- Correct roots/routes for representative monorepo fixtures.
- Escape/symlink/Unicode tests pass.

### Phase 2 — Protocol client and persistent runtime (5–8 days)

- Integrate `vscode-jsonrpc`.
- Implement safe process launch, capabilities, server-request responses, progress, request cancellation, and deadlines.
- Implement client manager, spawn dedupe, LRU/idle shutdown, cooldown, and process-tree cleanup.
- Implement document store and authoritative synchronization for Full and Incremental sync kinds, plus requested didSave/didClose behavior.
- Wire successful Pi write/edit results to already-active clients using typed guards and per-URI serialization.

Exit criteria:

- Fake-server tests prove reuse, versions, cancellation, late-response isolation, and descendant cleanup.
- Session shutdown leaves no child processes or ref'ed timers.

### Phase 3 — Truthful diagnostics (4–6 days)

- Implement push/pull/hybrid state machine and confirmed-only memory cache.
- Implement bounded path/workspace sweeps and role-aware aggregation.
- Register final `lsp_diagnostics` behavior and compact rendering as the first model tool.

Exit criteria:

- Full and unchanged document/workspace reports reuse correct cached evidence.
- Clean, diagnostics, silence, provisional unversioned empty, stale, timeout, cancellation, unavailable, and error are distinguishable.
- No output/details limit can be exceeded by fixture data.

### Phase 4 — Semantic navigation (4–7 days)

- Implement declaration, definition, type definition, implementation, references, hover, document symbols, workspace symbols/resolve, and call hierarchy.
- Normalize result variants and external URIs.
- Handle indexing/progress as `possiblyIncomplete`.
- Finalize and register `lsp_navigation` as the second model tool.

Exit criteria:

- Every operation has capability, null/empty, multiple-result, multi-item call-hierarchy, truncation, cancellation, external-target position, and malformed-result tests.
- TypeScript and at least two other real servers pass smoke tests.
- This phase is a clean releasable read-only milestone with exactly two tools; mutation tools remain unregistered.

### Phase 5 — Workspace-edit engine (5–8 days)

- First prove the recursive sorted `withFileMutationQueue` acquisition algorithm against the minimum supported Pi version, including cancellation-after-acquisition and concurrent built-in mutation tests.
- Implement parsing, validation, staging, diffs, deterministic multi-path queueing, atomic per-file writes, rollback, and post-commit synchronization.
- Reject applying every resource operation while still parsing/previewing it.

Exit criteria:

- Adversarial edit/symlink/version/concurrency/cancellation tests pass.
- A transaction never silently drops an edit or applies only a supported subset.

### Phase 6 — Code actions and rename (3–5 days)

- Implement code-action listing/resolve/stable identity/selection/preview/apply, then register `lsp_code_actions`.
- Implement prepare rename and rename preview/apply, then register `lsp_rename`.
- Enforce no command execution, no partial edit-plus-command apply, and no formatting subsystem.

Exit criteria:

- Preview is default.
- Apply requires a prior preview identity, a fresh request, and an exact `actionId`/`renameId` match; titles, list indices, and direct rename arguments never authorize mutation by themselves.
- Multi-file real-server smoke tests pass.

### Phase 7 — Catalog, hardening, and docs (4–7 days)

- Expand and verify built-in server catalog.
- Add platform CI, real-server matrix, leak tests, package-load self-test, and performance limits.
- Complete README and troubleshooting.
- Perform independent security and lifecycle review.

Exit criteria:

- Every catalog entry is table-tested and documentation-verified.
- Linux/Windows CI passes.
- No known unbounded protocol/output/process path remains.

Estimated total for a robust first release: **29–48 experienced developer-days**, depending on platform coverage and how many real servers are verified. A useful read-only milestone through Phase 4 is approximately **17–28 developer-days**.

## 29. Definition of done

The first release is done only when:

- A top-level `index.ts` auto-discovers from the requested global extension directory, the package manifest loads explicitly, and both paths work in TUI/RPC/JSON/print modes.
- Production dependency installation and loading work with dev dependencies omitted; the tested Node/Pi minimums are documented and exercised.
- The final extension registers exactly four intended tools and one command; earlier release milestones expose only completed tools.
- It starts no background process before a capability is needed.
- Untrusted projects cannot start servers by default, non-UI denial is deterministic, and the user-global override is tested and documented.
- Repeated requests reuse the same healthy server/root client.
- Root selection and project-config discovery are correct for nested and monorepo fixtures.
- Files and mutation targets cannot escape the session boundary.
- UTF-8/16/32 negotiation, public UTF-16 columns, external raw ranges, and edit ranges are correct for non-ASCII text.
- Full/incremental synchronization plus requested didSave/didClose ordering are tested.
- Cancellation does not unnecessarily kill healthy shared clients.
- Shutdown kills server descendants and leaves no active timers.
- Pull/workspace unchanged reports reuse their matching prior full evidence; silence, timeout, and provisional unversioned empties are never reported as clean.
- Every protocol frame, result, details collection, and stderr path is bounded and sanitized.
- Navigation supports all included operations with normalized, deterministic output.
- Code actions and rename require a prior preview identity and apply only fresh, identity-matched, validated complete text-edit transactions.
- No server command, edit-plus-command subset, resource-operation subset, or unsolicited edit can execute through an agent tool.
- Successful extension writes acquire the exact shared Pi mutation queues and synchronize active servers; parallel sibling mutation/LSP behavior is snapshot-labelled.
- `/reload`, new/resume/fork, and config reload tear down old clients without stale contexts.
- Unit, fake-server integration, Pi lifecycle, release-gating real-server, and Windows shim/cleanup tests pass.
- Documentation states external dependencies, execution/trust risks, security boundaries, diagnostics semantics, and non-goals accurately.

## 30. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Server behavior varies despite the protocol | Capability checks, declarative policy overrides, fake fixtures, representative real-server smokes. |
| Persistent clients become stale after edits | Authoritative pre-request reread, full `didChange`, versioning, tool-result sync. |
| Heavy servers consume resources | Lazy start, max-client cap, LRU idle shutdown, no automatic prewarm. |
| Slow indexing yields incomplete navigation | Track progress, per-server startup policies, `possiblyIncomplete`, persistent reuse. |
| Diagnostics falsely appear clean | Explicit result state machine and confirmed-only cache. |
| Rename corrupts multiple files | Fresh request on apply, complete validation/staging, queues, atomic per-file writes, rollback. |
| Process wrappers leave descendants | Process groups/tree kill, escalation, lifecycle tests. |
| Windows command launch introduces injection | No shell strings, safe shim resolution/quoting, Windows tests. |
| Large server output exhausts context/memory | Protocol frame limits, bounded stderr, data caps, Pi truncation utilities. |
| Language servers or project config execute repository-controlled behavior | Refuse server startup in untrusted projects by default, JSON-only trusted config, prominent warning, no auto-install; document that trust is authorization, not sandboxing. |
| Tool surface becomes too large | Four tools; group read-only operations; document explicit exclusions. |
| Scope drifts toward pi-lens | Preserve non-goals and require a demonstrated agent workflow before adding capabilities. |

## 31. Future additions only after evidence

Consider these only when actual sessions show a repeated need:

- Type hierarchy operations.
- Signature help.
- LSP-aware source-file rename (`willRenameFiles`/`didRenameFiles`).
- Safe support for `CreateFile`/`RenameFile`/`DeleteFile` resource operations, including nonexistent-path canonicalization and rollback.
- Persistent on-disk confirmed diagnostic cache.
- Reverse-dependency invalidation.
- Multiple workspace folders per client.
- Remote/container process and filesystem adapters.
- A dynamic tool loader if the four schemas become materially costly to prompt caching.

Do not add a capability merely because LSP defines it.

## 32. Reference material and provenance

Use these as design references:

- Pi extension documentation: local `docs/extensions.md` in the installed Pi coding-agent package.
- Pi package documentation: local `docs/packages.md`.
- LSP 3.17 specification: <https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/>
- pi-lsp: <https://github.com/narumiruna/pi-extensions/tree/main/extensions/pi-lsp>
- pi-lens: <https://github.com/apmantza/pi-lens>

Both referenced extensions are MIT-licensed, but this project is intended as a clean new implementation. If source code is copied rather than reimplemented, preserve the applicable copyright/license notices and document provenance in the new repository.
