import { CancellationTokenSource, createMessageConnection, ErrorCodes, NullLogger, ResponseError, StreamMessageWriter, type MessageConnection } from "vscode-jsonrpc/node";
import type { ServerDefinition } from "../config/schema.js";
import type { Limits } from "../runtime/limits.js";
import type { ManagedProcess } from "../runtime/process.js";
import { launchProcess } from "../runtime/process.js";
import type { ResolvedCommand } from "../servers/command.js";
import { CancelledError, TimeoutError, throwIfAborted } from "../util/async.js";
import { sanitizeText } from "../util/text.js";
import type { InitializeResult, NormalizedCapabilities, PublishDiagnosticsParams } from "./types.js";
import { normalizeCapabilities } from "./types.js";
import { BoundedStreamMessageReader } from "./bounded-reader.js";
import { DocumentStore } from "../runtime/document-store.js";
import { filePathToUri } from "../workspace/boundary.js";

export type ClientState = "new" | "starting" | "initializing" | "ready" | "stopping" | "stopped" | "failed";
export interface ClientStatus { server: string; root: string; state: ClientState; pid?: number; activeRequests: number; openDocuments: number; lastUse: number; capabilities?: NormalizedCapabilities; serverInfo?: { name: string; version?: string }; stderr: string; progress: string[]; failure?: string }

export class LspClient {
  state: ClientState = "new";
  capabilities?: NormalizedCapabilities;
  serverInfo?: { name: string; version?: string };
  documents?: DocumentStore;
  lastUse = Date.now();
  activeRequests = 0;
  activeOperations = 0;
  failure?: string;
  readonly progress = new Map<string | number, string>();
  private process: ManagedProcess | undefined;
  private connection: MessageConnection | undefined;
  private shutdownPromise?: Promise<void>;
  private readonly diagnosticListeners = new Set<(params: PublishDiagnosticsParams) => void>();
  private readonly diagnosticRefreshListeners = new Set<() => void>();
  private readonly documentChangeListeners = new Set<(path: string) => void>();
  private readonly stopListeners = new Set<() => void>();
  private stoppedEmitted = false;

  constructor(readonly server: ServerDefinition, readonly root: string, private readonly command: ResolvedCommand, private readonly limits: Limits, private readonly onFatal?: (error: Error) => void) {}

  async start(signal?: AbortSignal): Promise<void> {
    if (this.state === "ready") return;
    if (this.state !== "new") throw new Error(`Cannot start client in state ${this.state}`);
    throwIfAborted(signal);
    this.state = "starting";
    try {
      this.process = launchProcess(this.command, this.root, this.limits.maxStderrBytes);
      this.process.child.once("exit", (code, childSignal) => {
        if (this.state !== "stopping" && this.state !== "stopped") this.failTransport(new Error(`Language server exited (code=${String(code)}, signal=${String(childSignal)})`));
      });
      this.process.child.once("error", (error) => { this.failTransport(error); });
      const reader = new BoundedStreamMessageReader(this.process.child.stdout, {
        maxHeaderBytes: this.limits.maxFrameHeaderBytes,
        maxBodyBytes: this.limits.maxFrameBodyBytes,
      });
      reader.onError((error) => { this.failTransport(error); });
      const writer = new StreamMessageWriter(this.process.child.stdin);
      this.connection = createMessageConnection(reader, writer, NullLogger);
      this.installHandlers(this.connection);
      this.connection.listen();
      this.state = "initializing";
      const result = await this.requestRaw<InitializeResult>("initialize", {
        processId: process.pid,
        clientInfo: { name: "base-lsp", version: "0.1.0" },
        rootUri: filePathToUri(this.root),
        rootPath: this.root,
        workspaceFolders: [{ uri: filePathToUri(this.root), name: this.root.slice(Math.max(this.root.lastIndexOf("/"), this.root.lastIndexOf("\\")) + 1) || this.root }],
        capabilities: clientCapabilities(),
        initializationOptions: this.server.initializationOptions,
      }, this.limits.initializeTimeoutMs, signal);
      const normalized = normalizeCapabilities(result.capabilities ?? {});
      if (!(["utf-8", "utf-16", "utf-32"] as const).includes(normalized.positionEncoding)) throw new Error(`Unsupported position encoding: ${String(normalized.positionEncoding)}`);
      this.capabilities = { ...normalized, ...this.server.capabilityOverrides };
      if (result.serverInfo) this.serverInfo = result.serverInfo;
      await this.notify("initialized", {});
      if (this.server.settings !== undefined) await this.notify("workspace/didChangeConfiguration", { settings: this.server.settings });
      this.documents = new DocumentStore(this.server, this.capabilities, (method, params) => this.notify(method, params), this.limits.maxOpenDocuments, this.limits.maxFileBytes, (path) => { for (const listener of this.documentChangeListeners) listener(path); });
      this.state = "ready";
      this.lastUse = Date.now();
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
      this.state = "failed";
      await this.forceStop("failed");
      throw error;
    }
  }

  retain(): void { this.activeOperations += 1; this.lastUse = Date.now(); }
  release(): void { this.activeOperations = Math.max(0, this.activeOperations - 1); this.lastUse = Date.now(); }

  async request<T>(method: string, params: unknown, signal?: AbortSignal, timeoutMs = this.server.requestTimeoutMs ?? this.limits.requestTimeoutMs): Promise<T> {
    if (this.state !== "ready") throw new Error(`Language server is not ready (${this.state})`);
    this.lastUse = Date.now();
    return this.requestRaw<T>(method, params, timeoutMs, signal);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (!this.connection) throw new Error("Language server connection is unavailable");
    await this.connection.sendNotification(method, params);
  }

  onDiagnostics(listener: (params: PublishDiagnosticsParams) => void): () => void { this.diagnosticListeners.add(listener); return () => this.diagnosticListeners.delete(listener); }
  onDiagnosticRefresh(listener: () => void): () => void { this.diagnosticRefreshListeners.add(listener); return () => this.diagnosticRefreshListeners.delete(listener); }
  /** Fires when a document is synchronized with content this server has not seen before. */
  onDocumentChanged(listener: (path: string) => void): () => void { this.documentChangeListeners.add(listener); return () => this.documentChangeListeners.delete(listener); }
  /**
   * Fires once. A listener registered after the client has already stopped is invoked immediately:
   * the stop it was waiting for has happened, and a listener parked in the cleared set would never
   * run, silently stranding whatever state it was meant to release.
   */
  onStop(listener: () => void): () => void {
    if (this.stoppedEmitted) { listener(); return () => undefined; }
    this.stopListeners.add(listener); return () => this.stopListeners.delete(listener);
  }
  async forceTerminate(): Promise<void> { await this.forceStop("stopped"); }
  status(): ClientStatus {
    return {
      server: this.server.id, root: this.root, state: this.state,
      ...(this.process?.child.pid ? { pid: this.process.child.pid } : {}),
      activeRequests: this.activeRequests, openDocuments: this.documents?.list().length ?? 0, lastUse: this.lastUse,
      ...(this.capabilities ? { capabilities: this.capabilities } : {}),
      ...(this.serverInfo ? { serverInfo: this.serverInfo } : {}),
      stderr: this.process?.stderr() ?? "", progress: [...this.progress.values()].slice(0, 10),
      ...(this.failure ? { failure: sanitizeText(this.failure, 1_000) } : {}),
    };
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.doShutdown();
    return this.shutdownPromise;
  }

  private async requestRaw<T>(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    if (!this.connection) throw new Error("Language server connection is unavailable");
    throwIfAborted(signal);
    this.activeRequests += 1;
    const cancellation = new CancellationTokenSource();
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { cancellation.cancel(); reject(new TimeoutError(`${method} timed out after ${timeoutMs}ms`)); }, timeoutMs); timer.unref?.(); });
    const cancelled = new Promise<never>((_, reject) => {
      if (!signal) return;
      abort = () => { cancellation.cancel(); reject(new CancelledError()); };
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([this.connection.sendRequest<T>(method, params, cancellation.token), deadline, cancelled]);
    } finally {
      this.activeRequests -= 1;
      if (timer) clearTimeout(timer);
      if (abort && signal) signal.removeEventListener("abort", abort);
      cancellation.dispose();
    }
  }

  private installHandlers(connection: MessageConnection): void {
    connection.onNotification("textDocument/publishDiagnostics", (params: PublishDiagnosticsParams) => { for (const listener of this.diagnosticListeners) listener(params); });
    connection.onNotification("$/progress", (params: { token: string | number; value?: { kind?: string; title?: string; message?: string } }) => {
      const value = params.value;
      if (value?.kind === "end") this.progress.delete(params.token);
      else this.progress.set(params.token, sanitizeText(value?.title ?? value?.message ?? "working", 200));
    });
    const refreshDiagnostics = (): void => { for (const listener of this.diagnosticRefreshListeners) listener(); };
    connection.onNotification("workspace/diagnostic/refresh", refreshDiagnostics);
    connection.onRequest(async (method, params: unknown) => {
      if (method === "workspace/diagnostic/refresh") { refreshDiagnostics(); return null; }
      if (method === "workspace/configuration") return this.configurationResponse(params);
      if (method === "workspace/workspaceFolders") return [{ uri: filePathToUri(this.root), name: this.root }];
      if (method === "client/registerCapability" || method === "client/unregisterCapability" || method === "window/workDoneProgress/create") return null;
      if (method === "workspace/applyEdit") return { applied: false, failureReason: "Unsolicited edits are disabled" };
      if (method === "window/showMessageRequest") return null;
      throw new ResponseError(ErrorCodes.MethodNotFound, `Unsupported server request: ${method}`);
    });
    connection.onError((error) => { this.failTransport(error[0] ?? error); });
    connection.onClose(() => { if (this.state !== "stopping" && this.state !== "stopped") this.failTransport(new Error("Language server connection closed")); });
  }

  private configurationResponse(params: unknown): unknown[] {
    const items = (params as { items?: Array<{ section?: string }> } | undefined)?.items ?? [];
    return items.map((item) => {
      if (!item.section) return this.server.settings ?? null;
      return item.section.split(".").reduce<unknown>((value, key) => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined, this.server.workspaceConfiguration ?? this.server.settings) ?? null;
    });
  }

  private async doShutdown(): Promise<void> {
    if (this.state === "stopped") return;
    this.state = "stopping";
    try {
      await this.documents?.closeAll().catch(() => undefined);
      if (this.connection && this.capabilities) {
        await this.requestRaw("shutdown", null, this.limits.shutdownTimeoutMs).catch(() => undefined);
        await this.notify("exit").catch(() => undefined);
      }
    } finally { await this.forceStop("stopped"); }
  }
  private failTransport(error: unknown): void {
    if (this.state === "stopping" || this.state === "stopped" || this.state === "failed") return;
    const previousState = this.state;
    const failure = error instanceof Error ? error : new Error(String(error));
    this.failure = sanitizeText(failure.message, 1_000);
    this.state = "failed";
    if (previousState === "ready") this.onFatal?.(failure);
    try { this.connection?.dispose(); } catch { /* already closed */ }
    this.connection = undefined;
    const process = this.process;
    this.process = undefined;
    this.emitStopped();
    if (process) void process.terminate(0).catch(() => undefined);
  }
  private async forceStop(finalState: ClientState): Promise<void> {
    try { this.connection?.dispose(); } catch { /* already closed */ }
    this.connection = undefined;
    await this.process?.terminate(this.limits.shutdownTimeoutMs).catch(() => undefined);
    this.process = undefined;
    this.state = finalState;
    this.emitStopped();
  }
  private emitStopped(): void {
    if (this.stoppedEmitted) return;
    this.stoppedEmitted = true;
    for (const listener of this.stopListeners) listener();
    this.stopListeners.clear();
    this.diagnosticListeners.clear();
    this.diagnosticRefreshListeners.clear();
  }
}

function clientCapabilities(): Record<string, unknown> {
  return {
    general: { positionEncodings: ["utf-16", "utf-8", "utf-32"] },
    textDocument: {
      synchronization: { dynamicRegistration: false, willSave: false, didSave: true },
      publishDiagnostics: { relatedInformation: true, versionSupport: true, tagSupport: { valueSet: [1, 2] }, codeDescriptionSupport: true, dataSupport: true },
      diagnostic: { dynamicRegistration: false, relatedDocumentSupport: true },
      declaration: { dynamicRegistration: false, linkSupport: true }, definition: { dynamicRegistration: false, linkSupport: true }, typeDefinition: { dynamicRegistration: false, linkSupport: true }, implementation: { dynamicRegistration: false, linkSupport: true },
      references: { dynamicRegistration: false }, hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] }, documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
      callHierarchy: { dynamicRegistration: false }, codeAction: { dynamicRegistration: false, resolveSupport: { properties: ["edit", "command"] }, dataSupport: true }, rename: { dynamicRegistration: false, prepareSupport: true },
    },
    workspace: {
      applyEdit: false, workspaceFolders: true, configuration: true,
      symbol: { dynamicRegistration: false, resolveSupport: { properties: ["location.range"] } },
      diagnostics: { refreshSupport: true },
      workspaceEdit: { documentChanges: true, resourceOperations: [], failureHandling: "abort", normalizesLineEndings: true, changeAnnotationSupport: { groupsOnLabel: true } },
    },
    window: { workDoneProgress: true },
  };
}
