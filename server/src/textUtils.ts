// Small text-scanning primitives shared by hover, definition, references,
// completion, and rename -- kept dependency-free (no vscode-languageserver
// connection/document-manager imports) so callers, including unit tests,
// can use them without pulling in server.ts's side-effecting
// createConnection()/connection.listen() module load.

// \w is ASCII-only; PB identifiers can carry the `$` string-type suffix
// (e.g. "Name$") and, in practice, Unicode letters — \p{L} covers those too.
export const WORD_CHAR = /[\w#$]|\p{L}/u;

export function isWordChar(ch: string): boolean {
  return WORD_CHAR.test(ch);
}

export function wordAt(text: string, offset: number): string | undefined {
  let start = offset;
  let end = offset;
  while (start > 0 && isWordChar(text[start - 1])) start--;
  while (end < text.length && isWordChar(text[end])) end++;
  if (start === end) return undefined;
  return text.slice(start, end);
}

export function wordRangeAt(text: string, offset: number): { start: number; end: number } | undefined {
  let start = offset;
  let end = offset;
  while (start > 0 && isWordChar(text[start - 1])) start--;
  while (end < text.length && isWordChar(text[end])) end++;
  if (start === end) return undefined;
  return { start, end };
}

/**
 * Like wordAt, but recognizes PureBasic's `Module::Symbol` qualification: if
 * the cursor sits on either half of a `A::B` pair, returns both the module
 * name and the bare symbol name so a caller can disambiguate a lookup
 * instead of just matching the first same-named symbol anywhere. `module` is
 * absent for a plain, unqualified word.
 */
export function qualifiedWordAt(text: string, offset: number): { module?: string; name: string } | undefined {
  const range = wordRangeAt(text, offset);
  if (!range) return undefined;
  const name = text.slice(range.start, range.end);

  if (text.slice(range.end, range.end + 2) === "::") {
    const after = wordRangeAt(text, range.end + 2);
    if (after && after.start === range.end + 2) {
      return { module: name, name: text.slice(after.start, after.end) };
    }
  }

  if (range.start >= 3 && text.slice(range.start - 2, range.start) === "::") {
    const before = wordRangeAt(text, range.start - 3);
    if (before && before.end === range.start - 2) {
      return { module: text.slice(before.start, before.end), name };
    }
  }

  return { name };
}

/**
 * The module name immediately before the cursor for a just-typed or
 * in-progress `Module::` / `Module::partial` completion prefix.
 * qualifiedWordAt requires a word AT the offset, so it can't tell a plain
 * unqualified completion apart from one right after `Module::` with nothing
 * typed yet -- this scans back past any in-progress word first.
 */
export function typedModuleQualifierBefore(text: string, offset: number): string | undefined {
  const masked = maskStringsAndComments(text);
  let i = offset;
  while (i > 0 && isWordChar(masked[i - 1])) i--;
  if (text.slice(i - 2, i) !== "::") return undefined;
  const before = wordRangeAt(masked, i - 3);
  return before && before.end === i - 2 ? text.slice(before.start, before.end) : undefined;
}

/** Blanks out `;`-comment and `"`-string contents (preserving offsets/newlines)
 *  so a word-boundary scan run over the result can't match inside them. */
export function maskStringsAndComments(text: string): string {
  const out = text.split("");
  let inString = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (inString) {
      if (ch === '"') {
        inString = false;
      } else if (ch !== "\n") {
        out[i] = " ";
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === ";") {
      let j = i;
      while (j < out.length && out[j] !== "\n") {
        out[j] = " ";
        j++;
      }
      i = j - 1;
    }
  }
  return out.join("");
}
