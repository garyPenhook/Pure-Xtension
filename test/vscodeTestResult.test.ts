import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeVsCodeTestResult } from "./vscodeIntegration/resultFile";

test("VS Code test result records are atomically written for the outer runner", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pure-xtension-vscode-result-test-"));
  const resultFile = path.join(dir, "nested", "result.json");
  try {
    await writeVsCodeTestResult(resultFile, { status: "failed", error: "expected failure" });
    assert.deepEqual(JSON.parse(await readFile(resultFile, "utf8")), { status: "failed", error: "expected failure" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
