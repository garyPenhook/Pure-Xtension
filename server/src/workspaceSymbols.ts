// Regex-based extraction of user-defined symbols from a single PureBasic
// document's text. Deliberately not a full parser — good enough for
// completion/hover/documentSymbol/definition on the declaring keywords.

export type WorkspaceSymbolKind = "procedure" | "structure" | "interface" | "constant" | "macro";

export interface WorkspaceSymbol {
  kind: WorkspaceSymbolKind;
  name: string;
  /** 0-based line the declaration starts on. */
  line: number;
  /** Extra detail for hover/completion, e.g. the parameter list or field list. */
  detail: string;
}

const PROCEDURE_LINE = /^\s*Procedure(?:C|DLL|CDLL)?(?:\.\w+)?\s+(\w+)\s*\(([^)]*)\)/i;
const STRUCTURE_LINE = /^\s*Structure\s+(\w+)/i;
const INTERFACE_LINE = /^\s*Interface\s+(\w+)/i;
const MACRO_LINE = /^\s*Macro\s+(\w+)/i;
const CONSTANT_LINE = /^\s*#(\w+)(?:\.\w+)?\s*=\s*(.*)$/;

export function extractWorkspaceSymbols(text: string): WorkspaceSymbol[] {
  const symbols: WorkspaceSymbol[] = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const proc = PROCEDURE_LINE.exec(line);
    if (proc) {
      symbols.push({ kind: "procedure", name: proc[1], line: i, detail: `(${proc[2].trim()})` });
      continue;
    }

    const struct = STRUCTURE_LINE.exec(line);
    if (struct) {
      symbols.push({ kind: "structure", name: struct[1], line: i, detail: "Structure" });
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
