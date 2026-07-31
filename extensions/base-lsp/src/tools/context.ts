import { readFile } from "node:fs/promises";
import type { LoadedConfig } from "../config/schema.js";
import type { ClientManager } from "../runtime/client-manager.js";
import type { RootDetector } from "../servers/roots.js";
import type { ServerRegistry } from "../servers/registry.js";
import { routeFile, type Route } from "../servers/routing.js";
import type { DiagnosticService } from "../protocol/diagnostics.js";
import { resolveExplicitRoot, resolveInputPath } from "../workspace/boundary.js";
import { publicToServerPosition, resolveSymbolPosition } from "../protocol/positions.js";
import type { LspClient } from "../protocol/client.js";
import type { DocumentSnapshot } from "../runtime/document-store.js";

export interface SessionRuntime { cwd: string; boundary: string; loaded: LoadedConfig; registry: ServerRegistry; roots: RootDetector; manager: ClientManager; diagnostics: DiagnosticService; changed: Set<string>; previewActions: Set<string>; previewRenames: Set<string> }
export type RuntimeGetter = () => SessionRuntime;

// Retain recent unapplied previews; eviction requires a fresh preview and bounds long-session memory.
const MAX_PREVIEW_TOKENS = 200;
export function rememberPreview(tokens: Set<string>, id: string): void {
  tokens.delete(id);
  tokens.add(id);
  while (tokens.size > MAX_PREVIEW_TOKENS) {
    const oldest = tokens.values().next().value as string | undefined;
    if (oldest === undefined) break;
    tokens.delete(oldest);
  }
}

export interface SourceDocumentState {
  snapshot: DocumentSnapshot;
  position?: { line: number; character: number };
  publicCharacter?: number;
}
export interface AcquiredSource extends SourceDocumentState {
  path: string;
  route: Route;
  client: LspClient;
  withDocument<T>(fn: (state: SourceDocumentState) => Promise<T>): Promise<T>;
  release(): void;
}

export async function acquireSource(runtime: SessionRuntime, input: { path: string; server?: string; root?: string; line?: number; character?: number; symbol?: string }, signal?: AbortSignal): Promise<AcquiredSource> {
  const path = await resolveInputPath(input.path, runtime.cwd, runtime.boundary);
  const routed = await routeFile(path, runtime.boundary, runtime.registry.enabled(), runtime.roots, input.server);
  if (routed.ambiguous) throw Object.assign(new Error(`Ambiguous language servers: ${routed.ambiguous.join(", ")}`), { code: "AMBIGUOUS" });
  let route = routed.primary;
  if (!route && input.server) route = routed.diagnostics.find((item) => item.server.id === input.server);
  if (!route) throw Object.assign(new Error(`No language server matches ${input.path}`), { code: "UNAVAILABLE" });
  if (input.root) {
    const explicit = await resolveExplicitRoot(input.root, runtime.cwd, runtime.boundary);
    route = { ...route, root: explicit };
  }
  const client = await runtime.manager.acquire(route, signal);
  runtime.diagnostics.observe(client);
  const locate = (snapshot: DocumentSnapshot): SourceDocumentState => {
    let position: { line: number; character: number } | undefined;
    let publicCharacter: number | undefined;
    if (input.line !== undefined) {
      publicCharacter = input.character;
      if (publicCharacter === undefined && input.symbol) publicCharacter = resolveSymbolPosition(snapshot.text, input.line, input.symbol).character;
      if (publicCharacter === undefined) throw new Error("character or symbol is required for this operation");
      position = publicToServerPosition(snapshot.text, input.line, publicCharacter, client.capabilities!.positionEncoding);
    }
    return { snapshot, ...(position ? { position } : {}), ...(publicCharacter !== undefined ? { publicCharacter } : {}) };
  };
  let released = false;
  const release = (): void => { if (!released) { released = true; runtime.manager.release(client); } };
  let initial: SourceDocumentState;
  try { initial = locate(await client.documents!.sync(path, signal)); }
  catch (error) { release(); throw error; }
  const source = {
    path, route, client, ...initial,
    release,
    async withDocument<T>(fn: (state: SourceDocumentState) => Promise<T>): Promise<T> {
      if (released) throw new Error("LSP source lease has been released");
      return client.documents!.withSynchronizedDocument(path, signal, async (snapshot) => {
        const current = locate(snapshot);
        source.snapshot = current.snapshot;
        if (current.position) source.position = current.position; else delete source.position;
        if (current.publicCharacter !== undefined) source.publicCharacter = current.publicCharacter; else delete source.publicCharacter;
        return fn(current);
      });
    },
  } as AcquiredSource;
  return source;
}

export async function sourceText(path: string): Promise<string> { return readFile(path, "utf8"); }
