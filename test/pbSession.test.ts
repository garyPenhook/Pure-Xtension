// Unit tests for the wire-protocol decoders in src/debug/pbSession.ts.
// These are pure functions (Buffer in, struct out) with no dependency on a
// live PureBasic compiler, target process, or FIFO transport, so they're
// tested directly against hand-built buffers matching the layouts documented
// next to each parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PbDebugSession,
  parseArrayDecls,
  parseArrayElements,
  parseDebugOutputText,
  parseEvaluateReply,
  parseFrames,
  parseGlobalDecls,
  parseListDecls,
  parseListElements,
  parseMapDecls,
  parseMapElements,
  parseVariables,
  type PbMessage,
} from "../src/debug/pbSession";

test("a timed-out message wait does not consume the next request's reply", async () => {
  const session = new PbDebugSession();
  const internals = session as unknown as {
    nextMessageWithTimeout(timeoutMs: number, description: string): Promise<PbMessage>;
    dispatch(message: PbMessage): void;
  };

  await assert.rejects(
    internals.nextMessageWithTimeout(5, "a test message"),
    /timed out after 5ms waiting for a test message/,
  );

  const reply = internals.nextMessageWithTimeout(100, "the next reply");
  const expected: PbMessage = {
    type: 16,
    len: 0,
    f8: 7,
    f12: 0,
    f16: 0,
    payload: Buffer.alloc(0),
  };
  internals.dispatch(expected);
  assert.equal(await reply, expected);
});

function capturedControlHeader(send: (session: PbDebugSession) => void): Buffer {
  const session = new PbDebugSession();
  const writes: Buffer[] = [];
  // These tests exercise the public control methods without needing a FIFO.
  // `write()` only requires a stream-like object with `write(Buffer)`.
  (session as unknown as { writeStream: { write(chunk: Buffer): boolean } }).writeStream = {
    write(chunk: Buffer): boolean {
      writes.push(Buffer.from(chunk));
      return true;
    },
  };
  send(session);
  assert.equal(writes.length, 1, "a header-only control command should write exactly one buffer");
  return writes[0];
}

test("native execution-control methods encode the M9 opcode/value pairs", () => {
  const pause = capturedControlHeader((s) => s.pause());
  assert.deepEqual([pause.readInt32LE(0), pause.readInt32LE(4), pause.readInt32LE(8)], [0, 0, 0]);

  const into = capturedControlHeader((s) => s.stepInto(3));
  assert.deepEqual([into.readInt32LE(0), into.readInt32LE(4), into.readInt32LE(8)], [1, 0, 3]);

  const over = capturedControlHeader((s) => s.stepOver());
  assert.deepEqual([over.readInt32LE(0), over.readInt32LE(4), over.readInt32LE(8)], [1, 0, -1]);

  const out = capturedControlHeader((s) => s.stepOut());
  assert.deepEqual([out.readInt32LE(0), out.readInt32LE(4), out.readInt32LE(8)], [1, 0, -2]);

  const run = capturedControlHeader((s) => s.continue());
  assert.deepEqual([run.readInt32LE(0), run.readInt32LE(4), run.readInt32LE(8)], [2, 0, 1]);
});

test("stepInto rejects invalid wire counts before writing", () => {
  assert.throws(() => capturedControlHeader((s) => s.stepInto(0)), /positive int32/);
  assert.throws(() => capturedControlHeader((s) => s.stepInto(0x80000000)), /positive int32/);
});

function nulString(s: string): Buffer {
  return Buffer.concat([Buffer.from(s, "latin1"), Buffer.from([0])]);
}

function int32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n, 0);
  return b;
}

function int64le(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n), 0);
  return b;
}

test("parseFrames decodes repeated (line, NUL-terminated display) records", () => {
  const payload = Buffer.concat([
    int32le(5),
    nulString("Main()"),
    int32le(12),
    nulString("Sub(1, 2)"),
  ]);
  assert.deepEqual(parseFrames(payload), [
    { callSiteLine0: 5, display: "Main()" },
    { callSiteLine0: 12, display: "Sub(1, 2)" },
  ]);
});

test("parseFrames tolerates a missing trailing NUL by reading to buffer end", () => {
  const payload = Buffer.concat([int32le(3), Buffer.from("NoTerminator", "latin1")]);
  assert.deepEqual(parseFrames(payload), [{ callSiteLine0: 3, display: "NoTerminator" }]);
});

test("parseVariables decodes a scalar record", () => {
  // 7-byte header: type, flag(unused), kind, 4-byte reserved/nested — then
  // NUL-terminated name, then an 8-byte LE value (type !== struct tag 0x07).
  const payload = Buffer.concat([
    Buffer.from([0x15, 0, 3, 0, 0, 0, 0]),
    nulString("a"),
    int64le(42),
  ]);
  assert.deepEqual(parseVariables(payload), [{ type: 0x15, kind: 3, name: "a", value: "42" }]);
});

test("parseVariables attaches nested records to a preceding structure header", () => {
  const structHeader = Buffer.concat([Buffer.from([0x07, 0, 3, 0, 0, 0, 0]), nulString("p.Point")]);
  const fieldX = Buffer.concat([Buffer.from([0x15, 0, 3, 1, 0, 0, 0]), nulString("x"), int64le(10)]);
  const fieldY = Buffer.concat([Buffer.from([0x15, 0, 3, 1, 0, 0, 0]), nulString("y"), int64le(20)]);
  const payload = Buffer.concat([structHeader, fieldX, fieldY]);

  assert.deepEqual(parseVariables(payload), [
    {
      type: 0x07,
      kind: 3,
      name: "p.Point",
      // parseVariables always assigns a `value` property, even undefined
      // (structure headers carry no trailing scalar value of their own) —
      // deepStrictEqual treats a present-but-undefined key differently from
      // a missing one, so this must be listed explicitly.
      value: undefined,
      children: [
        { type: 0x15, kind: 3, name: "x", value: "10" },
        { type: 0x15, kind: 3, name: "y", value: "20" },
      ],
    },
  ]);
});

test("parseVariables falls back to a hex dump when the trailing value is truncated", () => {
  const payload = Buffer.concat([
    Buffer.from([0x15, 0, 3, 0, 0, 0, 0]),
    nulString("a"),
    Buffer.from([0xde, 0xad]), // only 2 bytes, not the full 8-byte value
  ]);
  assert.deepEqual(parseVariables(payload), [{ type: 0x15, kind: 3, name: "a", value: "0xdead" }]);
});

test("parseGlobalDecls decodes name-only records (7-byte header + name + 1 pad byte, no value)", () => {
  // Exact bytes captured live from opcode 9 for a mixed-type module scope
  // (.i alpha, .f z, .s bb, .q c3, Global .i gg): each record is header +
  // NUL name + a single trailing pad byte, and carries NO 8-byte value.
  const rec = (type: number, kind: number, name: string) =>
    Buffer.concat([Buffer.from([type, 0, kind, 0, 0, 0, 0]), nulString(name), Buffer.from([0])]);
  const payload = Buffer.concat([
    rec(0x15, 0, "alpha"),
    rec(0x09, 0, "z"),
    rec(0x08, 0, "bb"),
    rec(0x0d, 0, "c3"),
    rec(0x15, 1, "gg"),
  ]);
  assert.deepEqual(parseGlobalDecls(payload), [
    { name: "alpha", type: 0x15, kind: 0 },
    { name: "z", type: 0x09, kind: 0 },
    { name: "bb", type: 0x08, kind: 0 },
    { name: "c3", type: 0x0d, kind: 0 },
    { name: "gg", type: 0x15, kind: 1 },
  ]);
});

test("parseGlobalDecls returns an empty list for an empty (no module variables) payload", () => {
  assert.deepEqual(parseGlobalDecls(Buffer.alloc(0)), []);
});

test("parseGlobalDecls groups live-format module structure fields under their header", () => {
  const rec = (type: number, kind: number, nested: boolean, name: string) =>
    Buffer.concat([
      Buffer.from([type, 0, kind, nested ? 1 : 0, 0, 0, 0]),
      nulString(name),
      Buffer.from([0]),
    ]);
  const payload = Buffer.concat([
    rec(0x07, 1, false, "point.ProbePoint"),
    rec(0x15, 1, true, "x"),
    rec(0x08, 1, true, "label"),
    rec(0x15, 1, false, "after"),
  ]);
  assert.deepEqual(parseGlobalDecls(payload), [
    {
      name: "point.ProbePoint",
      type: 0x07,
      kind: 1,
      children: [
        { name: "x", type: 0x15, kind: 1 },
        { name: "label", type: 0x08, kind: 1 },
      ],
    },
    { name: "after", type: 0x15, kind: 1 },
  ]);
});

test("parseArrayDecls extracts the bare name up to the dimension parens", () => {
  // Layout: "<name>(<dims>)\0" + 1 type byte + 1 kind byte, repeated.
  const one = Buffer.concat([Buffer.from("nums(10)\0", "latin1"), Buffer.from([0x15, 3])]);
  const two = Buffer.concat([Buffer.from("scores(5,5)\0", "latin1"), Buffer.from([0x02, 3])]);
  assert.deepEqual(parseArrayDecls(Buffer.concat([one, two])), [{ name: "nums" }, { name: "scores" }]);
});

test("parseListDecls decodes name, count, and current index", () => {
  const payload = Buffer.concat([
    nulString("names"),
    Buffer.from([0, 0x15, 3]), // flag, type, kind
    int64le(3), // ListCount
    int64le(1), // ListIndex
  ]);
  assert.deepEqual(parseListDecls(payload), [{ name: "names", count: 3, currentIndex: 1 }]);
});

test("parseMapDecls decodes the current-key tail when present", () => {
  const payload = Buffer.concat([
    nulString("scores"),
    Buffer.from([0, 0x15, 3]),
    int64le(2), // MapSize
    Buffer.from([1]), // hasCurrentKey
    nulString("beta"),
  ]);
  assert.deepEqual(parseMapDecls(payload), [{ name: "scores", size: 2, currentKey: "beta" }]);
});

test("parseMapDecls omits currentKey when hasCurrentKey is 0", () => {
  const payload = Buffer.concat([nulString("scores"), Buffer.from([0, 0x15, 3]), int64le(0), Buffer.from([0])]);
  assert.deepEqual(parseMapDecls(payload), [{ name: "scores", size: 0, currentKey: undefined }]);
});

test("parseArrayElements decodes echoed name plus index/value pairs", () => {
  const payload = Buffer.concat([nulString("nums()"), nulString("0"), int64le(10), nulString("1"), int64le(20)]);
  assert.deepEqual(parseArrayElements(payload), {
    name: "nums()",
    elements: [
      { index: "0", value: "10" },
      { index: "1", value: "20" },
    ],
  });
});

test("parseMapElements decodes echoed name plus key/value pairs", () => {
  const payload = Buffer.concat([
    nulString("scores()"),
    nulString("alpha"),
    int64le(1),
    nulString("beta"),
    int64le(2),
  ]);
  assert.deepEqual(parseMapElements(payload), {
    name: "scores()",
    elements: [
      { key: "alpha", value: "1" },
      { key: "beta", value: "2" },
    ],
  });
});

test("parseListElements decodes the confirmed numeric 16-bytes-per-element layout", () => {
  const payload = Buffer.concat([nulString("nums()"), int64le(0), int64le(10), int64le(1), int64le(20)]);
  assert.deepEqual(parseListElements(payload, 2), {
    name: "nums()",
    elements: [
      { index: "0", value: "10" },
      { index: "1", value: "20" },
    ],
  });
});

test("parseListElements returns undefined when the payload doesn't match elementCount * 16 bytes (e.g. the List<String> mistagged-type case)", () => {
  const payload = Buffer.concat([nulString("names()"), int64le(0), Buffer.from([0])]); // 9 bytes/element shape, not 16
  assert.equal(parseListElements(payload, 2), undefined);
});

test("parseListElements returns undefined with no NUL terminator at all", () => {
  assert.equal(parseListElements(Buffer.from([1, 2, 3]), 1), undefined);
});

function fakeMessage(f12: number, payload: Buffer): PbMessage {
  return { type: 0, len: payload.length, f8: 0, f12, f16: 0, payload };
}

test("parseEvaluateReply decodes an error (kind 0) as a NUL-terminated string", () => {
  const result = parseEvaluateReply(fakeMessage(0, nulString("Missing a value to assign.")));
  assert.deepEqual(result, { kind: 0, error: "Missing a value to assign." });
});

test("parseEvaluateReply decodes a numeric reply (kind 1-3) as a raw LE int64", () => {
  const result = parseEvaluateReply(fakeMessage(2, int64le(99)));
  assert.deepEqual(result, { kind: 2, value: "99" });
});

test("parseEvaluateReply decodes a string reply (kind 4)", () => {
  const result = parseEvaluateReply(fakeMessage(4, nulString("beta")));
  assert.deepEqual(result, { kind: 4, value: "beta" });
});

test("parseDebugOutputText decodes a NUL-terminated string, ignoring anything after the NUL", () => {
  assert.equal(parseDebugOutputText(nulString("line4")), "line4");
});

test("parseDebugOutputText decodes a live-confirmed truncated payload (first half of the real text, zero-padded)", () => {
  // Real capture: `Debug "line4 c=" + Str(c)` (9 chars + NUL = 10 bytes
  // intended) arrives as only "line4" (5 bytes) plus 5 zero-padding bytes --
  // PureBasic's own debugger.a runtime bug, not a parser bug (see
  // parseDebugOutputText's doc comment). The parser's job is just to decode
  // whatever arrived, truncated or not.
  const payload = Buffer.from("6c696e65340000000000", "hex");
  assert.equal(parseDebugOutputText(payload), "line4");
});

test("parseDebugOutputText returns the whole payload verbatim if it never finds a NUL", () => {
  assert.equal(parseDebugOutputText(Buffer.from("no-nul-here", "latin1")), "no-nul-here");
});

test("parseEvaluateReply surfaces an unrecognized kind (e.g. 5, structure) as unsupported", () => {
  const result = parseEvaluateReply(fakeMessage(5, Buffer.alloc(0)));
  assert.equal(result.kind, 5);
  assert.match(result.error ?? "", /not decoded/);
});
