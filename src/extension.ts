import * as vscode from "vscode";
import { invalidateHomeCache, selectBackendCommand } from "./config";
import { PureBasicDiagnostics } from "./build/diagnostics";
import { createStatusBar } from "./build/statusBar";
import { PureBasicTaskProvider, TASK_TYPE } from "./build/taskProvider";
import { rebuildSymbolCacheCommand, startLanguageClient, stopLanguageClient } from "./client";

async function runTask(mode: "build" | "buildRun" | "check"): Promise<void> {
  const tasks = await vscode.tasks.fetchTasks({ type: TASK_TYPE });
  const task = tasks.find((t) => (t.definition as { mode?: string }).mode === mode);
  if (!task) {
    vscode.window.showErrorMessage(
      "Pure Xtension: no PureBasic compiler found. Set pureXtension.purebasicHome or pureXtension.compilerPath.*.",
    );
    return;
  }
  await vscode.tasks.executeTask(task);
}

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = new PureBasicDiagnostics();

  context.subscriptions.push(
    diagnostics,
    ...createStatusBar(),
    vscode.tasks.registerTaskProvider(TASK_TYPE, new PureBasicTaskProvider()),
    vscode.commands.registerCommand("pureXtension.helloWorld", () => {
      vscode.window.showInformationMessage("Pure Xtension is active.");
    }),
    vscode.commands.registerCommand("pureXtension.build", () => runTask("build")),
    vscode.commands.registerCommand("pureXtension.buildAndRun", () => runTask("buildRun")),
    vscode.commands.registerCommand("pureXtension.checkSyntax", () => runTask("check")),
    vscode.commands.registerCommand("pureXtension.selectBackend", async () => {
      await selectBackendCommand();
      await startLanguageClient(context);
    }),
    vscode.commands.registerCommand("pureXtension.rebuildSymbolCache", () =>
      rebuildSymbolCacheCommand(),
    ),
    vscode.workspace.onDidSaveTextDocument((doc) => diagnostics.scheduleCheck(doc)),
    vscode.workspace.onDidOpenTextDocument((doc) => diagnostics.scheduleCheck(doc)),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.clear(doc)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("pureXtension.purebasicHome")) {
        invalidateHomeCache();
      }
      if (
        e.affectsConfiguration("pureXtension.backend") ||
        e.affectsConfiguration("pureXtension.compilerPath")
      ) {
        startLanguageClient(context).catch((error) =>
          vscode.window.showErrorMessage(`Pure Xtension: ${String(error)}`),
        );
      }
    }),
  );

  for (const editor of vscode.window.visibleTextEditors) {
    diagnostics.scheduleCheck(editor.document);
  }

  void startLanguageClient(context);
}

export async function deactivate(): Promise<void> {
  await stopLanguageClient();
}
