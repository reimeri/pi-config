import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { navigationSchema, type NavigationInput } from "./schemas.js";
import type { RuntimeGetter, SessionRuntime } from "./context.js";
import { acquireSource } from "./context.js";
import { baseDetails, envelope, rethrowUnexpected, statusFromError } from "./results.js";
import { convertRange, normalizeLocations, type NormalizedLocation } from "../protocol/locations.js";
import type { CallHierarchyIncomingCall, CallHierarchyItem, CallHierarchyOutgoingCall, DocumentSymbol, Hover, MarkedString, SymbolInformation } from "../protocol/types.js";
import { sanitizeText, stableHash } from "../util/text.js";
import { routeFile, type Route } from "../servers/routing.js";
import { resolveExplicitRoot, resolveInputPath } from "../workspace/boundary.js";
import type { NormalizedCapabilities, PositionEncoding } from "../protocol/types.js";

interface NormalizedSymbol {
  name: string;
  detail?: string;
  kind: number;
  depth: number;
  range?: ReturnType<typeof convertRange>;
  selectionRange?: ReturnType<typeof convertRange>;
  location?: NormalizedLocation;
  containerName?: string;
}

export function registerNavigationTool(pi: ExtensionAPI, getRuntime: RuntimeGetter): void {
  pi.registerTool({
    name: "lsp_navigation",
    label: "LSP Navigation",
    description: "Perform semantic LSP navigation: declarations, definitions, references, hover, symbols, and call hierarchy.",
    promptSnippet: "Navigate code semantically using definitions, references, hover, symbols, and calls",
    promptGuidelines: ["Use lsp_navigation instead of text search when language semantics improve precision."],
    parameters: navigationSchema,
    async execute(_id, params: NavigationInput, signal) {
      const started = Date.now();
      const runtime = getRuntime();
      if (!runtime.loaded.authorized) return envelope("LSP startup refused because the project is untrusted.", { ...baseDetails(params.operation, "untrusted", started) });
      try {
        if (params.operation === "workspace_symbols") return await workspaceSymbols(runtime, params, started, signal);
        if (!params.path) throw new Error("path is required for this operation");
        const positionRequired = params.operation !== "document_symbols";
        if (positionRequired && params.line === undefined) throw new Error("line is required for this operation");
        const source = await acquireSource(runtime, {
          path: params.path,
          ...(params.server ? { server: params.server } : {}),
          ...(params.root ? { root: params.root } : {}),
          ...(params.line !== undefined ? { line: params.line } : {}),
          ...(params.character !== undefined ? { character: params.character } : {}),
          ...(params.symbol ? { symbol: params.symbol } : {}),
        }, signal);
        try {
        const capabilities = source.client.capabilities!;
        if (!supports(capabilities, params.operation)) return envelope(`${source.route.server.id} does not support ${params.operation}.`, { ...baseDetails(params.operation, "unsupported", started), server: source.route.server.id, root: source.route.root });
        const symbolOperation = params.operation === "document_symbols";
        const limit = Math.min(params.limit ?? (symbolOperation ? runtime.loaded.config.limits.maxSymbols : runtime.loaded.config.limits.maxLocations), symbolOperation ? runtime.loaded.config.limits.maxSymbols : runtime.loaded.config.limits.maxLocations);

        return await source.withDocument(async () => {
        if (params.operation === "hover") {
          const hover = await source.client.request<Hover | null>("textDocument/hover", textDocumentPosition(source.snapshot.uri, source.position!), signal);
          const text = normalizeHover(hover);
          return envelope(text || "No hover information.", { ...baseDetails(params.operation, text ? "ok" : "no_results", started), server: source.route.server.id, root: source.route.root, hover: text, contentHash: source.snapshot.contentHash, version: source.snapshot.version, possiblyIncomplete: source.client.progress.size > 0 });
        }

        if (params.operation === "document_symbols") {
          const raw = await source.client.request<Array<DocumentSymbol | SymbolInformation> | null>("textDocument/documentSymbol", { textDocument: { uri: source.snapshot.uri } }, signal) ?? [];
          const normalized = await normalizeDocumentSymbols(raw, source.snapshot.text, source.route.root, runtime.boundary, capabilities.positionEncoding, limit);
          const symbols = normalized.symbols;
          const text = symbols.map((item) => `${"  ".repeat(item.depth)}${item.name} (${item.kind})${item.range ? ` ${item.range.start.line}:${item.range.start.character}` : item.location ? ` ${item.location.path ?? item.location.uri}:${item.location.range.start.line}` : ""}`).join("\n") || "No symbols.";
          return envelope(text, { ...baseDetails(params.operation, symbols.length ? "ok" : "no_results", started), server: source.route.server.id, root: source.route.root, symbols, total: normalized.totalAtLeast, totalAtLeast: normalized.totalAtLeast, truncated: normalized.truncated, warnings: normalized.depthCapped ? ["Document-symbol hierarchy exceeded the depth limit."] : [], contentHash: source.snapshot.contentHash, version: source.snapshot.version });
        }

        if (params.operation === "incoming_calls" || params.operation === "outgoing_calls") return await callHierarchy(runtime, source, params, limit, started, signal);

        const method: Record<string, string> = {
          declaration: "textDocument/declaration",
          definition: "textDocument/definition",
          type_definition: "textDocument/typeDefinition",
          implementation: "textDocument/implementation",
          references: "textDocument/references",
        };
        const request = params.operation === "references"
          ? { ...textDocumentPosition(source.snapshot.uri, source.position!), context: { includeDeclaration: params.includeDeclaration ?? true } }
          : textDocumentPosition(source.snapshot.uri, source.position!);
        const raw = await source.client.request<unknown>(method[params.operation]!, request, signal);
        const normalized = await normalizeLocations(raw, source.route.root, runtime.boundary, capabilities.positionEncoding, limit, source.snapshot.text);
        const text = normalized.locations.map(renderLocation).join("\n") || "No results.";
        return envelope(text, { ...baseDetails(params.operation, normalized.locations.length ? "ok" : "no_results", started), server: source.route.server.id, root: source.route.root, ...normalized, contentHash: source.snapshot.contentHash, version: source.snapshot.version, possiblyIncomplete: source.client.progress.size > 0 });
        });
        } finally { source.release(); }
      } catch (error) {
        rethrowUnexpected(error);
        return envelope(error instanceof Error ? error.message : String(error), { ...baseDetails(params.operation, statusFromError(error), started) });
      }
    },
  });
}

async function workspaceSymbols(runtime: SessionRuntime, params: NavigationInput, started: number, signal?: AbortSignal) {
  if (params.query === undefined) throw new Error("query is required for workspace_symbols");
  let route: Route | undefined;
  if (params.path) {
    const file = await resolveInputPath(params.path, runtime.cwd, runtime.boundary);
    const routed = await routeFile(file, runtime.boundary, runtime.registry.enabled(), runtime.roots, params.server);
    if (routed.ambiguous) return envelope(`Ambiguous language servers: ${routed.ambiguous.join(", ")}`, { ...baseDetails(params.operation, "ambiguous", started) });
    route = routed.primary ?? (params.server ? routed.diagnostics.find((item) => item.server.id === params.server) : undefined);
  } else if (params.server) {
    const server = runtime.registry.get(params.server);
    const root = params.root ? await resolveExplicitRoot(params.root, runtime.cwd, runtime.boundary) : runtime.boundary;
    if (server?.enabled) route = { server, root, resolution: { root, fallback: "workspace", distance: 0, markerPriority: 0 }, specificity: 0 };
  } else {
    const active = runtime.manager.getActiveClients().filter((client) => client.capabilities?.workspaceSymbols && client.server.role === "primary");
    if (active.length === 1) {
      const client = active[0]!;
      route = { server: client.server, root: client.root, resolution: { root: client.root, distance: 0, markerPriority: 0 }, specificity: 0 };
    } else return envelope("workspace_symbols requires path or server when a single primary server cannot be selected.", { ...baseDetails(params.operation, "ambiguous", started) });
  }
  if (!route) return envelope("No matching server.", { ...baseDetails(params.operation, "unavailable", started) });
  const client = await runtime.manager.acquire(route, signal);
  try {
  if (!client.capabilities?.workspaceSymbols) return envelope("Workspace symbols unsupported.", { ...baseDetails(params.operation, "unsupported", started), server: route.server.id, root: route.root });
  const limit = Math.min(params.limit ?? runtime.loaded.config.limits.maxSymbols, runtime.loaded.config.limits.maxSymbols);
  const raw = await client.request<SymbolInformation[] | null>("workspace/symbol", { query: params.query }, signal) ?? [];
  const selected = raw.slice(0, limit);
  const symbols: Array<Record<string, unknown>> = [];
  for (let symbol of selected) {
    const location = symbol.location;
    if (client.capabilities.workspaceSymbolResolve && (!location || !("range" in location) || !location.range)) symbol = await client.request<SymbolInformation>("workspaceSymbol/resolve", symbol, signal);
    const resolvedLocation = symbol.location && "uri" in symbol.location && symbol.location.range
      ? (await normalizeLocations(symbol.location, route.root, runtime.boundary, client.capabilities.positionEncoding, 1)).locations[0]
      : undefined;
    symbols.push({ name: symbol.name, kind: symbol.kind, ...(symbol.containerName ? { containerName: symbol.containerName } : {}), ...(resolvedLocation ? { location: resolvedLocation } : {}) });
  }
  const text = symbols.map((item) => {
    const location = item.location as NormalizedLocation | undefined;
    return `${item.name} (${item.kind})${location ? ` ${renderLocation(location)}` : " [unresolved]"}`;
  }).join("\n") || "No symbols.";
  return envelope(text, { ...baseDetails(params.operation, symbols.length ? "ok" : "no_results", started), server: route.server.id, root: route.root, symbols, total: raw.length, truncated: raw.length > symbols.length, warnings: [], possiblyIncomplete: client.progress.size > 0 });
  } finally { runtime.manager.release(client); }
}

async function callHierarchy(runtime: SessionRuntime, source: Awaited<ReturnType<typeof acquireSource>>, params: NavigationInput, limit: number, started: number, signal?: AbortSignal) {
  const prepared = await source.client.request<CallHierarchyItem[] | null>("textDocument/prepareCallHierarchy", textDocumentPosition(source.snapshot.uri, source.position!), signal) ?? [];
  const choices = prepared.slice(0, limit).map((item) => ({ item, itemId: stableHash({ server: source.route.server.id, root: source.route.root, sourceHash: source.snapshot.contentHash, name: item.name, kind: item.kind, uri: item.uri, range: item.range, selectionRange: item.selectionRange, data: item.data }) }));
  if (!params.itemId && choices.length !== 1) {
    const normalizedChoices = await Promise.all(choices.map(async ({ item, itemId }) => ({ itemId, ...(await normalizeCallItem(item, runtime, source.route, source.client.capabilities!.positionEncoding)) })));
    return envelope(normalizedChoices.length ? `Multiple call hierarchy items:\n${normalizedChoices.map((choice) => `${choice.itemId} ${choice.name}`).join("\n")}` : "No call hierarchy item.", { ...baseDetails(params.operation, normalizedChoices.length ? "ambiguous" : "no_results", started), choices: normalizedChoices, truncated: prepared.length > choices.length, warnings: [] });
  }
  const selected = params.itemId ? choices.find((choice) => choice.itemId === params.itemId) : choices[0];
  if (!selected) return envelope("itemId no longer matches fresh preparation.", { ...baseDetails(params.operation, "no_results", started) });
  const incoming = params.operation === "incoming_calls";
  const raw = await source.client.request<Array<CallHierarchyIncomingCall | CallHierarchyOutgoingCall> | null>(incoming ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls", { item: selected.item }, signal) ?? [];
  const calls = await Promise.all(raw.slice(0, limit).map(async (entry) => {
    const item = incoming ? (entry as CallHierarchyIncomingCall).from : (entry as CallHierarchyOutgoingCall).to;
    const fromRanges = entry.fromRanges.slice(0, 50);
    return { ...(await normalizeCallItem(item, runtime, source.route, source.client.capabilities!.positionEncoding)), rawFromRanges: fromRanges, omittedFromRanges: Math.max(0, entry.fromRanges.length - fromRanges.length), positionEncoding: source.client.capabilities!.positionEncoding };
  }));
  const nestedTruncated = calls.some((call) => call.omittedFromRanges > 0);
  return envelope(calls.map((item) => `${item.name} ${renderLocation(item.location)}`).join("\n") || "No calls.", { ...baseDetails(params.operation, calls.length ? "ok" : "no_results", started), server: source.route.server.id, root: source.route.root, calls, total: raw.length, truncated: raw.length > calls.length || nestedTruncated, warnings: nestedTruncated ? ["Some call-site ranges were omitted by the nested range limit."] : [], possiblyIncomplete: source.client.progress.size > 0 });
}

async function normalizeCallItem(item: CallHierarchyItem, runtime: SessionRuntime, route: Route, encoding: PositionEncoding) {
  const location = (await normalizeLocations({ uri: item.uri, range: item.range }, route.root, runtime.boundary, encoding, 1)).locations[0]!;
  return { name: sanitizeText(item.name, 500), kind: item.kind, ...(item.detail ? { detail: sanitizeText(item.detail, 1_000) } : {}), location, rawSelectionRange: item.selectionRange, positionEncoding: encoding };
}

async function normalizeDocumentSymbols(items: Array<DocumentSymbol | SymbolInformation>, sourceText: string, root: string, boundary: string, encoding: PositionEncoding, limit: number): Promise<{ symbols: NormalizedSymbol[]; totalAtLeast: number; truncated: boolean; depthCapped: boolean }> {
  const symbols: NormalizedSymbol[] = [];
  let totalAtLeast = 0;
  let truncated = false;
  let depthCapped = false;
  const visit = async (entries: Array<DocumentSymbol | SymbolInformation>, depth: number): Promise<boolean> => {
    if (depth > 64) { depthCapped = true; truncated = true; return false; }
    for (const item of entries) {
      totalAtLeast += 1;
      if (symbols.length >= limit) { truncated = true; return false; }
      if (isDocumentSymbol(item)) {
        symbols.push({ name: sanitizeText(item.name, 500), ...(item.detail ? { detail: sanitizeText(item.detail, 1_000) } : {}), kind: item.kind, depth, range: convertRange(sourceText, item.range, encoding), selectionRange: convertRange(sourceText, item.selectionRange, encoding) });
        if (!await visit(item.children ?? [], depth + 1)) return false;
      } else {
        const location = item.location && "uri" in item.location && item.location.range ? (await normalizeLocations(item.location, root, boundary, encoding, 1)).locations[0] : undefined;
        symbols.push({ name: sanitizeText(item.name, 500), kind: item.kind, depth: 0, ...(item.containerName ? { containerName: sanitizeText(item.containerName, 500) } : {}), ...(location ? { location } : {}) });
      }
    }
    return true;
  };
  await visit(items, 0);
  return { symbols, totalAtLeast, truncated, depthCapped };
}

function isDocumentSymbol(item: DocumentSymbol | SymbolInformation): item is DocumentSymbol { return "range" in item && "selectionRange" in item; }
function textDocumentPosition(uri: string, position: { line: number; character: number }): Record<string, unknown> { return { textDocument: { uri }, position }; }
function supports(capabilities: NormalizedCapabilities, operation: NavigationInput["operation"]): boolean {
  const keys: Partial<Record<NavigationInput["operation"], keyof NormalizedCapabilities>> = { declaration: "declaration", definition: "definition", type_definition: "typeDefinition", implementation: "implementation", references: "references", hover: "hover", document_symbols: "documentSymbols", incoming_calls: "callHierarchy", outgoing_calls: "callHierarchy" };
  const key = keys[operation];
  return key ? Boolean(capabilities[key]) : operation === "workspace_symbols" ? capabilities.workspaceSymbols : false;
}
function normalizeHover(hover: Hover | null): string {
  if (!hover) return "";
  const value = hover.contents;
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) return sanitizeText(value.map(renderMarkedString).join("\n\n"));
  return sanitizeText(value.value);
}
function renderMarkedString(value: MarkedString): string { return typeof value === "string" ? value : `\`\`\`${value.language}\n${value.value}\n\`\`\``; }
function renderLocation(item: NormalizedLocation): string { return `${item.external ? "[external] " : ""}${item.path ?? item.uri}:${item.range.start.line}${item.range.start.character !== undefined ? `:${item.range.start.character}` : ""}`; }
