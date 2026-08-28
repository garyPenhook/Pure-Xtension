import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const RESULT_FILE_ENV = "PURE_XTENSION_VSCODE_TEST_RESULT_FILE";

export interface VsCodeTestResult {
  status: "passed" | "failed";
  error?: string;
}

/**
 * The Electron process reports only its own exit status, which is not a
 * reliable indication of extension-host Mocha failures.  The extension host
 * therefore writes this small, atomically replaced result record for the
 * parent runner to verify after VS Code exits.
 */
export async function writeVsCodeTestResult(resultFile: string | undefined, result: VsCodeTestResult): Promise<void> {
  if (!resultFile) return;

  await mkdir(path.dirname(resultFile), { recursive: true });
  const temporary = `${resultFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(result), "utf8");
  await rename(temporary, resultFile);
}
