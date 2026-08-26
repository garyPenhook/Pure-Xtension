import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GdbMiPtraceEngine,
  gdbEngineAvailable,
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
  { skip: gdbEngineAvailable() ? false : "GNU gdb is unavailable on this Linux host", timeout: 10000 },
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
