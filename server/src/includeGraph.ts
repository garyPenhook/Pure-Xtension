// Resolves the IncludeFile/XIncludeFile graph starting from an entry document so
// completion/hover/definition can see symbols declared in included files, not
// just the currently open one. Paths are resolved relative to the including
// file's directory (PureBasic's own resolution order also checks compiler
// search paths, but the relative-to-file case covers normal project layouts).

import * as fs from "node:fs";
import * as path from "node:path";
import type { TextDocuments } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { extractWorkspaceSymbols, WorkspaceSymbol } from "./workspaceSymbols";

export interface ResolvedSymbol extends WorkspaceSymbol {
  uri: string;
}

const INCLUDE_LINE = /^\s*X?IncludeFile\s+"([^"]+)"/i;
const INCLUDE_PATH_LINE = /^\s*IncludePath\s+"([^"]+)"/i;

// L7: the hand-rolled encodeURI()/decodeURIComponent() pair this replaced
// left URI delimiters such as `#` and `?` unescaped in a filename (encodeURI
// treats them as reserved/already-meaningful characters, not something to
// escape), so a real path containing one produced a URI that pointed at the
// wrong resource (everything from the `#`/`?` onward was read as a
// fragment/query, not part of the path) — and didn't robustly cover Windows
// drive letters or UNC paths either. vscode-uri is the same implementation
// VS Code and vscode-languageserver's own clients use for this exact
// conversion, so it agrees with how a real `file://...` URI from the client
// (e.g. in didOpen/didChange) decodes.
function uriToPath(uri: string): string {
  return URI.parse(uri).fsPath;
}

function pathToUri(p: string): string {
  return URI.file(p).toString();
}

/** Canonicalizes a URI's underlying path for de-dup purposes: resolves
 *  symlinks (so a symlink chain doesn't get re-parsed as a "new" file and
 *  loops only get caught at the depth cap) and normalizes case on
 *  case-insensitive filesystems. Falls back to a non-realpath'd normalize for
 *  a file that doesn't exist yet on disk (e.g. a still-unsaved include). */
function canonicalKey(uri: string): string {
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  let p: string;
  try {
    p = fs.realpathSync(uriToPath(uri));
  } catch {
    p = path.normalize(uriToPath(uri));
  }
  return caseInsensitive ? p.toLowerCase() : p;
}

interface ParsedInclude {
  /** The raw quoted path from the IncludeFile/XIncludeFile line. */
  path: string;
  /** The most recent `IncludePath "..."` value in effect earlier in this same
   *  file, if any -- IncludePath only affects includes "after the call of
   *  this command", so this is per-line, not file-wide. */
  includePath?: string;
}

function extractIncludes(text: string): ParsedInclude[] {
  const includes: ParsedInclude[] = [];
  let activeIncludePath: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const includePath = INCLUDE_PATH_LINE.exec(line);
    if (includePath) {
      activeIncludePath = includePath[1];
      continue;
    }
    const match = INCLUDE_LINE.exec(line);
    if (match) includes.push({ path: match[1], includePath: activeIncludePath });
  }
  return includes;
}

interface ParsedFile {
  /** TextDocument.version for an open document, or -1 for an on-disk file. */
  version: number;
  /** mtimeMs for an on-disk file (version === -1); unused otherwise. */
  mtimeMs: number;
  symbols: WorkspaceSymbol[];
  includes: ParsedInclude[];
}

// Keyed by URI. Open documents are cache-valid by version alone (bumped on
// every edit by TextDocuments); on-disk files are cache-valid by mtime. Either
// way this avoids a synchronous readFileSync + full regex re-parse of every
// included file on every completion/hover/definition/documentSymbol/
// signatureHelp request — previously done fresh, per request, blocking the
// event loop on every keystroke in multi-include projects.
const parseCache = new Map<string, ParsedFile>();

function parse(text: string, version: number, mtimeMs: number): ParsedFile {
  return { version, mtimeMs, symbols: extractWorkspaceSymbols(text), includes: extractIncludes(text) };
}

async function getParsedFile(uri: string, documents: TextDocuments<TextDocument>): Promise<ParsedFile | undefined> {
  const open = documents.get(uri);
  if (open) {
    const cached = parseCache.get(uri);
    if (cached && cached.version === open.version) return cached;
    const parsed = parse(open.getText(), open.version, -1);
    parseCache.set(uri, parsed);
    return parsed;
  }

  try {
    const filePath = uriToPath(uri);
    const stat = await fs.promises.stat(filePath);
    const cached = parseCache.get(uri);
    if (cached && cached.version === -1 && cached.mtimeMs === stat.mtimeMs) return cached;
    const text = await fs.promises.readFile(filePath, "utf8");
    const parsed = parse(text, -1, stat.mtimeMs);
    parseCache.set(uri, parsed);
    return parsed;
  } catch {
    parseCache.delete(uri);
    return undefined;
  }
}

/** Evicts a closed document's cache entry so it doesn't keep an open-document (version-keyed)
 *  record around forever if the same URI later needs re-reading from disk. */
export function invalidateIncludeGraphCache(uri: string): void {
  parseCache.delete(uri);
}

/** Returns the current open-document text when available, otherwise a fresh
 * on-disk snapshot.  Rename uses this after resolving the same include graph
 * so its WorkspaceEdit covers both unsaved buffers and included files that
 * are not open in the editor. */
export async function getIncludeGraphDocument(
  uri: string,
  documents: TextDocuments<TextDocument>,
): Promise<TextDocument | undefined> {
  const open = documents.get(uri);
  if (open) return open;
  try {
    return TextDocument.create(uri, "purebasic", 0, await fs.promises.readFile(uriToPath(uri), "utf8"));
  } catch {
    return undefined;
  }
}

// L7: cycles are already made safe by the canonicalKey-keyed `visited` set
// below (a repeated file, including through a symlink loop, is only ever
// visited once, regardless of depth) — the depth cap's only remaining job is
// bounding a pathologically wide/deep *acyclic* graph. 8 was low enough that
// a legitimate project nesting IncludeFile a few directories deep could
// silently lose symbols with no indication anything was cut off. This is
// exported so a caller can override it, but the default is now high enough
// that no real PureBasic project should ever hit it.
export const DEFAULT_MAX_INCLUDE_DEPTH = 1000;

/**
 * Walks the IncludeFile/XIncludeFile graph from `entryUri`, returning every
 * symbol reachable (including the entry document's own), each tagged with the
 * URI it was declared in. Cycles are cut by canonicalKey de-duplication, not
 * by `maxDepth` — see DEFAULT_MAX_INCLUDE_DEPTH's doc comment.
 */
export async function resolveIncludeGraphSymbols(
  entryUri: string,
  documents: TextDocuments<TextDocument>,
  maxDepth = DEFAULT_MAX_INCLUDE_DEPTH,
): Promise<ResolvedSymbol[]> {
  const visited = new Set<string>();
  const result: ResolvedSymbol[] = [];

  async function visit(uri: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const key = canonicalKey(uri);
    if (visited.has(key)) return;
    visited.add(key);

    const parsed = await getParsedFile(uri, documents);
    if (!parsed) return;

    for (const symbol of parsed.symbols) {
      result.push({ ...symbol, uri });
    }

    const dir = path.dirname(uriToPath(uri));
    for (const include of parsed.includes) {
      const resolvedPath = resolveIncludePath(dir, include);
      await visit(pathToUri(resolvedPath), depth + 1);
    }
  }

  await visit(entryUri, 0);
  return dedupeForwardDeclarations(result);
}

/** Every reachable source URI, including files that declare no symbols of
 * their own.  A rename needs this separately from symbol resolution: an
 * include may contain only references to a declaration made elsewhere. */
export async function resolveIncludeGraphUris(
  entryUri: string,
  documents: TextDocuments<TextDocument>,
  maxDepth = DEFAULT_MAX_INCLUDE_DEPTH,
): Promise<string[]> {
  const visited = new Set<string>();
  const result: string[] = [];
  async function visit(uri: string, depth: number): Promise<void> {
    if (depth > maxDepth || visited.has(canonicalKey(uri))) return;
    visited.add(canonicalKey(uri));
    const parsed = await getParsedFile(uri, documents);
    if (!parsed) return;
    result.push(uri);
    const dir = path.dirname(uriToPath(uri));
    for (const include of parsed.includes) await visit(pathToUri(resolveIncludePath(dir, include)), depth + 1);
  }
  await visit(entryUri, 0);
  return result;
}

/** An include's filename is normally relative to its own file's directory; an
 *  `IncludePath` in effect at that point additionally tries that path first
 *  (falling back to the plain relative resolution if nothing exists there) --
 *  see extractIncludes. An absolute include filename ignores both. */
function resolveIncludePath(fileDir: string, include: ParsedInclude): string {
  if (path.isAbsolute(include.path)) return include.path;
  if (include.includePath) {
    const withIncludePath = path.join(fileDir, include.includePath, include.path);
    if (fs.existsSync(withIncludePath)) return withIncludePath;
  }
  return path.join(fileDir, include.path);
}

/**
 * Drops a `Declare`-only forward-declaration symbol whenever a real
 * `Procedure`/`EndProcedure` body with the same (module, name) was also
 * found somewhere in the graph -- otherwise the common DeclareModule/Module
 * pairing registers every procedure twice, and callers like "go to
 * definition" that just take the first same-named match would land on the
 * bodyless stub instead of the real implementation whenever the
 * DeclareModule section (as is idiomatic) appears before the Module section.
 * A forward declaration with no matching body anywhere (e.g. genuinely
 * external, or split across files not on this include path) is kept, since
 * it's the only thing there is to find.
 */
function dedupeForwardDeclarations(symbols: ResolvedSymbol[]): ResolvedSymbol[] {
  const hasImplementation = new Set<string>();
  for (const s of symbols) {
    if (s.kind === "procedure" && !s.isForwardDeclaration) {
      hasImplementation.add(`${(s.module ?? "").toLowerCase()}::${s.name.toLowerCase()}`);
    }
  }
  if (hasImplementation.size === 0) return symbols;
  return symbols.filter(
    (s) =>
      !(s.kind === "procedure" && s.isForwardDeclaration && hasImplementation.has(`${(s.module ?? "").toLowerCase()}::${s.name.toLowerCase()}`)),
  );
}
