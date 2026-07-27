import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renameSchema, type RenameInput } from "./schemas.js";
import type { RuntimeGetter } from "./context.js";
import { acquireSource } from "./context.js";
import { baseDetails, envelope, rethrowUnexpected, statusFromError } from "./results.js";
import type { Range, WorkspaceEdit } from "../protocol/types.js";
import { normalizeWorkspaceEdit, type EditManifest } from "../workspace/edits.js";
import { renderManifest } from "../workspace/diff.js";
import { applyManifest } from "../workspace/transaction.js";
import { stableHash } from "../util/text.js";
import { sleep } from "../util/async.js";
import { relative } from "node:path";

/**
 * Number of rename responses collected while confirming stability. A language server that is still
 * loading a project answers from a partial index and can return an edit covering only the file the
 * request was made against, which would silently publish a half-finished refactor. Two consecutive
 * identical responses are required before an edit is considered applicable; the third attempt gives
 * one bounded retry when the first pair disagrees.
 */
const RENAME_STABILITY_ATTEMPTS = 3;

interface RenameAttempt { manifest: EditManifest; renameId: string; stable: boolean; attempts: number }

export function registerRenameTool(pi: ExtensionAPI, getRuntime: RuntimeGetter): void {
  pi.registerTool({ name: "lsp_rename", label: "LSP Rename", description: "Preview or safely apply semantic multi-file rename. Apply requires the renameId from a prior preview and a fresh exact server response.", promptSnippet: "Preview or apply a safe semantic symbol rename", promptGuidelines: ["Use lsp_rename with apply omitted first and review every affected file before applying its renameId."], parameters: renameSchema,
    async execute(_id, params: RenameInput, signal) {
      const started = Date.now(); const runtime = getRuntime();
      if (!runtime.loaded.authorized) return envelope("LSP startup refused because the project is untrusted.", { ...baseDetails("rename", "untrusted", started) });
      try {
        if (params.apply && !params.renameId) throw new Error("apply requires renameId from a prior preview");
        if (params.apply && !runtime.previewRenames.has(params.renameId!)) throw new Error("renameId was not previewed in this session");
        const source = await acquireSource(runtime, { path: params.path, line: params.line, ...(params.character ? { character: params.character } : {}), ...(params.symbol ? { symbol: params.symbol } : {}), ...(params.server ? { server: params.server } : {}), ...(params.root ? { root: params.root } : {}) }, signal);
        try {
        if (!source.client.capabilities?.rename) return envelope("Rename unsupported.", { ...baseDetails("rename", "unsupported", started), server: source.route.server.id, root: source.route.root });
        const phase = await source.withDocument(async (): Promise<RenameAttempt | undefined> => {
          if (source.client.capabilities!.prepareRename) {
            const prepared = await source.client.request<Range | { range: Range; placeholder?: string } | null>("textDocument/prepareRename", { textDocument: { uri: source.snapshot.uri }, position: source.position }, signal);
            if (!prepared) return undefined;
          }
          const requestRename = async (): Promise<{ manifest: EditManifest; renameId: string }> => {
            const edit = await source.client.request<WorkspaceEdit | null>("textDocument/rename", { textDocument: { uri: source.snapshot.uri }, position: source.position, newName: params.newName }, signal);
            const documents = source.client.documents!.list();
            const documentVersions = new Map(documents.map((document) => [document.uri, document.version] as const));
            const documentSnapshots = new Map(documents.map((document) => [document.uri, document] as const));
            const manifest = await normalizeWorkspaceEdit(edit, runtime.boundary, source.client.capabilities!.positionEncoding, runtime.loaded.config.limits, documentVersions, documentSnapshots);
            const renameId = stableHash({ server: source.route.server.id, root: source.route.root, hash: source.snapshot.contentHash, newName: params.newName, edit: manifest.fingerprint });
            return { manifest, renameId };
          };
          let latest = await requestRename();
          for (let attempt = 2; attempt <= RENAME_STABILITY_ATTEMPTS; attempt += 1) {
            await sleep(runtime.loaded.config.limits.mutationSettleMs, signal);
            const next = await requestRename();
            if (next.renameId === latest.renameId) return { ...next, stable: true, attempts: attempt };
            latest = next;
          }
          return { ...latest, stable: false, attempts: RENAME_STABILITY_ATTEMPTS };
        });
        if (!phase) return envelope("Server rejected rename at this position.", { ...baseDetails("rename", "no_results", started), server: source.route.server.id, root: source.route.root });
        const { manifest, renameId, stable, attempts } = phase;
        const unstableReason = `Server rename responses were still changing after ${attempts} attempts; the project is probably still loading. Preview again once indexing has settled.`;
        if (params.apply) {
          if (!stable) throw new Error(unstableReason);
          if (renameId !== params.renameId) throw new Error("Fresh rename response does not match the previewed renameId");
          const changed = await applyManifest(manifest, signal); for (const path of changed) { runtime.changed.add(path); await runtime.manager.syncActiveFile(path, signal, true); }
          return envelope(`Renamed symbol to ${params.newName} in ${changed.length} file(s).`, { ...baseDetails("rename", "ok", started), server: source.route.server.id, root: source.route.root, renameId, applied: true, changed, stable, attempts });
        }
        const applicable = manifest.applicable && stable;
        const reasons = stable ? manifest.reasons : [...manifest.reasons, unstableReason];
        if (applicable) runtime.previewRenames.add(renameId);
        const preview = renderManifest(manifest, 40_000, source.route.root);
        const status = !stable ? "partial" : manifest.files.length ? "ok" : "no_results";
        return envelope(`renameId: ${renameId}\n${stable ? "" : `${unstableReason}\n`}${preview.text}`, { ...baseDetails("rename", status, started), server: source.route.server.id, root: source.route.root, renameId, applicable, reasons, files: manifest.files.map((file) => ({ path: relative(source.route.root, file.path) || ".", edits: file.edits })), totalEdits: manifest.totalEdits, preview: preview.text, truncated: preview.truncated, stable, attempts, possiblyIncomplete: source.client.progress.size > 0, warnings: stable ? [] : [unstableReason] });
        } finally { source.release(); }
      } catch (error) { rethrowUnexpected(error); return envelope(error instanceof Error ? error.message : String(error), { ...baseDetails("rename", statusFromError(error), started) }); }
    } });
}
