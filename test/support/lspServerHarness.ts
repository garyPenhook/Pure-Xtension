// Shared harness for driving the real bundled dist/server.js over its actual
// IPC transport (the same one src/client.ts's LanguageClient uses) -- the
// same way pbDebugAdapter.e2e.test.ts drives the real bundled adapter.cjs
// over stdio, but for the language server instead of the debug adapter. No
// VS Code needed to exercise the server's own request handlers.
import { ChildProcess, fork } from "node:child_process";
import * as fs from "fs";
import * as path from "path";

// Compiled to out-test/test/support/lspServerHarness.js (tsconfig.test.json
// preserves the source tree under out-test/), but dist/server.js is built by
// esbuild.mjs straight to the real repo root's dist/, not under out-test/ --
// so this needs three levels up, not one.
export const SERVER_MODULE = path.join(__dirname, "..", "..", "..", "dist", "server.js");

/** Mirrors config.ts's env/PATH compiler resolution enough to decide whether
 *  a real PureBasic install is available -- only needed by tests that
 *  exercise built-in (compiler-backed) symbols; a test that only touches
 *  user-defined symbols can pass an empty compilerPath instead of skipping. */
export function findPbCompiler(): string | undefined {
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

export function offsetToPosition(text: string, offset: number): { line: number; character: number } {
  const before = text.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length - 1, character: lines[lines.length - 1].length };
}

export class LspIpcClient {
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

export function forkServer(): ChildProcess {
  return fork(SERVER_MODULE, ["--node-ipc"], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
}
