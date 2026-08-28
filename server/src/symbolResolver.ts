// Shared symbol-identity resolution (M10, CODE_REVIEW_TODO.md): originally
// built for rename.ts alone, then generalized so completion/hover/
// definition/signature-help/references all resolve "which symbol is this"
// the same way instead of each doing its own first-match spelling lookup.
// Kept dependency-free like textUtils.ts, so it's unit-testable without
// pulling in server.ts's side-effecting createConnection()/connection.listen()
// module load.
import { isKeyword } from "./keywordHelp";
import { maskStringsAndComments, wordRangeAt } from "./textUtils";
import { WorkspaceSymbol } from "./workspaceSymbols";

export type LookupSymbol = Pick<WorkspaceSymbol, "name" | "kind" | "line" | "scopeEndLine" | "module"> & { uri?: string };

// Generic over the symbol type so a caller that already has the full
// ResolvedSymbol (WorkspaceSymbol & {uri}) -- e.g. onHover, which also needs
// `.detail`/`.fields`/`.methods` -- gets that full type back on `.symbol`,
// not just the LookupSymbol fields resolution itself needs internally.
export interface ResolvedSymbolTarget<T extends LookupSymbol = LookupSymbol> {
  range: { start: number; end: number };
  bareName: string;
  sigil: "" | "#";
  /** Set only for a procedure-local variable/parameter (see
   *  WorkspaceSymbol.scopeEndLine): the result must stay within these
   *  0-based lines so a same-named local in a different procedure is left
   *  alone. Absent for every other kind, and for `Global` variables. */
  scope?: { startLine: number; endLine: number };
  /** The declaration selected at the cursor. Keep this identity with the
   * target: spelling alone is not enough once an include graph contains two
   * modules (or two procedure locals) with the same name. */
  symbol: T;
}

const MODULE_OPEN_RE = /^\s*(?:Declare)?Module\s+(\w+)/i;
const MODULE_END_RE = /^\s*End(?:Declare)?Module\b/i;

/**
 * Which `(Declare)?Module ... End(Declare)?Module` body, if any, contains
 * `line` -- a single forward scan tracking the currently-open block. Doesn't
 * distinguish a `DeclareModule` (public interface) from a `Module` (private
 * implementation) body, matching this codebase's existing, already-shipped
 * model (see findRenameRangesForTarget's prior `lineIsInModule`): a member is
 * "in scope" inside its own declaring module's body of either kind, or via
 * explicit `Module::` qualification -- not PureBasic's full public/private
 * split, which nothing else here models either (UseModule isn't parsed at
 * all).
 */
export function enclosingModuleAt(text: string, line: number): string | undefined {
  // Walks newline-to-newline instead of `text.split(/\r?\n/)`: split()
  // tokenizes the *entire* document regardless of `line`, so on a large file
  // with an early cursor -- the common case, since this runs on every
  // completion/hover/definition/signature-help request -- it did far more
  // work than the "scan up to my line" bound below suggests.
  let active: string | undefined;
  let lineStart = 0;
  for (let i = 0; i <= line && lineStart <= text.length; i++) {
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    const lineText = lineEnd > lineStart && text[lineEnd - 1] === "\r" ? text.slice(lineStart, lineEnd - 1) : text.slice(lineStart, lineEnd);
    const open = MODULE_OPEN_RE.exec(lineText);
    if (open) active = open[1];
    if (MODULE_END_RE.test(lineText)) active = undefined;
    lineStart = lineEnd + 1;
  }
  return active;
}

/**
 * True when a symbol declared in `symbolModule` (undefined = main code) is
 * visible from an unqualified reference whose cursor sits in `cursorModule`
 * (undefined = main code). Per PureBasic's module docs, a module's members
 * are invisible outside it without `Module::` qualification, and main-code
 * globals are equally invisible from inside a module -- so plain equality
 * (both directions, including undefined === undefined for main-code-sees-
 * main-code) is the correct visibility rule here.
 */
export function isVisibleUnqualified(symbolModule: string | undefined, cursorModule: string | undefined): boolean {
  return symbolModule === cursorModule;
}

/**
 * Picks the best candidate among same-name/same-kind matches that carry no
 * scope distinction of their own (procedures, structures, constants, ...):
 * an explicit qualifier wins outright; otherwise prefer one visible
 * unqualified from the cursor's module; otherwise fall back to the first
 * candidate so behavior is unchanged when nothing scores better. Shared by
 * resolveSymbolAt's own unscoped-candidate branch and signature help's
 * procedure lookup, so this three-way preference isn't duplicated per caller.
 */
export function pickVisibleCandidate<T extends { module?: string }>(
  candidates: T[],
  explicitModule: string | undefined,
  cursorModule: string | undefined,
): T | undefined {
  if (explicitModule !== undefined) {
    return candidates.find((c) => (c.module ?? "").toLowerCase() === explicitModule.toLowerCase());
  }
  return candidates.find((c) => isVisibleUnqualified(c.module, cursorModule)) ?? candidates[0];
}

/**
 * A word that identifies a known user-defined symbol (procedure/structure/
 * interface/macro/constant/variable/module -- whatever resolveIncludeGraphSymbols
 * tracks), not a keyword, not a built-in (those never appear in
 * resolveIncludeGraphSymbols, so they're rejected simply by never matching),
 * and not sitting inside a comment or string. `sigil` captures PureBasic's
 * `#constant` prefix separately from the editable bare name, since the `#`
 * itself is never part of the identifier resolveIncludeGraphSymbols stores.
 */
export function resolveSymbolAt<T extends LookupSymbol>(
  text: string,
  offset: number,
  symbols: T[],
  uri?: string,
): ResolvedSymbolTarget<T> | undefined {
  // Masking first means a cursor sitting inside a `;`-comment or a
  // `"`-string finds no word at all here (its characters are blanked to
  // spaces) instead of matching stray text that only looks like an
  // identifier -- rejecting comments/strings as targets for free.
  const masked = maskStringsAndComments(text);
  const range = wordRangeAt(masked, offset);
  if (!range) return undefined;

  let { start } = range;
  const { end } = range;
  const sigil = text[start] === "#" ? "#" : "";
  if (sigil) start++;
  if (start >= end) return undefined; // a bare "#" with nothing after it

  const bareName = text.slice(start, end);
  if (isKeyword(bareName)) return undefined;

  const cursorLine = text.slice(0, offset).split("\n").length - 1;
  // Only the right hand side of A::Name is module-qualified. A cursor on A
  // itself is a request to resolve the module, not its member.
  const moduleQualifier = text.slice(start - 2, start) === "::"
    ? wordRangeAt(masked, start - 3)
    : undefined;
  const qualifiedModule = moduleQualifier && moduleQualifier.end === start - 2
    ? text.slice(moduleQualifier.start, moduleQualifier.end)
    : undefined;
  const candidates = symbols.filter((s) => {
    // A constant's stored name never includes its `#`, and only constants
    // are ever referenced with one -- cross-checking the sigil both ways
    // stops a bare word from matching a same-named constant (and vice
    // versa) when PB itself would treat them as different identifiers.
    if ((s.kind === "constant") !== (sigil === "#")) return false;
    return s.name.toLowerCase() === bareName.toLowerCase() &&
      (!qualifiedModule || (s.module ?? "").toLowerCase() === qualifiedModule.toLowerCase());
  });
  if (candidates.length === 0) return undefined;

  // Two different procedures may each declare their own same-named local --
  // prefer whichever scoped candidate actually contains the cursor's line
  // over an unrelated same-named local elsewhere, before falling back to an
  // unscoped (global-ish) match, tie-broken by module visibility so an
  // unqualified reference inside a module prefers that module's own member
  // over an unrelated same-named one elsewhere.
  const localCandidates = candidates.filter((s) => s.scopeEndLine !== undefined && (s.uri === undefined || s.uri === uri));
  const scoped = localCandidates.find((s) => s.scopeEndLine !== undefined && cursorLine >= s.line && cursorLine <= s.scopeEndLine);
  const symbol =
    scoped ??
    pickVisibleCandidate(candidates.filter((s) => s.scopeEndLine === undefined), qualifiedModule, enclosingModuleAt(text, cursorLine));
  if (!symbol) return undefined;

  return {
    range: { start, end },
    bareName,
    sigil,
    scope: symbol.scopeEndLine !== undefined ? { startLine: symbol.line, endLine: symbol.scopeEndLine } : undefined,
    symbol,
  };
}
