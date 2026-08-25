// Resolves the IncludeFile/XIncludeFile graph starting from an entry document so
// completion/hover/definition can see symbols declared in included files, not
// just the currently open one. Paths are resolved relative to the including
// file's directory (PureBasic's own resolution order also checks compiler
// search paths, but the relative-to-file case covers normal project layouts).

import * as fs from "node:fs";
import * as path from "node:path";
import type { TextDocuments } from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";
import { extractWorkspaceSymbols, WorkspaceSymbol } from "./workspaceSymbols";

export interface ResolvedSymbol extends WorkspaceSymbol {
  uri: string;
}

const INCLUDE_LINE = /^\s*X?IncludeFile\s+"([^"]+)"/i;

function uriToPath(uri: string): string {
  const decoded = decodeURIComponent(uri.replace(/^file:\/\//, ""));
  // A Windows drive-letter path arrives as "/C:/foo/bar" (the file:///C:/...
  // URI convention's leading slash survives decoding) — strip it so fs/path
  // see a real Windows path ("C:/foo/bar"), not one path.win32/fs.* would
  // resolve wrong (or documents.get would fail to match against).
  return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
}

function pathToUri(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  // Mirror uriToPath: a Windows drive-letter path needs its leading slash
  // put back before encoding ("C:/foo" -> "file:///C:/foo").
  const withLeadingSlash = /^[A-Za-z]:/.test(normalized) ? `/${normalized}` : normalized;
  return "file://" + encodeURI(withLeadingSlash);
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

function extractIncludePaths(text: string): string[] {
  const includes: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = INCLUDE_LINE.exec(line);
    if (match) includes.push(match[1]);
  }
  return includes;
}

interface ParsedFile {
  /** TextDocument.version for an open document, or -1 for an on-disk file. */
  version: number;
  /** mtimeMs for an on-disk file (version === -1); unused otherwise. */
  mtimeMs: number;
  symbols: WorkspaceSymbol[];
  includes: string[];
}

// Keyed by URI. Open documents are cache-valid by version alone (bumped on
// every edit by TextDocuments); on-disk files are cache-valid by mtime. Either
// way this avoids a synchronous readFileSync + full regex re-parse of every
// included file on every completion/hover/definition/documentSymbol/
// signatureHelp request — previously done fresh, per request, blocking the
// event loop on every keystroke in multi-include projects.
const parseCache = new Map<string, ParsedFile>();

function parse(text: string, version: number, mtimeMs: number): ParsedFile {
  return { version, mtimeMs, symbols: extractWorkspaceSymbols(text), includes: extractIncludePaths(text) };
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

/**
 * Walks the IncludeFile/XIncludeFile graph from `entryUri`, returning every
 * symbol reachable (including the entry document's own), each tagged with the
 * URI it was declared in. Cycles and a depth cap keep this bounded.
 */
export async function resolveIncludeGraphSymbols(
  entryUri: string,
  documents: TextDocuments<TextDocument>,
  maxDepth = 8,
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
      const resolvedPath = path.isAbsolute(include) ? include : path.join(dir, include);
      await visit(pathToUri(resolvedPath), depth + 1);
    }
  }

  await visit(entryUri, 0);
  return result;
}
