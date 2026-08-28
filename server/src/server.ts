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
  SignatureHelp,
  SignatureInformation,
  ParameterInformation,
  ReferenceParams,
  RenameParams,
  PrepareRenameParams,
  WorkspaceEdit,
  TextEdit,
  ResponseError,
  ErrorCodes,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { BuiltinIndex, loadOrBuildBuiltinIndex, queryStructureFields } from "./builtinIndex";
import { resolveStructureFields, WorkspaceSymbol } from "./workspaceSymbols";
import { invalidateIncludeGraphCache, resolveIncludeGraphSymbols, ResolvedSymbol } from "./includeGraph";
import { formatStructureField, StructureField } from "./dumpParsers";
import { HelpIndex, getHelpUrl, loadOrFetchHelpIndex } from "./onlineHelpIndex";
import { getKeywordHelpUrl, isKeyword } from "./keywordHelp";
import { RetryableLoader } from "./retryableLoader";
import { isWordChar, maskStringsAndComments, qualifiedWordAt, wordAt } from "./textUtils";
import { findRenameRanges, IDENTIFIER_RE, RenameTarget, resolveRenameTargetFromSymbols } from "./rename";

interface InitializationOptions {
  compilerPath?: string;
  cacheDir?: string;
}

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let builtinIndex: BuiltinIndex | undefined;
let builtinIndexPromise: Promise<BuiltinIndex | undefined> | undefined;
let compilerPath = "";
let cacheDir = "";
const structureFieldsCache = new Map<string, StructureField[]>();
let helpIndex: HelpIndex | undefined;
const helpIndexLoader = new RetryableLoader<HelpIndex>(async (forceRefresh) => {
  try {
    const index = await loadOrFetchHelpIndex(cacheDir, forceRefresh);
    helpIndex = index;
    return index;
  } catch (error) {
    connection.console.warn(`Pure Xtension: help index fetch failed: ${String(error)}`);
    return undefined;
  }
});

/** Fetches (or loads the cached) purebasic.com command index in the background;
 *  never blocks a caller — hover/help-url lookups just get no link until it resolves. */
function ensureHelpIndex(forceRefresh = false): Promise<HelpIndex | undefined> {
  return helpIndexLoader.get(forceRefresh);
}

/** Memoizes on the in-flight promise (not just the resolved index) so concurrent
 *  completion/hover/signatureHelp calls on activation share one compiler build
 *  instead of each spawning pbcompiler and racing to write the same cache file. */
function ensureBuiltinIndex(forceRebuild = false): Promise<BuiltinIndex | undefined> {
  if (builtinIndex) return Promise.resolve(builtinIndex);
  if (!compilerPath) return Promise.resolve(undefined);
  if (!builtinIndexPromise) {
    builtinIndexPromise = loadOrBuildBuiltinIndex(compilerPath, cacheDir, forceRebuild)
      .then((index) => (builtinIndex = index))
      .catch((error) => {
        connection.console.error(`Pure Xtension: failed to build symbol index: ${String(error)}`);
        return undefined;
      })
      .finally(() => {
        builtinIndexPromise = undefined;
      });
  }
  return builtinIndexPromise;
}

async function getBuiltinStructureFields(name: string): Promise<StructureField[]> {
  const key = name.toLowerCase();
  // .has(), not a truthy check on .get() — a legitimately empty field list
  // ([]) is truthy too, so a truthy check would be indistinguishable from
  // "never cached" and this fast path would never trigger for it.
  if (structureFieldsCache.has(key)) return structureFieldsCache.get(key)!;
  if (!compilerPath) return [];
  try {
    const fields = await queryStructureFields(compilerPath, name);
    structureFieldsCache.set(key, fields);
    return fields;
  } catch (error) {
    // Don't cache a failed query as "no fields" — a transient compiler
    // timeout would otherwise permanently poison this structure's hover/
    // completion for the rest of the session. Just retry next time.
    connection.console.warn(`Pure Xtension: structure-fields query for "${name}" failed: ${String(error)}`);
    return [];
  }
}


function findWordRanges(doc: TextDocument, word: string): Range[] {
  const text = maskStringsAndComments(doc.getText());
  const lower = word.toLowerCase();
  const ranges: Range[] = [];
  let i = 0;
  while (i < text.length) {
    if (isWordChar(text[i]) && (i === 0 || !isWordChar(text[i - 1]))) {
      let j = i;
      while (j < text.length && isWordChar(text[j])) j++;
      if (text.slice(i, j).toLowerCase() === lower) {
        ranges.push(Range.create(doc.positionAt(i), doc.positionAt(j)));
      }
      i = j;
    } else {
      i++;
    }
  }
  return ranges;
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
    case "variable":
      return SymbolKind.Variable;
    case "module":
      return SymbolKind.Module;
  }
}

/** Backward scan from `offset` for the enclosing, unclosed `(` and which comma-separated
 *  argument slot `offset` falls in — used to resolve the active function call for signatureHelp. */
function findEnclosingCall(text: string, offset: number): { name: string; activeParameter: number } | undefined {
  let depth = 0;
  let activeParameter = 0;
  let i = offset - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === ")") {
      depth++;
    } else if (ch === "(") {
      if (depth === 0) {
        const name = wordAt(text, i);
        return name ? { name, activeParameter } : undefined;
      }
      depth--;
    } else if (ch === "," && depth === 0) {
      activeParameter++;
    }
    i--;
  }
  return undefined;
}

function splitParams(params: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of params) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function knownStructureNames(symbols: ResolvedSymbol[], index: BuiltinIndex | undefined): Set<string> {
  const names = new Set<string>();
  for (const symbol of symbols) {
    if (symbol.kind === "structure") names.add(symbol.name.toLowerCase());
  }
  for (const name of index?.structures ?? []) names.add(name.toLowerCase());
  return names;
}

/** First-occurrence `variable.TypeName` declarations where TypeName is a known structure. */
function buildVariableTypeMap(text: string, structureNames: Set<string>): Map<string, string> {
  const map = new Map<string, string>();
  // Mask comments/strings first — otherwise a comment like `; player.Position
  // resets` or a float literal like `3.14` can register a bogus mapping, and
  // since only the first occurrence wins, one before the real declaration
  // poisons field completion for the rest of the document.
  const masked = maskStringsAndComments(text);
  const DECL = /\b([A-Za-z_]\w*)\.(\w+)\b/g;
  let match: RegExpExecArray | null;
  while ((match = DECL.exec(masked))) {
    const [, varName, typeName] = match;
    const key = varName.toLowerCase();
    if (!map.has(key) && structureNames.has(typeName.toLowerCase())) {
      map.set(key, typeName);
    }
  }
  return map;
}

async function structureFieldCompletions(
  text: string,
  backslashOffset: number,
  uri: string,
): Promise<CompletionItem[]> {
  const varWord = wordAt(text, backslashOffset - 1);
  if (!varWord) return [];

  const symbols = await resolveIncludeGraphSymbols(uri, documents);
  const index = await ensureBuiltinIndex();
  const structureNames = knownStructureNames(symbols, index);
  const typeName = buildVariableTypeMap(text, structureNames).get(varWord.toLowerCase());
  if (!typeName) return [];

  const fields = await resolveStructureFields(symbols, typeName, getBuiltinStructureFields);

  return fields.map((field) => ({
    label: field.name,
    kind: CompletionItemKind.Field,
    detail: formatStructureField(field),
  }));
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const options = (params.initializationOptions ?? {}) as InitializationOptions;
  compilerPath = options.compilerPath ?? "";
  cacheDir = options.cacheDir ?? "";
  if (cacheDir) void ensureHelpIndex();

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { resolveProvider: false, triggerCharacters: ["#", "\\"] },
      hoverProvider: true,
      documentSymbolProvider: true,
      definitionProvider: true,
      signatureHelpProvider: { triggerCharacters: ["(", ","] },
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
    },
  };
});

connection.onRequest("pureXtension/rebuildSymbolCache", async () => {
  builtinIndex = undefined;
  builtinIndexPromise = undefined;
  structureFieldsCache.clear();
  await ensureBuiltinIndex(true);
});

connection.onRequest("pureXtension/rebuildHelpIndex", async () => {
  await ensureHelpIndex(true);
});

connection.onRequest(
  "pureXtension/helpUrl",
  async (params: { symbol: string }): Promise<{ url?: string }> => {
    await ensureHelpIndex();
    return { url: getHelpUrl(helpIndex, params.symbol) ?? getKeywordHelpUrl(params.symbol) };
  },
);

connection.onRequest(
  "pureXtension/helpEntries",
  async (): Promise<{ entries: { name: string; url: string }[] }> => {
    const index = await ensureHelpIndex();
    return { entries: Object.values(index?.commands ?? {}) };
  },
);

// Rebuilding ~1888 builtin CompletionItems from scratch on every keystroke is
// wasted work once `index`/`helpIndex` have settled, so cache the built list
// keyed by object identity of both inputs — invalidates itself exactly once,
// when helpIndex first resolves from undefined to a real index.
let builtinCompletionCache: { index: BuiltinIndex; help: HelpIndex | undefined; items: CompletionItem[] } | undefined;

function builtinCompletionItems(index: BuiltinIndex): CompletionItem[] {
  if (builtinCompletionCache && builtinCompletionCache.index === index && builtinCompletionCache.help === helpIndex) {
    return builtinCompletionCache.items;
  }
  const items: CompletionItem[] = [];
  for (const fn of index.functions) {
    const url = getHelpUrl(helpIndex, fn.name);
    items.push({
      label: fn.name,
      kind: CompletionItemKind.Function,
      detail: fn.signature,
      documentation: url
        ? { kind: "markdown", value: `${fn.description}\n\n[Open documentation](${url})` }
        : fn.description,
    });
  }
  for (const name of index.structures) {
    items.push({ label: name, kind: CompletionItemKind.Struct });
  }
  builtinCompletionCache = { index, help: helpIndex, items };
  return items;
}

connection.onCompletion(async (params): Promise<CompletionItem[]> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const text = doc.getText();
  const offset = doc.offsetAt(params.position);

  if (offset > 0 && text[offset - 1] === "\\") {
    return structureFieldCompletions(text, offset, doc.uri);
  }

  const items: CompletionItem[] = [];

  // Initialization starts this in the background so first completion is not
  // held behind a network timeout. Re-kick it here without awaiting it: if the
  // initial fetch happened while offline, a later completion can self-heal and
  // builtinCompletionItems() will invalidate its no-help cache when the index
  // arrives.
  void ensureHelpIndex();

  const index = await ensureBuiltinIndex();
  if (index) {
    items.push(...builtinCompletionItems(index));
  }

  for (const symbol of await resolveIncludeGraphSymbols(doc.uri, documents)) {
    items.push({
      label: symbol.name,
      kind:
        symbol.kind === "procedure"
          ? CompletionItemKind.Function
          : symbol.kind === "structure"
            ? CompletionItemKind.Struct
            : symbol.kind === "constant"
              ? CompletionItemKind.Constant
              : symbol.kind === "interface"
                ? CompletionItemKind.Interface
                : symbol.kind === "macro"
                  ? CompletionItemKind.Method
                  : symbol.kind === "variable"
                    ? CompletionItemKind.Variable
                    : symbol.kind === "module"
                      ? CompletionItemKind.Module
                      : CompletionItemKind.Reference,
      detail: symbol.detail,
    });
  }

  return items;
});

connection.onHover(async (params): Promise<Hover | undefined> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return undefined;

  const offset = doc.offsetAt(params.position);
  const qualified = qualifiedWordAt(doc.getText(), offset);
  if (!qualified) return undefined;
  const { module, name: word } = qualified;

  const index = await ensureBuiltinIndex();

  const fn = index?.functions.find((f) => f.name.toLowerCase() === word.toLowerCase());
  if (fn) {
    const url = getHelpUrl(helpIndex, fn.name);
    const link = url ? `\n\n[Open documentation](${url})` : "";
    return {
      contents: { kind: "markdown", value: `**${fn.signature}**\n\n${fn.description}${link}` },
    };
  }

  const symbols = await resolveIncludeGraphSymbols(doc.uri, documents);
  // A `Module::Name`-qualified reference must resolve to that module's own
  // symbol, not just the first same-named symbol anywhere -- otherwise a
  // name that's also used in a different module (or in main code) silently
  // wins on lookup order alone.
  const symbol = symbols.find(
    (s) =>
      s.name.toLowerCase() === word.toLowerCase() &&
      (!module || (s.module ?? "").toLowerCase() === module.toLowerCase()),
  );
  if (symbol) {
    const fields =
      symbol.kind === "structure" ? await resolveStructureFields(symbols, symbol.name, getBuiltinStructureFields, symbol.module) : symbol.fields;
    const fieldList = fields?.length ? `\n\n${fields.map((f) => `- ${formatStructureField(f)}`).join("\n")}` : "";
    const methodList = symbol.methods?.length
      ? `\n\n${symbol.methods.map((m) => `- ${m.name}${m.returnType ? `.${m.returnType}` : ""}(${m.params})`).join("\n")}`
      : "";
    return {
      contents: {
        kind: "markdown",
        value: `**${symbol.name}** _(${symbol.kind})_\n\n${symbol.detail}${fieldList}${methodList}`,
      },
    };
  }

  const builtinStructureOrInterface = index?.structures
    .concat(index.interfaces)
    .find((name) => name.toLowerCase() === word.toLowerCase());
  if (builtinStructureOrInterface) {
    const url = getHelpUrl(helpIndex, builtinStructureOrInterface);
    const link = url ? `\n\n[Open documentation](${url})` : "";
    const fields = await resolveStructureFields(symbols, builtinStructureOrInterface, getBuiltinStructureFields);
    const fieldList = fields.length ? `\n\n${fields.map((f) => `- ${formatStructureField(f)}`).join("\n")}` : "";
    return {
      contents: {
        kind: "markdown",
        value: `**${builtinStructureOrInterface}**${fieldList}${link}`,
      },
    };
  }

  const keywordUrl = getKeywordHelpUrl(word);
  if (keywordUrl) {
    return {
      contents: { kind: "markdown", value: `**${word}**\n\n[Open documentation](${keywordUrl})` },
    };
  }

  return undefined;
});

connection.onDocumentSymbol(async (params): Promise<DocumentSymbol[]> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const lines = doc.getText().split(/\r?\n/);
  return (await resolveIncludeGraphSymbols(doc.uri, documents))
    .filter((symbol) => symbol.uri === doc.uri)
    .map((symbol) => {
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

connection.onDefinition(async (params): Promise<Definition | undefined> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return undefined;

  const offset = doc.offsetAt(params.position);
  const qualified = qualifiedWordAt(doc.getText(), offset);
  if (!qualified) return undefined;

  const symbol = (await resolveIncludeGraphSymbols(doc.uri, documents)).find(
    (s) =>
      s.name.toLowerCase() === qualified.name.toLowerCase() &&
      (!qualified.module || (s.module ?? "").toLowerCase() === qualified.module.toLowerCase()),
  );
  if (!symbol) return undefined;

  const range = Range.create(Position.create(symbol.line, 0), Position.create(symbol.line, 0));
  return Location.create(symbol.uri, range);
});

connection.onSignatureHelp(async (params): Promise<SignatureHelp | undefined> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return undefined;

  const offset = doc.offsetAt(params.position);
  const call = findEnclosingCall(doc.getText(), offset);
  if (!call) return undefined;

  const index = await ensureBuiltinIndex();
  const fn = index?.functions.find((f) => f.name.toLowerCase() === call.name.toLowerCase());
  if (fn) {
    const params_ = splitParams(fn.params);
    return {
      signatures: [
        SignatureInformation.create(
          fn.signature,
          fn.description,
          ...params_.map((p) => ParameterInformation.create(p)),
        ),
      ],
      activeSignature: 0,
      activeParameter: Math.min(call.activeParameter, Math.max(params_.length - 1, 0)),
    };
  }

  const procedure = (await resolveIncludeGraphSymbols(doc.uri, documents)).find(
    (s) => s.kind === "procedure" && s.name.toLowerCase() === call.name.toLowerCase(),
  );
  if (procedure) {
    const rawParams = procedure.detail.replace(/^\(|\)$/g, "");
    const params_ = splitParams(rawParams);
    return {
      signatures: [
        SignatureInformation.create(
          `${procedure.name} ${procedure.detail}`,
          undefined,
          ...params_.map((p) => ParameterInformation.create(p)),
        ),
      ],
      activeSignature: 0,
      activeParameter: Math.min(call.activeParameter, Math.max(params_.length - 1, 0)),
    };
  }

  return undefined;
});

connection.onReferences((params: ReferenceParams): Location[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const offset = doc.offsetAt(params.position);
  const word = wordAt(doc.getText(), offset);
  if (!word) return [];

  return findWordRanges(doc, word).map((range) => Location.create(doc.uri, range));
});

async function resolveRenameTarget(doc: TextDocument, offset: number): Promise<RenameTarget | undefined> {
  const symbols = await resolveIncludeGraphSymbols(doc.uri, documents);
  return resolveRenameTargetFromSymbols(doc.getText(), offset, symbols);
}

connection.onPrepareRename(
  async (
    params: PrepareRenameParams,
  ): Promise<Range | { range: Range; placeholder: string } | undefined> => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return undefined;

    const target = await resolveRenameTarget(doc, doc.offsetAt(params.position));
    if (!target) return undefined;

    return {
      range: Range.create(doc.positionAt(target.range.start), doc.positionAt(target.range.end)),
      placeholder: target.bareName,
    };
  },
);

connection.onRenameRequest(async (params: RenameParams): Promise<WorkspaceEdit | undefined> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return undefined;

  const target = await resolveRenameTarget(doc, doc.offsetAt(params.position));
  if (!target) return undefined;

  // A user typing into the rename box may retype the `#` prefix out of
  // habit even though the editable range never included it -- strip one
  // back off instead of rejecting it outright.
  const newBareName = target.sigil && params.newName.startsWith("#") ? params.newName.slice(1) : params.newName;
  if (!IDENTIFIER_RE.test(newBareName)) {
    throw new ResponseError(ErrorCodes.InvalidParams, `"${params.newName}" is not a valid PureBasic identifier.`);
  }
  if (isKeyword(newBareName)) {
    throw new ResponseError(
      ErrorCodes.InvalidParams,
      `"${newBareName}" is a reserved PureBasic keyword and can't be used as an identifier.`,
    );
  }

  const edits: TextEdit[] = findRenameRanges(doc, target.bareName, target.sigil, target.scope).map((range) =>
    TextEdit.replace(range, newBareName),
  );
  return { changes: { [doc.uri]: edits } };
});

documents.onDidClose((event) => invalidateIncludeGraphCache(event.document.uri));

documents.listen(connection);
connection.listen();
