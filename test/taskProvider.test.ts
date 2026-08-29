import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const nodeRequire = createRequire(__filename);
const { problemMatchersForTask } = nodeRequire("../../out-test/taskProvider.cjs") as {
  problemMatchersForTask(mode: "build" | "buildRun" | "check" | "buildDebug" | "buildConsole"): string[];
};

test("every compiler task mode attaches both the main-file and included-file problem matchers", () => {
  for (const mode of ["build", "buildRun", "check", "buildDebug", "buildConsole"] as const) {
    assert.deepEqual(problemMatchersForTask(mode), ["$purebasic", "$purebasic-include"], mode);
  }
});
