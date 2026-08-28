import { execFile } from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { resolveBackendSilent, resolveCompilerPath } from "../config";
import { DiagnosticGenerations, DiagnosticOwnership } from "./diagnosticOwnership";
import { parseCompilerOutput, toDiagnostic } from "./problemMatcher";

const CHECK_DEBOUNCE_MS = 400;

export class PureBasicDiagnostics implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Diagnostics remain attributable to their main document. This prevents
   * one main file from clearing a shared include's diagnostics contributed by
   * another still-open main file. */
  private readonly ownership = new DiagnosticOwnership<vscode.Diagnostic>();
  /** Bumped per document on every check() call; lets a check detect a newer
   *  check for the same document started (and will finish) after it, so it
   *  can drop its own now-stale results instead of overwriting them. */
  private readonly generations = new DiagnosticGenerations();

  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection("purebasic");
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.ownership.clear();
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
    // Invalidate any check() still in flight for this document so it can't
    // land results after the document has closed.
    this.generations.advance(key);
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    this.publish(this.ownership.remove(key));
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

    const mainKey = document.uri.toString();
    const generation = this.generations.advance(mainKey);

    let stdout = "";
    let stderr = "";
    try {
      await new Promise<void>((resolve) => {
        execFile(
          compilerPath,
          ["-k", "-q", document.fileName],
          { cwd: path.dirname(document.fileName), timeout: 15000, maxBuffer: 10 * 1024 * 1024 },
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

    // A save during the execFile above may have started (and by now
    // finished) a newer check for this same document — if so, its results
    // are already current; don't let this older run overwrite them.
    if (!this.generations.isCurrent(mainKey, generation)) {
      return;
    }

    const problems = parseCompilerOutput(`${stdout}\n${stderr}`);
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
        // Loading an include is asynchronous too. Do not let an old compiler
        // run publish after a save, close, or newer check while it was open.
        if (!this.generations.isCurrent(mainKey, generation)) {
          return;
        }
      }
      const diagnostic = toDiagnostic(targetDoc, problem);
      const list = byFile.get(targetUri.toString()) ?? [];
      list.push(diagnostic);
      byFile.set(targetUri.toString(), list);
    }

    // A check could have become stale while converting the final problem.
    if (!this.generations.isCurrent(mainKey, generation)) {
      return;
    }
    this.publish(this.ownership.replace(mainKey, byFile));
  }

  private publish(uris: Iterable<string>): void {
    for (const uriString of uris) {
      const diagnostics = this.ownership.merged(uriString);
      const uri = vscode.Uri.parse(uriString);
      if (diagnostics.length === 0) {
        this.collection.delete(uri);
      } else {
        this.collection.set(uri, diagnostics);
      }
    }
  }
}
