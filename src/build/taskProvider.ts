import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { Backend, resolveBackend, resolveCompilerPath } from "../config";
import { PROBLEM_MATCHER_INCLUDE_NAME, PROBLEM_MATCHER_NAME } from "./problemMatcher";

export const TASK_TYPE = "purebasic";

export interface PureBasicTaskDefinition extends vscode.TaskDefinition {
  type: typeof TASK_TYPE;
  /** Compile action; defaults to "build". */
  mode?: "build" | "buildRun" | "check" | "buildDebug" | "buildConsole";
  /** Force a specific backend for this task; defaults to the workspace setting. */
  backend?: Backend;
  /** Source file to compile; defaults to the active editor's file. */
  file?: string;
}

interface TaskSpec {
  mode: NonNullable<PureBasicTaskDefinition["mode"]>;
  label: string;
  extraArgs: string[];
  /** Run the produced executable after a successful build. */
  runAfter: boolean;
}

/** Every contributed task invokes the compiler, so all compiler output must
 * be routed through the same matchers regardless of whether it also runs the
 * resulting executable. Two matchers are attached because PureBasic reports a
 * problem in the compiled file on one line but a problem in an XIncludeFile'd
 * file as its own two-line block (see problemMatcher.ts); each format needs
 * its own contributed pattern; VS Code applies both to the same output and
 * only the one that matches produces a diagnostic. Kept as a function to make
 * the task-mode contract directly testable without executing a compiler. */
export function problemMatchersForTask(_mode: NonNullable<PureBasicTaskDefinition["mode"]>): string[] {
  return [PROBLEM_MATCHER_NAME, PROBLEM_MATCHER_INCLUDE_NAME];
}

const TASK_SPECS: TaskSpec[] = [
  { mode: "build", label: "Build", extraArgs: [], runAfter: false },
  { mode: "buildRun", label: "Build and Run", extraArgs: [], runAfter: true },
  { mode: "check", label: "Syntax Check", extraArgs: ["-k"], runAfter: false },
  { mode: "buildDebug", label: "Build (debug)", extraArgs: ["-d", "-ds", "-l"], runAfter: false },
  { mode: "buildConsole", label: "Build (console)", extraArgs: ["-cl"], runAfter: false },
];

function activeFile(): string | undefined {
  return vscode.window.activeTextEditor?.document.uri.fsPath;
}

function outputPathFor(sourceFile: string): string {
  const parsed = path.parse(sourceFile);
  const exe = os.platform() === "win32" ? `${parsed.name}.exe` : parsed.name;
  return path.join(parsed.dir, exe);
}

/**
 * Runs the compiler (and optionally the produced binary) via spawn() with a
 * real argv array — never through a shell — so paths containing shell
 * metacharacters (`$()`, backticks, `;`, quotes...) can't be interpreted.
 */
export class CompileExecution implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number>();
  onDidWrite = this.writeEmitter.event;
  onDidClose = this.closeEmitter.event;
  private child: ChildProcessWithoutNullStreams | undefined;

  constructor(
    private readonly compilerPath: string,
    private readonly sourceFile: string,
    private readonly spec: TaskSpec,
    private readonly cwd: string,
  ) {}

  open(): void {
    this.write(`PUREBASIC_SOURCE_FILE: ${this.sourceFile}\r\n`);
    const outPath = outputPathFor(this.sourceFile);
    const args = [this.sourceFile, "-q", ...this.spec.extraArgs];
    if (this.spec.mode !== "check") {
      args.push("-o", outPath);
    }
    this.run(this.compilerPath, args, (code) => {
      if (code === 0 && this.spec.runAfter) {
        this.run(outPath, [], (runCode) => this.closeEmitter.fire(runCode ?? 1));
      } else {
        this.closeEmitter.fire(code ?? 1);
      }
    });
  }

  close(): void {
    this.child?.kill();
  }

  private run(command: string, args: string[], onExit: (code: number | null) => void): void {
    const child = spawn(command, args, { cwd: this.cwd });
    this.child = child;
    // A failed spawn (e.g. ENOENT) emits both "error" and "close" — Node
    // guarantees "close" fires even when the process never started — so this
    // guard is required to avoid running onExit (and firing closeEmitter,
    // which may itself start the "run after build" step) twice.
    let exited = false;
    const finish = (code: number | null) => {
      if (exited) {
        return;
      }
      exited = true;
      onExit(code);
    };
    child.stdout.on("data", (chunk: Buffer) => this.write(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => this.write(chunk.toString()));
    child.on("error", (err) => {
      this.write(`${err.message}\r\n`);
      finish(1);
    });
    child.on("close", (code) => finish(code));
  }

  private write(text: string): void {
    this.writeEmitter.fire(text.replace(/\r?\n/g, "\r\n"));
  }
}

async function buildTask(spec: TaskSpec, backend?: Backend, file?: string): Promise<vscode.Task | undefined> {
  const sourceFile = file ?? activeFile();
  if (!sourceFile) {
    return undefined;
  }
  const resolvedBackend = backend ?? (await resolveBackend());
  if (!resolvedBackend) {
    return undefined;
  }
  const compilerPath = resolveCompilerPath(resolvedBackend);
  if (!compilerPath) {
    return undefined;
  }

  const definition: PureBasicTaskDefinition = {
    type: TASK_TYPE,
    mode: spec.mode,
    backend: resolvedBackend,
    file: sourceFile,
  };

  const backendSuffix = resolvedBackend === "c" ? " (C backend)" : "";
  const cwd = path.dirname(sourceFile);
  const task = new vscode.Task(
    definition,
    vscode.TaskScope.Workspace,
    `${spec.label}${backendSuffix}`,
    "purebasic",
    new vscode.CustomExecution(
      async () => new CompileExecution(compilerPath, sourceFile, spec, cwd),
    ),
    problemMatchersForTask(spec.mode),
  );
  task.group = spec.mode === "build" || spec.mode === "buildRun" ? vscode.TaskGroup.Build : undefined;
  return task;
}

export class PureBasicTaskProvider implements vscode.TaskProvider {
  async provideTasks(): Promise<vscode.Task[]> {
    const tasks: vscode.Task[] = [];
    for (const spec of TASK_SPECS) {
      const task = await buildTask(spec);
      if (task) {
        tasks.push(task);
      }
    }
    return tasks;
  }

  async resolveTask(task: vscode.Task): Promise<vscode.Task | undefined> {
    const definition = task.definition as PureBasicTaskDefinition;
    const spec = TASK_SPECS.find((s) => s.mode === (definition.mode ?? "build"));
    if (!spec) {
      return undefined;
    }
    return buildTask(spec, definition.backend, definition.file);
  }
}
