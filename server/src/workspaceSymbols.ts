// Regex-based extraction of user-defined symbols from a single PureBasic
// document's text. Deliberately not a full parser — good enough for
// completion/hover/documentSymbol/definition on the declaring keywords.

import { StructureField } from "./dumpParsers";

export type WorkspaceSymbolKind = "procedure" | "structure" | "interface" | "constant" | "macro";

export interface WorkspaceSymbol {
  kind: WorkspaceSymbolKind;
  name: string;
  /** 0-based line the declaration starts on. */
  line: number;
  /** Extra detail for hover/completion, e.g. the parameter list or field list. */
  detail: string;
  /** Populated for `structure` symbols: fields declared between Structure/EndStructure. */
  fields?: StructureField[];
}

const PROCEDURE_LINE = /^\s*Procedure(?:C|DLL|CDLL)?(?:\.\w+)?\s+(\w+)\s*\(([^)]*)\)/i;
const STRUCTURE_LINE = /^\s*Structure\s+(\w+)/i;
const END_STRUCTURE_LINE = /^\s*EndStructure\b/i;
const STRUCTURE_FIELD_LINE = /^(\*?)([A-Za-z_]\w*)\.([A-Za-z_]\w*)(\[(\d+)\])?/;
const INTERFACE_LINE = /^\s*Interface\s+(\w+)/i;
const MACRO_LINE = /^\s*Macro\s+(\w+)/i;
const CONSTANT_LINE = /^\s*#(\w+)(?:\.\w+)?\s*=\s*(.*)$/;

export function extractWorkspaceSymbols(text: string): WorkspaceSymbol[] {
  const symbols: WorkspaceSymbol[] = [];
  const lines = text.split(/\r?\n/);
  let currentStructure: WorkspaceSymbol | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (currentStructure) {
      if (END_STRUCTURE_LINE.test(line)) {
        currentStructure = undefined;
        continue;
      }
      const field = STRUCTURE_FIELD_LINE.exec(line.trim());
      if (field) {
        const [, pointer, name, type, , arraySize] = field;
        (currentStructure.fields ??= []).push({
          name,
          type,
          isPointer: pointer === "*",
          arraySize: arraySize ? Number(arraySize) : undefined,
        });
        continue;
      }
      // Not a field and no EndStructure seen yet — if this line starts a new
      // top-level construct (the common mid-typing case: the user hasn't
      // typed EndStructure yet), treat the structure as implicitly closed
      // instead of swallowing everything below it. Otherwise it's a blank
      // or garbage line inside the structure body — ignore it.
      if (PROCEDURE_LINE.test(line) || STRUCTURE_LINE.test(line) || INTERFACE_LINE.test(line) || MACRO_LINE.test(line)) {
        currentStructure = undefined;
      } else {
        continue;
      }
    }

    const proc = PROCEDURE_LINE.exec(line);
    if (proc) {
      symbols.push({ kind: "procedure", name: proc[1], line: i, detail: `(${proc[2].trim()})` });
      continue;
    }

    const struct = STRUCTURE_LINE.exec(line);
    if (struct) {
      const symbol: WorkspaceSymbol = {
        kind: "structure",
        name: struct[1],
        line: i,
        detail: "Structure",
        fields: [],
      };
      symbols.push(symbol);
      currentStructure = symbol;
      continue;
    }

    const iface = INTERFACE_LINE.exec(line);
    if (iface) {
      symbols.push({ kind: "interface", name: iface[1], line: i, detail: "Interface" });
      continue;
    }

    const macro = MACRO_LINE.exec(line);
    if (macro) {
      symbols.push({ kind: "macro", name: macro[1], line: i, detail: "Macro" });
      continue;
    }

    const constant = CONSTANT_LINE.exec(line);
    if (constant) {
      symbols.push({
        kind: "constant",
        name: constant[1],
        line: i,
        detail: constant[2].trim(),
      });
    }
  }

  return symbols;
}
