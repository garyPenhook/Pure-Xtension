// Entry point for the *real* VS Code UI verification (PLAN.md §8 risk 1's
// long-standing "never verified through a real VS Code window" gap).
//
// Unlike test/pbDebugAdapter.e2e.test.ts (which drives the standalone
// stdio adapter binary directly via @vscode/debugadapter-testsupport,
// bypassing the extension host entirely), this launches a real VS Code
// process with this extension actually activated, and the test suite
// drives it through the real `vscode.debug` namespace -- the real
// DebugConfigurationProvider, the real DebugAdapterDescriptorFactory, the
// real breakpoint manager. That's the layer the standalone test cannot
// exercise at all.
//
// Uses @vscode/test-electron's runTests() rather than spawning the `code`
// CLI directly: the CLI wrapper script detaches into independent
// Electron/GPU/renderer processes that outlive it, so a plain
// child_process.spawn()'s "exit" event fires almost immediately regardless
// of whether the real test run has even started -- confirmed by watching
// `ps` after a "completed" run and finding the real window's process tree
// still alive and running. runTests() launches Electron directly (not
// through that detaching wrapper) and correctly waits for the actual test
// run to finish.
import * as fs from "fs";
import { readFile, rm } from "fs/promises";
import * as os from "os";
import * as path from "path";
import { runTests } from "@vscode/test-electron";
import { RESULT_FILE_ENV, VsCodeTestResult } from "./resultFile";

async function main() {
  // __dirname (compiled) is out-test/test/vscodeIntegration -- three levels
  // up is the real repo root (where package.json lives), not two: tsc
  // preserves the test/vscodeIntegration subtree under out-test. Getting
  // this wrong once already produced a silent near-instant "success" (VS
  // Code found no valid extension manifest at the bogus path and just did
  // nothing) -- confirmed by comparing wall-clock time against a manual run.
  const extensionDevelopmentPath = path.resolve(__dirname, "..", "..", "..");
  const extensionTestsPath = path.resolve(__dirname, "suite", "index");
  const workspacePath = path.resolve(__dirname, "fixture");

  // @vscode/test-electron must start Electron itself.  The distro's
  // /usr/bin/code-insiders shell wrapper detaches and returns before the
  // extension host runs, so prefer its real executable when no explicit test
  // binary was supplied.
  const bundledInsiders = "/usr/share/code-insiders/code-insiders";
  const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH
    || (fs.existsSync(bundledInsiders) ? bundledInsiders : "/usr/bin/code-insiders");

  // Without an isolated user-data-dir, VS Code's single-instance IPC just
  // forwards this invocation to whatever Insiders window the desktop
  // already has open (common on a real desktop, unlike CI) -- confirmed
  // live: without this, the process returned in ~2s having never actually
  // launched a fresh extension host.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pure-xtension-vscode-test-userdata-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pure-xtension-vscode-test-extensions-"));
  const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), "pure-xtension-vscode-test-result-"));
  const resultFile = path.join(resultDir, "result.json");

  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionTestsEnv: { [RESULT_FILE_ENV]: resultFile },
      launchArgs: [
        workspacePath,
        "--disable-extensions",
        "--skip-welcome",
        "--skip-release-notes",
        "--disable-workspace-trust",
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
      ],
    });

    let result: VsCodeTestResult;
    try {
      result = JSON.parse(await readFile(resultFile, "utf8")) as VsCodeTestResult;
    } catch (err) {
      throw new Error(`VS Code exited without an extension-test result record (${resultFile}): ${String(err)}`);
    }
    if (result.status !== "passed") {
      throw new Error(`VS Code extension tests failed: ${result.error ?? "no failure detail was recorded"}`);
    }
  } finally {
    await rm(resultDir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
    await rm(extensionsDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("Real VS Code UI verification failed:", err);
  process.exit(1);
});
