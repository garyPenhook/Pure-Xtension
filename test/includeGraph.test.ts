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
import { resolveIncludeGraphSymbols } from "../server/src/includeGraph";

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
function uriFor(dir: string, relPath: string): string {
  return "file://" + path.join(dir, relPath);
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
