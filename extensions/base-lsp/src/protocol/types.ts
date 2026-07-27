export type PositionEncoding = "utf-8" | "utf-16" | "utf-32";
export interface Position { line: number; character: number }
export interface Range { start: Position; end: Position }
export interface TextDocumentIdentifier { uri: string }
export interface VersionedTextDocumentIdentifier extends TextDocumentIdentifier { version: number | null }
export interface TextEdit { range: Range; newText: string; annotationId?: string }
export interface AnnotatedTextEdit extends TextEdit { annotationId: string }
export interface TextDocumentEdit { textDocument: VersionedTextDocumentIdentifier; edits: Array<TextEdit | AnnotatedTextEdit> }
export interface CreateFile { kind: "create"; uri: string; options?: { overwrite?: boolean; ignoreIfExists?: boolean }; annotationId?: string }
export interface RenameFile { kind: "rename"; oldUri: string; newUri: string; options?: { overwrite?: boolean; ignoreIfExists?: boolean }; annotationId?: string }
export interface DeleteFile { kind: "delete"; uri: string; options?: { recursive?: boolean; ignoreIfNotExists?: boolean }; annotationId?: string }
export type DocumentChange = TextDocumentEdit | CreateFile | RenameFile | DeleteFile;
export interface WorkspaceEdit { changes?: Record<string, TextEdit[]>; documentChanges?: DocumentChange[]; changeAnnotations?: Record<string, { label: string; needsConfirmation?: boolean; description?: string }> }
export interface Location { uri: string; range: Range }
export interface LocationLink { originSelectionRange?: Range; targetUri: string; targetRange: Range; targetSelectionRange: Range }
export interface Diagnostic { range: Range; severity?: number; code?: string | number | { value: string | number; target: string }; codeDescription?: { href: string }; source?: string; message: string; tags?: number[]; relatedInformation?: Array<{ location: Location; message: string }>; data?: unknown }
export interface Command { title: string; command: string; arguments?: unknown[] }
export interface CodeAction { title: string; kind?: string; diagnostics?: Diagnostic[]; isPreferred?: boolean; disabled?: { reason: string }; edit?: WorkspaceEdit; command?: Command; data?: unknown }
export interface MarkupContent { kind: "plaintext" | "markdown"; value: string }
export type MarkedString = string | { language: string; value: string };
export interface Hover { contents: MarkupContent | MarkedString | MarkedString[]; range?: Range }
export interface DocumentSymbol { name: string; detail?: string; kind: number; tags?: number[]; deprecated?: boolean; range: Range; selectionRange: Range; children?: DocumentSymbol[] }
export interface SymbolInformation { name: string; kind: number; tags?: number[]; deprecated?: boolean; location: Location | { uri: string; range?: Range }; containerName?: string; data?: unknown }
export interface CallHierarchyItem { name: string; kind: number; tags?: number[]; detail?: string; uri: string; range: Range; selectionRange: Range; data?: unknown }
export interface CallHierarchyIncomingCall { from: CallHierarchyItem; fromRanges: Range[] }
export interface CallHierarchyOutgoingCall { to: CallHierarchyItem; fromRanges: Range[] }
export interface PublishDiagnosticsParams { uri: string; version?: number; diagnostics: Diagnostic[] }
export interface FullDocumentDiagnosticReport { kind: "full"; resultId?: string; items: Diagnostic[]; relatedDocuments?: Record<string, DocumentDiagnosticReport> }
export interface UnchangedDocumentDiagnosticReport { kind: "unchanged"; resultId: string; relatedDocuments?: Record<string, DocumentDiagnosticReport> }
export type DocumentDiagnosticReport = FullDocumentDiagnosticReport | UnchangedDocumentDiagnosticReport;
export type WorkspaceDocumentDiagnosticReport = ({ uri: string; version?: number | null } & FullDocumentDiagnosticReport) | ({ uri: string; version?: number | null } & UnchangedDocumentDiagnosticReport);
export interface WorkspaceDiagnosticReport { items: WorkspaceDocumentDiagnosticReport[] }

export interface ServerCapabilities {
  positionEncoding?: PositionEncoding;
  textDocumentSync?: number | { openClose?: boolean; change?: number; save?: boolean | { includeText?: boolean } };
  diagnosticProvider?: boolean | { identifier?: string; interFileDependencies?: boolean; workspaceDiagnostics?: boolean };
  declarationProvider?: unknown;
  definitionProvider?: unknown;
  typeDefinitionProvider?: unknown;
  implementationProvider?: unknown;
  referencesProvider?: unknown;
  hoverProvider?: unknown;
  documentSymbolProvider?: unknown;
  workspaceSymbolProvider?: boolean | { resolveProvider?: boolean };
  callHierarchyProvider?: unknown;
  codeActionProvider?: boolean | { codeActionKinds?: string[]; resolveProvider?: boolean };
  renameProvider?: boolean | { prepareProvider?: boolean };
  executeCommandProvider?: { commands?: string[] };
  workspace?: { workspaceFolders?: { supported?: boolean; changeNotifications?: boolean | string } };
  [key: string]: unknown;
}

export interface InitializeResult { capabilities: ServerCapabilities; serverInfo?: { name: string; version?: string } }

export interface NormalizedCapabilities {
  positionEncoding: PositionEncoding;
  syncKind: 0 | 1 | 2;
  openClose: boolean;
  save: false | { includeText: boolean };
  diagnostics: { pull: boolean; workspace: boolean };
  declaration: boolean;
  definition: boolean;
  typeDefinition: boolean;
  implementation: boolean;
  references: boolean;
  hover: boolean;
  documentSymbols: boolean;
  workspaceSymbols: boolean;
  workspaceSymbolResolve: boolean;
  callHierarchy: boolean;
  codeActions: boolean;
  codeActionResolve: boolean;
  rename: boolean;
  prepareRename: boolean;
  executeCommands: string[];
}

export function normalizeCapabilities(capabilities: ServerCapabilities): NormalizedCapabilities {
  const sync = capabilities.textDocumentSync;
  const syncKind = (typeof sync === "number" ? sync : sync?.change ?? 0) as 0 | 1 | 2;
  const saveValue = typeof sync === "object" ? sync.save : false;
  const diagnostic = capabilities.diagnosticProvider;
  const codeAction = capabilities.codeActionProvider;
  const workspaceSymbol = capabilities.workspaceSymbolProvider;
  const rename = capabilities.renameProvider;
  const executeCommands = capabilities.executeCommandProvider?.commands;
  return {
    positionEncoding: capabilities.positionEncoding ?? "utf-16",
    syncKind,
    openClose: typeof sync === "object" ? sync.openClose !== false : syncKind !== 0,
    save: saveValue ? { includeText: typeof saveValue === "object" && saveValue.includeText === true } : false,
    diagnostics: { pull: Boolean(diagnostic), workspace: typeof diagnostic === "object" && diagnostic.workspaceDiagnostics === true },
    declaration: Boolean(capabilities.declarationProvider),
    definition: Boolean(capabilities.definitionProvider),
    typeDefinition: Boolean(capabilities.typeDefinitionProvider),
    implementation: Boolean(capabilities.implementationProvider),
    references: Boolean(capabilities.referencesProvider),
    hover: Boolean(capabilities.hoverProvider),
    documentSymbols: Boolean(capabilities.documentSymbolProvider),
    workspaceSymbols: Boolean(workspaceSymbol),
    workspaceSymbolResolve: typeof workspaceSymbol === "object" && workspaceSymbol.resolveProvider === true,
    callHierarchy: Boolean(capabilities.callHierarchyProvider),
    codeActions: Boolean(codeAction),
    codeActionResolve: typeof codeAction === "object" && codeAction.resolveProvider === true,
    rename: Boolean(rename),
    prepareRename: typeof rename === "object" && rename.prepareProvider === true,
    executeCommands: Array.isArray(executeCommands) ? executeCommands.filter((command): command is string => typeof command === "string") : [],
  };
}
