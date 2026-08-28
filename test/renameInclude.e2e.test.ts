// H9 regression: a rename initiated in a main file must also change the
// declaration in an included on-disk file.  This drives the bundled server,
// rather than only the scanner helpers, to cover WorkspaceEdit ownership.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { forkServer, LspIpcClient, offsetToPosition } from "./support/lspServerHarness";

let child: ChildProcess | undefined;
let tempDir: string | undefined;
after(async () => {
  child?.kill();
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

test("rename emits edits for a declaration in an included on-disk source", async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pure-xtension-rename-"));
  const mainPath = path.join(tempDir, "main.pb");
  const includePath = path.join(tempDir, "api.pbi");
  const includeText = ["Procedure SharedName()", "EndProcedure", "SharedName()"].join("\n");
  const mainText = ['IncludeFile "api.pbi"', "SharedName()"].join("\n");
  await fs.writeFile(includePath, includeText);
  await fs.writeFile(mainPath, mainText);
  const mainUri = pathToFileURL(mainPath).toString();
  const includeUri = pathToFileURL(includePath).toString();

  child = forkServer();
  const client = new LspIpcClient(child);
  await client.request("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(tempDir).toString(),
    capabilities: {},
    initializationOptions: { compilerPath: "", cacheDir: "" },
  });
  client.notify("initialized", {});
  // Deliberately keep only the main document open: the include must be read
  // from disk and still receive a WorkspaceEdit.
  client.notify("textDocument/didOpen", {
    textDocument: { uri: mainUri, languageId: "purebasic", version: 1, text: mainText },
  });

  const edit = await client.request<{ changes?: Record<string, Array<{ newText: string }>> }>("textDocument/rename", {
    textDocument: { uri: mainUri },
    position: offsetToPosition(mainText, mainText.lastIndexOf("SharedName") + 2),
    newName: "Renamed",
  });
  assert.equal(edit.changes?.[mainUri]?.length, 1, `the call in the main source should be edited: ${JSON.stringify(edit)}`);
  assert.equal(edit.changes?.[includeUri]?.length, 2, "the include's declaration and use should be edited too");
  assert.ok(edit.changes?.[includeUri]?.every((change) => change.newText === "Renamed"));
});
