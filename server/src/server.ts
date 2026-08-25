import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  CompletionItem,
  CompletionItemKind,
  Hover,
  DocumentSymbol,
  SymbolKind,
  Definition,
  Location,
  Range,
  Position,
  InitializeParams,
  InitializeResult,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { BuiltinIndex, loadOrBuildBuiltinIndex } from "./builtinIndex";
import { extractWorkspaceSymbols, WorkspaceSymbol } from "./workspaceSymbols";

interface InitializationOptions {
  compilerPath?: string;
  cacheDir?: string;
}

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let builtinIndex: BuiltinIndex | undefined;
let compilerPath = "";
let cacheDir = "";

async function ensureBuiltinIndex(): Promise<BuiltinIndex | undefined> {
  if (builtinIndex) return builtinIndex;
  if (!compilerPath) return undefined;
  try {
    builtinIndex = await loadOrBuildBuiltinIndex(compilerPath, cacheDir);
  } catch (error) {
    connection.console.error(`Pure Xtension: failed to build symbol index: ${String(error)}`);
  }
  return builtinIndex;
}

function wordAt(text: string, offset: number): string | undefined {
  const isWordChar = (ch: string) => /[\w#]/.test(ch);
  let start = offset;
  let end = offset;
  while (start > 0 && isWordChar(text[start - 1])) start--;
  while (end < text.length && isWordChar(text[end])) end++;
  if (start === end) return undefined;
  return text.slice(start, end);
}

function workspaceSymbolKindToLsp(kind: WorkspaceSymbol["kind"]): SymbolKind {
  switch (kind) {
    case "procedure":
      return SymbolKind.Function;
    case "structure":
      return SymbolKind.Struct;
    case "interface":
      return SymbolKind.Interface;
    case "macro":
      return SymbolKind.Method;
    case "constant":
      return SymbolKind.Constant;
  }
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const options = (params.initializationOptions ?? {}) as InitializationOptions;
  compilerPath = options.compilerPath ?? "";
  cacheDir = options.cacheDir ?? "";

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { resolveProvider: false, triggerCharacters: ["#"] },
      hoverProvider: true,
      documentSymbolProvider: true,
      definitionProvider: true,
    },
  };
});

connection.onRequest("pureXtension/rebuildSymbolCache", async () => {
  builtinIndex = undefined;
  await ensureBuiltinIndex();
});

connection.onCompletion(async (params): Promise<CompletionItem[]> => {
  const doc = documents.get(params.textDocument.uri);
  const items: CompletionItem[] = [];

  const index = await ensureBuiltinIndex();
  if (index) {
    for (const fn of index.functions) {
      items.push({
        label: fn.name,
        kind: CompletionItemKind.Function,
        detail: fn.signature,
        documentation: fn.description,
      });
    }
    for (const name of index.structures) {
      items.push({ label: name, kind: CompletionItemKind.Struct });
    }
  }

  if (doc) {
    for (const symbol of extractWorkspaceSymbols(doc.getText())) {
      items.push({
        label: symbol.name,
        kind:
          symbol.kind === "procedure"
            ? CompletionItemKind.Function
            : symbol.kind === "structure"
              ? CompletionItemKind.Struct
              : symbol.kind === "constant"
                ? CompletionItemKind.Constant
                : CompletionItemKind.Reference,
        detail: symbol.detail,
      });
    }
  }

  return items;
});

connection.onHover((params): Hover | undefined => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return undefined;

  const offset = doc.offsetAt(params.position);
  const word = wordAt(doc.getText(), offset);
  if (!word) return undefined;

  const fn = builtinIndex?.functions.find((f) => f.name.toLowerCase() === word.toLowerCase());
  if (fn) {
    return { contents: { kind: "markdown", value: `**${fn.signature}**\n\n${fn.description}` } };
  }

  const symbol = extractWorkspaceSymbols(doc.getText()).find(
    (s) => s.name.toLowerCase() === word.toLowerCase(),
  );
  if (symbol) {
    return {
      contents: { kind: "markdown", value: `**${symbol.name}** _(${symbol.kind})_\n\n${symbol.detail}` },
    };
  }

  return undefined;
});

connection.onDocumentSymbol((params): DocumentSymbol[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const lines = doc.getText().split(/\r?\n/);
  return extractWorkspaceSymbols(doc.getText()).map((symbol) => {
    // LSP's `uinteger` caps at 2^32-1; Number.MAX_SAFE_INTEGER overflows that
    // and can fail strict client-side validation, so clamp to the real line length.
    const range = Range.create(
      Position.create(symbol.line, 0),
      Position.create(symbol.line, lines[symbol.line]?.length ?? 0),
    );
    return DocumentSymbol.create(
      symbol.name,
      symbol.detail,
      workspaceSymbolKindToLsp(symbol.kind),
      range,
      range,
    );
  });
});

connection.onDefinition((params): Definition | undefined => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return undefined;

  const offset = doc.offsetAt(params.position);
  const word = wordAt(doc.getText(), offset);
  if (!word) return undefined;

  const symbol = extractWorkspaceSymbols(doc.getText()).find(
    (s) => s.name.toLowerCase() === word.toLowerCase(),
  );
  if (!symbol) return undefined;

  const range = Range.create(Position.create(symbol.line, 0), Position.create(symbol.line, 0));
  return Location.create(params.textDocument.uri, range);
});

documents.listen(connection);
connection.listen();
