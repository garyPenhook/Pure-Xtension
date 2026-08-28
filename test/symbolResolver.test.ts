// Unit tests for the shared symbol-identity resolution (M10,
// CODE_REVIEW_TODO.md): the module-visibility pieces that rename.ts's
// resolveRenameTargetFromSymbols didn't need, now shared with completion/
// hover/definition/signature-help/references. Everything rename.ts already
// covers (word/sigil/scope resolution) stays under test/rename.test.ts,
// which exercises the same resolveSymbolAt function through its
// resolveRenameTargetFromSymbols alias.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LookupSymbol, enclosingModuleAt, isVisibleUnqualified, pickVisibleCandidate, resolveSymbolAt } from "../server/src/symbolResolver";

test("enclosingModuleAt returns undefined outside any module block", () => {
  const text = ["Procedure Main()", "EndProcedure", "Main()"].join("\n");
  assert.equal(enclosingModuleAt(text, 2), undefined);
});

test("enclosingModuleAt tracks entry/exit of both DeclareModule and Module bodies", () => {
  const text = [
    "DeclareModule Ferrari", // 0
    "  Declare Init()", // 1
    "EndDeclareModule", // 2
    "Module Ferrari", // 3
    "  Procedure Init()", // 4
    "  EndProcedure", // 5
    "EndModule", // 6
    "Init()", // 7 -- outside again
  ].join("\n");
  assert.equal(enclosingModuleAt(text, 1), "Ferrari");
  assert.equal(enclosingModuleAt(text, 4), "Ferrari");
  assert.equal(enclosingModuleAt(text, 7), undefined);
});

test("enclosingModuleAt distinguishes two sequential modules", () => {
  const text = ["Module A", "EndModule", "Module B", "  Procedure P()", "  EndProcedure", "EndModule"].join("\n");
  assert.equal(enclosingModuleAt(text, 0), "A");
  assert.equal(enclosingModuleAt(text, 3), "B");
});

test("isVisibleUnqualified: main code sees main code, a module sees its own members, nothing crosses", () => {
  assert.equal(isVisibleUnqualified(undefined, undefined), true, "main code symbol from main code cursor");
  assert.equal(isVisibleUnqualified("Ferrari", "Ferrari"), true, "own module's member from inside it");
  assert.equal(isVisibleUnqualified("Ferrari", undefined), false, "module member invisible from main code unqualified");
  assert.equal(isVisibleUnqualified(undefined, "Ferrari"), false, "main-code global invisible from inside a module");
  assert.equal(isVisibleUnqualified("Ferrari", "Porsche"), false, "one module's member invisible from another");
});

test("pickVisibleCandidate: explicit qualifier wins outright over visibility", () => {
  const candidates = [{ module: "Ferrari" }, { module: "Porsche" }];
  assert.equal(pickVisibleCandidate(candidates, "Porsche", "Ferrari"), candidates[1]);
});

test("pickVisibleCandidate: prefers the cursor's own module when unqualified", () => {
  const candidates = [{ module: "Ferrari" }, { module: "Porsche" }];
  assert.equal(pickVisibleCandidate(candidates, undefined, "Porsche"), candidates[1]);
});

test("pickVisibleCandidate: falls back to the first candidate when none matches the cursor's module", () => {
  const candidates = [{ module: "Ferrari" }, { module: "Porsche" }];
  assert.equal(pickVisibleCandidate(candidates, undefined, undefined), candidates[0]);
});

test("resolveSymbolAt: an unqualified reference inside a module prefers that module's own member over a same-named one elsewhere", () => {
  const text = [
    "Module Ferrari", // 0
    "  Procedure Init()", // 1
    "    Init()", // 2 -- unqualified call, must resolve to Ferrari's own Init
    "  EndProcedure", // 3
    "EndModule", // 4
    "Procedure Init()", // 5 -- unrelated main-code Init, comes first in `symbols` order
    "EndProcedure", // 6
  ].join("\n");
  const symbols: LookupSymbol[] = [
    { name: "Init", kind: "procedure", line: 5 }, // main code, listed first on purpose
    { name: "Init", kind: "procedure", line: 1, module: "Ferrari" },
  ];
  const lines = text.split("\n");
  const cursorLine = 2;
  const offset = lines.slice(0, cursorLine).join("\n").length + 1 + lines[cursorLine].indexOf("Init");
  const target = resolveSymbolAt(text, offset, symbols);
  assert.ok(target);
  assert.equal(target.symbol.module, "Ferrari", "must resolve to Ferrari's own Init, not the main-code one listed first");
});

test("resolveSymbolAt: an unqualified reference in main code prefers a main-code symbol over a module's same-named member", () => {
  const text = ["Procedure Init()", "EndProcedure", "Init()"].join("\n");
  const symbols: LookupSymbol[] = [
    { name: "Init", kind: "procedure", line: 0, module: "Ferrari" }, // listed first on purpose
    { name: "Init", kind: "procedure", line: 0 },
  ];
  const target = resolveSymbolAt(text, text.lastIndexOf("Init") + 1, symbols);
  assert.ok(target);
  assert.equal(target.symbol.module, undefined, "must resolve to the main-code Init, not Ferrari's");
});

test("resolveSymbolAt: an explicit Module::Name qualifier still wins regardless of the cursor's own module", () => {
  const text = ["Module Porsche", "  Ferrari::Init()", "EndModule"].join("\n");
  const symbols: LookupSymbol[] = [
    { name: "Init", kind: "procedure", line: 0, module: "Porsche" },
    { name: "Init", kind: "procedure", line: 0, module: "Ferrari" },
  ];
  const target = resolveSymbolAt(text, text.lastIndexOf("Init") + 1, symbols);
  assert.ok(target);
  assert.equal(target.symbol.module, "Ferrari");
});

test("resolveSymbolAt: a scoped local still wins over the module-visibility tiebreaker", () => {
  // The tiebreaker only applies among unscoped candidates -- a matching
  // local in the enclosing procedure must still take priority.
  const text = ["Module Ferrari", "  Procedure Run()", "    Protected x.i", "    x = 1", "  EndProcedure", "EndModule"].join("\n");
  const symbols: LookupSymbol[] = [
    { name: "x", kind: "variable", line: 2, scopeEndLine: 4, module: "Ferrari" },
    { name: "x", kind: "variable", line: 0 }, // unrelated global, would win the old fallback
  ];
  const target = resolveSymbolAt(text, text.lastIndexOf("x = 1"), symbols);
  assert.ok(target);
  assert.deepEqual(target.scope, { startLine: 2, endLine: 4 });
});
