import type { LoadedConfig, ServerDefinition } from "../config/schema.js";
import { LspClient, type ClientStatus } from "../protocol/client.js";
import type { Route } from "../servers/routing.js";
import { resolveServerCommand } from "../servers/command.js";
import { Cooldown } from "./cooldown.js";
import { matchesServerFile } from "../workspace/files.js";
import { isContained } from "../workspace/boundary.js";
import { AsyncMutex, CancelledError, throwIfAborted, withDeadline } from "../util/async.js";

interface Startup {
  promise: Promise<LspClient>;
  controller: AbortController;
  waiters: number;
}

export class ClientManager {
  private readonly clients = new Map<string, LspClient>();
  private readonly startups = new Map<string, Startup>();
  private readonly cooldowns = new Map<string, Cooldown>();
  private readonly clientSlotMutex = new AsyncMutex();
  private idleTimer: NodeJS.Timeout | undefined;
  private closing = false;

  constructor(readonly loaded: LoadedConfig) {
    this.idleTimer = setInterval(() => { void this.stopIdle(); }, Math.min(30_000, Math.max(1_000, loaded.config.limits.idleClientMs / 4)));
    this.idleTimer.unref?.();
  }

  async acquire(route: Route, signal?: AbortSignal): Promise<LspClient> {
    if (this.closing) throw new Error("LSP manager is shutting down");
    if (!this.loaded.authorized) throw Object.assign(new Error("Project is untrusted; trust it and restart before starting language servers"), { code: "UNTRUSTED" });
    const key = this.key(route.server, route.root);
    const existing = this.clients.get(key);
    if (existing?.state === "ready") { existing.retain(); return existing; }
    let startup = this.startups.get(key);
    if (!startup) {
      const cooldown = this.cooldowns.get(key) ?? new Cooldown();
      this.cooldowns.set(key, cooldown);
      if (cooldown.active) throw new Error(`Language server ${route.server.id} is cooling down until ${new Date(cooldown.cooldownUntil).toISOString()}`);
      const controller = new AbortController();
      startup = { controller, waiters: 0, promise: Promise.resolve(undefined as never) };
      startup.promise = this.start(route, key, cooldown, controller.signal).finally(() => {
        if (this.startups.get(key) === startup) this.startups.delete(key);
      });
      this.startups.set(key, startup);
    }
    startup.waiters += 1;
    try { const client = await awaitWithSignal(startup.promise, signal); client.retain(); return client; }
    finally {
      startup.waiters -= 1;
      if (startup.waiters === 0 && this.startups.get(key) === startup) startup.controller.abort();
    }
  }

  status(): ClientStatus[] { return [...this.clients.values()].map((client) => client.status()).sort((a, b) => a.server.localeCompare(b.server) || a.root.localeCompare(b.root)); }
  getActiveClients(): LspClient[] { return [...this.clients.values()].filter((client) => client.state === "ready"); }
  release(client: LspClient): void { client.release(); }

  async stop(serverId?: string): Promise<number> {
    const selected = [...this.clients.entries()].filter(([, client]) => !serverId || client.server.id === serverId);
    const startups = [...this.startups.entries()].filter(([key]) => !serverId || key.includes(`\0${serverId}\0`));
    for (const [, startup] of startups) startup.controller.abort();
    await Promise.allSettled(startups.map(([, startup]) => startup.promise));
    await Promise.all(selected.map(async ([key, client]) => { this.clients.delete(key); await client.shutdown(); }));
    return selected.length + startups.length;
  }
  async restart(serverId?: string): Promise<number> {
    for (const [key, cooldown] of this.cooldowns) if (!serverId || key.includes(`\0${serverId}\0`)) cooldown.reset();
    return this.stop(serverId);
  }

  async syncActiveFile(filePath: string, signal?: AbortSignal, saved = false): Promise<void> {
    for (const client of this.getActiveClients()) {
      if (!isContained(client.root, filePath) || !matchesServerFile(client.server, filePath)) continue;
      client.retain();
      try {
        if (saved) await client.documents?.syncAndSave(filePath, signal).catch(() => undefined);
        else await client.documents?.sync(filePath, signal).catch(() => undefined);
      } finally { client.release(); }
    }
  }

  async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = undefined;
    const startups = [...this.startups.values()];
    for (const startup of startups) startup.controller.abort();
    await Promise.allSettled(startups.map((startup) => startup.promise));
    const clients = [...this.clients.values()];
    this.clients.clear();
    const graceful = Promise.allSettled(clients.map((client) => client.shutdown())).then(() => undefined);
    try {
      await withDeadline(graceful, Math.max(5_000, this.loaded.config.limits.shutdownTimeoutMs * 2), undefined, "LSP manager shutdown");
    } catch {
      await Promise.allSettled(clients.map((client) => client.forceTerminate()));
    }
  }

  private async start(route: Route, key: string, cooldown: Cooldown, signal: AbortSignal): Promise<LspClient> {
    this.assertStarting(signal);
    const command = await resolveServerCommand(route.server);
    this.assertStarting(signal);
    if (!command) throw Object.assign(new Error(`Language server command not found: ${route.server.command[0]}${route.server.installationHint ? `. ${route.server.installationHint}` : ""}`), { code: "UNAVAILABLE" });
    const client = new LspClient(route.server, route.root, command, this.loaded.config.limits, () => cooldown.fail());
    await this.clientSlotMutex.run(async () => {
      this.assertStarting(signal);
      await this.evictIfNeeded();
      this.assertStarting(signal);
      this.clients.set(key, client);
    });
    try {
      await client.start(signal);
      this.assertStarting(signal);
      cooldown.succeed();
      return client;
    } catch (error) {
      if (!(error instanceof CancelledError)) cooldown.fail();
      this.clients.delete(key);
      await client.forceTerminate();
      throw error;
    }
  }
  private assertStarting(signal: AbortSignal): void {
    throwIfAborted(signal);
    if (this.closing) throw new CancelledError("LSP manager is shutting down");
  }
  private async evictIfNeeded(): Promise<void> {
    if (this.clients.size < this.loaded.config.limits.maxClients) return;
    const candidate = [...this.clients.entries()].filter(([, client]) => client.state === "ready" && client.activeRequests === 0 && client.activeOperations === 0).sort((a, b) => a[1].lastUse - b[1].lastUse)[0];
    if (!candidate) throw new Error("Maximum LSP clients reached and no idle client can be evicted");
    this.clients.delete(candidate[0]);
    await candidate[1].shutdown();
  }
  private async stopIdle(): Promise<void> {
    if (this.closing) return;
    const cutoff = Date.now() - this.loaded.config.limits.idleClientMs;
    const selected = [...this.clients.entries()].filter(([, client]) => client.state === "ready" && client.activeRequests === 0 && client.activeOperations === 0 && client.lastUse < cutoff);
    await Promise.all(selected.map(async ([key, client]) => { this.clients.delete(key); await client.shutdown(); }));
  }
  private key(server: ServerDefinition, root: string): string { return `${this.loaded.generation}\0${server.id}\0${root}`; }
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new CancelledError());
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new CancelledError());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
