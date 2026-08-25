import * as vscode from "vscode";
import { PureBasicDebugSession } from "./pbDebugAdapter";

export const DEBUG_TYPE = "purebasic";

export class PureBasicDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  provideDebugConfigurations(): vscode.DebugConfiguration[] {
    return [
      {
        type: DEBUG_TYPE,
        request: "launch",
        name: "Debug current PureBasic file",
        program: "${file}",
        stopOnEntry: false,
      },
    ];
  }

  resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    if (!config.type && !config.request) {
      // Launched via F5 with no launch.json entry — fall back to the active editor.
      const editor = vscode.window.activeTextEditor;
      if (editor?.document.languageId === "purebasic") {
        config.type = DEBUG_TYPE;
        config.name = "Debug current PureBasic file";
        config.request = "launch";
        config.program = editor.document.uri.fsPath;
        config.stopOnEntry = false;
      }
    }
    if (!config.program) {
      vscode.window.showErrorMessage("Pure Xtension: no program specified to debug.");
      // undefined tells VS Code to silently cancel the launch — an empty
      // config object would instead be treated as a real, malformed one.
      return undefined;
    }
    return config;
  }
}

export class PureBasicDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    return new vscode.DebugAdapterInlineImplementation(new PureBasicDebugSession());
  }
}
