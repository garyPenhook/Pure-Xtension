import * as vscode from "vscode";

let panel: vscode.WebviewPanel | undefined;

/** Opens (or reuses) a single webview panel showing a live purebasic.com doc page in an iframe. */
export function showHelpPage(title: string, url: string): void {
  if (panel) {
    panel.title = title;
    panel.webview.html = pageHtml(title, url);
    panel.reveal(vscode.ViewColumn.Beside, true);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    "pureXtension.help",
    title,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: false },
  );
  panel.webview.html = pageHtml(title, url);
  panel.onDidDispose(() => (panel = undefined));
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function pageHtml(title: string, url: string): string {
  const csp = `default-src 'none'; frame-src https://www.purebasic.com; style-src 'unsafe-inline'`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>html,body,iframe{width:100%;height:100%;margin:0;border:0;background:#fff}</style>
</head><body><iframe title="${esc(title)}" src="${esc(url)}"></iframe></body></html>`;
}
