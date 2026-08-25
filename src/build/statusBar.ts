import * as vscode from "vscode";

export function createStatusBar(): vscode.Disposable[] {
  const buildItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  buildItem.text = "$(tools) Build";
  buildItem.tooltip = "Pure Xtension: Build";
  buildItem.command = "pureXtension.build";

  const runItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 19);
  runItem.text = "$(play) Run";
  runItem.tooltip = "Pure Xtension: Build and Run";
  runItem.command = "pureXtension.buildAndRun";

  const backendItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 18);
  backendItem.tooltip = "Pure Xtension: click to select compiler backend";
  backendItem.command = "pureXtension.selectBackend";

  function refreshVisibility(editor: vscode.TextEditor | undefined): void {
    const isPureBasic = editor?.document.languageId === "purebasic";
    for (const item of [buildItem, runItem, backendItem]) {
      if (isPureBasic) {
        item.show();
      } else {
        item.hide();
      }
    }
  }

  function refreshBackendLabel(): void {
    const backend = vscode.workspace.getConfiguration("pureXtension").get<string>("backend", "auto");
    backendItem.text = `$(package) ${backend === "c" ? "C backend" : backend === "asm" ? "ASM backend" : "auto backend"}`;
  }

  refreshVisibility(vscode.window.activeTextEditor);
  refreshBackendLabel();

  const editorListener = vscode.window.onDidChangeActiveTextEditor(refreshVisibility);
  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("pureXtension.backend")) {
      refreshBackendLabel();
    }
  });

  return [buildItem, runItem, backendItem, editorListener, configListener];
}
