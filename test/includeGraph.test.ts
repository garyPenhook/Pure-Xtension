// Regression coverage for CODE_REVIEW_TODO.md M5's IncludePath and
// Declare/DeclareModule dedup pieces. Exercises resolveIncludeGraphSymbols
// against real on-disk fixture files (no open-document path involved), since
// IncludePath resolution and cross-file forward-declaration dedup only show
// up once more than one real file is on the graph.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { TextDocuments } from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { DEFAULT_MAX_INCLUDE_DEPTH, resolveIncludeGraphSymbols } from "../server/src/includeGraph";

// No open editor buffers in any of these tests -- every file is read from disk.
const noOpenDocuments = { get: () => undefined } as unknown as TextDocuments<TextDocument>;

const tmpDirs: string[] = [];
function makeTempProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pure-xtension-includegraph-test-"));
  tmpDirs.push(dir);
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return dir;
}
// Mirrors how a real LSP client actually builds a document URI (properly
// percent-encoded) -- a naive "file://" + path concatenation is exactly the
// bug L7 fixed in includeGraph.ts itself, so the test helper must not
// reintroduce it, or these tests would only prove a hand-rolled encoder
// agrees with itself.
function uriFor(dir: string, relPath: string): string {
  return URI.file(path.join(dir, relPath)).toString();
}

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test("IncludePath is tried as an additional base for later IncludeFile calls in the same file", async () => {
  const dir = makeTempProject({
    "main.pb": ['IncludePath "libs"', 'IncludeFile "helper.pb"'].join("\n"),
    "libs/helper.pb": "Global HelperVar",
  });

  const symbols = await resolveIncludeGraphSymbols(uriFor(dir, "main.pb"), noOpenDocuments);
  assert.ok(
    symbols.some((s) => s.name === "HelperVar"),
    "expected helper.pb (resolved through IncludePath \"libs\") to be included",
  );
});

test("IncludePath doesn't retroactively apply to an IncludeFile that came before it", async () => {
  const dir = makeTempProject({
    "main.pb": ['IncludeFile "early.pb"', 'IncludePath "libs"', 'IncludeFile "late.pb"'].join("\n"),
    "early.pb": "Global EarlyVar", // sits next to main.pb, not under libs/
    "libs/late.pb": "Global LateVar",
  });

  const symbols = await resolveIncludeGraphSymbols(uriFor(dir, "main.pb"), noOpenDocuments);
  const names = symbols.map((s) => s.name);
  assert.ok(names.includes("EarlyVar"), "early.pb should resolve next to main.pb, before any IncludePath applies");
  assert.ok(names.includes("LateVar"), "late.pb should resolve through the IncludePath set before it");
});

test("a plain relative IncludeFile still resolves next to its own file when no IncludePath applies", async () => {
  const dir = makeTempProject({
    "main.pb": 'IncludeFile "sibling.pb"',
    "sibling.pb": "Global SiblingVar",
  });

  const symbols = await resolveIncludeGraphSymbols(uriFor(dir, "main.pb"), noOpenDocuments);
  assert.ok(symbols.some((s) => s.name === "SiblingVar"));
});

test("a Declare forward declaration is dropped in favor of the real Procedure body found elsewhere in the graph", async () => {
  const dir = makeTempProject({
    "impl.pb": [
      'IncludeFile "decl.pbi"',
      "Module Cars",
      "  Procedure CreateCar()",
      "  EndProcedure",
      "EndModule",
    ].join("\n"),
    "decl.pbi": ["DeclareModule Cars", "  Declare CreateCar()", "EndDeclareModule"].join("\n"),
  });

  const symbols = await resolveIncludeGraphSymbols(uriFor(dir, "impl.pb"), noOpenDocuments);
  const procs = symbols.filter((s) => s.kind === "procedure" && s.name === "CreateCar");
  assert.equal(procs.length, 1, "the forward declaration and the real body should collapse to one symbol");
  assert.equal(procs[0].isForwardDeclaration, undefined, "the surviving symbol should be the real implementation");
});

test("a Declare with no matching Procedure anywhere in the graph is still kept", async () => {
  const dir = makeTempProject({
    "decl.pbi": ["DeclareModule Cars", "  Declare ExternalOnly()", "EndDeclareModule"].join("\n"),
  });

  const symbols = await resolveIncludeGraphSymbols(uriFor(dir, "decl.pbi"), noOpenDocuments);
  const proc = symbols.find((s) => s.kind === "procedure" && s.name === "ExternalOnly");
  assert.ok(proc, "a Declare with no body anywhere should still be indexed");
  assert.equal(proc?.isForwardDeclaration, true);
});

test("a legitimate include chain deeper than the old 8-level cap is not silently truncated", async () => {
  // Old default was maxDepth=8; this chains 20 levels, each declaring its
  // own uniquely-named global, so a symbol from the deepest file surviving
  // proves the cap no longer cuts off a real (acyclic) project.
  const depth = 20;
  const files: Record<string, string> = {};
  for (let i = 0; i < depth; i++) {
    const next = i + 1 < depth ? `IncludeFile "level${i + 1}.pb"\n` : "";
    files[`level${i}.pb`] = `${next}Global DeepVar${i}`;
  }
  const dir = makeTempProject(files);

  const symbols = await resolveIncludeGraphSymbols(uriFor(dir, "level0.pb"), noOpenDocuments);
  const names = symbols.map((s) => s.name);
  assert.ok(
    names.includes(`DeepVar${depth - 1}`),
    `expected the deepest include's own symbol (level ${depth - 1}, well past the old cap of 8) to be reachable`,
  );
});

test("DEFAULT_MAX_INCLUDE_DEPTH is exported and used as the real default", () => {
  assert.ok(DEFAULT_MAX_INCLUDE_DEPTH > 8, "the cap must have been raised past the old silent-truncation default");
});

test("include paths containing URI-reserved characters (space, %, #, ?) and non-ASCII text resolve correctly", async () => {
  const dir = makeTempProject({
    "main.pb": [
      'IncludeFile "has space.pbi"',
      'IncludeFile "has%percent.pbi"',
      'IncludeFile "has#hash.pbi"',
      'IncludeFile "has?question.pbi"',
      'IncludeFile "héllo-wörld.pbi"',
    ].join("\n"),
    "has space.pbi": "Global SpaceVar",
    "has%percent.pbi": "Global PercentVar",
    "has#hash.pbi": "Global HashVar",
    "has?question.pbi": "Global QuestionVar",
    "héllo-wörld.pbi": "Global UnicodeVar",
  });

  const symbols = await resolveIncludeGraphSymbols(uriFor(dir, "main.pb"), noOpenDocuments);
  const byName = new Map(symbols.map((s) => [s.name, s]));
  const expected: [string, string][] = [
    ["SpaceVar", "has space.pbi"],
    ["PercentVar", "has%percent.pbi"],
    ["HashVar", "has#hash.pbi"],
    ["QuestionVar", "has?question.pbi"],
    ["UnicodeVar", "héllo-wörld.pbi"],
  ];
  for (const [name, relPath] of expected) {
    const symbol = byName.get(name);
    assert.ok(symbol, `expected ${name} from a URI-reserved-character filename to resolve`);
    // The real defect: a returned symbol.uri isn't just an internal cache
    // key -- it's handed back to a real client (e.g. as a go-to-definition
    // Location), which parses it with actual URI syntax rules. An unescaped
    // "#" or "?" there gets read as a fragment/query delimiter, silently
    // truncating everything after it -- so the round trip must go through
    // vscode-uri's own parser (what a real client uses), not this module's
    // internal functions, to actually catch that.
    assert.equal(
      URI.parse(symbol!.uri).fsPath,
      path.join(dir, relPath),
      `symbol.uri for ${relPath} must be a correctly escaped URI a real client can parse back to the exact path`,
    );
  }
});
