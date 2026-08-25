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
  return decodeURIComponent(uri.replace(/^file:\/\//, ""));
}

function pathToUri(p: string): string {
  return "file://" + encodeURI(p.replace(/\\/g, "/"));
}

function readDocText(uri: string, documents: TextDocuments<TextDocument>): string | undefined {
  const open = documents.get(uri);
  if (open) return open.getText();
  try {
    return fs.readFileSync(uriToPath(uri), "utf8");
  } catch {
    return undefined;
  }
}

function extractIncludePaths(text: string): string[] {
  const includes: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = INCLUDE_LINE.exec(line);
    if (match) includes.push(match[1]);
  }
  return includes;
}

/**
 * Walks the IncludeFile/XIncludeFile graph from `entryUri`, returning every
 * symbol reachable (including the entry document's own), each tagged with the
 * URI it was declared in. Cycles and a depth cap keep this bounded.
 */
export function resolveIncludeGraphSymbols(
  entryUri: string,
  documents: TextDocuments<TextDocument>,
  maxDepth = 8,
): ResolvedSymbol[] {
  const visited = new Set<string>();
  const result: ResolvedSymbol[] = [];

  function visit(uri: string, depth: number): void {
    if (visited.has(uri) || depth > maxDepth) return;
    visited.add(uri);

    const text = readDocText(uri, documents);
    if (text === undefined) return;

    for (const symbol of extractWorkspaceSymbols(text)) {
      result.push({ ...symbol, uri });
    }

    const dir = path.dirname(uriToPath(uri));
    for (const include of extractIncludePaths(text)) {
      const resolvedPath = path.isAbsolute(include) ? include : path.join(dir, include);
      visit(pathToUri(resolvedPath), depth + 1);
    }
  }

  visit(entryUri, 0);
  return result;
}
