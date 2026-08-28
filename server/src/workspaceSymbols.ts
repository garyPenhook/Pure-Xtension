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
  /** Populated for `structure` symbols: fields declared between Structure/EndStructure,
   *  not including fields inherited through `extends` -- see resolveStructureFields
   *  for the flattened chain. */
  fields?: StructureField[];
  /** Populated for `interface` symbols: methods declared between Interface/EndInterface. */
  methods?: InterfaceMethod[];
  /** Populated for `interface` and `structure` symbols with an `Extends <name>` clause. */
  extends?: string;
  /** Populated for a `procedure` symbol parsed from a `Declare` line rather than a real
   *  `Procedure`/`EndProcedure` block -- a forward declaration with no body of its own.
   *  resolveIncludeGraphSymbols drops one of these in favor of the real implementation
   *  when both are found (the common DeclareModule/Module pairing), so callers that just
   *  want "the" procedure named X don't land on the stub over the real body. */
  isForwardDeclaration?: boolean;
  /** Populated for any symbol declared inside a DeclareModule/Module block: the module's
   *  name. Enables `Module::Symbol`-qualified lookups (see qualifiedWordAt) to find the
   *  right symbol when the same name exists in more than one module or in main code. */
  module?: string;
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
// A forward declaration: same shape as Procedure's signature but with no
// body/EndProcedure of its own -- the whole point is that the real
// Procedure block (if any) lives elsewhere, typically in a paired
// DeclareModule/Module block's implementation half. Deliberately doesn't
// match `DeclareModule Name` -- that keyword has no space right after
// "Declare", so `\s+` here fails to match it.
const DECLARE_LINE = /^\s*Declare(?:C|DLL|CDLL)?(?:\.\w+)?\s+(\w+)\s*\(([^)]*)\)/i;
const STRUCTURE_LINE = /^\s*Structure\s+(\w+)(?:\s+Extends\s+(\w+))?/i;
const END_STRUCTURE_LINE = /^\s*EndStructure\b/i;
const STRUCTURE_FIELD_LINE = /^(\*?)([A-Za-z_]\w*)\.([A-Za-z_]\w*)(\[(\d+)\])?/;
// A bare `Name$` field with no `.Type` at all -- PB implicitly types it String,
// same as a plain `$`-suffixed variable elsewhere. Must not also match the
// dynamic-container lines below (those start with Array/List/Map keywords).
const STRUCTURE_STRING_FIELD_LINE = /^([A-Za-z_]\w*\$)\s*(?:;.*)?$/;
// Dynamic structure fields: `Array Tab.pointF(3)`, `List Friends$()`, `Map Foo.Bar()`.
// Unlike a static `Name.s[10]` field, these are containers PB auto-initializes and
// resizes -- the `(...)` dimension/no-arg list is never captured, only whether one
// follows, to tell this apart from a plain-typed field sharing the same keyword-less name.
const DYNAMIC_STRUCTURE_FIELD_LINE = /^(Array|List|Map)\s+([A-Za-z_]\w*\$?)(?:\.([A-Za-z_]\w*))?\s*\(/i;
const INTERFACE_LINE = /^\s*Interface\s+(\w+)(?:\s+Extends\s+(\w+))?/i;
const END_INTERFACE_LINE = /^\s*EndInterface\b/i;
const INTERFACE_METHOD_LINE = /^([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?\s*\(([^)]*)\)/;
const MACRO_LINE = /^\s*Macro\s+(\w+)/i;
// A constant name can carry the same `$` string-type suffix a variable can
// (e.g. `#FerrariName$ = "458 Italia"`, straight from PureBasic's own Module
// documentation example) -- without it, a string constant's declaration line
// silently failed to match at all.
const CONSTANT_LINE = /^\s*#(\w+\$?)(?:\.\w+)?\s*=\s*(.*)$/;
// `Module`/`EndModule` is the implementation body of a `DeclareModule`/
// `EndDeclareModule` pair (usually declared twice for the same name, once
// each way) -- both spellings resolve to the same "module" symbol kind,
// deduplicated by name below since they'd otherwise register as two
// separate declarations of the same identifier.
const MODULE_LINE = /^\s*(?:Declare)?Module\s+(\w+)/i;
const END_MODULE_LINE = /^\s*End(?:Declare)?Module\b/i;
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
  // Set for the whole DeclareModule/Module...End(Declare)Module body -- PB
  // modules don't nest, so a single tracker (not a stack) is enough. Every
  // symbol pushed while this is set is tagged with `.module` via push()
  // below, including a procedure's own parameters/locals.
  let currentModule: string | undefined;

  function push(symbol: WorkspaceSymbol): void {
    if (currentModule) symbol.module = currentModule;
    symbols.push(symbol);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (currentProcedureVars && END_PROCEDURE_LINE.test(line)) {
      for (const v of currentProcedureVars) v.scopeEndLine = i;
      currentProcedureVars = undefined;
    }

    if (currentModule && END_MODULE_LINE.test(line)) {
      currentModule = undefined;
      continue;
    }

    if (currentStructure) {
      if (END_STRUCTURE_LINE.test(line)) {
        currentStructure = undefined;
        continue;
      }
      const trimmed = line.trim();
      const field = STRUCTURE_FIELD_LINE.exec(trimmed);
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
      const dynamicField = DYNAMIC_STRUCTURE_FIELD_LINE.exec(trimmed);
      if (dynamicField) {
        const [, container, name, type] = dynamicField;
        (currentStructure.fields ??= []).push({
          name,
          type: type ?? (name.endsWith("$") ? "s" : ""),
          isPointer: false,
          container: container.toLowerCase() as "array" | "list" | "map",
        });
        continue;
      }
      const stringField = STRUCTURE_STRING_FIELD_LINE.exec(trimmed);
      if (stringField) {
        (currentStructure.fields ??= []).push({ name: stringField[1], type: "s", isPointer: false });
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
      push({ kind: "procedure", name: proc[1], line: i, detail: `(${proc[2].trim()})` });
      currentProcedureVars = [];
      for (const name of extractVarNames(proc[2])) {
        const param: WorkspaceSymbol = { kind: "variable", name, line: i, detail: "Parameter" };
        push(param);
        currentProcedureVars.push(param);
      }
      continue;
    }

    // Checked after PROCEDURE_LINE (a real Procedure's own signature line
    // never matches DECLARE_LINE, so order doesn't matter for correctness --
    // this just keeps the "real definitions win" reading order intuitive).
    const decl = DECLARE_LINE.exec(line);
    if (decl) {
      push({
        kind: "procedure",
        name: decl[1],
        line: i,
        detail: `(${decl[2].trim()})`,
        isForwardDeclaration: true,
      });
      continue;
    }

    const struct = STRUCTURE_LINE.exec(line);
    if (struct) {
      const symbol: WorkspaceSymbol = {
        kind: "structure",
        name: struct[1],
        line: i,
        detail: struct[2] ? `Structure Extends ${struct[2]}` : "Structure",
        fields: [],
        extends: struct[2],
      };
      push(symbol);
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
      push(symbol);
      currentInterface = symbol;
      continue;
    }

    const macro = MACRO_LINE.exec(line);
    if (macro) {
      push({ kind: "macro", name: macro[1], line: i, detail: "Macro" });
      continue;
    }

    const constant = CONSTANT_LINE.exec(line);
    if (constant) {
      push({
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
      if (!currentModule) currentModule = module[1];
      continue;
    }

    const global = GLOBAL_LINE.exec(line);
    if (global) {
      for (const name of extractVarNames(global[1])) {
        // No scopeEndLine -- Global is visible everywhere, unlike a
        // procedure's own Protected/Define/Static/parameters below.
        push({ kind: "variable", name, line: i, detail: "Global" });
      }
      continue;
    }

    const localVar = LOCAL_VAR_LINE.exec(line);
    if (localVar) {
      for (const name of extractVarNames(localVar[1])) {
        const symbol: WorkspaceSymbol = { kind: "variable", name, line: i, detail: "Variable" };
        push(symbol);
        // Declared outside any procedure (unusual, but not invalid PB) --
        // fall back to unbounded scope rather than dropping it.
        currentProcedureVars?.push(symbol);
      }
    }
  }

  return symbols;
}

/**
 * Resolves a structure's full field list by walking its `Extends` chain: a
 * parent's fields come first, own fields after, matching PureBasic's own
 * placement rule ("All fields found in the extended structure will be...
 * placed before the new fields"). `getBuiltinFields` is consulted whenever a
 * chain link isn't a structure declared in `symbols` -- either a genuine
 * built-in base (e.g. extending an OS structure) or an unresolvable name,
 * which just yields no extra fields. Cycle-safe (A extends B extends A).
 *
 * `module`, when given, scopes the initial lookup to that module first --
 * PB modules exist precisely so same-named structures can live in different
 * modules without conflict, so a bare name search alone could silently
 * resolve to the wrong module's structure (falls back to a bare-name search
 * if nothing matches in-module, e.g. Extends naming a built-in or a main-code
 * structure). Each Extends link is then resolved relative to *its own*
 * struct's module, since an Extends target is conventionally declared
 * alongside its child.
 */
export async function resolveStructureFields(
  symbols: Pick<WorkspaceSymbol, "kind" | "name" | "fields" | "extends" | "module">[],
  structureName: string,
  getBuiltinFields: (name: string) => Promise<StructureField[]>,
  module?: string,
): Promise<StructureField[]> {
  const visited = new Set<string>();

  function findStructure(name: string, inModule: string | undefined) {
    const key = name.toLowerCase();
    const scoped = (inModule ?? "").toLowerCase();
    return (
      symbols.find((s) => s.kind === "structure" && s.name.toLowerCase() === key && (s.module ?? "").toLowerCase() === scoped) ??
      (inModule ? symbols.find((s) => s.kind === "structure" && s.name.toLowerCase() === key) : undefined)
    );
  }

  async function resolve(name: string, inModule: string | undefined): Promise<StructureField[]> {
    const visitKey = `${(inModule ?? "").toLowerCase()}::${name.toLowerCase()}`;
    if (visited.has(visitKey)) return [];
    visited.add(visitKey);

    const struct = findStructure(name, inModule);
    if (!struct) return getBuiltinFields(name);

    const parentFields = struct.extends ? await resolve(struct.extends, struct.module) : [];
    return [...parentFields, ...(struct.fields ?? [])];
  }

  return resolve(structureName, module);
}
