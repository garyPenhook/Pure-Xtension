// Regression coverage for CODE_REVIEW_TODO.md M4.
//
// onHover in server/src/server.ts used to read the module-level `builtinIndex`
// variable directly instead of awaiting ensureBuiltinIndex() (unlike
// onCompletion/onSignatureHelp, which both correctly await it), and nothing
// else in the server eagerly loads it. So the very first hover request in a
// freshly started session -- before any completion or signature-help request
// had a chance to kick off (and let finish) the compiler-backed index build --
// silently returned no hover for a built-in function.
//
// This drives the real bundled dist/server.js over its actual IPC transport
// (the same one src/client.ts's LanguageClient uses), the same way
// pbDebugAdapter.e2e.test.ts drives the real bundled adapter.cjs over stdio --
// no VS Code needed to exercise the server's own request handlers. It
// self-skips when no PureBasic compiler is installed (loadOrBuildBuiltinIndex
// shells out to it), matching that file's precedent.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findPbCompiler, forkServer, LspIpcClient, offsetToPosition, SERVER_MODULE } from "./support/lspServerHarness";

const compiler = findPbCompiler();
const skip = compiler ? (fs.existsSync(SERVER_MODULE) ? false : "dist/server.js not built") : "PureBasic compiler not found";

const FIXTURE_TEXT = 'Procedure.i Add(a.i, b.i)\n  Define c.i\n  c = a + b\n  Debug "line c=" + Str(c)\nEndProcedure\n';

let child: ChildProcess | undefined;
let cacheDir: string | undefined;

after(() => {
  child?.kill();
  if (cacheDir) fs.rmSync(cacheDir, { recursive: true, force: true });
});

test("the first hover request in a fresh session resolves a built-in function", { skip }, async () => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "pure-xtension-hover-e2e-"));
  child = forkServer();
  const client = new LspIpcClient(child);

  await client.request("initialize", {
    processId: process.pid,
    rootUri: null,
    capabilities: {},
    initializationOptions: { compilerPath: compiler, cacheDir },
  });
  client.notify("initialized", {});
  client.notify("textDocument/didOpen", {
    textDocument: { uri: "file:///hover-e2e.pb", languageId: "purebasic", version: 1, text: FIXTURE_TEXT },
  });

  const position = offsetToPosition(FIXTURE_TEXT, FIXTURE_TEXT.indexOf("Str(c)"));
  // This is the session's very first request after didOpen: no completion or
  // signatureHelp request has run yet to have warmed the built-in index.
  const hover = await client.request<{ contents?: { value?: string } } | null>("textDocument/hover", {
    textDocument: { uri: "file:///hover-e2e.pb" },
    position,
  });

  assert.ok(hover, "expected a hover result for the built-in Str() function on the first request");
  assert.match(hover!.contents!.value ?? "", /Str/);
});
