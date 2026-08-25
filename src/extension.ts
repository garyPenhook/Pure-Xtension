import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("pureXtension.helloWorld", () => {
      vscode.window.showInformationMessage("Pure Xtension is active.");
    }),
  );
}

export function deactivate(): void {}
