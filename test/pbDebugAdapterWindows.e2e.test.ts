// Windows-support validation for the PureBasic debug adapter, run against a
// genuine Windows PureBasic install executing under Wine on this Linux
// sandbox -- there is no real Windows machine available here.
//
// This is not a simulation: pbcompiler.exe/pbcompilerc.exe are the actual
// Windows binaries from a real PureBasic 6.41 Windows installer, and
// target.bin is a real Wine-compiled PE executable, run via `wine target.bin`
// exactly as CODE_REVIEW_TODO.md's Windows-support work requires. What Wine
// cannot validate -- real Windows process-termination semantics
// (TerminateProcess vs. SIGKILL), and anything GDB/ptrace-based (Force Pause,
// which is already unconditionally gated to Linux) -- is out of scope here
// and still needs a real Windows machine before the platform gate
// (shouldRefuseUnvalidatedPlatformLaunch) is opened for win32.
//
// Self-skips unless both `wine` and a Windows PureBasic install are present:
//   - `wine` on PATH
//   - PUREBASIC_HOME_WINDOWS pointing at the Windows install directory as
//     seen from Linux (e.g. ~/.wine-purebasic/drive_c/PureBasic), containing
//     Compilers/pbcompiler.exe
//   - WINEPREFIX (standard Wine env var) set to that install's Wine prefix
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DebugClient } from "@vscode/debugadapter-testsupport";

// The adapter only honors exeRunner/compilerPath (test-only launch args)
// when this is set -- closes a real gap where a workspace's own launch.json
// could otherwise reach them (see testOnlyLaunchHooks() in
// pbDebugAdapter.ts). Set here, in the test *process*, so the adapter child
// DebugClient spawns below inherits it.
process.env.PURE_XTENSION_E2E_TEST_HOOKS = "1";

const MAIN_THREAD_ID = 1;
const ADAPTER = path.join(__dirname, "..", "adapter.cjs");
// frames()/localsOf() intentionally duplicate pbDebugAdapter.e2e.test.ts's
// own copies rather than importing them: node:test loads every *.test.js
// file directly and executes top-level module code as a side effect of
// import, so importing that file here would re-register its entire test
// suite a second time whenever both files run in the same `node --test`
// invocation (e.g. the normal `npm test` glob).
async function frames(dc: DebugClient) {
  return (await dc.stackTraceRequest({ threadId: MAIN_THREAD_ID })).body.stackFrames;
}

async function localsOf(dc: DebugClient, frameId: number): Promise<Map<string, string>> {
  const scopes = await dc.scopesRequest({ frameId });
  const vars = await dc.variablesRequest({ variablesReference: scopes.body.scopes[0].variablesReference });
  return new Map(vars.body.variables.map((v) => [v.name, v.value]));
}

const winePrefix = process.env.WINEPREFIX;
const pbHomeWindows = process.env.PUREBASIC_HOME_WINDOWS;
const compilerWindows = pbHomeWindows ? path.join(pbHomeWindows, "Compilers", "pbcompiler.exe") : undefined;
const wineOnPath = (process.env.PATH ?? "")
  .split(path.delimiter)
  .some((dir) => dir && fs.existsSync(path.join(dir, "wine")));

const skip =
  winePrefix && compilerWindows && fs.existsSync(compilerWindows) && wineOnPath
    ? false
    : "requires wine on PATH, WINEPREFIX, and PUREBASIC_HOME_WINDOWS pointing at a real Windows PureBasic install";

// Mirrors pbDebugAdapter.e2e.test.ts's MODULE_BP fixture shape, but without
// any IncludeFile: the target's own Init message reports its source root in
// Wine's "Z:\..." form (see toWinePath() in src/debug/pbSession.ts), which
// only the compiler's own -o/source-file arguments need converted to --
// resolving an *included* file's path would need reconciling that Windows
// -form root against this test's Linux-side paths too, which is out of
// scope for what this test is validating (the wire protocol and target
// binary behavior under Wine, not include-path bridging no real Windows or
// Linux user would ever need).
const FIXTURE_LINES = [
  "Global a.i = 3", // 1
  "Global b.i = 4", // 2
  'Debug "a=" + Str(a)', // 3 <-- module-scope breakpoint
  "Global c.i = a + b", // 4
  'Debug "c=" + Str(c)', // 5
];
const MODULE_BP = 3;

let fixtureDir: string | undefined;
let program = "";
if (!skip) {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "pure-xtension-e2e-windows-"));
  program = path.join(fixtureDir, "fixture.pb");
  fs.writeFileSync(program, FIXTURE_LINES.join("\n") + "\n");
}

after(() => {
  if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
});

test(
  "Windows (via Wine): a real Windows PureBasic compile + target hits a breakpoint, reads locals, and terminates",
  { skip, timeout: 30000 },
  async () => {
    const dc = new DebugClient("node", ADAPTER, "purebasic");
    dc.defaultTimeout = 30000;
    await dc.start();
    try {
      await Promise.all([
        dc.waitForEvent("initialized").then(() =>
          dc
            .setBreakpointsRequest({ source: { path: program }, breakpoints: [{ line: MODULE_BP }], lines: [MODULE_BP] })
            .then(() => dc.configurationDoneRequest()),
        ),
        dc.launch({
          program,
          backend: "asm",
          stopOnEntry: false,
          // Internal/test-only hooks (see pbDebugAdapter.ts's LaunchArgs):
          // run the compiler and the compiled target under Wine, against
          // the real Windows compiler binary -- transport auto-selects TCP
          // since exeRunner makes the effective platform "win32".
          exeRunner: "wine",
          compilerPath: compilerWindows,
        }),
        dc.assertStoppedLocation("breakpoint", { path: program, line: MODULE_BP }),
      ]);

      const st = await frames(dc);
      assert.equal(st.length, 1, "a module-scope stop should yield exactly the synthetic main frame");
      const locals = await localsOf(dc, st[0].id);
      assert.equal(locals.get("a"), "3", "module local a should be visible with its value from the real Windows target");
      assert.equal(locals.get("b"), "4", "module local b should be visible with its value from the real Windows target");

      const evalSum = await dc.evaluateRequest({ expression: "a+b", context: "repl" });
      assert.equal(evalSum.body.result, "7", "evaluate against the real Windows target should compute a live expression");

      // Native step-over (opcode 1, PLAN.md M9) past the `Global c.i = a + b`
      // assignment, then read c's freshly-assigned value back -- exercises
      // native stepping and re-reading locals after a step, not just the
      // initial stop. One step may land on the assignment line itself
      // (about to execute it, c still 0) rather than past it, so step again
      // in that case instead of assuming exact single-statement-step
      // granularity -- not this test's concern, unlike the real regression
      // this guards against: c actually reads 0 forever (a stuck/misdecoded
      // module-scope re-read) rather than momentarily during the step that
      // lands on its own assignment line.
      let stAfterStep: Awaited<ReturnType<typeof frames>> = [];
      let localsAfterStep = new Map<string, string>();
      for (let i = 0; i < 2 && localsAfterStep.get("c") !== "7"; i++) {
        await Promise.all([dc.nextRequest({ threadId: MAIN_THREAD_ID }), dc.assertStoppedLocation("step", {})]);
        stAfterStep = await frames(dc);
        localsAfterStep = await localsOf(dc, stAfterStep[0].id);
      }
      assert.notEqual(stAfterStep[0].line, MODULE_BP, "step should have moved off the original breakpoint line");
      assert.equal(localsAfterStep.get("c"), "7", "c should read back a+b after stepping past its assignment on the real Windows target");

      await Promise.all([dc.continueRequest({ threadId: MAIN_THREAD_ID }), dc.waitForEvent("terminated")]);
    } finally {
      await dc.stop();
    }
  },
);
