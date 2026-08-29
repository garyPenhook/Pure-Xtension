import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import test from "node:test";

const nodeRequire = createRequire(__filename);
const { problemMatchersForTask, CompileExecution, PureBasicTaskProvider } = nodeRequire(
  "../../out-test/taskProvider.cjs",
) as {
  problemMatchersForTask(mode: "build" | "buildRun" | "check" | "buildDebug" | "buildConsole"): string[];
  CompileExecution: new (
    compilerPath: string,
    sourceFile: string,
    spec: { mode: string; label: string; extraArgs: string[]; runAfter: boolean },
    cwd: string,
  ) => {
    onDidClose: (listener: (code: number) => void) => void;
    open(): void;
  };
  PureBasicTaskProvider: new () => { provideTasks(): Promise<unknown[]> };
};

/** Mirrors config.ts's env/PATH compiler resolution enough to decide whether both backends are installed here. */
function findPbCompiler(binary: "pbcompiler" | "pbcompilerc"): string | undefined {
  const home = process.env.PUREBASIC_HOME;
  if (home) {
    const candidate = path.join(home, "compilers", binary);
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, binary))) return path.join(dir, binary);
  }
  return undefined;
}
const hasBothBackends = Boolean(findPbCompiler("pbcompiler") && findPbCompiler("pbcompilerc"));

test("every compiler task mode attaches both the main-file and included-file problem matchers", () => {
  for (const mode of ["build", "buildRun", "check", "buildDebug", "buildConsole"] as const) {
    assert.deepEqual(problemMatchersForTask(mode), ["$purebasic", "$purebasic-include"], mode);
  }
});

test("a missing compiler executable closes the task pseudoterminal exactly once", async () => {
  const exec = new CompileExecution(
    "/definitely/not/a/real/purebasic-compiler-xyz",
    "/tmp/pure-xtension-taskprovider-missing-exe-test.pb",
    { mode: "build", label: "Build", extraArgs: [], runAfter: false },
    "/tmp",
  );
  const closeCodes: number[] = [];
  await new Promise<void>((resolve) => {
    exec.onDidClose((code) => {
      closeCodes.push(code);
      // Give a second, buggy close/error emission a chance to arrive before
      // asserting — a duplicate would otherwise race the test's own resolve.
      setTimeout(resolve, 100);
    });
    exec.open();
  });
  assert.deepEqual(closeCodes, [1]);
});

test(
  "provideTasks() never opens the backend picker, even in ambiguous auto mode with an active file",
  { skip: hasBothBackends ? false : "requires both the ASM and C PureBasic backends installed" },
  async () => {
    // L6: provideTasks() used to resolve the backend interactively once per
    // task spec (five specs) instead of once per call, and did so even
    // though VS Code invokes this for passive task discovery, not just when
    // the user explicitly asks to build. With both backends installed and
    // no `pureXtension.backend` setting (this bundle's stub always returns
    // the caller-supplied default), auto mode is genuinely ambiguous here —
    // exactly the condition that used to trigger up to five consecutive
    // showQuickPick prompts on every cancelled pick.
    (globalThis as Record<string, unknown>).__pureXtensionTestActiveFile = "/tmp/pure-xtension-taskprovider-active.pb";
    (globalThis as Record<string, unknown>).__pureXtensionTestQuickPickCalls = 0;
    try {
      const tasks = await new PureBasicTaskProvider().provideTasks();
      assert.equal(
        (globalThis as Record<string, unknown>).__pureXtensionTestQuickPickCalls,
        0,
        "task discovery must never prompt interactively, unsolicited or otherwise",
      );
      // Ambiguous auto mode with nothing persisted yet silently contributes
      // no tasks from discovery — the interactive resolution now happens
      // once, explicitly, in extension.ts's runTask() when the user asks to
      // build/run/check and discovery came back empty.
      assert.deepEqual(tasks, []);
    } finally {
      delete (globalThis as Record<string, unknown>).__pureXtensionTestActiveFile;
      delete (globalThis as Record<string, unknown>).__pureXtensionTestQuickPickCalls;
    }
  },
);
