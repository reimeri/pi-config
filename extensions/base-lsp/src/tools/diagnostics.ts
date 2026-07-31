import { stat } from "node:fs/promises";
import { relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { diagnosticsSchema, type DiagnosticsInput } from "./schemas.js";
import type { RuntimeGetter, SessionRuntime } from "./context.js";
import { discoverFiles, type DiscoveryResult } from "../workspace/files.js";
import { resolveExplicitRoot, resolveInputPath } from "../workspace/boundary.js";
import { routeFile, type Route } from "../servers/routing.js";
import { baseDetails, envelope, rethrowUnexpected, statusFromError, type ToolStatus } from "./results.js";
import { lineOnlyRange, tryConvertRange } from "../protocol/locations.js";
import type { Diagnostic } from "../protocol/types.js";
import type { DocumentSnapshot } from "../runtime/document-store.js";
import type { DiagnosticEvidence } from "../protocol/diagnostics.js";
import type { LspClient } from "../protocol/client.js";
import { sanitizeText } from "../util/text.js";
import { TimeoutError } from "../util/async.js";

interface Inventory extends DiscoveryResult { omittedUnknown?: boolean }
interface WorkItem { file: string; route: Route }
interface WorkGroup { route: Route; items: WorkItem[] }
interface RawEvidence { item: WorkItem; client?: LspClient; snapshot?: DocumentSnapshot; result: DiagnosticEvidence }
interface GroupDiagnosticResult { evidence: RawEvidence[]; run: { server: string; root?: string; status: string; durationMs: number }; omittedWorkspaceReports: number }

export function registerDiagnosticsTool(pi: ExtensionAPI, getRuntime: RuntimeGetter): void {
  pi.registerTool({
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description: "Get truthful, bounded LSP diagnostics for files or a workspace. Silence and timeout are not reported as clean.",
    promptSnippet: "Get semantic compiler/type diagnostics from configured language servers",
    promptGuidelines: ["Use lsp_diagnostics after meaningful code changes when a language server is available."],
    parameters: diagnosticsSchema,
    async execute(_id, params: DiagnosticsInput, signal) {
      const started = Date.now();
      const runtime = getRuntime();
      if (!runtime.loaded.authorized) return envelope("LSP startup refused because the project is untrusted. Trust the project and restart.", { ...baseDetails("diagnostics", "untrusted", started) });
      const maxFiles = Math.min(params.maxFiles ?? runtime.loaded.config.limits.maxFiles, runtime.loaded.config.limits.maxFiles);
      const maxDiagnostics = Math.min(params.maxDiagnostics ?? runtime.loaded.config.limits.maxDiagnostics, runtime.loaded.config.limits.maxDiagnostics);
      const waitMs = Math.min(params.waitMs ?? runtime.loaded.config.limits.requestTimeoutMs, runtime.loaded.config.limits.requestTimeoutMs);
      const mode = params.mode ?? (params.paths ? "paths" : "workspace");
      try {
        const inventory = await inventoryFiles(runtime, params, maxFiles, signal);
        if (!inventory.files.length) return envelope("No matching files found.", { ...baseDetails("diagnostics", inventory.capped ? "partial" : "no_results", started), files: [], discovery: inventory });
        const work = await buildWork(runtime, inventory.files, params.server);
        if (!work.length) return envelope("No configured language server matches the selected files.", { ...baseDetails("diagnostics", "no_results", started), files: [], discovery: inventory });
        const groups = groupWork(work);
        const concurrency = Math.max(1, Math.min(4, runtime.loaded.config.limits.maxClients, groups.length));
        const deadlineAt = Date.now() + waitMs;
        const deadlineController = new AbortController();
        const deadlineTimer = setTimeout(() => deadlineController.abort(new TimeoutError(`Diagnostic collection timed out after ${waitMs}ms`)), waitMs);
        deadlineTimer.unref?.();
        const operationSignal = signal ? AbortSignal.any([signal, deadlineController.signal]) : deadlineController.signal;
        let groupResults: GroupDiagnosticResult[];
        try {
          groupResults = await mapConcurrent(groups, concurrency, (group) => runDiagnosticGroup(runtime, group, mode, deadlineAt, params.refresh ?? false, operationSignal, signal));
        } finally { clearTimeout(deadlineTimer); }
        const rawEvidence = groupResults.flatMap((result) => result.evidence);
        const serverRuns = groupResults.map((result) => result.run);
        const omittedWorkspaceReports = groupResults.reduce((total, result) => total + result.omittedWorkspaceReports, 0);
        const evidence: Array<Record<string, unknown>> = [];
        let emittedDiagnostics = 0;
        let omittedDiagnostics = 0;
        let unresolvedRanges = 0;
        for (const entry of rawEvidence) {
          omittedDiagnostics += entry.result.omittedDiagnostics ?? 0;
          const filtered = entry.result.diagnostics.filter((diagnostic) => severityMatches(diagnostic, params.severity ?? "all"));
          const remaining = Math.max(0, maxDiagnostics - emittedDiagnostics);
          const displayed = filtered.slice(0, remaining);
          emittedDiagnostics += displayed.length;
          omittedDiagnostics += Math.max(0, filtered.length - displayed.length);
          let normalized: Array<Record<string, unknown>> = [];
          let normalizationError: string | undefined;
          if (entry.snapshot && entry.client) {
            try { normalized = displayed.map((diagnostic) => normalizeDiagnostic(diagnostic, entry.snapshot!.text, entry.client!.capabilities!.positionEncoding)); }
            catch (error) { normalizationError = error instanceof Error ? error.message : String(error); }
          }
          const unresolvedHere = normalized.filter((diagnostic) => diagnostic.rangeUnresolved).length;
          unresolvedRanges += unresolvedHere;
          evidence.push({
            path: relative(entry.item.route.root, entry.item.file) || ".",
            server: entry.item.route.server.id,
            root: entry.item.route.root,
            state: normalizationError ? "error" : entry.result.state,
            underlyingDiagnosticCount: entry.result.diagnostics.length + (entry.result.omittedDiagnostics ?? 0),
            filteredDiagnosticCount: filtered.length,
            possiblyStale: entry.result.possiblyStale ?? false,
            ...(unresolvedHere ? { unresolvedRanges: unresolvedHere } : {}),
            ...(entry.result.confirmation ? { confirmation: entry.result.confirmation } : {}),
            diagnostics: normalized,
            ...(normalizationError ? { message: `Malformed diagnostic range: ${normalizationError}` } : entry.result.message ? { message: entry.result.message } : {}),
            ...(entry.snapshot ? { contentHash: entry.snapshot.contentHash, version: entry.snapshot.version } : {}),
          });
        }
        const states = evidence.map((entry) => String(entry.state));
        const affirmative = states.filter((state) => state === "clean" || state === "diagnostics").length;
        const unavailableByServer = new Map<string, { server: string; root: string; files: number; message?: string; installationHint?: string }>();
        for (const entry of rawEvidence) {
          if (entry.result.state !== "unavailable") continue;
          const key = `${entry.item.route.server.id}\0${entry.item.route.root}`;
          const summary = unavailableByServer.get(key) ?? { server: entry.item.route.server.id, root: entry.item.route.root, files: 0, ...(entry.item.route.server.installationHint ? { installationHint: entry.item.route.server.installationHint } : {}) };
          summary.files += 1;
          if (!summary.message && entry.result.message) summary.message = entry.result.message;
          unavailableByServer.set(key, summary);
        }
        const unavailableServers = [...unavailableByServer.values()];
        let status = aggregateStatus(states, affirmative);
        if ((inventory.capped || omittedDiagnostics > 0 || omittedWorkspaceReports > 0 || unresolvedRanges > 0) && status === "ok") status = "partial";
        const warnings: string[] = [];
        if (inventory.capped) warnings.push(inventory.omittedUnknown ? `Discovery was capped; at least ${inventory.omitted} matching file(s) were omitted and additional files may be undiscovered.` : `Discovery was capped; ${inventory.omitted} matching file(s) were omitted.`);
        if (omittedDiagnostics) warnings.push(`${omittedDiagnostics} diagnostic(s) were omitted by the output limit.`);
        if (omittedWorkspaceReports) warnings.push(`${omittedWorkspaceReports} additional workspace diagnostic report(s) were omitted.`);
        if (unresolvedRanges) warnings.push(`${unresolvedRanges} diagnostic range(s) did not fit the synchronized document; their raw server ranges are preserved and public columns omitted. The server may be reporting against an older version.`);
        if (unavailableServers.length) warnings.push(`${unavailableServers.length} server/root group(s) were unavailable; per-file evidence is retained in details.`);
        const emittedUnavailable = new Set<string>();
        const lines = evidence.flatMap((entry) => {
          const diagnostics = entry.diagnostics as Array<Record<string, unknown>>;
          if (diagnostics.length) return diagnostics.map((diagnostic) => {
            const start = (diagnostic.range as { start: { line: number; character?: number } }).start;
            const column = start.character !== undefined ? `:${start.character}` : "";
            return `${entry.server} ${entry.path}:${start.line}${column} ${diagnostic.rangeUnresolved ? "[stale range] " : ""}${diagnostic.severity} ${diagnostic.message}`;
          });
          if (entry.state === "unavailable") {
            const key = `${entry.server}\0${entry.root}`;
            if (emittedUnavailable.has(key)) return [];
            emittedUnavailable.add(key);
            const summary = unavailableByServer.get(key)!;
            const suffix = summary.message ? ` (${summary.message})` : "";
            return [`${summary.server} ${summary.root}: unavailable for ${summary.files} file(s)${suffix}`];
          }
          const filtered = Number(entry.filteredDiagnosticCount ?? 0);
          const suffix = entry.state === "diagnostics" && filtered === 0 ? " (findings exist but none match the severity filter)" : entry.message ? ` (${entry.message})` : "";
          return [`${entry.server} ${entry.path}: ${entry.state}${suffix}`];
        });
        return envelope(lines.join("\n"), { ...baseDetails("diagnostics", status, started), servers: serverRuns, unavailableServers, coverage: { requested: states.length, affirmative, unavailable: states.filter((state) => state === "unavailable").length, unconfirmed: states.filter((state) => state === "unconfirmed").length }, files: evidence, discovery: inventory, omittedDiagnostics, omittedWorkspaceReports, unresolvedRanges, truncated: omittedDiagnostics > 0 || omittedWorkspaceReports > 0 || inventory.capped, warnings });
      } catch (error) {
        rethrowUnexpected(error);
        const status = statusFromError(error);
        return envelope(error instanceof Error ? error.message : String(error), { ...baseDetails("diagnostics", status, started) });
      }
    },
  });
}

async function runDiagnosticGroup(runtime: SessionRuntime, group: WorkGroup, mode: string, deadlineAt: number, refresh: boolean, signal?: AbortSignal, acquireSignal?: AbortSignal): Promise<GroupDiagnosticResult> {
  const started = Date.now();
  const evidence: RawEvidence[] = [];
  let omittedWorkspaceReports = 0;
  let client: LspClient | undefined;
  const remainingMs = (): number => Math.max(0, deadlineAt - Date.now());
  try {
    if (remainingMs() <= 0) throw new TimeoutError("Shared diagnostic deadline elapsed before server acquisition");
    const acquired = await acquireWithinDeadline(runtime, group.route, remainingMs(), acquireSignal);
    client = acquired;
    runtime.diagnostics.observe(acquired);
    if (remainingMs() <= 0) throw new TimeoutError("Shared diagnostic deadline elapsed during server acquisition");
    if (mode === "workspace" && acquired.capabilities?.diagnostics.workspace) {
      await acquired.documents!.withSynchronizedDocuments(group.items.map((item) => item.file), signal, async (snapshots) => {
        const remaining = remainingMs();
        if (remaining <= 0) throw new TimeoutError("Shared diagnostic deadline elapsed during document synchronization");
        const results = await runtime.diagnostics.checkWorkspace(acquired, snapshots, remaining, refresh, signal);
        omittedWorkspaceReports += results.omittedReports;
        const byPath = new Map(snapshots.map((snapshot) => [snapshot.canonicalPath, snapshot] as const));
        for (const item of group.items) {
          const snapshot = byPath.get(item.file)!;
          evidence.push({ item, client: acquired, snapshot, result: results.evidence.get(snapshot.uri) ?? { state: "unconfirmed", diagnostics: [], message: "No workspace diagnostic evidence" } });
        }
      });
    } else if (!acquired.capabilities?.diagnostics.pull) {
      const chunkSize = pushChunkSize(runtime.loaded.config.limits.maxOpenDocuments);
      for (let offset = 0; offset < group.items.length; offset += chunkSize) {
        const chunk = group.items.slice(offset, offset + chunkSize);
        if (remainingMs() <= 0) throw new TimeoutError("Shared diagnostic deadline elapsed before the push-diagnostic batch completed");
        const chunkDeadlineAt = Date.now() + chunkBudgetMs(remainingMs(), group.items.length - offset, chunkSize);
        const checkpoint = runtime.diagnostics.checkpoint(acquired);
        await acquired.documents!.withSynchronizedDocuments(chunk.map((item) => item.file), signal, async (snapshots) => {
          const results = await runtime.diagnostics.checkPushBatch(acquired, snapshots, chunkDeadlineAt, refresh, signal, checkpoint);
          const byPath = new Map(snapshots.map((snapshot) => [snapshot.canonicalPath, snapshot] as const));
          for (const item of chunk) {
            const snapshot = byPath.get(item.file)!;
            evidence.push({ item, client: acquired, snapshot, result: results.get(snapshot.uri) ?? { state: "unconfirmed", diagnostics: [], message: "No push diagnostic evidence" } });
          }
        });
      }
    } else {
      for (const item of group.items) {
        const remaining = remainingMs();
        if (remaining <= 0) throw new TimeoutError("Shared diagnostic deadline elapsed before the per-file diagnostic sweep completed");
        const checkpoint = runtime.diagnostics.checkpoint(acquired);
        await acquired.documents!.withSynchronizedDocument(item.file, signal, async (snapshot) => {
          evidence.push({ item, client: acquired, snapshot, result: await runtime.diagnostics.check(acquired, snapshot, remaining, refresh, signal, checkpoint) });
        });
      }
    }
    return { evidence, run: { server: group.route.server.id, root: group.route.root, status: groupEvidenceStatus(evidence.map((entry) => entry.result.state)), durationMs: Date.now() - started }, omittedWorkspaceReports };
  } catch (error) {
    const state = evidenceStateFromError(error, signal);
    const message = signal?.reason instanceof TimeoutError ? signal.reason.message : error instanceof Error ? error.message : String(error);
    const completed = new Set(evidence.map((entry) => entry.item.file));
    for (const item of group.items) if (!completed.has(item.file)) evidence.push({ item, result: { state, diagnostics: [], message } });
    return { evidence, run: { server: group.route.server.id, root: group.route.root, status: groupEvidenceStatus(evidence.map((entry) => entry.result.state)), durationMs: Date.now() - started }, omittedWorkspaceReports };
  } finally { if (client) runtime.manager.release(client); }
}

// Do not abort client acquisition at the call deadline; let a cold-starting server warm for retries.
async function acquireWithinDeadline(runtime: SessionRuntime, route: Route, budgetMs: number, signal?: AbortSignal): Promise<LspClient> {
  const acquisition = runtime.manager.acquire(route, signal);
  let expire!: (error: Error) => void;
  const deadline = new Promise<never>((_, reject) => { expire = reject; });
  const timer = setTimeout(() => expire(new TimeoutError("Shared diagnostic deadline elapsed during server acquisition")), budgetMs);
  timer.unref?.();
  try {
    return await Promise.race([acquisition, deadline]);
  } catch (error) {
    acquisition.then((client) => runtime.manager.release(client)).catch(() => undefined);
    throw error;
  } finally { clearTimeout(timer); }
}

// Reserve document capacity because push batches pin opened documents during collection.
export function pushChunkSize(maxOpenDocuments: number): number {
  const reserve = Math.min(16, Math.max(1, Math.ceil(maxOpenDocuments / 10)));
  return Math.max(1, maxOpenDocuments - reserve);
}

// Divide remaining time among chunks; unused time rolls forward so early chunks cannot starve later ones.
export function chunkBudgetMs(remainingMs: number, itemsLeft: number, chunkSize: number): number {
  return Math.max(1, Math.floor(remainingMs / Math.max(1, Math.ceil(itemsLeft / chunkSize))));
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function inventoryFiles(runtime: SessionRuntime, params: DiagnosticsInput, maxFiles: number, signal?: AbortSignal): Promise<Inventory> {
  const mode = params.mode ?? (params.paths ? "paths" : "workspace");
  if (mode === "changed") {
    const all = [...runtime.changed].sort();
    return { files: all.slice(0, maxFiles), entries: all.length, ignored: 0, oversized: 0, omitted: Math.max(0, all.length - maxFiles), capped: all.length > maxFiles };
  }
  const inputs = params.paths ?? [params.root ?? runtime.boundary];
  const result: Inventory = { files: [], entries: 0, ignored: 0, oversized: 0, omitted: 0, capped: false };
  const maxEntries = runtime.loaded.config.limits.maxDiscoveryEntries;
  for (let inputIndex = 0; inputIndex < inputs.length; inputIndex += 1) {
    if (result.entries >= maxEntries || result.files.length >= maxFiles) { result.capped = true; result.omittedUnknown = true; break; }
    const input = inputs[inputIndex]!;
    const canonical = params.root && !params.paths && input === params.root
      ? await resolveExplicitRoot(input, runtime.cwd, runtime.boundary)
      : await resolveInputPath(input, runtime.cwd, runtime.boundary, false);
    const info = await stat(canonical);
    if (info.isFile()) {
      result.entries += 1;
      if (result.files.length < maxFiles) result.files.push(canonical); else { result.omitted += 1; result.capped = true; }
    } else if (info.isDirectory()) {
      const remainingEntries = Math.max(0, maxEntries - result.entries);
      const remainingFiles = Math.max(0, maxFiles - result.files.length);
      const found = await discoverFiles(canonical, runtime.boundary, runtime.registry.enabled(), runtime.loaded.config.ignore, remainingEntries, remainingFiles, runtime.loaded.config.limits.maxFileBytes, signal);
      result.files.push(...found.files); result.entries += found.entries; result.ignored += found.ignored; result.oversized += found.oversized; result.omitted += found.omitted; result.capped ||= found.capped;
      if (found.capped && found.entries >= remainingEntries) result.omittedUnknown = true;
    }
    if ((result.files.length >= maxFiles || result.entries >= maxEntries) && inputIndex < inputs.length - 1) { result.capped = true; result.omittedUnknown = true; break; }
  }
  result.files = [...new Set(result.files)].sort().slice(0, maxFiles);
  return result;
}

async function buildWork(runtime: SessionRuntime, files: string[], selection?: string | string[]): Promise<WorkItem[]> {
  const explicit = selection ? (Array.isArray(selection) ? selection : [selection]) : undefined;
  const work: WorkItem[] = [];
  for (const file of files) {
    if (explicit) {
      for (const id of explicit) {
        const routed = await routeFile(file, runtime.boundary, runtime.registry.enabled(), runtime.roots, id);
        const route = routed.primary ?? routed.diagnostics.find((item) => item.server.id === id);
        if (route) work.push({ file, route });
      }
    } else {
      const routed = await routeFile(file, runtime.boundary, runtime.registry.enabled(), runtime.roots);
      if (routed.primary) work.push({ file, route: routed.primary });
      for (const route of routed.diagnostics) work.push({ file, route });
    }
  }
  return work;
}

function groupWork(work: WorkItem[]): WorkGroup[] {
  const groups = new Map<string, WorkGroup>();
  for (const item of work) {
    const key = `${item.route.server.id}\0${item.route.root}`;
    const group = groups.get(key) ?? { route: item.route, items: [] };
    if (!group.items.some((existing) => existing.file === item.file)) group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.route.server.id.localeCompare(b.route.server.id) || a.route.root.localeCompare(b.route.root));
}

function groupEvidenceStatus(states: DiagnosticEvidence["state"][]): string {
  if (!states.length) return "no_results";
  if (states.every((state) => state === "clean" || state === "diagnostics")) return "ok";
  if (states.every((state) => state === states[0])) return states[0]!;
  return "partial";
}

function aggregateStatus(states: string[], affirmative: number): ToolStatus {
  if (states.length && affirmative === states.length) return "ok";
  if (affirmative) return "partial";
  if (states.every((state) => state === "timed_out")) return "timed_out";
  if (states.every((state) => state === "cancelled")) return "cancelled";
  if (states.every((state) => state === "unavailable")) return "unavailable";
  if (states.every((state) => state === "error")) return "error";
  if (new Set(states).size > 1) return "partial";
  return "no_results";
}
function evidenceStateFromError(error: unknown, signal?: AbortSignal): DiagnosticEvidence["state"] { if (signal?.reason instanceof TimeoutError) return "timed_out"; const status = statusFromError(error); return status === "timed_out" || status === "cancelled" || status === "unavailable" ? status : "error"; }
function severityMatches(diagnostic: Diagnostic, severity: string): boolean { const wanted: Record<string, number> = { error: 1, warning: 2, information: 3, hint: 4 }; return severity === "all" || diagnostic.severity === wanted[severity]; }
// Preserve a stale push diagnostic's raw range without discarding other findings.
function normalizeDiagnostic(diagnostic: Diagnostic, text: string, encoding: "utf-8" | "utf-16" | "utf-32"): Record<string, unknown> {
  const converted = tryConvertRange(text, diagnostic.range, encoding);
  return {
    message: sanitizeText(diagnostic.message, 4_000),
    severity: ["unknown", "error", "warning", "information", "hint"][diagnostic.severity ?? 0] ?? "unknown",
    range: converted ?? lineOnlyRange(diagnostic.range),
    ...(converted ? {} : { rangeUnresolved: "out-of-range" as const, rawRange: diagnostic.range, positionEncoding: encoding }),
    ...(diagnostic.source ? { source: sanitizeText(diagnostic.source, 500) } : {}),
    ...(diagnostic.code !== undefined ? { code: sanitizeText(typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code, 500) } : {}),
    ...(diagnostic.codeDescription?.href ? { codeDescription: sanitizeText(diagnostic.codeDescription.href, 2_000) } : {}),
    ...(diagnostic.tags ? { tags: diagnostic.tags.slice(0, 10) } : {}),
    ...(diagnostic.relatedInformation ? { relatedInformation: diagnostic.relatedInformation.slice(0, 10).map((item) => ({ uri: sanitizeText(item.location.uri, 2_000), rawRange: item.location.range, message: sanitizeText(item.message, 2_000), positionEncoding: encoding })) } : {}),
    ...(diagnostic.data !== undefined ? { hasData: true } : {}),
  };
}
