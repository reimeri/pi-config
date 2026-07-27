import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { codeActionsSchema, type CodeActionsInput } from "./schemas.js";
import type { RuntimeGetter } from "./context.js";
import { acquireSource } from "./context.js";
import { baseDetails, envelope, rethrowUnexpected, statusFromError } from "./results.js";
import type { CodeAction, Command } from "../protocol/types.js";
import { publicToServerPosition } from "../protocol/positions.js";
import { normalizeWorkspaceEdit, type EditManifest } from "../workspace/edits.js";
import { renderManifest } from "../workspace/diff.js";
import { applyManifest } from "../workspace/transaction.js";
import { stableHash } from "../util/text.js";
import { classifyCodeActionCommand, type CodeActionCommandDisposition } from "./code-action-policy.js";

export function registerCodeActionsTool(pi: ExtensionAPI, getRuntime: RuntimeGetter): void {
  pi.registerTool({ name: "lsp_code_actions", label: "LSP Code Actions", description: "List and preview server code actions; apply only a freshly revalidated action previously previewed by actionId. Commands are never executed.", promptSnippet: "Preview or safely apply LSP quick fixes and refactors", promptGuidelines: ["Use lsp_code_actions with apply omitted first; apply only the returned actionId after reviewing the preview."], parameters: codeActionsSchema,
    async execute(_id, params: CodeActionsInput, signal) {
      const started = Date.now(); const runtime = getRuntime();
      if (!runtime.loaded.authorized) return envelope("LSP startup refused because the project is untrusted.", { ...baseDetails("code_actions", "untrusted", started) });
      try {
        if (params.apply && !params.actionId) throw new Error("apply requires actionId from a prior preview");
        if (params.apply && !runtime.previewActions.has(params.actionId!)) throw new Error("actionId was not previewed in this session");
        if (params.apply) runtime.previewActions.delete(params.actionId!);
        if (params.endCharacter !== undefined && params.endLine === undefined) throw new Error("endCharacter requires endLine");
        const source = await acquireSource(runtime, { path: params.path, line: params.line, ...(params.character ? { character: params.character } : {}), ...(params.symbol ? { symbol: params.symbol } : {}), ...(params.server ? { server: params.server } : {}), ...(params.root ? { root: params.root } : {}) }, signal);
        try {
        const capabilities = source.client.capabilities;
        if (!capabilities?.codeActions) return envelope("Code actions unsupported.", { ...baseDetails("code_actions", "unsupported", started), server: source.route.server.id, root: source.route.root });
        const phase = await source.withDocument(async () => {
        const end = params.endLine ? publicToServerPosition(source.snapshot.text, params.endLine, params.endCharacter ?? 1, capabilities.positionEncoding) : source.position!;
        if (end.line < source.position!.line || (end.line === source.position!.line && end.character < source.position!.character)) throw new Error("Code-action range end is before its start");
        const evidence = await runtime.diagnostics.check(source.client, source.snapshot, Math.min(3_000, runtime.loaded.config.limits.requestTimeoutMs), false, signal);
        let actions = await source.client.request<Array<CodeAction | Command> | null>("textDocument/codeAction", { textDocument: { uri: source.snapshot.uri }, range: { start: source.position, end }, context: { diagnostics: evidence.diagnostics, ...(params.kind ? { only: [params.kind] } : {}) } }, signal) ?? [];
        if (params.title) actions = actions.filter((action) => action.title === params.title);
        const totalActions = actions.length;
        actions = actions.slice(0, 100);
        const documents = source.client.documents!.list();
        const documentVersions = new Map(documents.map((document) => [document.uri, document.version] as const));
        const documentSnapshots = new Map(documents.map((document) => [document.uri, document] as const));
        const candidates: Array<{ action: CodeAction; manifest?: EditManifest; actionId: string; supported: boolean; commandDisposition: CodeActionCommandDisposition; reason?: string; normalizationError?: string }> = [];
        for (const raw of actions) {
          let action = isCodeAction(raw) ? raw : { title: raw.title, command: raw };
          let manifest: EditManifest | undefined;
          let normalizationError: string | undefined;
          if (action.data !== undefined && capabilities.codeActionResolve) action = await source.client.request<CodeAction>("codeAction/resolve", action, signal);
          try {
            if (action.edit) manifest = await normalizeWorkspaceEdit(action.edit, runtime.boundary, capabilities.positionEncoding, runtime.loaded.config.limits, documentVersions, documentSnapshots);
          } catch (error) {
            normalizationError = error instanceof Error ? error.message : String(error);
          }
          const formatting = action.kind?.startsWith("source.format") ?? false;
          const commandPolicy = classifyCodeActionCommand(source.route.server, action, source.client.serverInfo);
          const policyReason = action.disabled?.reason ?? (formatting ? "Formatting actions are excluded" : commandPolicy.reason);
          const reason = normalizationError ? `Malformed or stale server edit: ${normalizationError}` : policyReason ?? (manifest && !manifest.applicable ? manifest.reasons.join("; ") : undefined);
          const actionId = stableHash({ server: source.route.server.id, root: source.route.root, hash: source.snapshot.contentHash, title: action.title, kind: action.kind, edit: manifest?.fingerprint ?? (action.edit ? stableHash(action.edit) : undefined), command: action.command, commandDisposition: commandPolicy.disposition });
          candidates.push({ action, ...(manifest ? { manifest } : {}), actionId, supported: !reason && Boolean(manifest?.applicable), commandDisposition: commandPolicy.disposition, ...(reason ? { reason } : {}), ...(normalizationError ? { normalizationError } : {}) });
        }
        return { candidates, totalActions };
        });
        const { candidates, totalActions } = phase;
        if (params.apply) {
          const matches = candidates.filter((candidate) => candidate.actionId === params.actionId);
          if (matches.length !== 1) throw new Error("Fresh code-action response did not contain exactly one matching actionId");
          const selected = matches[0]!; if (!selected.supported || !selected.manifest) throw new Error(selected.reason ?? "Action cannot be applied");
          const changed = await applyManifest(selected.manifest, signal); for (const path of changed) { runtime.changed.add(path); await runtime.manager.syncActiveFile(path, signal, true); }
          return envelope(`Applied ${selected.action.title} to ${changed.length} file(s).`, { ...baseDetails("code_actions", "ok", started), server: source.route.server.id, root: source.route.root, actionId: selected.actionId, applied: true, changed, commandDisposition: selected.commandDisposition, commandExecuted: false });
        }
        const selected = params.title && candidates.length === 1 ? candidates[0] : undefined;
        const preview = selected?.manifest ? renderManifest(selected.manifest, 40_000, source.route.root) : undefined;
        if (selected?.manifest && selected.supported) runtime.previewActions.add(selected.actionId);
        const text = selected ? `${selected.action.title} [${selected.supported ? "applicable" : selected.reason}]\nactionId: ${selected.actionId}\n${preview?.text ?? ""}` : candidates.map((candidate) => `${candidate.actionId} ${candidate.action.title} (${candidate.action.kind ?? "action"})${candidate.reason ? ` [${candidate.reason}]` : ""}`).join("\n") || "No code actions.";
        const malformedActions = candidates.filter((candidate) => candidate.normalizationError).length;
        const status = params.title && candidates.length > 1 ? "ambiguous" : candidates.length ? malformedActions ? "partial" : "ok" : "no_results";
        const omittedActions = Math.max(0, totalActions - candidates.length);
        const warnings = [...(malformedActions ? [`${malformedActions} action(s) contained malformed or stale edits and were not applicable.`] : []), ...(omittedActions ? [`${omittedActions} action(s) omitted by the hard limit.`] : [])];
        return envelope(text, { ...baseDetails("code_actions", status, started), server: source.route.server.id, root: source.route.root, actions: candidates.map((candidate) => ({ actionId: candidate.actionId, title: candidate.action.title, kind: candidate.action.kind, preferred: candidate.action.isPreferred ?? false, disabled: candidate.action.disabled, supported: candidate.supported, reason: candidate.reason, ...(candidate.normalizationError ? { normalizationError: candidate.normalizationError } : {}), hasEdit: Boolean(candidate.action.edit), hasCommand: Boolean(candidate.action.command), commandDisposition: candidate.commandDisposition, commandExecuted: false, previewed: candidate === selected && candidate.supported })), totalActions, omittedActions, malformedActions, ...(selected ? { actionId: selected.actionId, preview: preview?.text, applicable: selected.supported, commandDisposition: selected.commandDisposition, commandExecuted: false } : {}), truncated: (preview?.truncated ?? false) || omittedActions > 0, warnings });
        } finally { source.release(); }
      } catch (error) { rethrowUnexpected(error); return envelope(error instanceof Error ? error.message : String(error), { ...baseDetails("code_actions", statusFromError(error), started) }); }
    } });
}
function isCodeAction(value: CodeAction | Command): value is CodeAction { return "edit" in value || "kind" in value || "diagnostics" in value || "isPreferred" in value || "disabled" in value || "data" in value; }
