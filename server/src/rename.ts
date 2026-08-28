// Symbol-aware, sigil-safe rename logic (H5). Split out from server.ts so
// the interesting decision logic -- which words are safe to rename, and how
// PureBasic's `#constant` sigil is kept out of the edited/validated text --
// is unit-testable without pulling in server.ts's side-effecting
// createConnection()/connection.listen() module load.
import { Range } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { isWordChar, maskStringsAndComments, wordRangeAt } from "./textUtils";
import { isKeyword } from "./keywordHelp";
import { WorkspaceSymbol } from "./workspaceSymbols";

export interface RenameTarget {
  range: { start: number; end: number };
  bareName: string;
  sigil: "" | "#";
  /** Set only for a procedure-local variable/parameter (see
   *  WorkspaceSymbol.scopeEndLine): the rename must stay within these
   *  0-based lines so a same-named local in a different procedure is left
   *  alone. Absent for every other kind, and for `Global` variables. */
  scope?: { startLine: number; endLine: number };
}

export type RenameSymbol = Pick<WorkspaceSymbol, "name" | "kind" | "line" | "scopeEndLine">;

/**
 * A word that's actually safe to rename: a known user-defined symbol
 * (procedure/structure/interface/macro/constant/variable/module -- whatever
 * resolveIncludeGraphSymbols tracks), not a keyword, not a built-in (those
 * never appear in resolveIncludeGraphSymbols, so they're rejected simply by
 * never matching), and not sitting inside a comment or string. `sigil`
 * captures PureBasic's `#constant` prefix separately from the editable bare
 * name, since the `#` itself must never be part of the rename edit -- every
 * real occurrence already carries it and it isn't part of the identifier
 * resolveIncludeGraphSymbols stores.
 */
export function resolveRenameTargetFromSymbols(
  text: string,
  offset: number,
  symbols: RenameSymbol[],
): RenameTarget | undefined {
  // Masking first means a cursor sitting inside a `;`-comment or a
  // `"`-string finds no word at all here (its characters are blanked to
  // spaces) instead of matching stray text that only looks like an
  // identifier -- rejecting comments/strings as rename targets for free.
  const range = wordRangeAt(maskStringsAndComments(text), offset);
  if (!range) return undefined;

  let { start } = range;
  const { end } = range;
  const sigil = text[start] === "#" ? "#" : "";
  if (sigil) start++;
  if (start >= end) return undefined; // a bare "#" with nothing after it

  const bareName = text.slice(start, end);
  if (isKeyword(bareName)) return undefined;

  const cursorLine = text.slice(0, offset).split("\n").length - 1;
  const candidates = symbols.filter((s) => {
    // A constant's stored name never includes its `#`, and only constants
    // are ever referenced with one -- cross-checking the sigil both ways
    // stops a bare word from matching a same-named constant (and vice
    // versa) when PB itself would treat them as different identifiers.
    if ((s.kind === "constant") !== (sigil === "#")) return false;
    return s.name.toLowerCase() === bareName.toLowerCase();
  });
  if (candidates.length === 0) return undefined;

  // Two different procedures may each declare their own same-named local --
  // prefer whichever scoped candidate actually contains the cursor's line
  // over an unrelated same-named local elsewhere, before falling back to an
  // unscoped (global-ish) match.
  const symbol =
    candidates.find((s) => s.scopeEndLine !== undefined && cursorLine >= s.line && cursorLine <= s.scopeEndLine) ??
    candidates.find((s) => s.scopeEndLine === undefined);
  if (!symbol) return undefined;

  return {
    range: { start, end },
    bareName,
    sigil,
    scope: symbol.scopeEndLine !== undefined ? { startLine: symbol.line, endLine: symbol.scopeEndLine } : undefined,
  };
}

// Valid PureBasic identifier: a letter or underscore, then letters/digits/
// underscore, with an optional trailing `$` (the string-type suffix, e.g.
// `Name$`). Applied to the bare name only -- a constant's `#` sigil is
// fixed and handled separately, never part of the validated/edited text.
export const IDENTIFIER_RE = /^[A-Za-z_]\w*\$?$/;

/** Every occurrence of `bareName` with the given sigil, as the range of just
 *  the editable bare-name portion (the `#`, when present, is always left
 *  untouched). Mirrors resolveRenameTargetFromSymbols's sigil cross-check so
 *  a rename can't bleed into an unrelated identically-spelled identifier of
 *  the other kind. `scope`, when given (a procedure-local variable/
 *  parameter -- see RenameTarget.scope), restricts matches to that line
 *  range so a same-named local in a different procedure is left alone. */
export function findRenameRanges(
  doc: TextDocument,
  bareName: string,
  sigil: "" | "#",
  scope?: { startLine: number; endLine: number },
): Range[] {
  const text = maskStringsAndComments(doc.getText());
  const lower = bareName.toLowerCase();
  const ranges: Range[] = [];
  let i = 0;
  while (i < text.length) {
    if (isWordChar(text[i]) && (i === 0 || !isWordChar(text[i - 1]))) {
      let j = i;
      while (j < text.length && isWordChar(text[j])) j++;
      const hasSigil = text[i] === "#";
      const nameStart = hasSigil ? i + 1 : i;
      if (hasSigil === (sigil === "#") && text.slice(nameStart, j).toLowerCase() === lower) {
        const start = doc.positionAt(nameStart);
        if (!scope || (start.line >= scope.startLine && start.line <= scope.endLine)) {
          ranges.push(Range.create(start, doc.positionAt(j)));
        }
      }
      i = j;
    } else {
      i++;
    }
  }
  return ranges;
}
