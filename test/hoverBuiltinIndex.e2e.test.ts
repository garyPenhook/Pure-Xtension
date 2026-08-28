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
import { ChildProcess, fork } from "node:child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Compiled to out-test/test/hoverBuiltinIndex.e2e.test.js (tsconfig.test.json
// preserves the source tree under out-test/), but dist/server.js is built by
// esbuild.mjs straight to the real repo root's dist/, not under out-test/ --
// so this needs two levels up, not one.
const SERVER_MODULE = path.join(__dirname, "..", "..", "dist", "server.js");

function findPbCompiler(): string | undefined {
  const home = process.env.PUREBASIC_HOME;
  if (home) {
    const candidate = path.join(home, "compilers", "pbcompiler");
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, "pbcompiler"))) return path.join(dir, "pbcompiler");
  }
  return undefined;
}

const compiler = findPbCompiler();
const skip = compiler ? (fs.existsSync(SERVER_MODULE) ? false : "dist/server.js not built") : "PureBasic compiler not found";

const FIXTURE_TEXT = 'Procedure.i Add(a.i, b.i)\n  Define c.i\n  c = a + b\n  Debug "line c=" + Str(c)\nEndProcedure\n';

function offsetToPosition(text: string, offset: number): { line: number; character: number } {
  const before = text.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length - 1, character: lines[lines.length - 1].length };
}

class LspIpcClient {
  private nextId = 1;
  private pending = new Map<number, (msg: { result?: unknown; error?: unknown }) => void>();

  constructor(private readonly child: ChildProcess) {
    child.on("message", (msg: { id?: number; result?: unknown; error?: unknown }) => {
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!(msg);
        this.pending.delete(msg.id);
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.child.send({ jsonrpc: "2.0", method, params });
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (msg) => (msg.error ? reject(msg.error) : resolve(msg.result as T)));
      this.child.send({ jsonrpc: "2.0", id, method, params });
    });
  }
}

let child: ChildProcess | undefined;
let cacheDir: string | undefined;

after(() => {
  child?.kill();
  if (cacheDir) fs.rmSync(cacheDir, { recursive: true, force: true });
});

test("the first hover request in a fresh session resolves a built-in function", { skip }, async () => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "pure-xtension-hover-e2e-"));
  child = fork(SERVER_MODULE, ["--node-ipc"], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
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
