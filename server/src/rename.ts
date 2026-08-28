// Symbol-aware, sigil-safe rename logic (H5). Split out from server.ts so
// the interesting decision logic -- which words are safe to rename, and how
// PureBasic's `#constant` sigil is kept out of the edited/validated text --
// is unit-testable without pulling in server.ts's side-effecting
// createConnection()/connection.listen() module load. The actual symbol
// resolution (M10) now lives in symbolResolver.ts, shared with completion/
// hover/definition/signature-help/references -- this file just keeps its
// original names as aliases so nothing else needs to change.
import { Range } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { isWordChar, maskStringsAndComments, wordRangeAt } from "./textUtils";
import { enclosingModuleAt, LookupSymbol, ResolvedSymbolTarget, resolveSymbolAt } from "./symbolResolver";

export type RenameTarget = ResolvedSymbolTarget;
export type RenameSymbol = LookupSymbol;
export const resolveRenameTargetFromSymbols = resolveSymbolAt;

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

/** True when `line` is inside a DeclareModule/Module body with this name.
 * Sufficient to distinguish the two module bodies that PureBasic permits to
 * have identical member names. */
function lineIsInModule(text: string, line: number, module: string): boolean {
  return enclosingModuleAt(text, line)?.toLowerCase() === module.toLowerCase();
}

/** Ranges belonging to one resolved symbol identity. Module members are
 * limited to their own module bodies plus explicit `Module::Name` uses;
 * that is what prevents an A::Run rename from changing B::Run. */
export function findRenameRangesForTarget(doc: TextDocument, target: RenameTarget): Range[] {
  const all = findRenameRanges(doc, target.bareName, target.sigil, target.scope);
  const module = target.symbol.module;
  if (!module) return all;
  const text = maskStringsAndComments(doc.getText());
  return all.filter((range) => {
    const offset = doc.offsetAt(range.start);
    const before = wordRangeAt(text, offset - 3);
    const qualifier = before && before.end === offset - 2 ? text.slice(before.start, before.end) : undefined;
    return qualifier?.toLowerCase() === module.toLowerCase() || lineIsInModule(doc.getText(), range.start.line, module);
  });
}
