import * as vscode from "vscode";
import { invalidateHomeCache, selectBackendCommand } from "./config";
import { PureBasicDiagnostics } from "./build/diagnostics";
import { createStatusBar } from "./build/statusBar";
import { PureBasicTaskProvider, TASK_TYPE } from "./build/taskProvider";
import {
  rebuildHelpIndexCommand,
  rebuildSymbolCacheCommand,
  resolveHelpUrl,
  startLanguageClient,
  stopLanguageClient,
} from "./client";
import { showHelpPage } from "./help/helpViewer";

function wordAt(text: string, offset: number): string | undefined {
  const isWordChar = (ch: string) => /[\w#]/.test(ch);
  let start = offset;
  let end = offset;
  while (start > 0 && isWordChar(text[start - 1])) start--;
  while (end < text.length && isWordChar(text[end])) end++;
  if (start === end) return undefined;
  return text.slice(start, end);
}

async function openHelpForSymbol(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "purebasic") return;

  const doc = editor.document;
  const offset = doc.offsetAt(editor.selection.active);
  const word = wordAt(doc.getText(), offset);
  if (!word) return;

  const url = await resolveHelpUrl(word);
  if (!url) {
    vscode.window.showInformationMessage(`Pure Xtension: no documentation found for "${word}".`);
    return;
  }
  showHelpPage(word, url);
}

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
    vscode.commands.registerCommand("pureXtension.rebuildHelpIndex", () =>
      rebuildHelpIndexCommand(),
    ),
    vscode.commands.registerCommand("pureXtension.openHelpForSymbol", () => openHelpForSymbol()),
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
