import * as path from "path";
import Mocha from "mocha";
import { RESULT_FILE_ENV, writeVsCodeTestResult } from "../resultFile";

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: "tdd", timeout: 120000, color: false });
  // hoverFirstRequest must load (and therefore run) first: it verifies the very
  // first hover request in the session, before any other suite's completion or
  // signature-help requests have a chance to warm the built-in index.
  mocha.addFile(path.resolve(__dirname, "hoverFirstRequest.test.js"));
  mocha.addFile(path.resolve(__dirname, "debugSession.test.js"));
  mocha.addFile(path.resolve(__dirname, "configRestart.test.js"));
  mocha.addFile(path.resolve(__dirname, "taskProblemMatcher.test.js"));
  mocha.addFile(path.resolve(__dirname, "taskBackendPrompt.test.js"));

  try {
    await new Promise<void>((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) reject(new Error(`${failures} test(s) failed.`));
        else resolve();
      });
    } catch (err) {
      reject(err);
    }
    });
    await writeVsCodeTestResult(process.env[RESULT_FILE_ENV], { status: "passed" });
  } catch (err) {
    const error = err instanceof Error ? (err.stack ?? err.message) : String(err);
    // Do not hide the original Mocha failure if reporting itself fails.  The
    // outer runner will reject a missing result record as a harness failure.
    await writeVsCodeTestResult(process.env[RESULT_FILE_ENV], { status: "failed", error }).catch(() => undefined);
    throw err;
  }
}
