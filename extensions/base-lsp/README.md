# base-lsp

`base-lsp` is a compact Language Server Protocol toolbox for [Pi](https://github.com/earendil-works/pi-mono). It gives the coding agent semantic diagnostics, navigation, code actions, and rename support while keeping language-server processes lazy, persistent for one Pi session, bounded, and explicitly shut down.

This extension is intended for personal use on **Node.js 24+** and has been tested with **Pi coding-agent 0.82.1+**. It does not download language servers.

## Scope

The extension registers exactly four model tools and one slash command:

- `lsp_diagnostics`
- `lsp_navigation`
- `lsp_code_actions`
- `lsp_rename`
- `/lsp`

It deliberately does **not** provide completion, signature-help UI, formatting, format-on-write, non-LSP linters/scanners, tests, semantic-token rendering, inlay hints, code lenses, a general `workspace/executeCommand`, or automatic model-context injection.

## Installation

This directory is already in Pi's global auto-discovery location:

```text
~/.pi/agent/extensions/base-lsp/
```

Install dependencies and reload Pi:

```bash
cd ~/.pi/agent/extensions/base-lsp
npm install --ignore-scripts
# then run /reload in Pi
```

The top-level `index.ts` is the auto-discovery shim. The package can also be loaded explicitly through the `pi.extensions` entry in `package.json`.

Runtime dependencies are `ignore` and `vscode-jsonrpc`. Pi packages are peer dependencies. `typescript-language-server` and TypeScript are pinned development dependencies used by smoke tests, not automatically installed for repositories.

## Language servers

Servers are started only when a tool needs one. `/lsp status` reports whether each executable is available and provides an installation hint. Representative built-in commands are:

| ID | Command | Typical markers |
|---|---|---|
| `typescript` | `typescript-language-server --stdio` | `tsconfig.json`, `jsconfig.json`, `package.json` |
| `deno` | `deno lsp` | `deno.json`, `deno.jsonc` |
| `vue` | `vue-language-server --stdio` | Vue/Vite config, `package.json` |
| `svelte` | `svelteserver --stdio` | Svelte config, `package.json` |
| `basedpyright` | `basedpyright-langserver --stdio` | `pyproject.toml`, Pyright config |
| `pyright` | `pyright-langserver --stdio` | `pyproject.toml`, Pyright config |
| `ruff` | `ruff server` | Ruff/Python config; diagnostic role |
| `rust-analyzer` | `rust-analyzer` | `Cargo.toml` |
| `gopls` | `gopls` | `go.work`, `go.mod` |
| `clangd` | `clangd --background-index` | compile database, `.clangd`, CMake/Meson |
| `jdtls` | `jdtls` wrapper | Maven/Gradle/Eclipse markers |
| `kotlin` | `kotlin-lsp` | Gradle/Maven markers |
| `csharp-ls` | `csharp-ls` | solution/project files |
| `fsautocomplete` | `fsautocomplete --adaptive-lsp-server-enabled` | solution/F# project files |
| `sourcekit-lsp` | `sourcekit-lsp` | Swift package/Xcode project |
| `ruby-lsp` | `ruby-lsp` | `Gemfile`, Ruby version, gemspec |
| `intelephense` | `intelephense --stdio` | `composer.json` |
| `lua-language-server` | `lua-language-server` | `.luarc.json*` |
| `elixirls` | `elixir-ls` user wrapper | `mix.exs` |
| `zls` | `zls` | `build.zig*` |
| `dart` | `dart language-server` | `pubspec.yaml` |
| `ocamllsp` | `ocamllsp` | Dune/opam markers |
| `hls` | `haskell-language-server-wrapper --lsp` | Cabal/Stack/HLS markers |
| `bash-language-server` | `bash-language-server start` | Git/workspace |
| `clojure-lsp` | `clojure-lsp listen` | `deps.edn`, `project.clj`, `bb.edn` |
| `gleam` | `gleam lsp` | `gleam.toml` |
| `nixd` | `nixd` | Nix flake/shell markers |
| `terraform-ls` | `terraform-ls serve` | Terraform state/lock markers |
| `yaml` | `yaml-language-server --stdio` | YAML/Git workspace |
| `json` | `vscode-json-language-server --stdio` | package/Git workspace |
| `html` | `vscode-html-language-server --stdio` | package/Git workspace |
| `css` | `vscode-css-language-server --stdio` | package/Git workspace |
| `prisma` | `prisma-language-server --stdio` | Prisma schema/package |

Some ecosystems require a user wrapper or selected toolchain. In particular, JDT LS needs a unique writable `-data` directory per workspace, ElixirLS distributions expose platform launch scripts, Ruby commonly needs `bundle exec`, and opam-managed OCaml may need `opam exec --`. Override the command in user config rather than putting shell syntax in a command string.

The commands above were checked against official project documentation/repositories in July 2026. Catalog entries are table-tested, but only TypeScript and locally available clangd can be exercised in this checkout; a catalog entry is not a claim that its external executable is installed.

## Tool contracts

All public lines and columns are **1-based**. Public columns count **UTF-16 code units**. Internally the client negotiates UTF-8, UTF-16, or UTF-32 with the server.

A position may use `character` or a literal `symbol` on the selected line. `character` wins when both are present. Use `name#N` for the Nth exact occurrence, for example `value#2`. Ambiguous symbol matches are rejected rather than guessed.

Every result contains bounded text plus structured `details` with:

```text
operation, status, durationMs, truncated, warnings
```

Routing may also include `server`, `root`, or per-server timing records. Paths and structured arrays are bounded as well as display text.

### `lsp_diagnostics`

Gets diagnostics for changed files, explicit paths/directories, or a bounded workspace inventory.

```json
{
  "mode": "paths",
  "paths": ["src"],
  "severity": "all",
  "maxFiles": 100,
  "maxDiagnostics": 300,
  "waitMs": 20000,
  "refresh": false
}
```

When supported, workspace mode uses `workspace/diagnostic`; otherwise it performs a deterministic server-affine sweep. Discovery honors configured ignores, size limits, file caps, and entry caps and reports omissions.

Per-file evidence states are:

- `diagnostics`: an affirmative response with findings;
- `clean`: an affirmative response with no findings;
- `unconfirmed`: a push server was silent or returned provisional evidence;
- `timed_out`;
- `unavailable`;
- `cancelled`;
- `error`.

Silence, timeout, an unmatched `unchanged` report, stale versioned publication, or an unversioned empty publication after a change is never converted to `clean`. For TypeScript only, an initial post-`didOpen` empty publication may confirm a clean version-1 document after the catalog's bounded settling period; results identify this as `confirmation: "post_open_server_policy"`. Unversioned non-empty publications can be returned as `possiblyStale: true`.

### `lsp_navigation`

Supported operations:

```text
declaration, definition, type_definition, implementation, references,
hover, document_symbols, workspace_symbols, incoming_calls, outgoing_calls
```

Example:

```json
{
  "operation": "references",
  "path": "src/index.ts",
  "line": 42,
  "symbol": "createClient",
  "includeDeclaration": true,
  "limit": 100
}
```

Locations, `LocationLink`, hierarchical/flat symbols, hover variants, workspace-symbol resolution, and call-hierarchy preparation are normalized. Local locations use 1-based UTF-16 columns. External or non-file targets are marked `external`; when their text cannot safely be read, the result preserves `rawRange` and `positionEncoding` and does not invent a public column.

If call-hierarchy preparation returns multiple items, select a fresh stable `itemId` on a second request. Active server progress makes results `possiblyIncomplete`.

### `lsp_code_actions`

Lists actions or previews one exact title. Preview is the default.

```json
{
  "path": "src/index.ts",
  "line": 42,
  "symbol": "problemValue",
  "kind": "quickfix",
  "title": "Add missing import"
}
```

A uniquely selected edit-bearing preview returns `actionId`. Apply requires another call:

```json
{
  "path": "src/index.ts",
  "line": 42,
  "symbol": "problemValue",
  "actionId": "<preview identity>",
  "apply": true
}
```

Apply makes a fresh code-action request and requires exactly one identical response. Merely listing an ID does not authorize apply. Commands are never executed. Command-only actions remain unsupported. Edit-plus-command actions are non-applicable except for the pinned TypeScript `_typescript.applyCodeActionCommand` wrapper when its payload proves that it has no nested commands; in that case the complete validated edit may be applied and the redundant wrapper is omitted. Formatting actions, unsafe resource operations, and unsupported partial subsets remain non-applicable. Malformed candidates are reported individually and do not hide other valid actions.

### `lsp_rename`

Preview a semantic rename:

```json
{
  "path": "src/index.ts",
  "line": 42,
  "symbol": "oldName",
  "newName": "newName"
}
```

The preview returns a `renameId` and bounded unified diff. Apply requires the same arguments plus that identity and `"apply": true`. The extension reruns prepare/rename against fresh synchronized content and requires an exact identity match before publication.

## Mutation safety

Code actions and rename share one workspace-edit engine:

1. Parse both `changes` and `documentChanges` without silently dropping files.
2. Parse resource operations for preview, but reject the whole transaction for v1 apply.
3. Require local `file:` URIs, regular existing files, canonical containment, safe ranges, matching non-null document versions, no overlaps, and hard transaction limits.
4. Stage every file from one snapshot and generate bounded diffs.
5. On apply, make a fresh LSP request, revalidate identity, acquire Pi's canonical file mutation queues in sorted order, and recheck cancellation/content/inode/path state.
6. Publish each file through a same-directory fsynced temporary and atomic rename.
7. Attempt atomic per-file rollback if a later publication fails and report any rollback failure precisely.
8. Synchronize active clients and send `didSave` when requested.

Normal filesystems do not provide true multi-file atomicity. The staging, queueing, pre-publication checks, and rollback are the practical safety boundary.

## Commands

```text
/lsp
/lsp status [server]
/lsp restart [server]
/lsp stop [server]
/lsp config
```

Status shows command availability, active roots, initialized server name/version, normalized capabilities, and client state. Restart/stop affects only session clients; the next tool call starts a server lazily. Config output shows effective paths and redacted values, not environment values or server settings.

## Configuration

Lowest to highest precedence:

1. built-in defaults;
2. user config: Pi agent directory `base-lsp.json` (normally `~/.pi/agent/base-lsp.json`);
3. nearest trusted project config from the current directory to the fixed VCS/session boundary: `<CONFIG_DIR_NAME>/base-lsp.json`.

Configuration is JSON only. Objects deep-merge, arrays replace, and `null` clears an optional value. Server entries merge by ID.

```json
{
  "enabled": true,
  "allowUntrustedProjects": false,
  "ignore": ["generated/**", "vendor/**"],
  "disabledServers": ["ruff"],
  "limits": {
    "requestTimeoutMs": 20000,
    "maxClients": 6,
    "maxFiles": 100
  },
  "serverOverrides": {
    "ruby-lsp": {
      "command": ["bundle", "exec", "ruby-lsp"]
    }
  },
  "servers": {
    "custom-foo": {
      "displayName": "Foo Language Server",
      "enabled": true,
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

Commands are argv arrays and are spawned directly without a shell. Environment overlays are supported but redacted from status/config output.

## Trust and security

By default, **no language server starts in an untrusted project**. Project config is not read until `ctx.isProjectTrusted()` is true. User config may set `allowUntrustedProjects: true` as an explicit blanket override; project config cannot set it.

Pi trust is authorization, not a sandbox. Language servers and configured commands run with your user permissions and may load repository-controlled plugins, compiler hooks, build files, macros, or toolchain configuration. Review repositories and server configuration before trusting them.

The session boundary is fixed before reading extension config. Roots cannot widen it. Read-only navigation may display external targets, but mutation code never reads or writes external/non-file targets. Unsolicited `workspace/applyEdit` requests are declined.

## Runtime behavior

Clients are keyed by configuration generation, server ID, and canonical root. Startup and root detection are deduplicated. Clients are reused until idle eviction, explicit stop/restart, failure cooldown, or session shutdown. Requests have deadlines and LSP cancellation; cancelling one request does not normally kill a healthy shared server.

Protocol headers, bodies, incomplete retained data, stderr, files, locations, symbols, diagnostics, edits, rendered text, and structured details all have hard limits. POSIX servers run in detached process groups for descendant cleanup. Recognized npm Windows shims are resolved to `node <script>` without a command shell, and Windows cleanup uses tree termination.

No server, watcher, or process starts in the extension factory or `session_start`; servers start only when a tool needs one. Idle timers are unref'ed. `session_shutdown` drains requests, attempts graceful LSP shutdown, then force-terminates remaining process trees.

## Troubleshooting

- **Missing server:** run `/lsp status <id>`, install the reported executable, or override its argv in user config.
- **Wrong server/root:** pass explicit `server`/`root`, inspect project markers, then `/lsp restart <id>` after marker changes.
- **TypeScript cannot find TypeScript:** install both `typescript-language-server` and `typescript`, or configure `initializationOptions.tsserver.path`.
- **Timeout or incomplete navigation:** let initial indexing finish, increase the bounded request timeout in user config, or inspect `/lsp status` progress/stderr.
- **Unconfirmed diagnostics:** the server did not provide affirmative evidence. Retry with `refresh: true`; do not interpret it as clean. TypeScript initial clean files use a bounded post-open server policy, while later unversioned empty publications remain provisional.
- **Unsupported TypeScript declaration:** `typescript-language-server` does not advertise the LSP declaration method. Use an explicit definition request only when definition semantics are acceptable.
- **Unavailable workspace servers:** implicit workspace scans summarize missing server/root groups while retaining per-file `unavailable` evidence and installation hints in structured details.
- **Stale diagnostics after external edits:** explicit requests reread authoritative disk content. Use `refresh: true` or restart a misbehaving server.
- **Apply rejected:** content, version, identity, path, edit limits, or resource operations changed since preview. Preview again rather than bypassing the check.
- **Untrusted:** trust the project and reload/restart the Pi session, or deliberately set the user-global override.

## Development

```bash
npm run typecheck
npm test
npm run test:integration
npm run test:smoke
```

Tests include position/root/routing/config units, bounded transport and fake-server integration, truthful push/pull/workspace diagnostics, navigation variants, mutation identity and queue safety, package registration, and pinned real TypeScript definition/rename smoke tests. `clangd` is also available on this development machine for manual smoke testing.

See [`PLAN.md`](./PLAN.md) for design invariants and phased rationale.
