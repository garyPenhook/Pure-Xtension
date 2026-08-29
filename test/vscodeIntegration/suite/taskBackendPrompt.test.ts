// Regression coverage for CODE_REVIEW_TODO.md L6: provideTasks() used to
// resolve the backend interactively once per task spec (five specs), and did
// so during ordinary task discovery -- not just when the user actually asked
// to build. In ambiguous auto mode (both backends installed, nothing
// persisted yet) that meant up to five consecutive backend-selection
// prompts on a single cancelled pick, and an unsolicited prompt on plain
// discovery. This drives the real registered pureXtension.checkSyntax
// command (not a hand-rolled call into provideTasks()) through the real
// VS Code task system, with vscode.window.showQuickPick monkey-patched to
// count invocations, and confirms: at most one prompt for the whole build,
// and zero further prompts once the choice is persisted.
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { PureXtensionExports } from "../../../src/extension";

function writeFakeCompiler(scriptPath: string): void {
  fs.writeFileSync(scriptPath, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
}

async function runCheckAndWait(): Promise<void> {
  const ended = new Promise<void>((resolve) => {
    const disposable = vscode.tasks.onDidEndTaskProcess((e) => {
      if ((e.execution.task.definition as { mode?: string }).mode === "check") {
        disposable.dispose();
        resolve();
      }
    });
  });
  await vscode.commands.executeCommand("pureXtension.checkSyntax");
  await ended;
}

suite("Task discovery backend prompt (L6)", () => {
  test("build prompts for an ambiguous backend at most once, then the choice sticks silently", async function () {
    this.timeout(30000);

    const ext = vscode.extensions.getExtension<PureXtensionExports>("local.pure-xtension");
    assert.ok(ext, "extension local.pure-xtension not found");
    await ext!.activate();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pure-xtension-backend-prompt-"));
    const mainFile = path.join(dir, "main.pb");
    fs.writeFileSync(mainFile, "; main\n");
    const asmCompiler = path.join(dir, "fake-pbcompiler");
    const cCompiler = path.join(dir, "fake-pbcompilerc");
    writeFakeCompiler(asmCompiler);
    writeFakeCompiler(cCompiler);

    const config = vscode.workspace.getConfiguration("pureXtension");
    const originalBackend = config.get<string>("backend");
    const originalAsmPath = config.get<string>("compilerPath.asm");
    const originalCPath = config.get<string>("compilerPath.c");

    const doc = await vscode.workspace.openTextDocument(mainFile);
    await vscode.window.showTextDocument(doc);

    const originalShowQuickPick = vscode.window.showQuickPick;
    let quickPickCalls = 0;
    // config.ts's resolveBackend() passes a plain array of {label, value}
    // items -- always resolve to the first (the ASM backend) to simulate a
    // real pick rather than a dismissal, so the "second build never prompts
    // again" half of this test has a persisted choice to actually verify.
    (vscode.window as { showQuickPick: unknown }).showQuickPick = (async (items: unknown) => {
      quickPickCalls++;
      return Array.isArray(items) ? items[0] : undefined;
    }) as typeof vscode.window.showQuickPick;

    try {
      // Workspace scope (not Global): a Global update's read-back in this
      // single-folder test workspace is not guaranteed to be visible to an
      // immediately following get() in this test harness, confirmed live by
      // comparing the two -- Workspace scope resolves synchronously enough
      // for this test's own read-after-write assertions below to hold.
      await config.update("backend", "auto", vscode.ConfigurationTarget.Workspace);
      await config.update("compilerPath.asm", asmCompiler, vscode.ConfigurationTarget.Workspace);
      await config.update("compilerPath.c", cCompiler, vscode.ConfigurationTarget.Workspace);

      await runCheckAndWait();
      assert.equal(quickPickCalls, 1, "ambiguous auto mode must prompt exactly once, not once per task spec");
      assert.equal(
        vscode.workspace.getConfiguration("pureXtension").get("backend"),
        "asm",
        "the picked backend must be persisted",
      );

      await runCheckAndWait();
      assert.equal(quickPickCalls, 1, "a second build with the backend now persisted must not prompt again");
    } finally {
      vscode.window.showQuickPick = originalShowQuickPick;
      await config.update("backend", originalBackend, vscode.ConfigurationTarget.Workspace);
      await config.update("compilerPath.asm", originalAsmPath, vscode.ConfigurationTarget.Workspace);
      await config.update("compilerPath.c", originalCPath, vscode.ConfigurationTarget.Workspace);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
