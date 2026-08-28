// Regression coverage for CODE_REVIEW_TODO.md M3: a `pureXtension.purebasicHome`
// change used to only invalidate the cached home-resolution result
// (src/config.ts's invalidateHomeCache) without ever restarting the language
// client, so a running server kept using the compiler path (and cacheDir-scoped
// built-in/help data) it started with. Verified through the real activation
// path -- via the extension's `exports`, not by importing src/client.ts
// directly, since that would be a separate module instance from the one the
// bundled `dist/extension.js` VS Code actually runs.
import * as assert from "assert";
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
});
