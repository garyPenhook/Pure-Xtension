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
