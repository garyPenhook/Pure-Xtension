// Regex-based extraction of user-defined symbols from a single PureBasic
// document's text. Deliberately not a full parser — good enough for
// completion/hover/documentSymbol/definition on the declaring keywords.

import { StructureField } from "./dumpParsers";

export type WorkspaceSymbolKind = "procedure" | "structure" | "interface" | "constant" | "macro" | "variable" | "module";

export interface InterfaceMethod {
  name: string;
  /** Return type after the method name, e.g. `Perimeter.i()` -> "i". */
  returnType?: string;
  /** Raw parameter-list text between the parens. */
  params: string;
}

export interface WorkspaceSymbol {
  kind: WorkspaceSymbolKind;
  name: string;
  /** 0-based line the declaration starts on. */
  line: number;
  /** Extra detail for hover/completion, e.g. the parameter list or field list. */
  detail: string;
  /** Populated for `structure` symbols: fields declared between Structure/EndStructure. */
  fields?: StructureField[];
  /** Populated for `interface` symbols: methods declared between Interface/EndInterface. */
  methods?: InterfaceMethod[];
  /** Populated for `interface` symbols with an `Extends <name>` clause. */
  extends?: string;
  /**
   * Populated for `variable` symbols declared `Protected`/`Define`/`Static`/
   * `Dim`/`NewList`/`NewMap` inside a procedure, or as that procedure's own
   * parameter: the 0-based line of the enclosing `EndProcedure`. A rename
   * (or any other consumer that cares about visibility) must not touch text
   * outside `[line, scopeEndLine]` -- two different procedures are free to
   * each declare their own same-named local without colliding. Absent for
   * `Global` variables (and everything else), which have no such bound.
   */
  scopeEndLine?: number;
}

const PROCEDURE_LINE = /^\s*Procedure(?:C|DLL|CDLL)?(?:\.\w+)?\s+(\w+)\s*\(([^)]*)\)/i;
const END_PROCEDURE_LINE = /^\s*EndProcedure\b/i;
const STRUCTURE_LINE = /^\s*Structure\s+(\w+)/i;
const END_STRUCTURE_LINE = /^\s*EndStructure\b/i;
const STRUCTURE_FIELD_LINE = /^(\*?)([A-Za-z_]\w*)\.([A-Za-z_]\w*)(\[(\d+)\])?/;
const INTERFACE_LINE = /^\s*Interface\s+(\w+)(?:\s+Extends\s+(\w+))?/i;
const END_INTERFACE_LINE = /^\s*EndInterface\b/i;
const INTERFACE_METHOD_LINE = /^([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?\s*\(([^)]*)\)/;
const MACRO_LINE = /^\s*Macro\s+(\w+)/i;
const CONSTANT_LINE = /^\s*#(\w+)(?:\.\w+)?\s*=\s*(.*)$/;
// `Module`/`EndModule` is the implementation body of a `DeclareModule`/
// `EndDeclareModule` pair (usually declared twice for the same name, once
// each way) -- both spellings resolve to the same "module" symbol kind,
// deduplicated by name below since they'd otherwise register as two
// separate declarations of the same identifier.
const MODULE_LINE = /^\s*(?:Declare)?Module\s+(\w+)/i;
// A `.Type` suffix, when present, attaches to each declared *name*
// (`counter.i`), never to the keyword itself -- extractVarNames strips it
// per-segment, so these only need to capture the rest of the line.
const GLOBAL_LINE = /^\s*Global\b(.*)$/i;
const LOCAL_VAR_LINE = /^\s*(?:Protected|Define|Static|Dim|NewList|NewMap)\b(.*)$/i;
const VAR_NAME_IN_SEGMENT = /^\s*\*?([A-Za-z_]\w*\$?)/;

/** Depth-aware comma split so `Dim a(10, 20), b(5)`'s array-dimension commas
 *  don't get mistaken for the declaration-list separators. */
function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** Extracts each declared variable's bare name from a `Global`/`Protected`/.../
 *  parameter-list segment list -- tolerates a leading `*` (pointer), a
 *  trailing `.Type`/array-dims/`= initializer` on each segment (all ignored),
 *  and a `$` string-type suffix (kept, since it's part of the identifier). */
function extractVarNames(declList: string): string[] {
  const names: string[] = [];
  for (const segment of splitTopLevelCommas(declList)) {
    const match = VAR_NAME_IN_SEGMENT.exec(segment);
    if (match) names.push(match[1]);
  }
  return names;
}

export function extractWorkspaceSymbols(text: string): WorkspaceSymbol[] {
  const symbols: WorkspaceSymbol[] = [];
  const lines = text.split(/\r?\n/);
  let currentStructure: WorkspaceSymbol | undefined;
  let currentInterface: WorkspaceSymbol | undefined;
  // Parameters and Protected/Define/Static/Dim/NewList/NewMap locals
  // declared while this is set get their scopeEndLine backfilled once the
  // matching EndProcedure is found -- PureBasic doesn't nest Procedure
  // blocks, so a flat single-level tracker is enough.
  let currentProcedureVars: WorkspaceSymbol[] | undefined;
  // `DeclareModule Name`/`Module Name` normally both appear for the same
  // module (public declaration + implementation) -- keep only the first
  // sighting of each name so it isn't registered twice.
  const seenModules = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (currentProcedureVars && END_PROCEDURE_LINE.test(line)) {
      for (const v of currentProcedureVars) v.scopeEndLine = i;
      currentProcedureVars = undefined;
    }

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

    if (currentInterface) {
      if (END_INTERFACE_LINE.test(line)) {
        currentInterface = undefined;
        continue;
      }
      const method = INTERFACE_METHOD_LINE.exec(line.trim());
      if (method) {
        const [, name, returnType, params] = method;
        (currentInterface.methods ??= []).push({ name, returnType, params: params.trim() });
        continue;
      }
      // Same implicit-close rule as currentStructure above, for mid-typing.
      if (PROCEDURE_LINE.test(line) || STRUCTURE_LINE.test(line) || INTERFACE_LINE.test(line) || MACRO_LINE.test(line)) {
        currentInterface = undefined;
      } else {
        continue;
      }
    }

    const proc = PROCEDURE_LINE.exec(line);
    if (proc) {
      symbols.push({ kind: "procedure", name: proc[1], line: i, detail: `(${proc[2].trim()})` });
      currentProcedureVars = [];
      for (const name of extractVarNames(proc[2])) {
        const param: WorkspaceSymbol = { kind: "variable", name, line: i, detail: "Parameter" };
        symbols.push(param);
        currentProcedureVars.push(param);
      }
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
      const symbol: WorkspaceSymbol = {
        kind: "interface",
        name: iface[1],
        line: i,
        detail: iface[2] ? `Interface Extends ${iface[2]}` : "Interface",
        methods: [],
        extends: iface[2],
      };
      symbols.push(symbol);
      currentInterface = symbol;
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
      continue;
    }

    const module = MODULE_LINE.exec(line);
    if (module) {
      const key = module[1].toLowerCase();
      if (!seenModules.has(key)) {
        seenModules.add(key);
        symbols.push({ kind: "module", name: module[1], line: i, detail: "Module" });
      }
      continue;
    }

    const global = GLOBAL_LINE.exec(line);
    if (global) {
      for (const name of extractVarNames(global[1])) {
        // No scopeEndLine -- Global is visible everywhere, unlike a
        // procedure's own Protected/Define/Static/parameters below.
        symbols.push({ kind: "variable", name, line: i, detail: "Global" });
      }
      continue;
    }

    const localVar = LOCAL_VAR_LINE.exec(line);
    if (localVar) {
      for (const name of extractVarNames(localVar[1])) {
        const symbol: WorkspaceSymbol = { kind: "variable", name, line: i, detail: "Variable" };
        symbols.push(symbol);
        // Declared outside any procedure (unusual, but not invalid PB) --
        // fall back to unbounded scope rather than dropping it.
        currentProcedureVars?.push(symbol);
      }
    }
  }

  return symbols;
}
