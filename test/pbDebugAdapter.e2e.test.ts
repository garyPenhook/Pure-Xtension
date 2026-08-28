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
import { gdbEngineAvailable } from "../src/debug/ptraceEngine";

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

// Fixture for the Force Pause test below: a single statement blocked in
// Delay(2000) with nothing before it but one Debug, so the target is
// reliably inside the blocking call well before the test's bounded pause
// fallback fires. Mirrors src/debug/spike/ptrace_blocking.pb's shape.
const BLOCKING_FIXTURE_LINES = [
  'Debug "start"', // 1
  "Delay(2000)", // 2
  'Debug "after delay"', // 3
  "End", // 4
];

// Fixture for the data breakpoint test below: a module-global counter
// incremented a few times with a short Delay between iterations, so each
// change can be observed as a separate stop.
const DATA_BREAKPOINT_FIXTURE_LINES = [
  "Global counter.i = 0", // 1
  "Define i.i", // 2
  "For i = 1 To 3", // 3
  "  counter = counter + 1", // 4
  "  Delay(30)", // 5
  "Next", // 6
  'Debug "done"', // 7
];

// Fixture for the per-type decode test below (PLAN.md M12): one Protected
// local of several different PureBasic scalar types, deliberately with a
// String in the middle rather than last -- before the per-type fix, a
// String record's true (1-byte) trailing length was misread as a uniform
// 8 bytes, desyncing every variable parsed after it, so this ordering is
// what actually catches that regression instead of just a formatting nit.
const TYPES_FIXTURE_LINES = [
  "EnableExplicit", // 1
  "Structure Widget", // 2
  "  label.s", // 3
  "  count.i", // 4
  "EndStructure", // 5
  "Procedure ProbeTypes()", // 6
  "  Protected varByte.b = -12", // 7
  "  Protected varString.s = \"Hi\"", // 8
  "  Protected varWord.w = -1234", // 9
  "  Protected varFloat.f = 3.140000104904175", // 10
  "  Protected varDouble.d = 2.718281828", // 11
  "  Protected w.Widget", // 12
  "  w\\label = \"gizmo\"", // 13
  "  w\\count = 7", // 14
  '  Debug "stop here"', // 15 <- breakpoint
  "EndProcedure", // 16
  "ProbeTypes()", // 17
];
const TYPES_BP = 15;

let fixtureDir: string | undefined;
let program = "";
let blockingProgram = "";
let dataBreakpointProgram = "";
let typesProgram = "";
if (compiler) {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "pure-xtension-e2e-"));
  program = path.join(fixtureDir, "fixture.pb");
  fs.writeFileSync(program, FIXTURE_LINES.join("\n") + "\n");
  blockingProgram = path.join(fixtureDir, "blocking.pb");
  fs.writeFileSync(blockingProgram, BLOCKING_FIXTURE_LINES.join("\n") + "\n");
  dataBreakpointProgram = path.join(fixtureDir, "databreakpoint.pb");
  fs.writeFileSync(dataBreakpointProgram, DATA_BREAKPOINT_FIXTURE_LINES.join("\n") + "\n");
  typesProgram = path.join(fixtureDir, "types.pb");
  fs.writeFileSync(typesProgram, TYPES_FIXTURE_LINES.join("\n") + "\n");
}

after(() => {
  if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
});

/** Spawns a fresh adapter, launches the fixture, and resolves once the target is stopped at `line`. */
async function launchToBreakpoint(line: number, transport?: "fifo" | "tcp"): Promise<DebugClient> {
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
    dc.launch({ program, backend: "asm", stopOnEntry: false, transport }),
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

test("TCP transport: the same breakpoint/locals/continue flow reproduces over NetworkServer", { skip }, async () => {
  // There's no Windows machine available to verify the win32-only automatic
  // selection actually works there -- this instead proves the thing that
  // IS verifiable here: the identical wire protocol, driven through the
  // real TCP handshake and PB_DEBUGGER_Communication=NetworkServer;<port>
  // (PLAN.md M10), reproduces genuine breakpoint/locals/continue behavior
  // on this Linux machine. It's a deliberately small subset of the FIFO
  // test matrix above, not a full duplicate -- pbSession.test.ts already
  // covers the handshake/framing edge cases in isolation.
  const dc = await launchToBreakpoint(MODULE_BP, "tcp");
  try {
    const st = await frames(dc);
    assert.equal(st.length, 1, "a module-scope stop should yield exactly the synthetic main frame");
    const locals = await localsOf(dc, st[0].id);
    assert.equal(locals.get("a"), "3", "module local a should be visible with its value over TCP");

    await Promise.all([
      dc.continueRequest({ threadId: MAIN_THREAD_ID }),
      dc.waitForEvent("terminated"),
    ]);
  } finally {
    await dc.stop();
  }
});

test("TCP transport: repeated back-to-back launches each succeed (startup retry doesn't leak or wedge state)", { skip }, async () => {
  // H1: the retry loop in openTcpSocket() and the free-port probe in
  // allocateFreeTcpPort() are both per-launch state that could leak a
  // socket/handle or race a reused port across launches. Three consecutive
  // full launch/breakpoint/continue/terminate cycles, each through a fresh
  // adapter process, is what would surface that -- a single launch (the test
  // above) can't.
  for (let i = 0; i < 3; i++) {
    const dc = await launchToBreakpoint(MODULE_BP, "tcp");
    try {
      const st = await frames(dc);
      assert.equal(st.length, 1, `launch ${i}: a module-scope stop should yield exactly the synthetic main frame`);
      const locals = await localsOf(dc, st[0].id);
      assert.equal(locals.get("a"), "3", `launch ${i}: module local a should be visible with its value over TCP`);

      await Promise.all([
        dc.continueRequest({ threadId: MAIN_THREAD_ID }),
        dc.waitForEvent("terminated"),
      ]);
    } finally {
      await dc.stop();
    }
  }
});

test("launch surfaces a spawn failure (nonexistent cwd) as a clean DAP error, not an unhandled adapter crash", { skip }, async () => {
  // H3: an invalid cwd makes child_process.spawn() emit an async 'error'
  // event (ENOENT) instead of throwing -- before the 'error' listener this
  // adapter now attaches, that would either hang until the connect timeout
  // with a generic message, or (if nothing ever drained the event) throw
  // unhandled and take the adapter process down. The launch response
  // rejecting promptly and specifically, and the adapter process staying up
  // to answer a follow-up request, is what proves both are fixed.
  const dc = new DebugClient("node", ADAPTER, "purebasic");
  dc.defaultTimeout = 30000;
  await dc.start();
  try {
    await dc.initializeRequest();
    const missingCwd = path.join(fixtureDir!, "does-not-exist");
    await assert.rejects(
      dc.launch({ program, backend: "asm", cwd: missingCwd }),
      /failed to start the target process/,
      "a bad cwd should be reported as a specific spawn failure, not a generic connect timeout",
    );
    // The adapter process must still be alive and responsive afterwards --
    // an unhandled 'error' event would have crashed it instead.
    await dc.threadsRequest();
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

test("procedure locals decode correctly per PureBasic type, including a String that doesn't corrupt later variables", { skip }, async () => {
  const dc = new DebugClient("node", ADAPTER, "purebasic");
  dc.defaultTimeout = 30000;
  await dc.start();
  try {
    await Promise.all([
      dc.waitForEvent("initialized").then(() =>
        dc
          .setBreakpointsRequest({ source: { path: typesProgram }, breakpoints: [{ line: TYPES_BP }], lines: [TYPES_BP] })
          .then(() => dc.configurationDoneRequest()),
      ),
      dc.launch({ program: typesProgram, backend: "asm", stopOnEntry: false }),
      dc.assertStoppedLocation("breakpoint", { path: typesProgram, line: TYPES_BP }),
    ]);

    const st = await frames(dc);
    const locals = await localsOf(dc, st[0].id);
    // PLAN.md M12: before the per-type fix, varString's record's true
    // (1-byte) trailing length was misread as a uniform 8, desyncing every
    // variable parsed after it in the same reply -- so a wrong value for
    // varWord/varFloat/varDouble here would mean that desync regressed,
    // not just a display formatting nit.
    assert.equal(locals.get("varByte"), "-12", "Byte (.b)");
    assert.equal(locals.get("varString"), "Hi", "String (.s) needs its own evaluate() fetch, not an inline value");
    assert.equal(locals.get("varWord"), "-1234", "Word (.w) -- first variable after the String");
    assert.equal(locals.get("varFloat"), "3.140000104904175", "Float (.f) must render as a number, not a huge int64");
    assert.equal(locals.get("varDouble"), "2.718281828", "Double (.d)");

    const vars = await variablesOf(dc, st[0].id);
    const w = vars.find((v) => v.name === "w.Widget");
    assert.ok(w && w.variablesReference > 0, "struct local should be expandable");
    const fields = await dc.variablesRequest({ variablesReference: w!.variablesReference });
    assert.deepEqual(
      new Map(fields.body.variables.map((v) => [v.name, v.value])),
      new Map([["label", "gizmo"], ["count", "7"]]),
      "a struct's String field should resolve its real text via evaluate(), not a blank or garbage value",
    );

    await Promise.all([dc.continueRequest({ threadId: MAIN_THREAD_ID }), dc.waitForEvent("terminated")]);
  } finally {
    await dc.stop();
  }
});

test("evaluate on an unresolvable expression is quiet for hover/watch but a real error for the console", { skip }, async () => {
  const dc = await launchToBreakpoint(MODULE_BP);
  try {
    // A stale Watch entry (or a hover over an out-of-scope identifier) is
    // routine, not actionable -- must not surface as an error response
    // (which VS Code turns into a notification toast), just an inline result.
    const hover = await dc.evaluateRequest({ expression: "notAVariable", context: "hover" });
    assert.match(hover.body.result, /not found/i, "hover should report the failure text as a plain result");

    const watch = await dc.evaluateRequest({ expression: "notAVariable", context: "watch" });
    assert.match(watch.body.result, /not found/i, "watch should report the failure text as a plain result");

    // A user deliberately typing an expression into the Debug Console
    // still gets a real error response.
    await assert.rejects(dc.evaluateRequest({ expression: "notAVariable", context: "repl" }), /not found/i);
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

test(
  "Force Pause: GDB attach interrupts a target blocked in Delay(), and Continue actually resumes it",
  { skip: skip || !gdbEngineAvailable(), timeout: 30000 },
  async () => {
    const dc = new DebugClient("node", ADAPTER, "purebasic");
    dc.defaultTimeout = 30000;
    await dc.start();
    try {
      await Promise.all([
        dc.waitForEvent("initialized").then(() => dc.configurationDoneRequest()),
        dc.launch({ program: blockingProgram, backend: "asm", stopOnEntry: false }),
      ]);

      // By the time launch's response arrives, pb.continue() has already
      // been sent (launchRequest awaits configurationDone then calls it).
      // Give the target a moment to actually reach Delay(2000) -- the only
      // statement before it is one Debug -- well before pausing.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const stoppedPromise = dc.waitForEvent("stopped");
      const pauseSentAt = Date.now();
      await dc.pauseRequest({ threadId: MAIN_THREAD_ID });

      // Plain cooperative pause (opcode 0) cannot interrupt a target inside
      // Delay() -- PB_DEBUGGER_Check never runs mid-call. This asserts the
      // GDB fallback, not some pre-existing cooperative behavior, produced
      // the stop, landing well before the 2000ms Delay would return on its
      // own (a natural return would also make pauseRequest's cooperative
      // pause fire, making this assertion meaningless without the timing
      // bounds below).
      const stoppedEvent = await stoppedPromise;
      const elapsed = Date.now() - pauseSentAt;
      assert.equal(stoppedEvent.body.reason, "pause");
      assert.ok(elapsed >= 600, `forced pause fired suspiciously early (${elapsed}ms) -- did a cooperative stop happen instead?`);
      assert.ok(elapsed < 1800, `forced pause should land well before Delay(2000) returns on its own (took ${elapsed}ms)`);

      // A stack trace request must not hang while force-paused (the main
      // thread cannot answer wire requests here -- see stackTraceRequest).
      const st = await frames(dc);
      assert.equal(st.length, 1, "force-paused stop should report exactly one synthetic frame");
      assert.match(st[0].name, /native code \(paused\)/);

      // Continue must actually resume the target rather than have it
      // immediately re-stop at the next line (the still-armed cooperative
      // pause flag, if left uncleared) -- run it to real completion.
      await Promise.all([dc.continueRequest({ threadId: MAIN_THREAD_ID }), dc.waitForEvent("terminated")]);
    } finally {
      await dc.stop();
    }
  },
);

test(
  "Force Pause: a quick Continue after Pause cancels the still-pending fallback timer",
  { skip: skip || !gdbEngineAvailable(), timeout: 30000 },
  async () => {
    // Regression test: armForcePauseFallback()'s timer used to only be
    // invalidated by an already-*active* force pause or a cooperative wire
    // stop -- continueRequest/step didn't cancel a timer that was still
    // pending (armed but not yet fired). Pausing and then immediately
    // continuing, well inside the fallback window, used to leave that stale
    // timer to fire later and force-attach GDB to a target that was already
    // running normally again.
    const dc = new DebugClient("node", ADAPTER, "purebasic");
    dc.defaultTimeout = 30000;
    await dc.start();
    try {
      await Promise.all([
        dc.waitForEvent("initialized").then(() => dc.configurationDoneRequest()),
        dc.launch({ program: blockingProgram, backend: "asm", stopOnEntry: false }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 300));

      await dc.pauseRequest({ threadId: MAIN_THREAD_ID });
      await dc.continueRequest({ threadId: MAIN_THREAD_ID });

      let sawStoppedEvent: unknown;
      const stoppedListener = (event: { body?: unknown }) => {
        sawStoppedEvent = event.body;
      };
      dc.on("stopped", stoppedListener);
      try {
        // Watch through (and past) FORCE_PAUSE_FALLBACK_MS's window for a
        // stray forced-pause stop, then let the target finish normally.
        await Promise.race([dc.waitForEvent("terminated"), new Promise((resolve) => setTimeout(resolve, 2500))]);
      } finally {
        dc.removeListener("stopped", stoppedListener);
      }
      assert.equal(sawStoppedEvent, undefined, `no stopped event should fire after Continue cancelled the pause, got: ${JSON.stringify(sawStoppedEvent)}`);
    } finally {
      await dc.stop();
    }
  },
);

test(
  "data breakpoint: re-arm loop catches each value change, and removal actually stops target-side",
  { skip, timeout: 20000 },
  async () => {
    const dc = new DebugClient("node", ADAPTER, "purebasic");
    dc.defaultTimeout = 30000;
    await dc.start();
    try {
      await Promise.all([
        dc.waitForEvent("initialized").then(() => dc.configurationDoneRequest()),
        dc.launch({ program: dataBreakpointProgram, backend: "asm", stopOnEntry: true }),
        dc.waitForEvent("stopped"),
      ]);

      // variablesReference here is the *scope's* own reference, exactly what
      // VS Code's real Variables-view "Add Data Breakpoint" action sends
      // alongside a plain top-level local's name (PLAN.md M1/DAP spec: it
      // identifies the containing variable container, not "name is a
      // compound value"). A prior bug rejected every request that carried
      // any variablesReference at all, which is how the real UI always
      // calls this -- a name-only request (no variablesReference) never
      // actually happens outside a synthetic test.
      const st = await frames(dc);
      const scopes = await dc.scopesRequest({ frameId: st[0].id });
      const info = await dc.dataBreakpointInfoRequest({
        variablesReference: scopes.body.scopes[0].variablesReference,
        name: "counter",
      });
      assert.equal(info.body.dataId, "counter");
      assert.ok(info.body.accessTypes?.includes("write"), "counter should report a write access type");

      const set = await dc.setDataBreakpointsRequest({
        breakpoints: [{ dataId: "counter", accessType: "write" }],
      });
      assert.equal(set.body.breakpoints.length, 1);
      assert.equal(set.body.breakpoints[0].verified, true);

      // Each iteration only succeeds if rearmDataBreakpoint() reused the
      // same wire id and correctly reseeded the condition against the new
      // value -- a reintroduced M9.6-style id bug would either stop firing
      // after the first hit or fire on the wrong value.
      for (const expected of [1, 2, 3]) {
        const [stoppedEvent] = await Promise.all([
          dc.waitForEvent("stopped"),
          dc.continueRequest({ threadId: MAIN_THREAD_ID }),
        ]);
        assert.equal(stoppedEvent.body.reason, "data breakpoint");
        const result = await dc.evaluateRequest({ expression: "counter" });
        assert.equal(result.body.result, String(expected), `counter should read back ${expected} on hit ${expected}`);
      }

      const cleared = await dc.setDataBreakpointsRequest({ breakpoints: [] });
      assert.equal(cleared.body.breakpoints.length, 0);

      // If removal only updated local adapter state (the exact bug found in
      // the real PureBasic GUI's own DataBreakPoints.pb, PLAN.md M9.6), the
      // target-side breakpoint would remain armed and this would still stop.
      let sawFurtherHit = false;
      const listener = (event: { body?: { reason?: string } }) => {
        if (event.body?.reason === "data breakpoint") sawFurtherHit = true;
      };
      dc.on("stopped", listener);
      try {
        await Promise.all([dc.continueRequest({ threadId: MAIN_THREAD_ID }), dc.waitForEvent("terminated")]);
      } finally {
        dc.removeListener("stopped", listener);
      }
      assert.equal(sawFurtherHit, false, "no data breakpoint stop should occur after removal");
    } finally {
      await dc.stop();
    }
  },
);

test("data breakpoint info: rejects a struct field's own compound variablesReference, not just any variablesReference", { skip }, async () => {
  // PLAN.md M1: the fix that made a *scope's* variablesReference acceptable
  // must not also accidentally start accepting a *compound container's*
  // reference -- a struct field has no stable address in this v1, so this
  // must stay rejected, driven through the same "expand a field, then ask
  // about it" flow the real Variables-view would use.
  const dc = await launchToBreakpoint(MODULE_BP);
  try {
    const moduleVars = await variablesOf(dc, (await frames(dc))[0].id);
    const point = moduleVars.find((v) => v.name === "point.ProbePoint");
    assert.ok(point && point.variablesReference > 0, "module structure should be expandable");

    const info = await dc.dataBreakpointInfoRequest({
      variablesReference: point!.variablesReference,
      name: "x",
    });
    assert.equal(info.body.dataId, null, "a struct field must still be rejected as a data breakpoint target");

    await Promise.all([dc.continueRequest({ threadId: MAIN_THREAD_ID }), dc.waitForEvent("terminated")]);
  } finally {
    await dc.stop();
  }
});
