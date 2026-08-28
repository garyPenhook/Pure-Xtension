import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  GdbMiPtraceEngine,
  gdbEngineAvailableSync,
  parseMiResultRecord,
  parseMiStoppedRecord,
} from "../src/debug/ptraceEngine";

test("parseMiResultRecord preserves the token and result payload", () => {
  assert.deepEqual(
    parseMiResultRecord('42^done,bkpt={number="3",addr="0x0000000000405171"}'),
    { token: 42, klass: "done", text: 'bkpt={number="3",addr="0x0000000000405171"}' },
  );
  assert.equal(parseMiResultRecord('*stopped,reason="breakpoint-hit"'), undefined);
});

test("parseMiStoppedRecord extracts the main-thread frame address", () => {
  const line = '*stopped,reason="breakpoint-hit",disp="keep",bkptno="1",thread-id="1",stopped-threads=["1"],frame={addr="0x0000000000405171",func="main",args=[]}';
  assert.deepEqual(parseMiStoppedRecord(line), {
    reason: "breakpoint-hit",
    threadId: 1,
    address: 0x405171,
    text: line,
  });
});

test("parseMiStoppedRecord accepts a stop without a frame", () => {
  assert.deepEqual(parseMiStoppedRecord('*stopped,reason="signal-received",thread-id="2"'), {
    reason: "signal-received",
    threadId: 2,
    address: undefined,
    text: '*stopped,reason="signal-received",thread-id="2"',
  });
});

test(
  "GdbMiPtraceEngine launches and disposes a non-stop inferior",
  { skip: gdbEngineAvailableSync() ? false : "GNU gdb is unavailable on this Linux host", timeout: 10000 },
  async () => {
    const engine = new GdbMiPtraceEngine();
    try {
      const pid = await engine.launch("/bin/sleep", ["30"], process.cwd(), { PATH: process.env.PATH ?? "" });
      assert.ok(pid > 0, "GDB should report the inferior pid in =thread-group-started");
    } finally {
      await engine.dispose();
    }
  },
);

test(
  "GdbMiPtraceEngine attach/detach stops then resumes an already-running process",
  { skip: gdbEngineAvailableSync() ? false : "GNU gdb is unavailable on this Linux host", timeout: 10000 },
  async () => {
    const sleeper = cp.spawn("sleep", ["30"]);
    await new Promise((resolve) => sleeper.once("spawn", resolve));
    const engine = new GdbMiPtraceEngine();
    try {
      const pc = await engine.attach(sleeper.pid!);
      assert.ok(pc > 0, "attach should resolve a stopped program counter");
      await engine.detach();
      // A detached ptrace tracee keeps running; signal 0 just probes liveness.
      assert.doesNotThrow(() => process.kill(sleeper.pid!, 0), "sleep should still be running after detach");
    } finally {
      await engine.dispose();
      sleeper.kill("SIGKILL");
    }
  },
);

// M9 (CODE_REVIEW_TODO.md): every GDB/MI operation must be bounded and
// cancellation-aware instead of trusting a well-behaved gdb. These tests
// drive GdbMiPtraceEngine against a fake "gdb" -- a real child process, just
// not the real gdb binary -- so a hung/misbehaving/killed MI peer can be
// simulated deterministically and quickly (short custom timeouts) without
// depending on gdb's actual availability or behavior.
const fakeGdbDir = fs.mkdtempSync(path.join(os.tmpdir(), "pure-xtension-fake-gdb-"));
const fakeGdbPath = path.join(fakeGdbDir, "fake-gdb.cjs");
fs.writeFileSync(
  fakeGdbPath,
  `#!/usr/bin/env node
"use strict";
const readline = require("readline");
// gdbEngineAvailable()'s capability probe always calls "--version" -- answer
// it unconditionally (even under FAKE_GDB_SILENT) so it reflects only the
// MI conversation under test, not this fixture's own availability.
if (process.argv.includes("--version")) {
  process.stdout.write("GNU gdb (fake) 1.0\\n");
  process.exit(0);
}
// FAKE_GDB_SILENT: never reply to anything (simulates a wedged/hung gdb).
// FAKE_GDB_NO_STOPPED: acknowledge -target-attach but never emit *stopped.
// FAKE_GDB_DROP_MATCH: silently drop (never reply to) any command containing this substring.
// FAKE_GDB_DELAY_MS/FAKE_GDB_DELAY_MATCH: reply to a matching command only after this delay.
if (process.env.FAKE_GDB_SILENT === "1") {
  process.stdin.resume();
} else {
  const dropMatch = process.env.FAKE_GDB_DROP_MATCH || "";
  const delayMs = Number(process.env.FAKE_GDB_DELAY_MS || "0");
  const delayMatch = process.env.FAKE_GDB_DELAY_MATCH || "";
  const noStopped = process.env.FAKE_GDB_NO_STOPPED === "1";
  readline.createInterface({ input: process.stdin, terminal: false }).on("line", (line) => {
    const m = /^(\\d+)(.*)$/.exec(line);
    if (!m) return;
    const token = m[1];
    const cmd = m[2];
    if (dropMatch && cmd.includes(dropMatch)) return;
    const reply = () => {
      if (cmd.includes("-target-attach")) {
        process.stdout.write(token + "^done\\n");
        if (!noStopped) {
          setTimeout(() => {
            process.stdout.write('*stopped,reason="signal-received",thread-id="1",frame={addr="0x0000000000001000"}\\n');
          }, 10);
        }
        return;
      }
      if (cmd.includes("-break-insert")) {
        process.stdout.write(token + '^done,bkpt={number="1",addr="0x0000000000001000"}\\n');
        return;
      }
      if (cmd.includes("-data-evaluate-expression")) {
        process.stdout.write(token + '^done,value="0x0000000000001000"\\n');
        return;
      }
      process.stdout.write(token + "^done\\n");
    };
    if (delayMs > 0 && cmd.includes(delayMatch)) setTimeout(reply, delayMs);
    else reply();
  });
}
`,
  "utf8",
);
fs.chmodSync(fakeGdbPath, 0o755);

after(() => {
  fs.rmSync(fakeGdbDir, { recursive: true, force: true });
});

// Timeouts here are deliberately generous (hundreds of ms, not tens) even
// though the fake gdb fixture itself replies near-instantly -- these run
// alongside the rest of `npm test`'s real compiler/gdb/GUI-debugger
// processes, and a too-tight budget flaked under that system load rather
// than testing the behavior under test (a real gdb-unresponsive scenario
// plays out over seconds in production, not single-digit milliseconds).
function fakeGdbEngine(envOverrides: Record<string, string>, timeouts: { commandTimeoutMs?: number; stopWaitTimeoutMs?: number } = {}): GdbMiPtraceEngine {
  return new GdbMiPtraceEngine({
    gdbPath: fakeGdbPath,
    commandTimeoutMs: timeouts.commandTimeoutMs ?? 800,
    stopWaitTimeoutMs: timeouts.stopWaitTimeoutMs ?? 800,
    env: { ...process.env, ...envOverrides },
  });
}

test("GdbMiPtraceEngine.attach() rejects instead of hanging when gdb never responds to anything (silent process)", { timeout: 8000 }, async () => {
  const engine = fakeGdbEngine({ FAKE_GDB_SILENT: "1" });
  try {
    await assert.rejects(engine.attach(1), /timed out/, "the startup -gdb-set command should time out, not hang");
  } finally {
    await engine.dispose();
  }
});

test("GdbMiPtraceEngine.attach() rejects instead of hanging when a command's result record never arrives", { timeout: 8000 }, async () => {
  const engine = fakeGdbEngine({ FAKE_GDB_DROP_MATCH: "-target-attach" });
  try {
    await assert.rejects(engine.attach(1), /timed out.*-target-attach/, "the dropped -target-attach command should time out on its own, not stall the wait for a stop");
  } finally {
    await engine.dispose();
  }
});

test("GdbMiPtraceEngine.attach() rejects instead of hanging when gdb acknowledges attach but never reports *stopped", { timeout: 8000 }, async () => {
  const engine = fakeGdbEngine({ FAKE_GDB_NO_STOPPED: "1" });
  try {
    await assert.rejects(engine.attach(1), /timed out.*waiting for GDB to report a stop/, "a *stopped that never arrives must not hang attach() forever");
  } finally {
    await engine.dispose();
  }
});

test("GdbMiPtraceEngine: disposing during an in-flight attach() rejects it promptly instead of waiting out the full stop-wait timeout", { timeout: 8000 }, async () => {
  // A generous stop-wait timeout stands in for pbDebugAdapter.ts's real
  // scenario: forcePauseAttaching lets disconnectRequest dispose() an
  // attach that's still in flight, well before it would ever time out on
  // its own -- this is exactly that cancellation path, at the engine level.
  const engine = fakeGdbEngine({ FAKE_GDB_NO_STOPPED: "1" }, { stopWaitTimeoutMs: 6000 });
  const attaching = engine.attach(1);
  const start = Date.now();
  setTimeout(() => {
    void engine.dispose();
  }, 300);
  await assert.rejects(attaching, /disposed/);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 4000, `dispose() should abort the in-flight attach well before the 6s stop-wait timeout, took ${elapsed}ms`);
});

test("GdbMiPtraceEngine: a late reply for an already-timed-out command is safely ignored, and the engine keeps working", { timeout: 8000 }, async () => {
  const engine = fakeGdbEngine(
    { FAKE_GDB_DELAY_MS: "1200", FAKE_GDB_DELAY_MATCH: "-break-insert" },
    { stopWaitTimeoutMs: 4000 },
  );
  try {
    const pc = await engine.attach(1);
    assert.ok(pc > 0, "attach should succeed normally -- the delay only targets -break-insert");

    // setBreakpoint() has no catch-and-dispose wrapper (unlike launch()/
    // attach()), so its command timeout leaves the engine alive to receive
    // the fake gdb's still-pending, now-orphaned reply once the delay
    // elapses -- exactly the "late record after cancellation" scenario.
    await assert.rejects(engine.setBreakpoint(0x1000), /timed out/);

    // Outlive the fake gdb's delayed reply for the abandoned token.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // The engine must still be fully functional -- a late, unmatched reply
    // must not have corrupted pending-command routing or crashed anything.
    await engine.detach();
  } finally {
    await engine.dispose();
  }
});
