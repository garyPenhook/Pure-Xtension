import * as path from "path";
import * as vscode from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from "vscode-languageclient/node";
import { resolveBackendSilent, resolveCompilerPath } from "./config";

let client: LanguageClient | undefined;

export function getClient(): LanguageClient | undefined {
  return client;
}

/** Starts (or restarts) the PureBasic language server, if a compiler is resolvable. */
export async function startLanguageClient(context: vscode.ExtensionContext): Promise<void> {
  await stopLanguageClient();

  const backend = resolveBackendSilent();
  const compilerPath = backend ? resolveCompilerPath(backend) : undefined;
  if (!compilerPath) {
    // No compiler resolved yet (or backend choice is ambiguous) — IntelliSense
    // stays off until a build/check picks a backend; language basics still work.
    return;
  }

  const serverModule = context.asAbsolutePath(path.join("dist", "server.js"));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "purebasic" }],
    initializationOptions: {
      compilerPath,
      cacheDir: context.globalStorageUri.fsPath,
    },
  };

  const newClient = new LanguageClient(
    "pureXtension",
    "Pure Xtension Language Server",
    serverOptions,
    clientOptions,
  );

  try {
    await newClient.start();
    client = newClient;
  } catch (error) {
    // Don't leave `client` pointing at an instance that never started —
    // stop()/sendRequest() on it would themselves throw on the next call.
    vscode.window.showErrorMessage(
      `Pure Xtension: language server failed to start: ${String(error)}`,
    );
  }
}

export async function stopLanguageClient(): Promise<void> {
  if (client) {
    await client.stop();
    client = undefined;
  }
}

export async function rebuildSymbolCacheCommand(): Promise<void> {
  if (!client) {
    vscode.window.showWarningMessage("Pure Xtension: language server is not running.");
    return;
  }
  await client.sendRequest("pureXtension/rebuildSymbolCache");
  vscode.window.showInformationMessage("Pure Xtension: symbol cache rebuilt.");
}

export async function rebuildHelpIndexCommand(): Promise<void> {
  if (!client) {
    vscode.window.showWarningMessage("Pure Xtension: language server is not running.");
    return;
  }
  await client.sendRequest("pureXtension/rebuildHelpIndex");
  vscode.window.showInformationMessage("Pure Xtension: help index refreshed from purebasic.com.");
}

/** Resolves the purebasic.com documentation URL for a command name, or undefined
 *  if the language server isn't running or the symbol isn't a known built-in. */
export async function resolveHelpUrl(symbol: string): Promise<string | undefined> {
  if (!client) return undefined;
  const result = await client.sendRequest<{ url?: string }>("pureXtension/helpUrl", { symbol });
  return result.url;
}
