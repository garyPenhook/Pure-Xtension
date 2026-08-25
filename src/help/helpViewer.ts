import * as vscode from "vscode";

let panel: vscode.WebviewPanel | undefined;

// Must match pageHtml's CSP frame-src below — any other host would render a
// silent blank iframe with no explanation, so those are opened externally
// instead of even creating the panel.
const ALLOWED_HELP_HOSTS = new Set(["www.purebasic.com", "purebasic.com"]);

/** Opens (or reuses) a single webview panel showing a live purebasic.com doc page in an iframe. */
export function showHelpPage(title: string, url: string): void {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    // malformed URL — fall through, treated the same as a disallowed host
  }
  if (!ALLOWED_HELP_HOSTS.has(host)) {
    void vscode.env.openExternal(vscode.Uri.parse(url));
    return;
  }

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

/** Closes the shared help panel, if open — called from deactivate() since the
 *  panel is a module-level singleton, not registered in context.subscriptions. */
export function disposeHelpPanel(): void {
  panel?.dispose();
  panel = undefined;
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
