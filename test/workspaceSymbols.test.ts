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
