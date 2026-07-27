import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
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
