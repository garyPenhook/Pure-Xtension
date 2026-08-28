// Bundles the debug adapter as a standalone stdio DAP server for the
// end-to-end test harness (test/pbDebugAdapter.e2e.test.ts).
//
// Unlike the extension build (esbuild.mjs), which marks `vscode` external
// because the extension host provides it, this build has no host — so the
// bare `vscode` import that ../config pulls in is aliased to a minimal stub
// (test/support/vscode-stub.js). Everything else is bundled into a single
// self-contained CJS file the test spawns via `node`.
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [path.join(here, "src/debug/pbDebugAdapterMain.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: path.join(here, "out-test/adapter.cjs"),
  alias: { vscode: path.join(here, "test/support/vscode-stub.js") },
});

// Task-provider unit tests use the same lightweight VS Code stand-in. This
// keeps the production extension bundle external to VS Code while allowing
// task construction policy to be tested in Node.
await esbuild.build({
  entryPoints: [path.join(here, "src/build/taskProvider.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: path.join(here, "out-test/taskProvider.cjs"),
  alias: { vscode: path.join(here, "test/support/vscode-stub.js") },
});
