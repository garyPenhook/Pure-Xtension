import { test } from "node:test";
import assert from "node:assert/strict";
import { extractWorkspaceSymbols } from "../server/src/workspaceSymbols";

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
