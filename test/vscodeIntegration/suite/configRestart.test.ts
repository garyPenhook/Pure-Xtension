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
    const originalBackend = config.get<string>("backend");

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

      // Pin the backend explicitly: on a machine with both the ASM and C
      // backends actually installed (live-confirmed on this runner),
      // overriding only compilerPath.asm still leaves resolveBackendSilent()
      // ambiguous (the real, auto-detected C compiler is still resolvable),
      // so the client's compilerPath came back undefined instead of either
      // fake path -- the launch/build backend-selection ambiguity (M13)
      // has nothing to do with this restart-queue's own logic, so pin it
      // out rather than let it depend on what happens to be installed.
      await config.update("backend", "asm", vscode.ConfigurationTarget.Workspace);

      // Deliberately not awaited between the two updates: the second change
      // should land while the restart triggered by the first is still
      // in-flight (the language server is a real spawned process, so
      // startLanguageClient() takes long enough for this to race reliably).
      // Workspace scope, not Global: two rapid-succession Global-scope
      // writes to the same key were live-confirmed (in this sandbox) to
      // sometimes lose one of them -- the client fell back to its
      // auto-detected real compiler, meaning the setting read back empty,
      // not just slow. Workspace scope's write path doesn't show this.
      await config.update("compilerPath.asm", fakeCompilerA, vscode.ConfigurationTarget.Workspace);
      const secondUpdate = config.update(
        "compilerPath.asm",
        fakeCompilerB,
        vscode.ConfigurationTarget.Workspace,
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
      await config.update("compilerPath.asm", original, vscode.ConfigurationTarget.Workspace);
      await config.update("backend", originalBackend, vscode.ConfigurationTarget.Workspace);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
