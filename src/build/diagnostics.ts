import { execFile } from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { resolveBackendSilent, resolveCompilerPath } from "../config";
import { parseCompilerOutput, toDiagnostic } from "./problemMatcher";

const CHECK_DEBOUNCE_MS = 400;

export class PureBasicDiagnostics implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Included-file URIs last populated for a given main-document URI, so a
   * fixed include (or one that's no longer reachable) has its diagnostics
   * cleared instead of lingering forever. */
  private readonly relatedUris = new Map<string, Set<string>>();

  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection("purebasic");
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.collection.dispose();
  }

  scheduleCheck(document: vscode.TextDocument): void {
    if (document.languageId !== "purebasic" || document.uri.scheme !== "file") {
      return;
    }
    const key = document.uri.toString();
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.check(document);
      }, CHECK_DEBOUNCE_MS),
    );
  }

  clear(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    this.collection.delete(document.uri);
    for (const relatedUri of this.relatedUris.get(key) ?? []) {
      this.collection.delete(vscode.Uri.parse(relatedUri));
    }
    this.relatedUris.delete(key);
  }

  async check(document: vscode.TextDocument): Promise<void> {
    if (document.languageId !== "purebasic" || document.uri.scheme !== "file") {
      return;
    }

    const backend = resolveBackendSilent();
    if (!backend) {
      return; // no compiler configured — stay silent, build commands will report it
    }
    const compilerPath = resolveCompilerPath(backend);
    if (!compilerPath) {
      return;
    }

    let stdout = "";
    let stderr = "";
    try {
      await new Promise<void>((resolve) => {
        execFile(
          compilerPath,
          ["-k", "-q", document.fileName],
          { cwd: path.dirname(document.fileName), timeout: 15000 },
          (_error, out, err) => {
            stdout = out;
            stderr = err;
            resolve();
          },
        );
      });
    } catch {
      return;
    }

    const problems = parseCompilerOutput(`${stdout}\n${stderr}`);
    const mainKey = document.uri.toString();
    this.collection.delete(document.uri);
    for (const staleUri of this.relatedUris.get(mainKey) ?? []) {
      this.collection.delete(vscode.Uri.parse(staleUri));
    }
    this.relatedUris.delete(mainKey);

    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const problem of problems) {
      const targetPath = problem.file ?? document.fileName;
      const targetUri = vscode.Uri.file(targetPath);
      let targetDoc = document;
      if (targetPath !== document.fileName) {
        try {
          targetDoc = await vscode.workspace.openTextDocument(targetUri);
        } catch {
          continue; // included file not readable — drop the diagnostic rather than guess a range
        }
      }
      const diagnostic = toDiagnostic(targetDoc, problem);
      const list = byFile.get(targetUri.toString()) ?? [];
      list.push(diagnostic);
      byFile.set(targetUri.toString(), list);
    }

    const related = new Set<string>();
    for (const [uriString, diagnostics] of byFile) {
      this.collection.set(vscode.Uri.parse(uriString), diagnostics);
      if (uriString !== mainKey) {
        related.add(uriString);
      }
    }
    if (related.size > 0) {
      this.relatedUris.set(mainKey, related);
    }
  }
}
