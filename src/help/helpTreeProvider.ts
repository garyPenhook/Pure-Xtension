import * as vscode from "vscode";
import { HelpEntry, listHelpEntries } from "../client";
import { showHelpPage } from "./helpViewer";

type HelpTreeNode =
  | { kind: "category"; label: string; entries: HelpEntry[] }
  | { kind: "command"; entry: HelpEntry };

/** Extracts the library folder segment from a documentation URL,
 *  e.g. ".../documentation/string/left.html" -> "string". */
function categoryOf(entry: HelpEntry): string {
  const match = /\/documentation\/([a-z0-9_]+)\//i.exec(entry.url);
  return match ? match[1] : "other";
}

export class HelpTreeProvider implements vscode.TreeDataProvider<HelpTreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private entries: HelpEntry[] | undefined;

  /** Drops the cached entry list and notifies the tree view to reload. Called
   *  after `pureXtension.rebuildHelpIndex` so the sidebar picks up fresh data. */
  refresh(): void {
    this.entries = undefined;
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(node: HelpTreeNode): vscode.TreeItem {
    if (node.kind === "category") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon("folder");
      item.contextValue = "pureXtension.helpCategory";
      return item;
    }

    const item = new vscode.TreeItem(node.entry.name, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon("symbol-method");
    item.contextValue = "pureXtension.helpCommand";
    item.command = {
      command: "pureXtension.openHelpEntry",
      title: "Open Documentation",
      arguments: [node.entry],
    };
    return item;
  }

  async getChildren(node?: HelpTreeNode): Promise<HelpTreeNode[]> {
    if (!node) {
      const entries = await this.ensureEntries();
      const byCategory = new Map<string, HelpEntry[]>();
      for (const entry of entries) {
        const category = categoryOf(entry);
        const list = byCategory.get(category);
        if (list) list.push(entry);
        else byCategory.set(category, [entry]);
      }
      return [...byCategory.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([label, categoryEntries]) => ({ kind: "category" as const, label, entries: categoryEntries }));
    }

    if (node.kind === "category") {
      return [...node.entries]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => ({ kind: "command" as const, entry }));
    }

    return [];
  }

  private async ensureEntries(): Promise<HelpEntry[]> {
    // Retry (don't permanently cache) an empty result: the language client may
    // not have started yet (no compiler resolved), so [] here doesn't mean
    // "no help available" — call refresh()/re-expand once the client is up.
    if (!this.entries || this.entries.length === 0) {
      this.entries = await listHelpEntries();
    }
    return this.entries;
  }
}

export function openHelpEntry(entry: HelpEntry): void {
  showHelpPage(entry.name, entry.url);
}

/** Fuzzy-searchable QuickPick over every entry in the online help index — the
 *  sidebar's category tree has no filter box, so this is the "type to find a
 *  command" path (bound to the view's title bar and the command palette). */
export async function searchHelp(): Promise<void> {
  const entries = await listHelpEntries();
  if (entries.length === 0) {
    vscode.window.showInformationMessage(
      "Pure Xtension: help index isn't loaded yet — try again once the language server has started.",
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    entries
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => ({ label: entry.name, description: categoryOf(entry), entry })),
    { placeHolder: "Search PureBasic help...", matchOnDescription: true },
  );
  if (picked) openHelpEntry(picked.entry);
}
