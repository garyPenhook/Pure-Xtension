// End-to-end test for the PureBasic debug adapter.
//
// Unlike pbSession.test.ts (pure decoder unit tests over hand-built buffers),
// this drives the *whole* adapter — the standalone stdio build produced by
// esbuild.adapter.mjs — as a real DAP server, against the real pbcompiler and
// the real target debugger over the FIFO wire protocol. It compiles a fixture
// .pb program, hits breakpoints in both module and procedure scope, reads
// locals, and exercises stepping, asserting on the target's actual run/stop
// behaviour rather than on parsed bytes.
//
// This is what PLAN.md §8 flagged as unverified "because the sandbox has no X
// display": the adapter is a stdio DAP server, so it never needed a display —
// only a harness that speaks DAP to it. No VS Code, no Xvfb. Standing this up
// is what surfaced (and let us fix) the module-scope stack-frame bug and pin
// down earlier adapter edge cases. Native step controls are separately
// verified below against the real target (PLAN.md M9).
//
// It self-skips when no PureBasic compiler is installed (e.g. GitHub CI), so it
// stays green there while still running locally wherever the toolchain exists.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DebugClient } from "@vscode/debugadapter-testsupport";

const MAIN_THREAD_ID = 1;
const ADAPTER = path.join(__dirname, "..", "adapter.cjs");

/** Mirrors config.ts's env/PATH compiler resolution enough to decide whether the live target is even runnable here. */
function findPbCompiler(): string | undefined {
  const home = process.env.PUREBASIC_HOME;
  if (home) {
    const candidate = path.join(home, "compilers", "pbcompiler");
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, "pbcompiler"))) return path.join(dir, "pbcompiler");
  }
  return undefined;
}

const compiler = findPbCompiler();
const skip = compiler ? false : "PureBasic compiler not found";

// Line-numbered fixture (1-indexed). Two interesting stop points: the module
// body's Add(a, b) call at line 20 (where the target is stopped *at module
// scope*, the case that used to yield no stack frame at all), and line 7 inside
// Add at line 12 (a real procedure frame, whose caller — the synthesized main frame — used
// to be missing entirely).
const FIXTURE_LINES = [
  "; Pure Xtension e2e debug fixture",       // 1
  "EnableExplicit",                            // 2
  "Structure ProbePoint",                       // 3
  "  x.i",                                     // 4
  "  label.s",                                 // 5
  "EndStructure",                              // 6
  "Global g.i = 100",                          // 7
  "Global point.ProbePoint",                   // 8
  "",                                          // 9
  "Procedure.i Add(x.i, y.i)",                 // 10
  "  Protected r.i",                           // 11
  "  r = x + y",                               // 12 <-- procedure-scope breakpoint
  "  ProcedureReturn r",                       // 13
  "EndProcedure",                              // 14
  "",                                          // 15
  "Define a.i = 3",                            // 16
  "Define b.i = 4",                            // 17
  "point\\x = 42",                             // 18
  "point\\label = \"probe\"",                  // 19
  "Define c.i = Add(a, b)",                    // 20 <-- module-scope breakpoint
  "Define d.i = c + g",                        // 21
  "Debug d",                                   // 22
];
const MODULE_BP = 20;
const PROC_BP = 12;
const ENTRY_LINE = 7;

let fixtureDir: string | undefined;
let program = "";
if (compiler) {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "pure-xtension-e2e-"));
  program = path.join(fixtureDir, "fixture.pb");
  fs.writeFileSync(program, FIXTURE_LINES.join("\n") + "\n");
}

after(() => {
  if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
});

/** Spawns a fresh adapter, launches the fixture, and resolves once the target is stopped at `line`. */
async function launchToBreakpoint(line: number): Promise<DebugClient> {
  const dc = new DebugClient("node", ADAPTER, "purebasic");
  // The first request triggers a full debug-build compile before the target
  // even starts — well above DebugClient's 5s default.
  dc.defaultTimeout = 30000;
  await dc.start();
  await Promise.all([
    dc.waitForEvent("initialized").then(() =>
      dc
        .setBreakpointsRequest({ source: { path: program }, breakpoints: [{ line }], lines: [line] })
        .then(() => dc.configurationDoneRequest()),
    ),
    dc.launch({ program, backend: "asm", stopOnEntry: false }),
    dc.assertStoppedLocation("breakpoint", { path: program, line }),
  ]);
  return dc;
}

async function frames(dc: DebugClient) {
  return (await dc.stackTraceRequest({ threadId: MAIN_THREAD_ID })).body.stackFrames;
}

async function localsOf(dc: DebugClient, frameId: number): Promise<Map<string, string>> {
  const scopes = await dc.scopesRequest({ frameId });
  const vars = await dc.variablesRequest({ variablesReference: scopes.body.scopes[0].variablesReference });
  return new Map(vars.body.variables.map((v) => [v.name, v.value]));
}

async function variablesOf(dc: DebugClient, frameId: number) {
  const scopes = await dc.scopesRequest({ frameId });
  return (await dc.variablesRequest({ variablesReference: scopes.body.scopes[0].variablesReference })).body.variables;
}

test("stopOnEntry reports the first executable module line, not line 1", { skip }, async () => {
  const dc = new DebugClient("node", ADAPTER, "purebasic");
  dc.defaultTimeout = 30000;
  await dc.start();
  try {
    await Promise.all([
      dc.waitForEvent("initialized").then(() => dc.configurationDoneRequest()),
      dc.launch({ program, backend: "asm", stopOnEntry: true }),
      dc.assertStoppedLocation("entry", { path: program, line: ENTRY_LINE }),
    ]);

    const st = await frames(dc);
    assert.equal(st.length, 1, "entry should be a module-scope stop");
    assert.equal(st[0].line, ENTRY_LINE, "the synthetic main frame should use the discovered entry line");

    await Promise.all([
      dc.continueRequest({ threadId: MAIN_THREAD_ID }),
      dc.waitForEvent("terminated"),
    ]);
  } finally {
    await dc.stop();
  }
});

test("module-scope stop: synthesizes a main frame, reads module locals, and steps over a call", { skip }, async () => {
  const dc = await launchToBreakpoint(MODULE_BP);
  try {
    // Opcode 16 reports no procedure frame at module scope; the adapter must
    // synthesize the single main frame at the stop line. Before the fix this
    // was zero frames — VS Code would show no call stack and no variables.
    const st = await frames(dc);
    assert.equal(st.length, 1, "a module-scope stop should yield exactly the synthetic main frame");
    assert.match(st[0].name, /\(main\)$/, "the only frame should be the synthetic main frame");
    assert.equal(st[0].line, MODULE_BP, "main frame should sit at the stop line");

    const locals = await localsOf(dc, st[0].id);
    assert.equal(locals.get("a"), "3", "module local a should be visible with its value");
    assert.equal(locals.get("b"), "4", "module local b should be visible with its value");
    assert.equal(locals.get("g"), "100", "global g should be visible with its value");
    const moduleVars = await variablesOf(dc, st[0].id);
    const point = moduleVars.find((v) => v.name === "point.ProbePoint");
    assert.ok(point && point.variablesReference > 0, "module structure should be expandable");
    const fields = await dc.variablesRequest({ variablesReference: point.variablesReference });
    assert.deepEqual(
      new Map(fields.body.variables.map((v) => [v.name, v.value])),
      new Map([["x", "42"], ["label", "probe"]]),
      "module structure fields should retain their names and evaluated values",
    );

    // Step over the Add(a, b) call: the wire runs the whole call-line
    // atomically, so this lands on the next module line at the same depth.
    await Promise.all([dc.nextRequest({ threadId: MAIN_THREAD_ID }), dc.assertStoppedLocation("step", {})]);
    const after = await frames(dc);
    assert.equal(after.length, 1, "step over should stay at module depth (not descend into Add)");
    assert.ok(after[0].line > MODULE_BP, `step over should advance past the call line (landed on ${after[0].line})`);

    // PB_DEBUGGER_EndExternal emits wire message type 1 before it tears down
    // the transport. The adapter must surface that as DAP termination without
    // requiring the user to press Stop.
    await Promise.all([
      dc.continueRequest({ threadId: MAIN_THREAD_ID }),
      dc.waitForEvent("terminated"),
    ]);
  } finally {
    await dc.stop();
  }
});

test("native step-in descends into a called procedure", { skip }, async () => {
  const dc = await launchToBreakpoint(MODULE_BP);
  try {
    // M9 established that command 1/value1=1 is the target's real step-into
    // operation. The old all-line-breakpoint reconstruction could only step
    // over this call line; this must now land with Add as the innermost frame.
    await Promise.all([dc.stepInRequest({ threadId: MAIN_THREAD_ID }), dc.assertStoppedLocation("step", {})]);
    const after = await frames(dc);
    assert.equal(after.length, 2, "step in should add the Add procedure frame above main");
    assert.match(after[0].name, /Add/, "native step in should be stopped inside Add");

    await Promise.all([
      dc.continueRequest({ threadId: MAIN_THREAD_ID }),
      dc.waitForEvent("terminated"),
    ]);
  } finally {
    await dc.stop();
  }
});

test("procedure-scope stop: reports the procedure frame plus the synthesized main frame, and steps out", { skip }, async () => {
  const dc = await launchToBreakpoint(PROC_BP);
  try {
    // Inside Add: opcode 16 reports the Add frame but never the module/main
    // caller beneath it, so the adapter must append it. Each frame's line must
    // be its own current line — Add at the stop line, main at the call site —
    // not opcode 16's per-frame call-site line (the old off-by-one-frame bug).
    const st = await frames(dc);
    assert.equal(st.length, 2, "should report the Add frame and the synthesized main frame beneath it");
    assert.match(st[0].name, /Add/, "innermost frame should be the Add procedure");
    assert.equal(st[0].line, PROC_BP, "Add frame should be at the actual stop line");
    assert.match(st[1].name, /\(main\)$/, "bottom frame should be the synthesized main frame");
    assert.equal(st[1].line, MODULE_BP, "main frame should show the call site line, not the callee's line");

    // Procedure locals come from opcode 17; the main frame's from opcode 9 +
    // evaluate, which resolves module-scope values even from inside a call.
    const procLocals = await localsOf(dc, st[0].id);
    assert.equal(procLocals.get("x"), "3", "procedure param x");
    assert.equal(procLocals.get("y"), "4", "procedure param y");
    const mainLocals = await localsOf(dc, st[1].id);
    assert.equal(mainLocals.get("a"), "3", "module local a is reachable from the main frame while inside a call");
    assert.equal(mainLocals.get("b"), "4", "module local b is reachable from the main frame while inside a call");

    // Step out: run until the stack is shallower than the Add frame, i.e. back
    // in module scope (the single synthetic main frame).
    await Promise.all([dc.stepOutRequest({ threadId: MAIN_THREAD_ID }), dc.assertStoppedLocation("step", {})]);
    const after = await frames(dc);
    assert.equal(after.length, 1, "step out should return to module scope (main frame only)");
    assert.match(after[0].name, /\(main\)$/, "after stepping out the only frame should be main");

    await Promise.all([
      dc.continueRequest({ threadId: MAIN_THREAD_ID }),
      dc.waitForEvent("terminated"),
    ]);
  } finally {
    await dc.stop();
  }
});

test("a wire request after disconnect receives an error response instead of hanging", { skip }, async () => {
  const dc = await launchToBreakpoint(MODULE_BP);
  try {
    await dc.disconnectRequest({});
    await assert.rejects(
      dc.stackTraceRequest({ threadId: MAIN_THREAD_ID }),
      /reading the stack trace failed: debugger session closed/,
    );
  } finally {
    await dc.stop();
  }
});
