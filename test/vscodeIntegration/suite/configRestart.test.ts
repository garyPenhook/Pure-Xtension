// Regression coverage for CODE_REVIEW_TODO.md M3: a `pureXtension.purebasicHome`
// change used to only invalidate the cached home-resolution result
// (src/config.ts's invalidateHomeCache) without ever restarting the language
// client, so a running server kept using the compiler path (and cacheDir-scoped
// built-in/help data) it started with. Verified through the real activation
// path -- via the extension's `exports`, not by importing src/client.ts
// directly, since that would be a separate module instance from the one the
// bundled `dist/extension.js` VS Code actually runs.
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { PureXtensionExports } from "../../../src/extension";

async function waitFor<T>(
  predicate: () => T | undefined | null | false,
  description: string,
  timeoutMs = 20000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

suite("Configuration-change language client restart", () => {
  test("changing purebasicHome restarts the language client", async function () {
    this.timeout(30000);

    const ext = vscode.extensions.getExtension<PureXtensionExports>("local.pure-xtension");
    assert.ok(ext, "extension local.pure-xtension not found");
    await ext!.activate();
    const exports = ext!.exports;
    assert.ok(exports, "activate() did not return exports");

    const config = vscode.workspace.getConfiguration("pureXtension");
    const original = config.get<string>("purebasicHome");
    const before = exports.getRestartCount();

    try {
      await config.update(
        "purebasicHome",
        "/tmp/pure-xtension-test-fake-home",
        vscode.ConfigurationTarget.Global,
      );
      await waitFor(
        () => exports.getRestartCount() > before,
        "language client restart triggered by a purebasicHome change",
      );
    } finally {
      await config.update("purebasicHome", original, vscode.ConfigurationTarget.Global);
    }
  });

  // Regression coverage for CODE_REVIEW_TODO.md M11: restartLanguageClient()
  // used to coalesce every call into whichever restart was already running.
  // If a second compiler-path change arrived after the in-flight restart had
  // already read the (now stale) configuration but before it finished, that
  // second change scheduled no follow-up restart, leaving the server on a
  // superseded compilerPath. This fires two compilerPath.asm changes back to
  // back, without waiting for the first restart to finish, and asserts the
  // language client converges on the *second* (last) value rather than the
  // first.
  test("two reordered compilerPath changes converge on the last value", async function () {
    this.timeout(30000);

    const ext = vscode.extensions.getExtension<PureXtensionExports>("local.pure-xtension");
    assert.ok(ext, "extension local.pure-xtension not found");
    await ext!.activate();
    const exports = ext!.exports;
    assert.ok(exports, "activate() did not return exports");

    const config = vscode.workspace.getConfiguration("pureXtension");
    const original = config.get<string>("compilerPath.asm");

    // fs.existsSync() is all resolveCompilerPath() checks -- these don't need
    // to be real compilers, just present on disk, so the test doesn't depend
    // on a PureBasic install being available in this environment.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pure-xtension-restart-queue-"));
    const fakeCompilerA = path.join(dir, "pbcompiler-a");
    const fakeCompilerB = path.join(dir, "pbcompiler-b");
    fs.writeFileSync(fakeCompilerA, "");
    fs.writeFileSync(fakeCompilerB, "");

    try {
      const before = exports.getRestartCount();

      // Deliberately not awaited between the two updates: the second change
      // should land while the restart triggered by the first is still
      // in-flight (the language server is a real spawned process, so
      // startLanguageClient() takes long enough for this to race reliably).
      await config.update("compilerPath.asm", fakeCompilerA, vscode.ConfigurationTarget.Global);
      const secondUpdate = config.update(
        "compilerPath.asm",
        fakeCompilerB,
        vscode.ConfigurationTarget.Global,
      );

      await secondUpdate;
      await waitFor(
        () => exports.getRestartCount() >= before + 2,
        "both compilerPath changes triggered a restart request",
      );
      await waitFor(
        () => exports.getLastCompilerPath() === fakeCompilerB,
        `language client converged on the last compilerPath (${fakeCompilerB}), ` +
          `saw ${String(exports.getLastCompilerPath())}`,
      );
    } finally {
      await config.update("compilerPath.asm", original, vscode.ConfigurationTarget.Global);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
