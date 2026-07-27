import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { classifyCodeActionCommand } from "../../src/tools/code-action-policy.js";
import type { CodeAction } from "../../src/protocol/types.js";
import { BUILTIN_SERVERS } from "../../src/servers/catalog.js";

const typescriptServer = BUILTIN_SERVERS.typescript!;

function action(overrides: Record<string, unknown> = {}): CodeAction {
  const file = join(tmpdir(), "policy.ts"); const uri = pathToFileURL(file).href;
  const edit = { documentChanges: [{ textDocument: { uri, version: 1 }, edits: [{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } }, newText: "fixed" }] }] };
  const tsAction = { fixName: "fix", description: "Fix value", changes: [{ fileName: file, textChanges: [{ start: { line: 1, offset: 2 }, end: { line: 1, offset: 5 }, newText: "fixed" }] }], ...overrides };
  return { title: "Fix value", kind: "quickfix", edit, command: { title: "", command: "_typescript.applyCodeActionCommand", arguments: [{ action: tsAction, diagnostic: {}, documentUri: uri }] } };
}

describe("TypeScript code-action command policy", () => {
  it("elides only a strict wrapper whose changes exactly match the LSP edit", () => {
    expect(classifyCodeActionCommand(typescriptServer, action())).toEqual({ disposition: "redundant" });
    expect(classifyCodeActionCommand(typescriptServer, action({ changes: [] }))).toMatchObject({ disposition: "unsupported", reason: expect.stringContaining("exactly match") });
    expect(classifyCodeActionCommand(typescriptServer, action({ commands: [{ type: "install package" }] }))).toMatchObject({ disposition: "unsupported", reason: expect.stringContaining("nested commands") });
    expect(classifyCodeActionCommand(typescriptServer, action({ unknownEffect: true }))).toMatchObject({ disposition: "unsupported", reason: expect.stringContaining("unsupported fields") });
  });

  it("preserves order for multiple inserts at the same position", () => {
    const candidate = action() as any;
    const uri = candidate.edit.documentChanges[0].textDocument.uri;
    const file = candidate.command.arguments[0].action.changes[0].fileName;
    candidate.edit = { documentChanges: [{ textDocument: { uri, version: 1 }, edits: [
      { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, newText: "first" },
      { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, newText: "second" },
    ] }] };
    candidate.command.arguments[0].action.changes = [{ fileName: file, textChanges: [
      { start: { line: 1, offset: 2 }, end: { line: 1, offset: 2 }, newText: "second" },
      { start: { line: 1, offset: 2 }, end: { line: 1, offset: 2 }, newText: "first" },
    ] }];
    expect(classifyCodeActionCommand(typescriptServer, candidate)).toMatchObject({ disposition: "unsupported", reason: expect.stringContaining("exactly match") });
  });

  it("does not generalize the wrapper policy to other server identities", () => {
    expect(classifyCodeActionCommand({ ...typescriptServer, id: "custom" }, action())).toMatchObject({ disposition: "unsupported" });
    expect(classifyCodeActionCommand(typescriptServer, action(), { name: "different-server", version: "1" })).toMatchObject({ disposition: "unsupported" });
  });
});
