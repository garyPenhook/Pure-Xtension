// Regression coverage for CODE_REVIEW_TODO.md M4: `onHover` in server/src/server.ts
// used to read the module-level `builtinIndex` variable directly instead of
// awaiting `ensureBuiltinIndex()` (as onCompletion/onSignatureHelp both correctly
// do), and nothing else in the server eagerly loads it. So the very first hover
// request in a freshly started session -- before any completion or signature-help
// request had a chance to kick off (and let complete) the compiler-backed index
// build -- silently returned nothing for a built-in function.
//
// This must run before any other suite sends the server a completion or
// signature-help request, or it would no longer exercise a "fresh" index -- see
// suite/index.ts, which adds this file first.
import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";

suite("First hover request in a fresh session", () => {
  test("hovering a built-in function resolves without a prior warming request", async function () {
    this.timeout(30000);

    // The test runner intentionally exposes both compiler backends, making
    // `auto` ambiguous.  Pick ASM before activation so the client exists;
    // this is configuration, not a request that could warm the index.
    const config = vscode.workspace.getConfiguration("pureXtension");
    const originalBackend = config.get<string>("backend");
    await config.update("backend", "asm", vscode.ConfigurationTarget.Global);

    const ext = vscode.extensions.getExtension("local.pure-xtension");
    assert.ok(ext, "extension local.pure-xtension not found");
    await ext!.activate();

    const fixturePath = path.resolve(__dirname, "..", "fixture", "test-step.pb");
    const doc = await vscode.workspace.openTextDocument(fixturePath);
    await vscode.window.showTextDocument(doc);

    // Activation starts the language client asynchronously.  Waiting for that
    // startup window does not send a completion/signature/hover request, so
    // the hover below is still the server's first built-in-index consumer.
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const text = doc.getText();
    const strOffset = text.indexOf("Str(c)");
    assert.ok(strOffset >= 0, "fixture must contain a Str(...) call");
    const position = doc.positionAt(strOffset);

    try {
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        doc.uri,
        position,
      );

      assert.ok(hovers && hovers.length > 0, "expected a hover result for the built-in Str() function");
      const contents = hovers[0].contents
        .map((c) => (typeof c === "string" ? c : c.value))
        .join("\n");
      assert.match(contents, /Str/);
    } finally {
      await config.update("backend", originalBackend, vscode.ConfigurationTarget.Global);
    }
  });
});
