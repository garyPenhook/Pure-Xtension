import { test } from "node:test";
import assert from "node:assert/strict";
import { extractWorkspaceSymbols, resolveStructureFields } from "../server/src/workspaceSymbols";

test("interface methods are captured for hover", () => {
  const text = [
    "Interface NewRectangle",
    "  Perimeter.i()",
    "  Surface.i()",
    "  Length.i(Valeur)",
    "  Width.i(Valeur)",
    "  Destroy.i()",
    "EndInterface",
  ].join("\n");

  const [symbol] = extractWorkspaceSymbols(text);
  assert.equal(symbol.kind, "interface");
  assert.equal(symbol.name, "NewRectangle");
  assert.equal(symbol.extends, undefined);
  assert.deepEqual(symbol.methods, [
    { name: "Perimeter", returnType: "i", params: "" },
    { name: "Surface", returnType: "i", params: "" },
    { name: "Length", returnType: "i", params: "Valeur" },
    { name: "Width", returnType: "i", params: "Valeur" },
    { name: "Destroy", returnType: "i", params: "" },
  ]);
});

test("interface without return types or Extends", () => {
  const text = ["Interface MyObject", "  Move(x,y)", "  MoveF(x.f,y.f)", "  Destroy()", "EndInterface"].join("\n");

  const [symbol] = extractWorkspaceSymbols(text);
  assert.deepEqual(symbol.methods, [
    { name: "Move", returnType: undefined, params: "x,y" },
    { name: "MoveF", returnType: undefined, params: "x.f,y.f" },
    { name: "Destroy", returnType: undefined, params: "" },
  ]);
});

test("Extends clause is captured", () => {
  const text = ["Interface ColoredCube Extends Cube", "  GetColor()", "  SetColor(Color)", "EndInterface"].join("\n");

  const [symbol] = extractWorkspaceSymbols(text);
  assert.equal(symbol.extends, "Cube");
  assert.equal(symbol.detail, "Interface Extends Cube");
  assert.deepEqual(symbol.methods, [
    { name: "GetColor", returnType: undefined, params: "" },
    { name: "SetColor", returnType: undefined, params: "Color" },
  ]);
});

test("an interface left unclosed by mid-typing doesn't swallow a following Procedure", () => {
  const text = ["Interface Foo", "  Bar()", "", "Procedure Baz()", "EndProcedure"].join("\n");

  const symbols = extractWorkspaceSymbols(text);
  const proc = symbols.find((s) => s.kind === "procedure");
  assert.ok(proc, "Procedure after an unclosed Interface should still be extracted");
  assert.equal(proc?.name, "Baz");
});

test("Global variables are extracted with no scope bound, including a multi-name comma list", () => {
  const text = "Global counter.i, name$ = \"x\"";
  const symbols = extractWorkspaceSymbols(text);
  const vars = symbols.filter((s) => s.kind === "variable");
  assert.deepEqual(
    vars.map((v) => v.name),
    ["counter", "name$"],
  );
  for (const v of vars) assert.equal(v.scopeEndLine, undefined);
});

test("procedure parameters and Protected/Static/Dim locals are scoped to their EndProcedure line", () => {
  const text = [
    "Procedure Add(a.i, *ptr.Point, b.i = 5)", // 0
    "  Protected result.i", // 1
    "  Static callCount.i", // 2
    "  Dim scratch(10)", // 3
    "  result = a + b", // 4
    "EndProcedure", // 5
  ].join("\n");
  const symbols = extractWorkspaceSymbols(text);
  const vars = symbols.filter((s) => s.kind === "variable");
  assert.deepEqual(
    vars.map((v) => v.name),
    ["a", "ptr", "b", "result", "callCount", "scratch"],
  );
  // Every one of them belongs to this procedure -- all scoped to line 5.
  for (const v of vars) assert.equal(v.scopeEndLine, 5);
});

test("two procedures each get their own independently-scoped same-named local", () => {
  const text = ["Procedure A()", "  Protected total.i", "EndProcedure", "Procedure B()", "  Protected total.i", "EndProcedure"].join(
    "\n",
  );
  const symbols = extractWorkspaceSymbols(text).filter((s) => s.kind === "variable");
  assert.equal(symbols.length, 2);
  assert.deepEqual([symbols[0].line, symbols[0].scopeEndLine], [1, 2]);
  assert.deepEqual([symbols[1].line, symbols[1].scopeEndLine], [4, 5]);
});

test("DeclareModule/Module pairs collapse to a single module symbol by name", () => {
  const text = ["DeclareModule Geometry", "EndDeclareModule", "Module Geometry", "EndModule"].join("\n");
  const modules = extractWorkspaceSymbols(text).filter((s) => s.kind === "module");
  assert.equal(modules.length, 1, "DeclareModule and Module for the same name should not double-register");
  assert.equal(modules[0].name, "Geometry");
  assert.equal(modules[0].line, 0);
});

test("Dim's array-dimension commas don't get mistaken for separate declarations", () => {
  const text = "Dim grid(10, 20), other(5)";
  const vars = extractWorkspaceSymbols(text).filter((s) => s.kind === "variable");
  assert.deepEqual(
    vars.map((v) => v.name),
    ["grid", "other"],
  );
});

test("a constant name can carry the $ string-type suffix", () => {
  const text = '#FerrariName$ = "458 Italia"';
  const [symbol] = extractWorkspaceSymbols(text);
  assert.equal(symbol.kind, "constant");
  assert.equal(symbol.name, "FerrariName$");
  assert.equal(symbol.detail, '"458 Italia"');
});

test("Declare registers a forward-declared procedure, but not DeclareModule", () => {
  const text = ["Declare CreateFerrari()", "Declare.s Attach(String1$, String2$)", "DeclareModule Cars", "EndDeclareModule"].join(
    "\n",
  );
  const symbols = extractWorkspaceSymbols(text);
  const procs = symbols.filter((s) => s.kind === "procedure");
  assert.deepEqual(
    procs.map((p) => p.name),
    ["CreateFerrari", "Attach"],
  );
  assert.ok(procs.every((p) => p.isForwardDeclaration));
  const modules = symbols.filter((s) => s.kind === "module");
  assert.deepEqual(
    modules.map((m) => m.name),
    ["Cars"],
  );
});

test("symbols declared inside DeclareModule/Module are tagged with that module's name", () => {
  const text = [
    "DeclareModule Ferrari",
    "  #FerrariName$ = 1",
    "  Declare CreateFerrari()",
    "EndDeclareModule",
    "Module Ferrari",
    "  Global Initialized",
    "  Procedure Init()",
    "    Protected ok.i",
    "  EndProcedure",
    "EndModule",
    "Global Outside",
  ].join("\n");
  const symbols = extractWorkspaceSymbols(text);
  const byName = new Map(symbols.map((s) => [s.name, s]));
  assert.equal(byName.get("FerrariName$")?.module, "Ferrari");
  assert.equal(byName.get("CreateFerrari")?.module, "Ferrari");
  assert.equal(byName.get("Initialized")?.module, "Ferrari");
  assert.equal(byName.get("Init")?.module, "Ferrari");
  assert.equal(byName.get("ok")?.module, "Ferrari");
  assert.equal(byName.get("Outside")?.module, undefined);
});

test("a structure's Extends clause is captured the same way an interface's is", () => {
  const text = ["Structure MyPoint", "  x.l", "  y.l", "EndStructure", "Structure MyColoredPoint Extends MyPoint", "  color.l", "EndStructure"].join(
    "\n",
  );
  const structs = extractWorkspaceSymbols(text).filter((s) => s.kind === "structure");
  assert.equal(structs[0].extends, undefined);
  assert.equal(structs[1].extends, "MyPoint");
  assert.equal(structs[1].detail, "Structure Extends MyPoint");
  assert.deepEqual(structs[1].fields, [{ name: "color", type: "l", isPointer: false, arraySize: undefined }]);
});

test("resolveStructureFields prepends inherited fields and falls back to a builtin base, cycle-safe", async () => {
  const text = ["Structure MyPoint", "  x.l", "  y.l", "EndStructure", "Structure MyColoredPoint Extends MyPoint", "  color.l", "EndStructure"].join(
    "\n",
  );
  const symbols = extractWorkspaceSymbols(text);
  const getBuiltinFields = async () => [];

  const fields = await resolveStructureFields(symbols, "MyColoredPoint", getBuiltinFields);
  assert.deepEqual(
    fields.map((f) => f.name),
    ["x", "y", "color"],
  );

  // Extends a name that isn't among our own structures -- treated as a builtin base.
  const builtinBase = await resolveStructureFields(
    [{ kind: "structure", name: "Derived", fields: [{ name: "own", type: "l", isPointer: false }], extends: "RECT" }],
    "Derived",
    async (name) => (name === "RECT" ? [{ name: "left", type: "l", isPointer: false }] : []),
  );
  assert.deepEqual(
    builtinBase.map((f) => f.name),
    ["left", "own"],
  );

  // A extends B extends A must terminate instead of recursing forever.
  const cyclic = await resolveStructureFields(
    [
      { kind: "structure", name: "A", fields: [{ name: "a", type: "l", isPointer: false }], extends: "B" },
      { kind: "structure", name: "B", fields: [{ name: "b", type: "l", isPointer: false }], extends: "A" },
    ],
    "A",
    getBuiltinFields,
  );
  assert.deepEqual(
    cyclic.map((f) => f.name),
    ["b", "a"],
  );
});

test("resolveStructureFields disambiguates same-named structures declared in different modules", async () => {
  // PB modules exist precisely so two modules (or a module and main code) can
  // each declare their own "Point" without conflict -- a name-only lookup
  // would silently resolve to whichever one happens to come first in the
  // array instead of the one actually being asked about.
  const symbols = [
    { kind: "structure" as const, name: "Point", fields: [{ name: "mainX", type: "l", isPointer: false }] },
    {
      kind: "structure" as const,
      name: "Point",
      module: "Geometry",
      fields: [{ name: "geoX", type: "l", isPointer: false }],
    },
    {
      kind: "structure" as const,
      name: "ColoredPoint",
      module: "Geometry",
      extends: "Point",
      fields: [{ name: "color", type: "l", isPointer: false }],
    },
  ];
  const getBuiltinFields = async () => [];

  const mainFields = await resolveStructureFields(symbols, "Point", getBuiltinFields);
  assert.deepEqual(mainFields.map((f) => f.name), ["mainX"]);

  const geometryFields = await resolveStructureFields(symbols, "Point", getBuiltinFields, "Geometry");
  assert.deepEqual(geometryFields.map((f) => f.name), ["geoX"]);

  // Extends must also resolve "Point" within ColoredPoint's own module
  // (Geometry), not main code's same-named structure.
  const coloredFields = await resolveStructureFields(symbols, "ColoredPoint", getBuiltinFields, "Geometry");
  assert.deepEqual(coloredFields.map((f) => f.name), ["geoX", "color"]);
});

test("dynamic Array/List/Map structure fields are parsed with their container kind", () => {
  const text = [
    "Structure Person",
    "  Name$",
    "  Age.l",
    "  List Friends$()",
    "  Array Scores.l(10)",
    "  Map Lookup.Point()",
    "EndStructure",
  ].join("\n");
  const [symbol] = extractWorkspaceSymbols(text);
  assert.deepEqual(symbol.fields, [
    { name: "Name$", type: "s", isPointer: false },
    { name: "Age", type: "l", isPointer: false, arraySize: undefined },
    { name: "Friends$", type: "s", isPointer: false, container: "list" },
    { name: "Scores", type: "l", isPointer: false, container: "array" },
    { name: "Lookup", type: "Point", isPointer: false, container: "map" },
  ]);
});
