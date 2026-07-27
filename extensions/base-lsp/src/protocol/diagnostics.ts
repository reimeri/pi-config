import type { LspClient } from "./client.js";
import type { Diagnostic, DocumentDiagnosticReport, PublishDiagnosticsParams, WorkspaceDiagnosticReport } from "./types.js";
import type { DocumentSnapshot } from "../runtime/document-store.js";
import { CancelledError, TimeoutError, throwIfAborted } from "../util/async.js";
import { sanitizeText } from "../util/text.js";
import { isTypeScriptLanguageServer } from "../servers/implementation.js";

export type DiagnosticEvidenceState = "diagnostics" | "clean" | "unconfirmed" | "timed_out" | "unavailable" | "cancelled" | "error";
export interface DiagnosticEvidence { state: DiagnosticEvidenceState; diagnostics: Diagnostic[]; omittedDiagnostics?: number; version?: number; possiblyStale?: boolean; resultId?: string; message?: string; confirmation?: "versioned" | "post_open_server_policy" }
export interface WorkspaceDiagnosticEvidence { evidence: Map<string, DiagnosticEvidence>; omittedReports: number }
export type PushCheckpoint = number;

interface BoundedPublishDiagnostics extends PublishDiagnosticsParams { omittedDiagnostics?: number; sequence: number; receivedAt: number }
interface ClientDiagnosticState {
  pushes: Map<string, BoundedPublishDiagnostics>;
  waiters: Map<string, Set<(params: BoundedPublishDiagnostics) => void>>;
  reports: Map<string, { resultId: string; diagnostics: Diagnostic[]; contentHash: string }>;
  confirmed: Map<string, DiagnosticEvidence>;
  sequence: number;
  dispose: () => void;
}

export class DiagnosticService {
  constructor(private readonly maxDiagnostics = 1_000, private readonly maxCachedUris = 500) {}
  private readonly clients = new WeakMap<LspClient, ClientDiagnosticState>();
  private readonly states = new Set<ClientDiagnosticState>();

  observe(client: LspClient): void { this.ensure(client); }
  checkpoint(client: LspClient): PushCheckpoint { return this.ensure(client).sequence; }

  invalidate(client?: LspClient, uri?: string): void {
    if (!client) {
      for (const state of this.states) { state.reports.clear(); state.confirmed.clear(); state.pushes.clear(); }
      return;
    }
    const state = this.clients.get(client);
    if (!state) return;
    if (!uri) { state.reports.clear(); state.confirmed.clear(); state.pushes.clear(); return; }
    state.reports.delete(uri);
    state.pushes.delete(uri);
    for (const key of [...state.confirmed.keys()]) if (key.startsWith(`${uri}\0`)) state.confirmed.delete(key);
  }

  async check(client: LspClient, snapshot: DocumentSnapshot, waitMs: number, refresh: boolean, signal?: AbortSignal, checkpoint?: PushCheckpoint): Promise<DiagnosticEvidence> {
    throwIfAborted(signal);
    const state = this.ensure(client);
    const cacheKey = `${snapshot.uri}\0${snapshot.contentHash}`;
    if (!refresh) {
      const cached = state.confirmed.get(cacheKey);
      if (cached) return structuredClone(cached);
    } else {
      state.reports.delete(snapshot.uri);
      for (const key of [...state.confirmed.keys()]) if (key.startsWith(`${snapshot.uri}\0`)) state.confirmed.delete(key);
    }
    try {
      let evidence: DiagnosticEvidence;
      if (client.capabilities?.diagnostics.pull) evidence = await this.pull(client, snapshot, waitMs, signal);
      else {
        const initialEmptyPolicy = isTypeScriptLanguageServer(client.server, client.serverInfo) && client.server.diagnosticPolicy?.acceptUnversionedEmptyAfterOpen === true;
        evidence = await this.waitForPush(state, snapshot, waitMs, signal, client.server.diagnosticPolicy?.settleMs ?? 50, client.server.diagnosticPolicy?.pushFirstMs ?? waitMs, initialEmptyPolicy, checkpoint);
      }
      if ((evidence.state === "clean" || evidence.state === "diagnostics") && !evidence.possiblyStale) this.cacheConfirmed(state, snapshot, evidence);
      return evidence;
    } catch (error) {
      if (error instanceof TimeoutError) return { state: "timed_out", diagnostics: [], message: error.message };
      if (error instanceof CancelledError || (error instanceof Error && error.name === "AbortError")) return { state: "cancelled", diagnostics: [], message: "Cancelled" };
      return { state: "error", diagnostics: [], message: error instanceof Error ? error.message : String(error) };
    }
  }

  async checkWorkspace(client: LspClient, snapshots: DocumentSnapshot[], waitMs: number, refresh: boolean, signal?: AbortSignal): Promise<WorkspaceDiagnosticEvidence> {
    throwIfAborted(signal);
    const state = this.ensure(client);
    if (refresh) { state.reports.clear(); state.confirmed.clear(); }
    const byUri = new Map(snapshots.map((snapshot) => [snapshot.uri, snapshot] as const));
    const previousResultIds = snapshots.flatMap((snapshot) => {
      const previous = state.reports.get(snapshot.uri);
      return previous?.contentHash === snapshot.contentHash ? [{ uri: snapshot.uri, value: previous.resultId }] : [];
    });
    try {
      const report = await client.request<WorkspaceDiagnosticReport>("workspace/diagnostic", { previousResultIds }, signal, waitMs);
      const evidence = new Map<string, DiagnosticEvidence>();
      let omittedReports = 0;
      const processReport = (uri: string, item: DocumentDiagnosticReport, version?: number | null): void => {
        const snapshot = byUri.get(uri);
        if (!snapshot) { omittedReports += 1; return; }
        if (version !== undefined && version !== null && version !== snapshot.version) {
          state.reports.delete(uri);
          evidence.set(uri, { state: "unconfirmed", diagnostics: [], message: `Workspace diagnostic version mismatch: server=${version}, client=${snapshot.version}` });
          return;
        }
        if (item.kind === "unchanged") {
          const previous = state.reports.get(uri);
          if (!item.resultId || !previous || previous.resultId !== item.resultId || previous.contentHash !== snapshot.contentHash) {
            state.reports.delete(uri);
            evidence.set(uri, { state: "unconfirmed", diagnostics: [], message: "Unchanged workspace report has no matching full report" });
          } else evidence.set(uri, { state: previous.diagnostics.length ? "diagnostics" : "clean", diagnostics: structuredClone(previous.diagnostics), resultId: item.resultId });
          return;
        }
        const rawDiagnostics = Array.isArray(item.items) ? item.items : [];
        const diagnostics = rawDiagnostics.slice(0, this.maxDiagnostics);
        const omittedDiagnostics = Math.max(0, rawDiagnostics.length - diagnostics.length);
        if (item.resultId) this.cacheReport(state, uri, { resultId: item.resultId, diagnostics: structuredClone(diagnostics), contentHash: snapshot.contentHash });
        evidence.set(uri, { state: rawDiagnostics.length ? "diagnostics" : "clean", diagnostics, ...(omittedDiagnostics ? { omittedDiagnostics } : {}), ...(item.resultId ? { resultId: item.resultId } : {}) });
      };
      const items = report?.items ?? [];
      const itemLimit = Math.max(snapshots.length, Math.min(snapshots.length + 100, 600));
      omittedReports += Math.max(0, items.length - itemLimit);
      let relatedBudget = 100;
      for (const item of items.slice(0, itemLimit)) {
        processReport(item.uri, item, item.version);
        for (const [uri, related] of Object.entries(item.relatedDocuments ?? {})) {
          if (relatedBudget-- <= 0) { omittedReports += 1; continue; }
          processReport(uri, related);
        }
      }
      for (const snapshot of snapshots) {
        const item = evidence.get(snapshot.uri) ?? { state: "unconfirmed" as const, diagnostics: [], message: "Workspace diagnostic response omitted this file" };
        evidence.set(snapshot.uri, item);
        if ((item.state === "clean" || item.state === "diagnostics") && !item.possiblyStale) this.cacheConfirmed(state, snapshot, item);
      }
      return { evidence, omittedReports };
    } catch (error) {
      const stateName: DiagnosticEvidenceState = error instanceof TimeoutError ? "timed_out" : error instanceof CancelledError || (error instanceof Error && error.name === "AbortError") ? "cancelled" : "error";
      const message = error instanceof Error ? error.message : String(error);
      return { evidence: new Map(snapshots.map((snapshot) => [snapshot.uri, { state: stateName, diagnostics: [], message }])), omittedReports: 0 };
    }
  }

  private async pull(client: LspClient, snapshot: DocumentSnapshot, waitMs: number, signal?: AbortSignal): Promise<DiagnosticEvidence> {
    const state = this.ensure(client);
    const reportKey = snapshot.uri;
    const cached = state.reports.get(reportKey);
    const previous = cached?.contentHash === snapshot.contentHash ? cached : undefined;
    if (cached && !previous) state.reports.delete(reportKey);
    const report = await client.request<DocumentDiagnosticReport>("textDocument/diagnostic", { textDocument: { uri: snapshot.uri }, ...(previous ? { previousResultId: previous.resultId } : {}) }, signal, waitMs);
    if (!report || (report.kind !== "full" && report.kind !== "unchanged")) return { state: "error", diagnostics: [], message: "Malformed diagnostic report" };
    if (report.kind === "unchanged") {
      if (!previous || previous.resultId !== report.resultId) { state.reports.delete(reportKey); return { state: "unconfirmed", diagnostics: [], message: "Unchanged report has no matching full report" }; }
      return { state: previous.diagnostics.length ? "diagnostics" : "clean", diagnostics: structuredClone(previous.diagnostics), resultId: report.resultId };
    }
    const rawDiagnostics = Array.isArray(report.items) ? report.items : [];
    const diagnostics = rawDiagnostics.slice(0, this.maxDiagnostics);
    const omittedDiagnostics = Math.max(0, rawDiagnostics.length - diagnostics.length);
    if (report.resultId) this.cacheReport(state, reportKey, { resultId: report.resultId, diagnostics: structuredClone(diagnostics), contentHash: snapshot.contentHash });
    if (!diagnostics.length && (client.server.diagnosticPolicy?.emptyPullGraceMs ?? 0) > 0) {
      const pushed = await this.waitForPush(this.ensure(client), snapshot, Math.min(waitMs, client.server.diagnosticPolicy!.emptyPullGraceMs!), signal, client.server.diagnosticPolicy?.settleMs ?? 50, client.server.diagnosticPolicy?.pushFirstMs ?? waitMs, false).catch(() => undefined);
      if (pushed?.state === "diagnostics") return pushed;
    }
    return { state: rawDiagnostics.length ? "diagnostics" : "clean", diagnostics, ...(omittedDiagnostics ? { omittedDiagnostics } : {}), ...(report.resultId ? { resultId: report.resultId } : {}) };
  }

  private cacheReport(state: ClientDiagnosticState, uri: string, report: { resultId: string; diagnostics: Diagnostic[]; contentHash: string }): void {
    if (!state.reports.has(uri) && state.reports.size >= this.maxCachedUris) { const oldest = state.reports.keys().next().value as string | undefined; if (oldest) state.reports.delete(oldest); }
    state.reports.delete(uri);
    state.reports.set(uri, report);
  }

  private cacheConfirmed(state: ClientDiagnosticState, snapshot: DocumentSnapshot, evidence: DiagnosticEvidence): void {
    for (const key of [...state.confirmed.keys()]) if (key.startsWith(`${snapshot.uri}\0`)) state.confirmed.delete(key);
    if (state.confirmed.size >= this.maxCachedUris) { const oldest = state.confirmed.keys().next().value as string | undefined; if (oldest) state.confirmed.delete(oldest); }
    state.confirmed.set(`${snapshot.uri}\0${snapshot.contentHash}`, structuredClone(evidence));
  }

  private waitForPush(state: ClientDiagnosticState, snapshot: DocumentSnapshot, waitMs: number, signal: AbortSignal | undefined, settleMs: number, pushFirstMs: number, acceptUnversionedEmptyAfterOpen: boolean, checkpoint?: PushCheckpoint): Promise<DiagnosticEvidence> {
    const relevant = (params: BoundedPublishDiagnostics): boolean => checkpoint === undefined || params.sequence > checkpoint;
    const provisionalEmpty = (params: BoundedPublishDiagnostics): boolean => params.version === undefined && params.diagnostics.length === 0;
    const current = state.pushes.get(snapshot.uri);
    const converted = current && relevant(current) ? evidenceFromPush(current, snapshot, this.maxDiagnostics) : undefined;
    if (converted && converted.state !== "unconfirmed") return Promise.resolve(converted);
    return new Promise((resolve, reject) => {
      const started = Date.now();
      let deadlineTimer: NodeJS.Timeout | undefined;
      let settleTimer: NodeJS.Timeout | undefined;
      let pending = current && relevant(current) && provisionalEmpty(current) ? current : undefined;
      const listeners = state.waiters.get(snapshot.uri) ?? new Set<(params: BoundedPublishDiagnostics) => void>();
      state.waiters.set(snapshot.uri, listeners);
      const deadlineAt = started + waitMs;
      const finish = (value?: BoundedPublishDiagnostics): void => {
        const latest = value ?? pending;
        const policyCandidate = Boolean(latest && acceptUnversionedEmptyAfterOpen && snapshot.syncState === "opened" && checkpoint !== undefined && latest.sequence > checkpoint && provisionalEmpty(latest));
        const policyReadyAt = latest ? Math.max(started + pushFirstMs, latest.receivedAt + settleMs) : Number.POSITIVE_INFINITY;
        const now = Date.now();
        if (policyCandidate && now < policyReadyAt && policyReadyAt <= deadlineAt) {
          if (settleTimer) clearTimeout(settleTimer);
          settleTimer = setTimeout(() => finish(latest), Math.max(1, policyReadyAt - now)); settleTimer.unref?.();
          return;
        }
        cleanup();
        const acceptEmpty = policyCandidate && now >= policyReadyAt;
        resolve(latest ? evidenceFromPush(latest, snapshot, this.maxDiagnostics, acceptEmpty) : { state: "unconfirmed", diagnostics: [], message: "Push server was silent" });
      };
      const schedule = (params: BoundedPublishDiagnostics, isProvisional: boolean): void => {
        pending = params;
        if (settleTimer) clearTimeout(settleTimer);
        const firstGrace = isProvisional ? Math.max(0, Math.min(pushFirstMs, waitMs) - (Date.now() - started)) : 0;
        const delay = Math.min(waitMs, Math.max(settleMs, firstGrace));
        if (delay <= 0) finish(params);
        else { settleTimer = setTimeout(() => finish(pending), delay); settleTimer.unref?.(); }
      };
      const listener = (params: BoundedPublishDiagnostics): void => {
        if (!relevant(params)) return;
        const evidence = evidenceFromPush(params, snapshot, this.maxDiagnostics);
        if (evidence.state === "unconfirmed" && !provisionalEmpty(params)) return;
        schedule(params, provisionalEmpty(params));
      };
      const abort = (): void => { cleanup(); reject(new CancelledError()); };
      const cleanup = (): void => { if (deadlineTimer) clearTimeout(deadlineTimer); if (settleTimer) clearTimeout(settleTimer); listeners.delete(listener); signal?.removeEventListener("abort", abort); };
      listeners.add(listener);
      deadlineTimer = setTimeout(() => finish(), waitMs); deadlineTimer.unref?.();
      if (pending) schedule(pending, true);
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private ensure(client: LspClient): ClientDiagnosticState {
    const existing = this.clients.get(client);
    if (existing) return existing;
    const pushes = new Map<string, BoundedPublishDiagnostics>();
    const waiters = new Map<string, Set<(params: BoundedPublishDiagnostics) => void>>();
    const reports = new Map<string, { resultId: string; diagnostics: Diagnostic[]; contentHash: string }>();
    const confirmed = new Map<string, DiagnosticEvidence>();
    const disposeDiagnostics = client.onDiagnostics((params) => {
      if (params.uri.length > 8_192) return;
      const diagnostics = params.diagnostics.slice(0, this.maxDiagnostics).map(boundDiagnostic);
      state.sequence += 1;
      const bounded: BoundedPublishDiagnostics = { uri: params.uri, ...(params.version !== undefined ? { version: params.version } : {}), diagnostics, sequence: state.sequence, receivedAt: Date.now(), ...(params.diagnostics.length > diagnostics.length ? { omittedDiagnostics: params.diagnostics.length - diagnostics.length } : {}) };
      for (const key of [...confirmed.keys()]) if (key.startsWith(`${params.uri}\0`)) confirmed.delete(key);
      if (!pushes.has(params.uri) && pushes.size >= this.maxCachedUris) { const oldest = pushes.keys().next().value as string | undefined; if (oldest) pushes.delete(oldest); }
      pushes.delete(params.uri); pushes.set(params.uri, bounded);
      for (const waiter of waiters.get(params.uri) ?? []) waiter(bounded);
    });
    const disposeRefresh = client.onDiagnosticRefresh(() => this.invalidate(client));
    let disposed = false;
    let state!: ClientDiagnosticState;
    const disposeStop = client.onStop(() => state.dispose());
    state = { pushes, waiters, reports, confirmed, sequence: 0, dispose: () => {
      if (disposed) return;
      disposed = true;
      disposeDiagnostics(); disposeRefresh(); disposeStop();
      pushes.clear(); waiters.clear(); reports.clear(); confirmed.clear();
      this.clients.delete(client); this.states.delete(state);
    } };
    this.clients.set(client, state);
    this.states.add(state);
    return state;
  }
}

function evidenceFromPush(params: BoundedPublishDiagnostics, snapshot: DocumentSnapshot, maxDiagnostics: number, acceptUnversionedEmpty = false): DiagnosticEvidence {
  if (params.version !== undefined && params.version < snapshot.version) return { state: "unconfirmed", diagnostics: [], message: "Only stale push diagnostics are available" };
  if (params.version !== undefined && params.version > snapshot.version) return { state: "unconfirmed", diagnostics: [], message: "Push diagnostics belong to a newer document version" };
  if (params.version === undefined && params.diagnostics.length === 0) {
    if (acceptUnversionedEmpty) return { state: "clean", diagnostics: [], confirmation: "post_open_server_policy", message: "Clean after a post-open TypeScript diagnostic settling period" };
    return { state: "unconfirmed", diagnostics: [], possiblyStale: true, message: "Unversioned empty publication is provisional" };
  }
  const diagnostics = params.diagnostics.slice(0, maxDiagnostics);
  const omittedDiagnostics = (params.omittedDiagnostics ?? 0) + Math.max(0, params.diagnostics.length - diagnostics.length);
  return { state: params.diagnostics.length || omittedDiagnostics ? "diagnostics" : "clean", diagnostics, ...(omittedDiagnostics ? { omittedDiagnostics } : {}), ...(params.version !== undefined ? { version: params.version, confirmation: "versioned" as const } : { possiblyStale: true }) };
}

function boundDiagnostic(diagnostic: Diagnostic): Diagnostic {
  return {
    range: diagnostic.range,
    message: sanitizeText(diagnostic.message, 4_000),
    ...(diagnostic.severity !== undefined ? { severity: diagnostic.severity } : {}),
    ...(diagnostic.code !== undefined ? { code: typeof diagnostic.code === "object" ? { value: diagnostic.code.value, target: sanitizeText(diagnostic.code.target, 2_000) } : diagnostic.code } : {}),
    ...(diagnostic.codeDescription?.href ? { codeDescription: { href: sanitizeText(diagnostic.codeDescription.href, 2_000) } } : {}),
    ...(diagnostic.source ? { source: sanitizeText(diagnostic.source, 500) } : {}),
    ...(diagnostic.tags ? { tags: diagnostic.tags.slice(0, 10) } : {}),
    ...(diagnostic.relatedInformation ? { relatedInformation: diagnostic.relatedInformation.slice(0, 10).map((item) => ({ location: item.location, message: sanitizeText(item.message, 2_000) })) } : {}),
  };
}
