import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiagnosticService } from "../../src/protocol/diagnostics.js";
import { fakeClient } from "../helpers/fake.js";

async function fixture(text: string) {
  const root = await mkdtemp(join(tmpdir(), "base-lsp-diagnostics-"));
  await writeFile(join(root, "tsconfig.json"), "{}");
  const path = join(root, "a.ts");
  await writeFile(path, text);
  return { root, path };
}

describe("truthful diagnostics", () => {
  it("reuses full evidence for unchanged workspace reports", async () => {
    const { root, path } = await fixture("const ERROR = 1;\n");
    const client = await fakeClient(root);
    const service = new DiagnosticService();
    try {
      await client.start();
      const snapshot = await client.documents!.sync(path);
      const first = await service.checkWorkspace(client, [snapshot], 1_000, false);
      expect(first.evidence.get(snapshot.uri)?.state).toBe("diagnostics");
      const unchanged = await service.checkWorkspace(client, [snapshot], 1_000, false);
      expect(unchanged.evidence.get(snapshot.uri)?.state).toBe("diagnostics");
      expect(unchanged.evidence.get(snapshot.uri)?.diagnostics).toHaveLength(1);
    } finally { await client.shutdown(); }
  });

  it("rejects stale versioned workspace reports and counts unrelated reports", async () => {
    const { root, path } = await fixture("const ERROR = 1;\n");
    const client = await fakeClient(root, { FAKE_LSP_WORKSPACE_VERSION_OFFSET: "-1", FAKE_LSP_EXTRA_WORKSPACE: "1" });
    const service = new DiagnosticService();
    try {
      await client.start();
      const snapshot = await client.documents!.sync(path);
      const result = await service.checkWorkspace(client, [snapshot], 1_000, false);
      expect(result.evidence.get(snapshot.uri)?.state).toBe("unconfirmed");
      expect(result.evidence.get(snapshot.uri)?.message).toMatch(/version mismatch/);
      expect(result.omittedReports).toBe(1);
    } finally { await client.shutdown(); }
  });

  it("bounds diagnostics before caching workspace reports", async () => {
    const { root, path } = await fixture("const ERROR = 1;\n");
    const client = await fakeClient(root, { FAKE_LSP_MANY_DIAGNOSTICS: "2000" });
    const service = new DiagnosticService(10);
    try {
      await client.start();
      const snapshot = await client.documents!.sync(path);
      const result = await service.checkWorkspace(client, [snapshot], 1_000, false);
      expect(result.evidence.get(snapshot.uri)?.diagnostics).toHaveLength(10);
      expect(result.evidence.get(snapshot.uri)?.omittedDiagnostics).toBe(1_990);
    } finally { await client.shutdown(); }
  });

  it("bounds pull and confirmed caches by URI and replaces old content hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-lsp-diagnostic-cache-")); await writeFile(join(root, "tsconfig.json"), "{}");
    const paths = ["a.ts", "b.ts", "c.ts"].map((name) => join(root, name)); await Promise.all(paths.map((path) => writeFile(path, "const ERROR = 1;\n")));
    const client = await fakeClient(root); const service = new DiagnosticService(10, 2);
    try {
      await client.start();
      for (const path of paths) { const snapshot = await client.documents!.sync(path); await service.check(client, snapshot, 1_000, false); }
      await writeFile(paths[2]!, "const fixed = 1;\n"); const changed = await client.documents!.sync(paths[2]!); await service.check(client, changed, 1_000, false);
      const state = [...(service as any).states][0];
      expect(state.reports.size).toBeLessThanOrEqual(2); expect(state.confirmed.size).toBeLessThanOrEqual(2);
      expect([...state.confirmed.keys()].filter((key: string) => key.startsWith(`${changed.uri}\0`))).toHaveLength(1);
    } finally { await client.shutdown(); }
  });

  it("does not turn an unmatched unchanged report into clean", async () => {
    const { root, path } = await fixture("const value = 1;\n");
    const client = await fakeClient(root, { FAKE_LSP_FORCE_UNCHANGED: "1" });
    const service = new DiagnosticService();
    try {
      await client.start();
      const snapshot = await client.documents!.sync(path);
      const result = await service.check(client, snapshot, 1_000, true);
      expect(result.state).toBe("unconfirmed");
    } finally { await client.shutdown(); }
  });

  it("cancels every pending waiter in a push batch", async () => {
    const { root, path } = await fixture("const first = 1;\n");
    const second = join(root, "b.ts"); const third = join(root, "c.ts");
    await writeFile(second, "const second = 2;\n"); await writeFile(third, "const third = 3;\n");
    const client = await fakeClient(root, { FAKE_LSP_NO_PULL: "1" });
    const service = new DiagnosticService();
    try {
      await client.start(); service.observe(client);
      const checkpoint = service.checkpoint(client);
      const snapshots = await Promise.all([path, second, third].map((file) => client.documents!.sync(file)));
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);
      const started = Date.now();
      const result = await service.checkPushBatch(client, snapshots, Date.now() + 1_000, true, controller.signal, checkpoint);
      expect(Date.now() - started).toBeLessThan(300);
      expect([...result.values()].every((evidence) => evidence.state === "cancelled")).toBe(true);
    } finally { await client.shutdown(); }
  });

  it("distinguishes silent and provisional unversioned empty push results", async () => {
    const silentFixture = await fixture("const value = 1;\n");
    const silent = await fakeClient(silentFixture.root);
    const service = new DiagnosticService();
    try {
      await silent.start();
      silent.capabilities!.diagnostics = { pull: false, workspace: false };
      service.observe(silent);
      const snapshot = await silent.documents!.sync(silentFixture.path);
      expect((await service.check(silent, snapshot, 30, true)).state).toBe("unconfirmed");
    } finally { await silent.shutdown(); }

    const pushFixture = await fixture("const value = 1;\n");
    const push = await fakeClient(pushFixture.root, { FAKE_LSP_PUSH: "1", FAKE_LSP_UNVERSIONED: "1" });
    try {
      await push.start();
      push.capabilities!.diagnostics = { pull: false, workspace: false };
      service.observe(push);
      const snapshot = await push.documents!.sync(pushFixture.path);
      const result = await service.check(push, snapshot, 50, true);
      expect(result.state).toBe("unconfirmed");
      expect(result.possiblyStale).toBe(true);
    } finally { await push.shutdown(); }
  });

  it("uses and caches affirmative synchronous TypeScript diagnostics without the push grace", async () => {
    const { root, path } = await fixture("const ERROR = 1;\n");
    const executeLog = join(root, "execute.log");
    const client = await fakeClient(root, {
      FAKE_LSP_NO_PULL: "1",
      FAKE_LSP_TS_REQUEST: "1",
      FAKE_LSP_SERVER_NAME: "typescript-language-server",
      FAKE_LSP_EXECUTE_LOG: executeLog,
    }, { id: "typescript", diagnosticPolicy: { pushFirstMs: 10_000, settleMs: 5, acceptUnversionedEmptyAfterOpen: true } });
    const service = new DiagnosticService();
    try {
      await client.start(); service.observe(client);
      const checkpoint = service.checkpoint(client);
      const snapshot = await client.documents!.sync(path);
      const started = Date.now();
      const result = (await service.checkPushBatch(client, [snapshot], Date.now() + 1_000, true, undefined, checkpoint)).get(snapshot.uri)!;
      expect(Date.now() - started).toBeLessThan(500);
      expect(result).toMatchObject({ state: "diagnostics", confirmation: "typescript_tsserver_request" });
      expect(result.diagnostics[0]).toMatchObject({ message: "fake tsserver semantic error", code: 9001, range: { start: { line: 0, character: 6 } } });

      const cached = (await service.checkPushBatch(client, [snapshot], Date.now() + 100, false, undefined, service.checkpoint(client))).get(snapshot.uri)!;
      expect(cached).toMatchObject({ state: "diagnostics", confirmation: "typescript_tsserver_request" });
      expect((await readFile(executeLog, "utf8")).trim().split("\n")).toHaveLength(3);

      const refreshed = (await service.checkPushBatch(client, [snapshot], Date.now() + 1_000, true, undefined, service.checkpoint(client))).get(snapshot.uri)!;
      expect(refreshed).toMatchObject({ state: "diagnostics", confirmation: "typescript_tsserver_request" });
      expect((await readFile(executeLog, "utf8")).trim().split("\n")).toHaveLength(6);

      const aborted = new AbortController(); aborted.abort();
      await expect(service.checkPushBatch(client, [snapshot], Date.now() + 1_000, false, aborted.signal, service.checkpoint(client))).rejects.toThrow(/cancel/i);
    } finally { await client.shutdown(); }
  });

  it("drops confirmed evidence when a dependency reaches the server with new content", async () => {
    const { root, path } = await fixture("const ERROR = 1;\n");
    const dependency = join(root, "dependency.ts");
    await writeFile(dependency, "export const value = 1;\n");
    const executeLog = join(root, "execute.log");
    const client = await fakeClient(root, {
      FAKE_LSP_NO_PULL: "1",
      FAKE_LSP_TS_REQUEST: "1",
      FAKE_LSP_SERVER_NAME: "typescript-language-server",
      FAKE_LSP_EXECUTE_LOG: executeLog,
    }, { id: "typescript", diagnosticPolicy: { pushFirstMs: 10_000, settleMs: 5, acceptUnversionedEmptyAfterOpen: true } });
    const service = new DiagnosticService();
    const requestCount = async (): Promise<number> => (await readFile(executeLog, "utf8")).trim().split("\n").filter(Boolean).length;
    try {
      await client.start(); service.observe(client);
      await client.documents!.sync(dependency);
      const snapshot = await client.documents!.sync(path);
      await service.checkPushBatch(client, [snapshot], Date.now() + 1_000, true, undefined, service.checkpoint(client));
      expect(await requestCount()).toBe(3);

      // An unchanged reopen is not an edit, so cache survives eviction.
      await client.documents!.close(path);
      const reopened = await client.documents!.sync(path);
      const cached = (await service.checkPushBatch(client, [reopened], Date.now() + 1_000, false, undefined, service.checkpoint(client))).get(reopened.uri)!;
      expect(cached).toMatchObject({ state: "diagnostics", confirmation: "typescript_tsserver_request" });
      expect(await requestCount()).toBe(3);

      // Changes in another file can invalidate this file's diagnostics.
      await writeFile(dependency, "export const value = \"two\";\n");
      await client.documents!.sync(dependency);
      const rechecked = (await service.checkPushBatch(client, [reopened], Date.now() + 1_000, false, undefined, service.checkpoint(client))).get(reopened.uri)!;
      expect(rechecked).toMatchObject({ state: "diagnostics", confirmation: "typescript_tsserver_request" });
      expect(await requestCount()).toBe(6);
    } finally { await client.shutdown(); }
  });

  it("preserves completed TypeScript evidence when another file consumes the shared deadline", async () => {
    const { root, path } = await fixture("const ERROR = 1;\n");
    const second = join(root, "second.ts"); const hung = join(root, "hung.ts");
    await writeFile(second, "const value = 1;\n"); await writeFile(hung, "const waiting = 1;\n");
    const client = await fakeClient(root, {
      FAKE_LSP_NO_PULL: "1",
      FAKE_LSP_TS_REQUEST: "1",
      FAKE_LSP_TS_REQUEST_HANG_URI_SUFFIX: "hung.ts",
      FAKE_LSP_SERVER_NAME: "typescript-language-server",
    }, { id: "typescript" });
    const service = new DiagnosticService();
    try {
      await client.start(); service.observe(client);
      const checkpoint = service.checkpoint(client);
      const snapshots = await Promise.all([path, second, hung].map((file) => client.documents!.sync(file)));
      const result = await service.checkPushBatch(client, snapshots, Date.now() + 100, true, undefined, checkpoint);
      expect(result.get(snapshots[0]!.uri)).toMatchObject({ state: "diagnostics", confirmation: "typescript_tsserver_request" });
      expect(result.get(snapshots[1]!.uri)).toMatchObject({ state: "clean", confirmation: "typescript_tsserver_request" });
      expect(result.get(snapshots[2]!.uri)?.state).toBe("timed_out");
    } finally { await client.shutdown(); }
  });

  it("preserves completed TypeScript evidence when a sibling is cancelled", async () => {
    const { root, path } = await fixture("const ERROR = 1;\n");
    const hung = join(root, "hung.ts"); await writeFile(hung, "const waiting = 1;\n");
    const client = await fakeClient(root, {
      FAKE_LSP_NO_PULL: "1",
      FAKE_LSP_TS_REQUEST: "1",
      FAKE_LSP_TS_REQUEST_HANG_URI_SUFFIX: "hung.ts",
      FAKE_LSP_SERVER_NAME: "typescript-language-server",
    }, { id: "typescript" });
    const service = new DiagnosticService();
    try {
      await client.start(); service.observe(client);
      const checkpoint = service.checkpoint(client);
      const snapshots = await Promise.all([path, hung].map((file) => client.documents!.sync(file)));
      const controller = new AbortController(); setTimeout(() => controller.abort(), 100);
      const result = await service.checkPushBatch(client, snapshots, Date.now() + 1_000, true, controller.signal, checkpoint);
      expect(result.get(snapshots[0]!.uri)).toMatchObject({ state: "diagnostics", confirmation: "typescript_tsserver_request" });
      expect(result.get(snapshots[1]!.uri)?.state).toBe("cancelled");
    } finally { await client.shutdown(); }
  });

  it.each([
    ["malformed", { FAKE_LSP_TS_REQUEST_MALFORMED: "1" }],
    ["rejected", { FAKE_LSP_TS_REQUEST_REJECT: "1" }],
  ])("falls back truthfully to push evidence when a TypeScript diagnostic response is %s", async (_label, failureEnv) => {
    const { root, path } = await fixture("const value = 1;\n");
    const client = await fakeClient(root, {
      FAKE_LSP_NO_PULL: "1",
      FAKE_LSP_PUSH: "1",
      FAKE_LSP_UNVERSIONED: "1",
      FAKE_LSP_TS_REQUEST: "1",
      ...failureEnv,
      FAKE_LSP_SERVER_NAME: "typescript-language-server",
    }, { id: "typescript", diagnosticPolicy: { pushFirstMs: 20, settleMs: 5, acceptUnversionedEmptyAfterOpen: true } });
    const service = new DiagnosticService();
    try {
      await client.start(); service.observe(client);
      const checkpoint = service.checkpoint(client);
      const snapshot = await client.documents!.sync(path);
      const result = (await service.checkPushBatch(client, [snapshot], Date.now() + 500, true, undefined, checkpoint)).get(snapshot.uri)!;
      expect(result).toMatchObject({ state: "clean", confirmation: "post_open_server_policy" });
    } finally { await client.shutdown(); }
  });

  it("confirms only an initial post-open unversioned empty under an explicit server policy", async () => {
    const { root, path } = await fixture("const value = 1;\n");
    const client = await fakeClient(root, { FAKE_LSP_PUSH: "1", FAKE_LSP_UNVERSIONED: "1", FAKE_LSP_SERVER_NAME: "typescript-language-server" }, { id: "typescript", diagnosticPolicy: { pushFirstMs: 20, settleMs: 5, acceptUnversionedEmptyAfterOpen: true } });
    const service = new DiagnosticService();
    try {
      await client.start();
      client.capabilities!.diagnostics = { pull: false, workspace: false };
      service.observe(client);
      const checkpoint = service.checkpoint(client);
      const snapshot = await client.documents!.sync(path);
      const initial = await service.check(client, snapshot, 100, true, undefined, checkpoint);
      expect(initial).toMatchObject({ state: "clean", confirmation: "post_open_server_policy" });

      await writeFile(path, "const changed = 2;\n");
      const changedCheckpoint = service.checkpoint(client);
      const changed = await client.documents!.sync(path);
      const afterChange = await service.check(client, changed, 100, true, undefined, changedCheckpoint);
      expect(afterChange.state).toBe("unconfirmed");
    } finally { await client.shutdown(); }
  });

  it("does not accept an initial empty before the full policy grace", async () => {
    const { root, path } = await fixture("const value = 1;\n");
    const client = await fakeClient(root, { FAKE_LSP_PUSH: "1", FAKE_LSP_UNVERSIONED: "1", FAKE_LSP_SERVER_NAME: "typescript-language-server" }, { id: "typescript", diagnosticPolicy: { pushFirstMs: 100, settleMs: 5, acceptUnversionedEmptyAfterOpen: true } });
    const service = new DiagnosticService();
    try {
      await client.start(); client.capabilities!.diagnostics = { pull: false, workspace: false }; service.observe(client);
      const checkpoint = service.checkpoint(client); const snapshot = await client.documents!.sync(path);
      const result = await service.check(client, snapshot, 20, true, undefined, checkpoint);
      expect(result.state).toBe("unconfirmed");
    } finally { await client.shutdown(); }
  });

  it("invalidates cached initial clean evidence when a later publication adds findings", async () => {
    const { root, path } = await fixture("const value = 1;\n");
    const client = await fakeClient(root, { FAKE_LSP_PUSH: "1", FAKE_LSP_UNVERSIONED: "1", FAKE_LSP_SERVER_NAME: "typescript-language-server", FAKE_LSP_PUSH_SECOND_ERROR_DELAY_MS: "60" }, { id: "typescript", diagnosticPolicy: { pushFirstMs: 20, settleMs: 5, acceptUnversionedEmptyAfterOpen: true } });
    const service = new DiagnosticService();
    try {
      await client.start(); client.capabilities!.diagnostics = { pull: false, workspace: false }; service.observe(client);
      const checkpoint = service.checkpoint(client); const snapshot = await client.documents!.sync(path);
      expect((await service.check(client, snapshot, 40, true, undefined, checkpoint)).state).toBe("clean");
      await new Promise((resolve) => setTimeout(resolve, 80));
      const current = await service.check(client, { ...snapshot, syncState: "unchanged" }, 50, false);
      expect(current.state).toBe("diagnostics");
      expect(current.diagnostics[0]?.message).toContain("delayed semantic error");
    } finally { await client.shutdown(); }
  });

  it("accepts a versioned publication that predates the checkpoint instead of stalling", async () => {
    const { root, path } = await fixture("const ERROR = 1;\n");
    const client = await fakeClient(root, { FAKE_LSP_PUSH: "1" });
    const service = new DiagnosticService();
    try {
      await client.start();
      client.capabilities!.diagnostics = { pull: false, workspace: false };
      service.observe(client);
      // Checkpoint after the earlier publication so the next call does not await it.
      await client.documents!.sync(path);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const checkpoint = service.checkpoint(client);
      const snapshot = await client.documents!.sync(path);
      expect(snapshot.syncState).toBe("unchanged");
      const started = Date.now();
      const result = await service.check(client, snapshot, 2_000, false, undefined, checkpoint);
      expect(result.state).toBe("diagnostics");
      expect(result.confirmation).toBe("versioned");
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally { await client.shutdown(); }
  });

  it("still requires an unversioned publication to postdate the checkpoint", async () => {
    const { root, path } = await fixture("const ERROR = 1;\n");
    const client = await fakeClient(root, { FAKE_LSP_PUSH: "1", FAKE_LSP_UNVERSIONED: "1" });
    const service = new DiagnosticService();
    try {
      await client.start();
      client.capabilities!.diagnostics = { pull: false, workspace: false };
      service.observe(client);
      await client.documents!.sync(path);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const checkpoint = service.checkpoint(client);
      const snapshot = await client.documents!.sync(path);
      const result = await service.check(client, snapshot, 50, true, undefined, checkpoint);
      expect(result.state).toBe("unconfirmed");
    } finally { await client.shutdown(); }
  });

  it("returns unversioned non-empty push findings as possibly stale", async () => {
    const { root, path } = await fixture("const ERROR = 1;\n");
    const client = await fakeClient(root, { FAKE_LSP_PUSH: "1", FAKE_LSP_UNVERSIONED: "1" });
    const service = new DiagnosticService();
    try {
      await client.start();
      client.capabilities!.diagnostics = { pull: false, workspace: false };
      service.observe(client);
      const snapshot = await client.documents!.sync(path);
      const result = await service.check(client, snapshot, 100, true);
      expect(result.state).toBe("diagnostics");
      expect(result.possiblyStale).toBe(true);
    } finally { await client.shutdown(); }
  });
});
