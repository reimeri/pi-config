import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

const path = Type.String({ minLength: 1, maxLength: 4_096 });
const line = Type.Integer({ minimum: 1 });
const character = Type.Integer({ minimum: 1 });
const server = Type.String({ minLength: 1, maxLength: 200 });
const root = Type.String({ minLength: 1, maxLength: 4_096 });
const symbol = Type.String({ minLength: 1, maxLength: 1_000 });
const identity = Type.String({ minLength: 1, maxLength: 256 });

export const diagnosticsSchema = Type.Object({
  paths: Type.Optional(Type.Array(path, { maxItems: 500 })),
  root: Type.Optional(root),
  server: Type.Optional(Type.Union([server, Type.Array(server, { minItems: 1, maxItems: 20 })])),
  severity: Type.Optional(StringEnum(["error", "warning", "information", "hint", "all"] as const)),
  mode: Type.Optional(StringEnum(["changed", "paths", "workspace"] as const)),
  maxFiles: Type.Optional(Type.Integer({ minimum: 1 })),
  maxDiagnostics: Type.Optional(Type.Integer({ minimum: 1 })),
  waitMs: Type.Optional(Type.Integer({ minimum: 1 })),
  refresh: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export type DiagnosticsInput = Static<typeof diagnosticsSchema>;

export const navigationSchema = Type.Object({
  operation: StringEnum(["declaration", "definition", "type_definition", "implementation", "references", "hover", "document_symbols", "workspace_symbols", "incoming_calls", "outgoing_calls"] as const),
  path: Type.Optional(path), line: Type.Optional(line), character: Type.Optional(character), symbol: Type.Optional(symbol), query: Type.Optional(Type.String({ maxLength: 2_000 })),
  includeDeclaration: Type.Optional(Type.Boolean()), itemId: Type.Optional(identity), server: Type.Optional(server), root: Type.Optional(root), limit: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });
export type NavigationInput = Static<typeof navigationSchema>;

export const codeActionsSchema = Type.Object({
  path, line, character: Type.Optional(character), endLine: Type.Optional(line), endCharacter: Type.Optional(character), symbol: Type.Optional(symbol),
  kind: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })), title: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })), actionId: Type.Optional(identity), server: Type.Optional(server), root: Type.Optional(root), apply: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export type CodeActionsInput = Static<typeof codeActionsSchema>;

export const renameSchema = Type.Object({
  path, line, character: Type.Optional(character), symbol: Type.Optional(symbol), newName: Type.String({ minLength: 1, maxLength: 1_000 }), renameId: Type.Optional(identity), server: Type.Optional(server), root: Type.Optional(root), apply: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export type RenameInput = Static<typeof renameSchema>;
