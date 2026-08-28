import * as path from "path";
import Mocha from "mocha";

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "tdd", timeout: 120000, color: false });
  // hoverFirstRequest must load (and therefore run) first: it verifies the very
  // first hover request in the session, before any other suite's completion or
  // signature-help requests have a chance to warm the built-in index.
  mocha.addFile(path.resolve(__dirname, "hoverFirstRequest.test.js"));
  mocha.addFile(path.resolve(__dirname, "debugSession.test.js"));
  mocha.addFile(path.resolve(__dirname, "configRestart.test.js"));

  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) reject(new Error(`${failures} test(s) failed.`));
        else resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}
