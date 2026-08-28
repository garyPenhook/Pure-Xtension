// Parsers for the plain-text dumps produced by `pbcompiler -lf/-ls/-li -o <file>`.
// Formats verified directly against pbcompiler 6.41 output, e.g.:
//   -lf: "AddGadgetItem (#Gadget, Position, Text$ [, ImageID [, Flags]]) - Add an item..."
//   -ls: one bare structure name per line, e.g. "GtkEntry"
//   -li: same bare-name format as -ls (commonly empty)
//   -qs: field lines like "packed_flags.l", "*text_area.GdkWindow", "pad.b[3]"

export interface BuiltinFunction {
  name: string;
  signature: string;
  params: string;
  description: string;
}

export interface StructureField {
  name: string;
  type: string;
  isPointer: boolean;
  arraySize?: number;
  /** Set when the field is a dynamic `Array`/`List`/`Map` container (workspace-parsed
   *  structures only -- pbcompiler's `-qs` dump never reports these). */
  container?: "array" | "list" | "map";
}

/** Shared hover/completion rendering for a structure field, e.g. `*Next.Window`,
 *  `Name.s[10]`, or `Array Tab.pointF(3)`. A bare `Name$` field (implicitly
 *  String, no `.Type` in the source at all) renders the same way it's
 *  actually written, rather than as the redundant-looking `Name$.s`. */
export function formatStructureField(field: StructureField): string {
  const containerPrefix = field.container ? `${field.container[0].toUpperCase()}${field.container.slice(1)} ` : "";
  const pointer = field.isPointer ? "*" : "";
  const arraySuffix = field.arraySize ? `[${field.arraySize}]` : "";
  const typeSuffix = field.name.endsWith("$") && field.type === "s" ? "" : `.${field.type}`;
  return `${containerPrefix}${pointer}${field.name}${typeSuffix}${arraySuffix}`;
}

const FUNCTION_NAME_AND_OPEN_PAREN = /^(\S+)\s*\(/;

// Params can contain their own nested, empty parens (e.g. "List()" in
// "AddElement (List())", "@Callback()" in "BindEvent (Event, @Callback() [...])"),
// and the trailing description is optional (e.g. "AddSplinePoint (#Spline, x, y, z)"
// has no " - ..." at all) — so this needs a depth-aware scan rather than a single
// regex, which either truncates at the first nested ")" or requires a description.
export function parseFunctionsDump(text: string): BuiltinFunction[] {
  const result: BuiltinFunction[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const opening = FUNCTION_NAME_AND_OPEN_PAREN.exec(line);
    if (!opening) continue;
    const name = opening[1];
    const paramsStart = opening[0].length;

    let depth = 1;
    let i = paramsStart;
    for (; i < line.length && depth > 0; i++) {
      if (line[i] === "(") depth++;
      else if (line[i] === ")") depth--;
    }
    if (depth !== 0) continue; // unbalanced — not a well-formed entry

    const closeParenIndex = i - 1;
    const params = line.slice(paramsStart, closeParenIndex);
    const rest = line.slice(closeParenIndex + 1).trim();
    const description = rest.replace(/^-\s*/, "");

    result.push({
      name,
      signature: `${name} (${params})`,
      params: params.trim(),
      description,
    });
  }
  return result;
}

export function parseNameListDump(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const FIELD_LINE = /^(\*?)([A-Za-z_]\w*)\.([A-Za-z_]\w*)(\[(\d+)\])?$/;

export function parseStructureFieldsDump(text: string): StructureField[] {
  const result: StructureField[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = FIELD_LINE.exec(line);
    if (!match) continue;
    const [, pointer, name, type, , arraySize] = match;
    result.push({
      name,
      type,
      isPointer: pointer === "*",
      arraySize: arraySize ? Number(arraySize) : undefined,
    });
  }
  return result;
}
