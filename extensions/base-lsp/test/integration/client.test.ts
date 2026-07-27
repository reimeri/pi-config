import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiagnosticService } from "../../src/protocol/diagnostics.js";
import { fakeClient, fakeServer } from "../helpers/fake.js";
import { ClientManager } from "../../src/runtime/client-manager.js";
import { defaultConfig } from "../../src/config/defaults.js";
import type { Route } from "../../src/servers/routing.js";

async function fixture(text = "const ERROR = 1;\n") {
  const root = await mkdtemp(join(tmpdir(), "base-lsp-fake-"));
  await writeFile(join(root, "tsconfig.json"), "{}");
  const path = join(root, "a.ts");
  await writeFile(path, text);
  return { root, path };
}

describe("persistent protocol client", () => {
  it("handles fragmented frames, synchronizes versions, and reuses pull diagnostics", async () => {
    const { root, path } = await fixture();
    const client = await fakeClient(root, { FAKE_LSP_FRAGMENT: "1" });
    const diagnostics = new DiagnosticService();
    try {
      await client.start();
      const first = await client.documents!.sync(path);
      expect(first.version).toBe(1);
      const found = await diagnostics.check(client, first, 1_000, false);
      expect(found.state).toBe("diagnostics");
      expect(found.diagnostics).toHaveLength(1);
      diagnostics.invalidate(client, first.uri);
      const unchanged = await diagnostics.check(client, first, 1_000, false);
      expect(unchanged.state).toBe("diagnostics");
      await writeFile(path, "const fixed = 1;\n");
      const second = await client.documents!.sync(path);
      expect(second.version).toBe(2);
      const clean = await diagnostics.check(client, second, 1_000, false);
      expect(clean.state).toBe("clean");
      const definition = await client.request<any[]>("textDocument/definition", { textDocument: { uri: second.uri }, position: { line: 0, character: 6 } });
      expect(definition[0].targetUri).toBe(second.uri);
    } finally { await client.shutdown(); }
  });

  it("cancels one request without killing the shared server", async () => {
    const { root, path } = await fixture("const value = 1;\n");
    const client = await fakeClient(root, { FAKE_LSP_DELAY_MS: "100", FAKE_LSP_IGNORE_CANCEL: "1" });
    try {
      await client.start();
      const snapshot = await client.documents!.sync(path);
      const controller = new AbortController();
      const request = client.request("textDocument/hover", { textDocument: { uri: snapshot.uri }, position: { line: 0, character: 6 } }, controller.signal);
      setTimeout(() => controller.abort(), 10);
      await expect(request).rejects.toMatchObject({ name: "CancelledError" });
      const hover = await client.request<any>("textDocument/hover", { textDocument: { uri: snapshot.uri }, position: { line: 0, character: 6 } });
      expect(hover.contents.value).toContain("fake hover");
      expect(client.state).toBe("ready");
    } finally { await client.shutdown(); }
  });

  it("treats oversized protocol frames as fatal", async () => {
    const { root } = await fixture();
    const client = await fakeClient(root, { FAKE_LSP_MALFORMED: "1" });
    await expect(client.start()).rejects.toThrow();
    expect(client.state).toBe("failed");
    expect(client.status().pid).toBeUndefined();
  });

  it("deduplicates startup while allowing one waiter to cancel independently", async () => {
    const { root } = await fixture();
    const server = fakeServer({ FAKE_LSP_DELAY_MS: "100" });
    const config = { ...defaultConfig(), servers: { fake: server } };
    const loaded = { config, generation: 1, userPath: join(root, "user.json"), warnings: [], trusted: true, authorized: true };
    const manager = new ClientManager(loaded);
    const route: Route = { server, root, resolution: { root, distance: 0, markerPriority: 0 }, specificity: 1 };
    try {
      const controller = new AbortController();
      const first = manager.acquire(route, controller.signal);
      const second = manager.acquire(route);
      setTimeout(() => controller.abort(), 10);
      await expect(first).rejects.toMatchObject({ name: "CancelledError" });
      expect((await second).state).toBe("ready");
      expect(manager.status()).toHaveLength(1);
    } finally { await manager.shutdown(); }
  });

  it("enforces maxClients across concurrent starts for different server keys", async () => {
    const { root } = await fixture();
    const firstServer = { ...fakeServer({ FAKE_LSP_DELAY_MS: "100" }), id: "fake-one" };
    const secondServer = { ...fakeServer({ FAKE_LSP_DELAY_MS: "100" }), id: "fake-two" };
    const config = { ...defaultConfig(), limits: { ...defaultConfig().limits, maxClients: 1 }, servers: { "fake-one": firstServer, "fake-two": secondServer } };
    const loaded = { config, generation: 1, userPath: join(root, "user.json"), warnings: [], trusted: true, authorized: true };
    const manager = new ClientManager(loaded);
    const route = (server: typeof firstServer): Route => ({ server, root, resolution: { root, distance: 0, markerPriority: 0 }, specificity: 1 });
    try {
      const settled = await Promise.allSettled([manager.acquire(route(firstServer)), manager.acquire(route(secondServer))]);
      expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      expect(settled.filter((item) => item.status === "rejected")).toHaveLength(1);
      expect(manager.status()).toHaveLength(1);
    } finally { await manager.shutdown(); }
  });

  it("prevents an in-flight startup from escaping session shutdown", async () => {
    const { root } = await fixture();
    const server = fakeServer({ FAKE_LSP_DELAY_MS: "200" });
    const config = { ...defaultConfig(), servers: { fake: server } };
    const loaded = { config, generation: 1, userPath: join(root, "user.json"), warnings: [], trusted: true, authorized: true };
    const manager = new ClientManager(loaded);
    const route: Route = { server, root, resolution: { root, distance: 0, markerPriority: 0 }, specificity: 1 };
    const acquisition = manager.acquire(route);
    const rejected = expect(acquisition).rejects.toMatchObject({ name: "CancelledError" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await manager.shutdown();
    await rejected;
    expect(manager.status()).toEqual([]);
  });

  it("cancels an unobserved startup after its sole waiter aborts", async () => {
    const { root } = await fixture();
    const server = fakeServer({ FAKE_LSP_DELAY_MS: "200" });
    const config = { ...defaultConfig(), servers: { fake: server } };
    const loaded = { config, generation: 1, userPath: join(root, "user.json"), warnings: [], trusted: true, authorized: true };
    const manager = new ClientManager(loaded);
    const route: Route = { server, root, resolution: { root, distance: 0, markerPriority: 0 }, specificity: 1 };
    try {
      const controller = new AbortController();
      const acquisition = manager.acquire(route, controller.signal);
      controller.abort();
      await expect(acquisition).rejects.toMatchObject({ name: "CancelledError" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(manager.status()).toEqual([]);
    } finally { await manager.shutdown(); }
  });

  it.skipIf(process.platform === "win32")("kills wrapper descendants after a hung shutdown", async () => {
    const { root } = await fixture();
    const client = await fakeClient(root, { FAKE_LSP_DESCENDANT: "1", FAKE_LSP_HANG_SHUTDOWN: "1", FAKE_LSP_IGNORE_EXIT: "1" });
    await client.start();
    const pid = await waitForDescendant(client);
    await Promise.all([client.shutdown(), client.shutdown()]);
    await expectProcessGone(pid);
  });
});

async function waitForDescendant(client: Awaited<ReturnType<typeof fakeClient>>): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const match = client.status().stderr.match(/DESCENDANT_PID=(\d+)/);
    if (match) return Number(match[1]);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Fake server did not report descendant PID");
}
async function expectProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Descendant process ${pid} survived shutdown`);
}
