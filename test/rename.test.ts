// Unit tests for the symbol-aware, sigil-safe rename logic (H5). These
// exercise resolveRenameTargetFromSymbols/findRenameRanges directly against
// hand-built symbol lists, not through a live LSP connection -- server.ts
// itself can't be imported in a test process since its module load calls
// createConnection()/connection.listen() over stdio as a side effect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-textdocument";
import { findRenameRanges, findRenameRangesForTarget, IDENTIFIER_RE, RenameSymbol, resolveRenameTargetFromSymbols } from "../server/src/rename";
import { isKeyword } from "../server/src/keywordHelp";
import { extractWorkspaceSymbols } from "../server/src/workspaceSymbols";

function doc(text: string): TextDocument {
  return TextDocument.create("file:///t.pb", "purebasic", 1, text);
}

/** Offset of the cursor placed just inside `needle`'s first occurrence in `text`. */
function offsetOf(text: string, needle: string): number {
  const i = text.indexOf(needle);
  assert.ok(i >= 0, `fixture text must contain "${needle}"`);
  return i + 1;
}

test("resolveRenameTargetFromSymbols accepts a known procedure", () => {
  const text = "Define c.i = Add(1, 2)";
  const symbols: RenameSymbol[] = [{ name: "Add", kind: "procedure", line: 0 }];
  const target = resolveRenameTargetFromSymbols(text, offsetOf(text, "Add"), symbols);
  assert.ok(target);
  assert.equal(target.bareName, "Add");
  assert.equal(target.sigil, "");
  assert.equal(target.scope, undefined);
  assert.equal(text.slice(target.range.start, target.range.end), "Add");
  assert.equal(text.indexOf("Add"), target.range.start);
});

test("resolveRenameTargetFromSymbols accepts a known structure, interface, macro, and module", () => {
  const text = "Global p.Point : If MyInterface(p) : DOUBLE(1) : MyModule::Go()";
  const symbols: RenameSymbol[] = [
    { name: "Point", kind: "structure", line: 0 },
    { name: "MyInterface", kind: "interface", line: 0 },
    { name: "DOUBLE", kind: "macro", line: 0 },
    { name: "MyModule", kind: "module", line: 0 },
  ];
  assert.equal(resolveRenameTargetFromSymbols(text, offsetOf(text, "Point"), symbols)?.bareName, "Point");
  assert.equal(resolveRenameTargetFromSymbols(text, offsetOf(text, "MyInterface"), symbols)?.bareName, "MyInterface");
  assert.equal(resolveRenameTargetFromSymbols(text, offsetOf(text, "DOUBLE"), symbols)?.bareName, "DOUBLE");
  assert.equal(resolveRenameTargetFromSymbols(text, offsetOf(text, "MyModule"), symbols)?.bareName, "MyModule");
});

test("resolveRenameTargetFromSymbols strips the # sigil from a constant's editable range", () => {
  const text = "x = #MAXVAL + 1";
  const symbols: RenameSymbol[] = [{ name: "MAXVAL", kind: "constant", line: 0 }];
  const target = resolveRenameTargetFromSymbols(text, offsetOf(text, "MAXVAL"), symbols);
  assert.ok(target);
  assert.equal(target.sigil, "#");
  assert.equal(target.bareName, "MAXVAL");
  // The range must exclude the '#' itself -- it sits one character before start.
  assert.equal(text[target.range.start - 1], "#");
  assert.equal(text.slice(target.range.start, target.range.end), "MAXVAL");
});

test("resolveRenameTargetFromSymbols cross-checks the sigil both ways", () => {
  // A constant named the same as a non-constant symbol (or vice versa) must
  // not match across kinds -- PB itself treats #Foo and Foo as unrelated.
  const procOnly: RenameSymbol[] = [{ name: "Foo", kind: "procedure", line: 0 }];
  assert.equal(resolveRenameTargetFromSymbols("x = #Foo", offsetOf("x = #Foo", "Foo"), procOnly), undefined);

  const constOnly: RenameSymbol[] = [{ name: "Foo", kind: "constant", line: 0 }];
  assert.equal(resolveRenameTargetFromSymbols("Foo(1)", offsetOf("Foo(1)", "Foo"), constOnly), undefined);
});

test("resolveRenameTargetFromSymbols rejects language keywords", () => {
  const text = "If x = 1 : EndIf";
  // Even if a same-named symbol somehow existed, the keyword must win.
  const symbols: RenameSymbol[] = [{ name: "If", kind: "macro", line: 0 }];
  assert.equal(resolveRenameTargetFromSymbols(text, offsetOf(text, "If"), symbols), undefined);
});

test("resolveRenameTargetFromSymbols rejects built-ins (never present in the symbol list)", () => {
  const text = "x = Str(1)";
  // resolveIncludeGraphSymbols only ever returns user-defined symbols, so a
  // built-in like Str() is rejected simply by never appearing in `symbols`.
  assert.equal(resolveRenameTargetFromSymbols(text, offsetOf(text, "Str"), []), undefined);
});

test("resolveRenameTargetFromSymbols refuses a cursor inside a comment", () => {
  const text = '; calls MyProc\nMyProc()';
  const symbols: RenameSymbol[] = [{ name: "MyProc", kind: "procedure", line: 1 }];
  assert.equal(resolveRenameTargetFromSymbols(text, offsetOf(text, "MyProc"), symbols), undefined);
});

test("resolveRenameTargetFromSymbols refuses a cursor inside a string literal", () => {
  const text = 'Debug "MyProc"\nMyProc()';
  const symbols: RenameSymbol[] = [{ name: "MyProc", kind: "procedure", line: 1 }];
  assert.equal(resolveRenameTargetFromSymbols(text, offsetOf(text, '"MyProc'), symbols), undefined);
});

test("resolveRenameTargetFromSymbols accepts a Global variable anywhere in the file", () => {
  const text = "Global counter.i = 0\ncounter = counter + 1";
  const symbols: RenameSymbol[] = [{ name: "counter", kind: "variable", line: 0 }];
  const target = resolveRenameTargetFromSymbols(text, offsetOf(text, "\ncounter") + 1, symbols);
  assert.ok(target);
  assert.equal(target.bareName, "counter");
  assert.equal(target.scope, undefined, "Global variables have no scope bound");
});

test("resolveRenameTargetFromSymbols picks the local variable whose procedure scope contains the cursor", () => {
  // Two procedures each declare their own `total` -- renaming from inside
  // ProcB's body must resolve to ProcB's declaration (line 4), not ProcA's
  // (line 1), even though both share the same bare name.
  const text = [
    "Procedure ProcA()",
    "  Protected total.i", // line 1
    "  total = 1",
    "EndProcedure",
    "Procedure ProcB()",
    "  Protected total.i", // line 5
    "  total = 2", // line 6 -- cursor here
    "EndProcedure",
  ].join("\n");
  const symbols: RenameSymbol[] = [
    { name: "total", kind: "variable", line: 1, scopeEndLine: 3 },
    { name: "total", kind: "variable", line: 5, scopeEndLine: 7 },
  ];
  const lines = text.split("\n");
  const cursorLine = 6;
  const offset = lines.slice(0, cursorLine).join("\n").length + 1 + lines[cursorLine].indexOf("total");
  const target = resolveRenameTargetFromSymbols(text, offset, symbols);
  assert.ok(target);
  assert.deepEqual(target.scope, { startLine: 5, endLine: 7 });
});

test("resolveRenameTargetFromSymbols refuses a local variable referenced outside its owning procedure", () => {
  // `total` only exists inside ProcA (lines 1-3) -- a same-spelled word
  // outside that range must not resolve to it (and, with no Global/other
  // candidate, must be refused outright).
  const text = ["Procedure ProcA()", "  Protected total.i", "  total = 1", "EndProcedure", "total = 5"].join("\n");
  const symbols: RenameSymbol[] = [{ name: "total", kind: "variable", line: 1, scopeEndLine: 3 }];
  assert.equal(resolveRenameTargetFromSymbols(text, offsetOf(text, "\ntotal = 5") + 1, symbols), undefined);
});

test("findRenameRanges finds every non-sigil occurrence and skips comments/strings", () => {
  const text = ["Procedure Add(a, b)", "  ; calls Add recursively? no it doesn't", '  Debug "Add"', "  ProcedureReturn a + b", "EndProcedure", "x = Add(1, 2)"].join("\n");
  const ranges = findRenameRanges(doc(text), "Add", "");
  // Exactly two real occurrences: the declaration and the call -- not the
  // comment or the string.
  assert.equal(ranges.length, 2);
});

test("findRenameRanges restricts a scoped variable rename to its owning procedure's lines", () => {
  const text = [
    "Procedure ProcA()", // 0
    "  Protected total.i", // 1
    "  total = 1", // 2
    "EndProcedure", // 3
    "Procedure ProcB()", // 4
    "  Protected total.i", // 5
    "  total = 2", // 6
    "EndProcedure", // 7
  ].join("\n");
  const d = doc(text);
  const ranges = findRenameRanges(d, "total", "", { startLine: 5, endLine: 7 });
  assert.equal(ranges.length, 2, "should only match ProcB's declaration and use, not ProcA's");
  for (const range of ranges) {
    assert.ok(range.start.line >= 5 && range.start.line <= 7);
  }
});

test("findRenameRanges finds constant occurrences by their bare name, excluding the # from the range", () => {
  const text = "#MAXVAL = 10\nDefine x.i = #MAXVAL + #MAXVAL";
  const d = doc(text);
  const ranges = findRenameRanges(d, "MAXVAL", "#");
  assert.equal(ranges.length, 3);
  for (const range of ranges) {
    const start = d.offsetAt(range.start);
    const end = d.offsetAt(range.end);
    assert.equal(text.slice(start, end), "MAXVAL");
    assert.equal(text[start - 1], "#", "the '#' itself must be excluded from the replaced range");
  }
});

test("findRenameRanges doesn't cross the sigil boundary in either direction", () => {
  const text = "Foo(1) : x = #Foo";
  const d = doc(text);
  assert.equal(findRenameRanges(d, "Foo", "").length, 1, "sigil-less search must not match #Foo");
  assert.equal(findRenameRanges(d, "Foo", "#").length, 1, "sigilled search must not match bare Foo");
});

test("module-qualified rename ranges stay in the selected module", () => {
  const text = [
    "DeclareModule A",
    "  Declare Run()",
    "EndDeclareModule",
    "DeclareModule B",
    "  Declare Run()",
    "EndDeclareModule",
    "Module A",
    "  Procedure Run() : EndProcedure",
    "EndModule",
    "Module B",
    "  Procedure Run() : EndProcedure",
    "EndModule",
    "A::Run() : B::Run()",
  ].join("\n");
  const symbols: RenameSymbol[] = [
    { name: "Run", kind: "procedure", line: 1, module: "A", uri: "file:///t.pb" },
    { name: "Run", kind: "procedure", line: 4, module: "B", uri: "file:///t.pb" },
  ];
  const target = resolveRenameTargetFromSymbols(text, text.lastIndexOf("A::Run") + 4, symbols, "file:///t.pb");
  assert.ok(target);
  assert.equal(target.symbol.module, "A");
  const ranges = findRenameRangesForTarget(doc(text), target);
  assert.equal(ranges.length, 3, "A declaration, implementation, and A::Run call only");
  for (const range of ranges) {
    assert.notEqual(doc(text).getText(range), "", "ranges remain valid document positions");
  }
});

test("IDENTIFIER_RE accepts valid PureBasic identifiers and rejects invalid replacement names", () => {
  for (const valid of ["Add", "_private", "Name$", "value2", "MAXVAL"]) {
    assert.ok(IDENTIFIER_RE.test(valid), `"${valid}" should be a valid identifier`);
  }
  for (const invalid of ["2Add", "has space", "Foo-Bar", "", "Foo(", "Foo.Bar", "$Foo"]) {
    assert.ok(!IDENTIFIER_RE.test(invalid), `"${invalid}" should be rejected`);
  }
});

test("isKeyword rejects a proposed replacement name that collides with a reserved keyword", () => {
  assert.ok(isKeyword("If"));
  assert.ok(isKeyword("procedure"));
  assert.ok(!isKeyword("Add"));
});

test("end-to-end: extractWorkspaceSymbols feeds resolveRenameTargetFromSymbols/findRenameRanges to correctly scope a real local-variable rename", () => {
  // Proves the whole pipeline together, not just each half in isolation.
  const text = [
    "Procedure ProcA(total.i)", // 0 -- parameter named `total`
    "  ProcedureReturn total", // 1
    "EndProcedure", // 2
    "Procedure ProcB()", // 3
    "  Protected total.i", // 4
    "  total = 2", // 5 -- cursor here
    "EndProcedure", // 6
  ].join("\n");
  const symbols = extractWorkspaceSymbols(text);
  const lines = text.split("\n");
  const offset = lines.slice(0, 5).join("\n").length + 1 + lines[5].indexOf("total");
  const target = resolveRenameTargetFromSymbols(text, offset, symbols);
  assert.ok(target);
  assert.deepEqual(target.scope, { startLine: 4, endLine: 6 });
  const d = doc(text);
  const ranges = findRenameRanges(d, target.bareName, target.sigil, target.scope);
  assert.equal(ranges.length, 2, "ProcB's declaration and use only -- not ProcA's parameter/return");
});
