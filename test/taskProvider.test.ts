import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const nodeRequire = createRequire(__filename);
const { problemMatchersForTask, CompileExecution } = nodeRequire("../../out-test/taskProvider.cjs") as {
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
};

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
