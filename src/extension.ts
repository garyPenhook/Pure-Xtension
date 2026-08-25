import * as vscode from "vscode";
import { invalidateHomeCache, selectBackendCommand } from "./config";
import { PureBasicDiagnostics } from "./build/diagnostics";
import { createStatusBar } from "./build/statusBar";
import { PureBasicTaskProvider, TASK_TYPE } from "./build/taskProvider";
import {
  HelpEntry,
  rebuildHelpIndexCommand,
  rebuildSymbolCacheCommand,
  resolveHelpUrl,
  startLanguageClient,
  stopLanguageClient,
} from "./client";
import { disposeHelpPanel, showHelpPage } from "./help/helpViewer";
import { HelpTreeProvider, openHelpEntry, searchHelp } from "./help/helpTreeProvider";
import {
  DEBUG_TYPE,
  PureBasicDebugAdapterDescriptorFactory,
  PureBasicDebugConfigurationProvider,
} from "./debug/debugConfigProvider";

// \w is ASCII-only; PB identifiers can carry the `$` string-type suffix
// (e.g. "Name$") and, in practice, Unicode letters — \p{L} covers those too.
const WORD_CHAR = /[\w#$]|\p{L}/u;

function wordAt(text: string, offset: number): string | undefined {
  const isWordChar = (ch: string) => WORD_CHAR.test(ch);
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
  const helpTree = new HelpTreeProvider();

  // The tree's data lives behind the language client; refresh it every time the
  // client (re)starts so a sidebar expanded before the compiler resolved (or
  // before a backend switch) picks up the newly available entries.
  //
  // Serialized behind restartInFlight: selectBackend's handler and the
  // onDidChangeConfiguration listener below can both fire a restart for the
  // very same backend change (config().update() triggers the listener too),
  // and startLanguageClient() races on module-level state in client.ts
  // (stop the old client, then set the shared `client` var) — two concurrent
  // calls can interleave and leave a second, orphaned server running.
  let restartInFlight: Promise<void> | undefined;
  async function restartLanguageClient(): Promise<void> {
    if (restartInFlight) return restartInFlight;
    restartInFlight = (async () => {
      await startLanguageClient(context);
      helpTree.refresh();
    })().finally(() => {
      restartInFlight = undefined;
    });
    return restartInFlight;
  }

  context.subscriptions.push(
    diagnostics,
    ...createStatusBar(),
    vscode.tasks.registerTaskProvider(TASK_TYPE, new PureBasicTaskProvider()),
    vscode.window.registerTreeDataProvider("pureXtension.helpBrowser", helpTree),
    vscode.commands.registerCommand("pureXtension.build", () => runTask("build")),
    vscode.commands.registerCommand("pureXtension.buildAndRun", () => runTask("buildRun")),
    vscode.commands.registerCommand("pureXtension.checkSyntax", () => runTask("check")),
    vscode.commands.registerCommand("pureXtension.selectBackend", async () => {
      await selectBackendCommand();
      await restartLanguageClient();
    }),
    vscode.commands.registerCommand("pureXtension.rebuildSymbolCache", () =>
      rebuildSymbolCacheCommand(),
    ),
    vscode.commands.registerCommand("pureXtension.rebuildHelpIndex", async () => {
      await rebuildHelpIndexCommand();
      helpTree.refresh();
    }),
    vscode.commands.registerCommand("pureXtension.openHelpForSymbol", () => openHelpForSymbol()),
    vscode.commands.registerCommand("pureXtension.openHelpEntry", (entry: HelpEntry) =>
      openHelpEntry(entry),
    ),
    vscode.commands.registerCommand("pureXtension.searchHelp", () => searchHelp()),
    vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, new PureBasicDebugConfigurationProvider()),
    vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, new PureBasicDebugAdapterDescriptorFactory()),
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
        restartLanguageClient().catch((error) =>
          vscode.window.showErrorMessage(`Pure Xtension: ${String(error)}`),
        );
      }
    }),
  );

  for (const editor of vscode.window.visibleTextEditors) {
    diagnostics.scheduleCheck(editor.document);
  }

  void restartLanguageClient();
}

export async function deactivate(): Promise<void> {
  disposeHelpPanel();
  await stopLanguageClient();
}
