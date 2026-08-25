// Unit tests for the wire-protocol decoders in src/debug/pbSession.ts.
// These are pure functions (Buffer in, struct out) with no dependency on a
// live PureBasic compiler, target process, or FIFO transport, so they're
// tested directly against hand-built buffers matching the layouts documented
// next to each parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseArrayDecls,
  parseArrayElements,
  parseEvaluateReply,
  parseFrames,
  parseListDecls,
  parseListElements,
  parseMapDecls,
  parseMapElements,
  parseVariables,
  type PbMessage,
} from "../src/debug/pbSession";

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

test("parseEvaluateReply surfaces an unrecognized kind (e.g. 5, structure) as unsupported", () => {
  const result = parseEvaluateReply(fakeMessage(5, Buffer.alloc(0)));
  assert.equal(result.kind, 5);
  assert.match(result.error ?? "", /not decoded/);
});
