import * as vscode from "vscode";

/**
 * PureBasic's compiler prints one problem per one or two lines:
 *   Error: Line 12 - message text.
 *   Warning: Line 12 - message text.
 * or, when the problem is in an XIncludeFile'd file, the file comes first:
 *   Error: in included file '/abs/path/inc.pbi'
 *   Line 2 - message text.
 * `file` is undefined for problems in the file that was actually passed to
 * the compiler; callers attach that document's own URI in that case.
 */
const SIMPLE_PATTERN = /^(Error|Warning):\s*Line\s+(\d+)\s*-\s*(.+)$/;
const INCLUDE_HEADER_PATTERN = /^(Error|Warning):\s*in included file\s+'(.+)'$/;
const CONTINUATION_LINE_PATTERN = /^Line\s+(\d+)\s*-\s*(.+)$/;

export interface ParsedProblem {
  file?: string; // absolute path; undefined = the file passed to the compiler
  line: number; // 1-based, as reported by the compiler
  severity: vscode.DiagnosticSeverity;
  message: string;
}

export function parseCompilerOutput(output: string): ParsedProblem[] {
  const problems: ParsedProblem[] = [];
  const lines = output.split(/\r?\n/).map((l) => l.trim());

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const includeMatch = INCLUDE_HEADER_PATTERN.exec(line);
    if (includeMatch) {
      const [, kind, file] = includeMatch;
      const next = lines[i + 1] ?? "";
      const contMatch = CONTINUATION_LINE_PATTERN.exec(next);
      if (contMatch) {
        const [, lineStr, message] = contMatch;
        problems.push({
          file,
          line: Number(lineStr),
          severity: kind === "Error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
          message,
        });
        i++; // consume the continuation line
      }
      continue;
    }

    const simpleMatch = SIMPLE_PATTERN.exec(line);
    if (simpleMatch) {
      const [, kind, lineStr, message] = simpleMatch;
      problems.push({
        line: Number(lineStr),
        severity: kind === "Error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
        message,
      });
    }
  }

  return problems;
}

export function toDiagnostic(document: vscode.TextDocument, problem: ParsedProblem): vscode.Diagnostic {
  const lineIndex = Math.max(0, Math.min(problem.line - 1, document.lineCount - 1));
  const range = document.lineAt(lineIndex).range;
  return new vscode.Diagnostic(range, problem.message, problem.severity);
}

/** Shell-facing problem matcher name, must match the one declared in package.json. */
export const PROBLEM_MATCHER_NAME = "$purebasic";
