// Regression coverage for CODE_REVIEW_TODO.md M5's module-qualified symbol
// lookup: onHover/onDefinition in server/src/server.ts used to match a symbol
// by bare name alone, so a `Module::Symbol` reference could resolve to the
// wrong same-named symbol (e.g. one declared in main code, or in a different
// module) whenever it happened to come first in file order. qualifiedWordAt
// (server/src/textUtils.ts) is covered directly by unit tests; this exercises
// the full path through the real bundled dist/server.js instead, since
// onHover/onDefinition themselves can't be unit tested (server.ts's module
// load calls createConnection()/connection.listen() as a side effect).
//
// Only touches user-defined symbols, so unlike hoverBuiltinIndex.e2e.test.ts
// this needs no PureBasic compiler and never skips: ensureBuiltinIndex()
// resolves to undefined outright when compilerPath is empty.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { forkServer, LspIpcClient, offsetToPosition } from "./support/lspServerHarness";

// Deliberately declares the *main-code* CreateCar first: a naive "first
// same-named symbol wins" lookup (the pre-fix behavior) would match this one
// for a `Ferrari::CreateCar()` reference below, since it comes first in file
// order -- proving the fix actually requires the module qualifier to matter,
// not just happen to land on the right symbol either way.
const FIXTURE_TEXT = [
  "Procedure CreateCar()", // 0 -- same name in main code, must not shadow Ferrari::CreateCar
  "  ProcedureReturn 0", // 1
  "EndProcedure", // 2
  "DeclareModule Ferrari", // 3
  "  Declare CreateCar()", // 4
  "EndDeclareModule", // 5
  "Module Ferrari", // 6
  "  Procedure CreateCar()", // 7
  "    ProcedureReturn 1", // 8
  "  EndProcedure", // 9
  "EndModule", // 10
  "Ferrari::CreateCar()", // 11
].join("\n");

let child: ChildProcess | undefined;
after(() => child?.kill());

test("Module::Symbol hover and go-to-definition resolve the qualified module's own symbol", async () => {
  child = forkServer();
  const client = new LspIpcClient(child);

  await client.request("initialize", {
    processId: process.pid,
    rootUri: null,
    capabilities: {},
    initializationOptions: { compilerPath: "", cacheDir: "" },
  });
  client.notify("initialized", {});
  client.notify("textDocument/didOpen", {
    textDocument: { uri: "file:///qualified.pb", languageId: "purebasic", version: 1, text: FIXTURE_TEXT },
  });

  // Cursor on "CreateCar" in the `Ferrari::CreateCar()` call on line 11.
  const position = offsetToPosition(FIXTURE_TEXT, FIXTURE_TEXT.lastIndexOf("CreateCar") + 2);

  const hover = await client.request<{ contents?: { value?: string } } | null>("textDocument/hover", {
    textDocument: { uri: "file:///qualified.pb" },
    position,
  });
  assert.ok(hover, "expected a hover result for the qualified reference");
  assert.match(hover!.contents!.value ?? "", /CreateCar/);

  const definition = await client.request<{ uri: string; range: { start: { line: number } } } | null>(
    "textDocument/definition",
    { textDocument: { uri: "file:///qualified.pb" }, position },
  );
  assert.ok(definition, "expected a definition result for the qualified reference");
  assert.equal(
    definition!.range.start.line,
    7,
    "go-to-definition on Ferrari::CreateCar() should land on the real Procedure body inside Module Ferrari (line 7), not the DeclareModule stub or main code's same-named procedure (line 0) that comes first in file order",
  );
});
