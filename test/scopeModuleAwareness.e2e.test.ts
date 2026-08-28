// Regression coverage for CODE_REVIEW_TODO.md M10: completion, hover,
// definition, signature help, and references in server/src/server.ts now all
// resolve a symbol's identity through the shared resolveSymbolAt
// (server/src/symbolResolver.ts) instead of each doing its own first-match
// spelling lookup -- so a procedure's locals stay inside that procedure, and
// a module's members don't leak into (or get shadowed from) unrelated scopes.
// Drives the real bundled dist/server.js over IPC, like
// hoverModuleQualified.e2e.test.ts; only touches user-defined symbols, so no
// PureBasic compiler is needed and this never skips.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { forkServer, LspIpcClient, offsetToPosition } from "./support/lspServerHarness";

interface CompletionItemLike { label: string }
interface DefinitionLike { uri: string; range: { start: { line: number } } }
interface SignatureHelpLike { signatures?: Array<{ label: string; parameters?: unknown[] }> }
interface LocationLike { uri: string; range: { start: { line: number } } }

const URI = "file:///scope.pb";

// Deliberately gives Ferrari::Go and Porsche::Go different arities so
// signature help can prove which one it resolved, and deliberately lists
// ProcA/ProcB and Ferrari/Porsche in file order so a naive "first same-named
// match" would land on the wrong one every time this fixture exercises it.
const FIXTURE_TEXT = [
  "Procedure ProcA()", // 0
  "  Protected localVar.i", // 1
  "  localVar = 1", // 2
  "EndProcedure", // 3
  "", // 4
  "Procedure ProcB()", // 5
  "  Protected localVar.i", // 6
  "  localVar = 2", // 7 -- completion probe: only ProcB's own localVar should show
  "EndProcedure", // 8
  "", // 9
  "DeclareModule Ferrari", // 10
  "  Declare Go(speed.i)", // 11
  "EndDeclareModule", // 12
  "Module Ferrari", // 13
  "  Procedure Go(speed.i)", // 14 -- real body: definition must land here, not line 11
  "    Go(speed)", // 15 -- unqualified self-call: must resolve to Ferrari's own Go
  "  EndProcedure", // 16
  "EndModule", // 17
  "", // 18
  "DeclareModule Porsche", // 19
  "  Declare Go(speed.i, gear.i)", // 20
  "EndDeclareModule", // 21
  "Module Porsche", // 22
  "  Procedure Go(speed.i, gear.i)", // 23
  "    Go(speed, gear)", // 24 -- unqualified self-call: must resolve to Porsche's own Go
  "  EndProcedure", // 25
  "EndModule", // 26
  "", // 27
  "Ferrari::Go(10)", // 28 -- explicit qualifier from main code
].join("\n");

// One shared server/document for the whole file -- the fixture is static
// and every test only reads from it, so there's no need to pay a fresh
// fork()+initialize per test (and no need to track/kill one child per test).
let child: ChildProcess | undefined;
let client: LspIpcClient;
after(() => child?.kill());

before(async () => {
  child = forkServer();
  client = new LspIpcClient(child);
  await client.request("initialize", {
    processId: process.pid,
    rootUri: null,
    capabilities: {},
    initializationOptions: { compilerPath: "", cacheDir: "" },
  });
  client.notify("initialized", {});
  client.notify("textDocument/didOpen", {
    textDocument: { uri: URI, languageId: "purebasic", version: 1, text: FIXTURE_TEXT },
  });
});

test("completion: a procedure's locals don't leak outside their own procedure", async () => {
  const position = offsetToPosition(FIXTURE_TEXT, FIXTURE_TEXT.indexOf("  localVar = 2"));
  const items = await client.request<CompletionItemLike[]>("textDocument/completion", {
    textDocument: { uri: URI },
    position,
  });
  const localVarItems = items.filter((i) => i.label === "localVar");
  assert.equal(localVarItems.length, 1, `expected exactly ProcB's own localVar, got: ${JSON.stringify(localVarItems)}`);
});

test("completion: a module's members don't leak into a different module unqualified", async () => {
  // Cursor inside Ferrari's own Go body.
  const position = offsetToPosition(FIXTURE_TEXT, FIXTURE_TEXT.indexOf("    Go(speed)"));
  const items = await client.request<CompletionItemLike[]>("textDocument/completion", {
    textDocument: { uri: URI },
    position,
  });
  const goItems = items.filter((i) => i.label === "Go");
  assert.equal(goItems.length, 1, `expected only Ferrari's own Go, not Porsche's too: ${JSON.stringify(goItems)}`);
});

test("completion: typing Module:: only offers that module's own members", async () => {
  const position = offsetToPosition(FIXTURE_TEXT, FIXTURE_TEXT.indexOf("Ferrari::Go(10)") + "Ferrari::".length);
  const items = await client.request<CompletionItemLike[]>("textDocument/completion", {
    textDocument: { uri: URI },
    position,
  });
  assert.equal(items.filter((i) => i.label === "Go").length, 1, "Ferrari's own Go should be offered");
  assert.equal(items.filter((i) => i.label === "ProcA").length, 0, "unrelated main-code symbols must not appear after a module qualifier");
  assert.equal(items.filter((i) => i.label === "localVar").length, 0, "unrelated locals must not appear after a module qualifier");
});

test("definition: an unqualified call inside a module resolves to that module's own procedure body, not the DeclareModule stub or the other module's same-named one", async () => {
  const position = offsetToPosition(FIXTURE_TEXT, FIXTURE_TEXT.indexOf("    Go(speed)") + 4);
  const definition = await client.request<DefinitionLike | null>("textDocument/definition", {
    textDocument: { uri: URI },
    position,
  });
  assert.ok(definition, "expected a definition result");
  assert.equal(definition!.range.start.line, 14, "should land on Ferrari's real Procedure Go body, not line 11's Declare stub or Porsche's Go");
});

test("signature help: an unqualified call inside a module resolves that module's own procedure, distinguished by arity", async () => {
  const ferrariPosition = offsetToPosition(FIXTURE_TEXT, FIXTURE_TEXT.indexOf("    Go(speed)") + "    Go(".length);
  const ferrariHelp = await client.request<SignatureHelpLike | null>("textDocument/signatureHelp", {
    textDocument: { uri: URI },
    position: ferrariPosition,
  });
  assert.equal(ferrariHelp?.signatures?.[0]?.parameters?.length, 1, "Ferrari::Go takes exactly one parameter");

  const porschePosition = offsetToPosition(FIXTURE_TEXT, FIXTURE_TEXT.indexOf("    Go(speed, gear)") + "    Go(".length);
  const porscheHelp = await client.request<SignatureHelpLike | null>("textDocument/signatureHelp", {
    textDocument: { uri: URI },
    position: porschePosition,
  });
  assert.equal(porscheHelp?.signatures?.[0]?.parameters?.length, 2, "Porsche::Go takes exactly two parameters");
});

test("references: only finds Ferrari's own Go occurrences (declaration, body, self-call, and its explicit qualification), never Porsche's", async () => {
  const position = offsetToPosition(FIXTURE_TEXT, FIXTURE_TEXT.indexOf("Ferrari::Go(10)") + "Ferrari::".length);
  const locations = await client.request<LocationLike[]>("textDocument/references", {
    textDocument: { uri: URI },
    position,
    context: { includeDeclaration: true },
  });
  const lines = locations.map((l) => l.range.start.line).sort((a, b) => a - b);
  assert.deepEqual(lines, [11, 14, 15, 28], `expected exactly Ferrari's own Go occurrences, got lines: ${JSON.stringify(lines)}`);
});
