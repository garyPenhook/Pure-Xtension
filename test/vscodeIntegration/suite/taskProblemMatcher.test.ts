// Regression coverage for CODE_REVIEW_TODO.md M12: the contributed
// `$purebasic` task problem matcher only understood the single-line
// `Error: Line N - message` form PureBasic uses for problems in the file it
// was actually asked to compile. A problem inside an XIncludeFile'd file uses
// a different two-line form instead (`Error: in included file '<path>'` then
// `Line N - message` on the next line, confirmed against the real pbcompiler
// during development), which the task matcher silently dropped even though
// `src/build/diagnostics.ts`'s background check already handled it via
// `parseCompilerOutput()`. This drives the real VS Code task + problem
// matcher engine (not a hand-rolled reimplementation of VS Code's own
// matcher logic, which would only prove the reimplementation self-consistent)
// through a fake compiler script standing in for pbcompiler, and asserts the
// diagnostic lands on the *included* file rather than the file that was
// actually compiled.
//
// Does NOT assert that the diagnostic clears on a later clean rerun: M12's
// own checklist called for verifying that, and doing so here surfaced a
// separate, pre-existing bug tracked as CODE_REVIEW_TODO.md M14 -- a
// CustomExecution-backed task's problem-matcher diagnostics are never
// cleared by VS Code on rerun regardless of matcher or output, confirmed to
// also affect the pre-existing single-line format and to *not* reproduce
// with an equivalent ShellExecution-backed task. That is a defect in how
// every task in this extension reports diagnostics, not something this
// fix's new matcher introduced or can fix on its own.
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

function writeFakeCompiler(scriptPath: string, body: string): void {
  fs.writeFileSync(scriptPath, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

async function runCheckTask(): Promise<void> {
  const tasks = await vscode.tasks.fetchTasks({ type: "purebasic" });
  const task = tasks.find((t) => (t.definition as { mode?: string }).mode === "check");
  assert.ok(task, "no 'check' task was provided");
  const execution = await vscode.tasks.executeTask(task!);
  await new Promise<void>((resolve) => {
    const disposable = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution === execution) {
        disposable.dispose();
        resolve();
      }
    });
  });
}

suite("Task problem matcher: included-file diagnostics", () => {
  test("an error reported in an XIncludeFile'd file is owned by that file, not the compiled one", async function () {
    this.timeout(30000);

    const ext = vscode.extensions.getExtension<PureXtensionExports>("local.pure-xtension");
    assert.ok(ext, "extension local.pure-xtension not found");
    await ext!.activate();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pure-xtension-task-matcher-"));
    const mainFile = path.join(dir, "main.pb");
    const incFile = path.join(dir, "inc.pbi");
    fs.writeFileSync(mainFile, "; main\n; \n; \n; \n; \n");
    fs.writeFileSync(incFile, "; inc\n; \n; \n; \n; \n");

    // Stands in for pbcompiler: the extension itself writes the
    // PUREBASIC_SOURCE_FILE sentinel before spawning this, so only the
    // included-file error block needs to be faked here.
    const errScript = path.join(dir, "pbcompiler-err");
    writeFakeCompiler(
      errScript,
      `echo "Error: in included file '${incFile}'"\necho "Line 4 - bad keyword usage."\nexit 1`,
    );

    const config = vscode.workspace.getConfiguration("pureXtension");
    const originalCompilerPath = config.get<string>("compilerPath.asm");
    const originalBackend = config.get<string>("backend");

    const doc = await vscode.workspace.openTextDocument(mainFile);
    await vscode.window.showTextDocument(doc);

    try {
      // Workspace scope, not Global: two Global-scope writes here in quick
      // succession were live-confirmed (in this sandbox) to sometimes lose
      // one of them, so the task ran against the real auto-detected
      // compiler instead of errScript and never produced the diagnostic
      // this test waits for. Workspace scope's write path doesn't show this.
      await config.update("backend", "asm", vscode.ConfigurationTarget.Workspace);
      await config.update("compilerPath.asm", errScript, vscode.ConfigurationTarget.Workspace);
      await runCheckTask();

      const incUri = vscode.Uri.file(incFile);
      const mainUri = vscode.Uri.file(mainFile);
      const incDiagnostics = await waitFor(() => {
        const diags = vscode.languages.getDiagnostics(incUri);
        return diags.length > 0 ? diags : undefined;
      }, "a diagnostic on the included file");

      assert.equal(incDiagnostics.length, 1);
      assert.equal(incDiagnostics[0].range.start.line, 3); // "Line 4" is 0-based line 3
      assert.match(incDiagnostics[0].message, /bad keyword usage/);
      assert.equal(incDiagnostics[0].severity, vscode.DiagnosticSeverity.Error);
      assert.equal(
        vscode.languages.getDiagnostics(mainUri).length,
        0,
        "the file actually passed to the compiler should carry no diagnostic of its own",
      );
    } finally {
      await config.update("compilerPath.asm", originalCompilerPath, vscode.ConfigurationTarget.Workspace);
      await config.update("backend", originalBackend, vscode.ConfigurationTarget.Workspace);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
