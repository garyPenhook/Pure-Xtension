// Unit tests for the wire-protocol decoders in src/debug/pbSession.ts.
// These are pure functions (Buffer in, struct out) with no dependency on a
// live PureBasic compiler, target process, or FIFO transport, so they're
// tested directly against hand-built buffers matching the layouts documented
// next to each parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "net";
import {
  allocateFreeTcpPort,
  type PbReadable,
  type PbWritable,
  buildConnectRequest,
  DBP_EVAL_ERROR,
  DBP_TRUE,
  encodeDataBreakpointPayload,
  MSG_DATA_BREAKPOINT,
  parseCompilerVersionBanner,
  parseHandshakeReply,
  PbDebugSession,
  parseArrayDecls,
  parseArrayElements,
  parseDataBreakpointEvent,
  parseDebugOutputText,
  parseEvaluateReply,
  parseFrames,
  parseGlobalDecls,
  parseListDecls,
  parseListElements,
  parseMapDecls,
  parseMapElements,
  parseVariables,
  splitHandshakeFrame,
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
  const writes = capturedWrites(send);
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

function capturedWrites(send: (session: PbDebugSession) => void): Buffer[] {
  const session = new PbDebugSession();
  const writes: Buffer[] = [];
  (session as unknown as { writeStream: { write(chunk: Buffer): boolean } }).writeStream = {
    write(chunk: Buffer): boolean {
      writes.push(Buffer.from(chunk));
      return true;
    },
  };
  send(session);
  return writes;
}

test("addDataBreakpoint encodes opcode 3/f8=4/f12=procedureScope plus an id+latin1-condition payload", () => {
  const writes = capturedWrites((s) => s.addDataBreakpoint(1, "total > 400"));
  assert.equal(writes.length, 2, "header and payload are written separately");
  const [header, payload] = writes;
  assert.deepEqual(
    [header.readInt32LE(0), header.readInt32LE(4), header.readInt32LE(8), header.readInt32LE(12)],
    [3, 16, 4, -2],
  );
  // 4 (id) + 11 (latin1 "total > 400") + 1 (NUL) = 16. Live-confirmed against
  // a real target: this adapter never sets PB_DEBUGGER_Options' Unicode
  // field, so the target defaults to ANSI, not the UTF-16LE PLAN.md's M9.5
  // GUI capture used (that capture explicitly ran with Unicode enabled).
  assert.equal(payload.length, 16);
  assert.equal(payload.readInt32LE(0), 1);
  assert.equal(payload.subarray(4, payload.length - 1).toString("latin1"), "total > 400");
  assert.equal(payload[payload.length - 1], 0);
});

test("addDataBreakpoint honors an explicit procedure scope", () => {
  const [header] = capturedWrites((s) => s.addDataBreakpoint(2, "x > 0", 3));
  assert.equal(header.readInt32LE(12), 3);
});

test("removeDataBreakpoint encodes opcode 3/f8=5 with the numeric id in f12 and no payload", () => {
  const header = capturedControlHeader((s) => s.removeDataBreakpoint(7));
  assert.deepEqual([header.readInt32LE(0), header.readInt32LE(4), header.readInt32LE(8), header.readInt32LE(12)], [3, 0, 5, 7]);
});

test("clearAllDataBreakpoints encodes opcode 3/f8=6 with no payload", () => {
  const header = capturedControlHeader((s) => s.clearAllDataBreakpoints());
  assert.deepEqual([header.readInt32LE(0), header.readInt32LE(4), header.readInt32LE(8)], [3, 0, 6]);
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

function dataBreakpointMessage(status: number, id: number, payload: Buffer = Buffer.alloc(0)): PbMessage {
  return { type: MSG_DATA_BREAKPOINT, len: payload.length, f8: status, f12: id, f16: 0, payload };
}

test("parseDataBreakpointEvent decodes a no-payload status (added/could-not-add/false/true)", () => {
  assert.deepEqual(parseDataBreakpointEvent(dataBreakpointMessage(1, 5)), { id: 5, status: 1 });
  assert.deepEqual(parseDataBreakpointEvent(dataBreakpointMessage(DBP_TRUE, 5)), { id: 5, status: DBP_TRUE });
});

test("parseDataBreakpointEvent decodes the eval-error payload as a NUL-terminated latin1 string", () => {
  const msg = dataBreakpointMessage(DBP_EVAL_ERROR, 5, nulString("Missing a value to assign."));
  assert.deepEqual(parseDataBreakpointEvent(msg), { id: 5, status: DBP_EVAL_ERROR, error: "Missing a value to assign." });
});

test("dispatch() routes MSG_DATA_BREAKPOINT to the dataBreakpoint event, never to a pending request waiter", async () => {
  const session = new PbDebugSession();
  const internals = session as unknown as { dispatch(message: PbMessage): void };

  const events: unknown[] = [];
  session.on("dataBreakpoint", (evt) => events.push(evt));

  const stray = dataBreakpointMessage(DBP_TRUE, 3);
  // Simulate an unrelated request still in flight when the unsolicited
  // type-39 event arrives -- it must not be handed to this waiter as if it
  // were that request's reply (same hazard MSG_DEBUG_OUTPUT was fixed for).
  const pendingReply = (session as unknown as { nextMessage(expectedType?: number): Promise<PbMessage> }).nextMessage(16);
  internals.dispatch(stray);

  assert.deepEqual(events, [{ id: 3, status: DBP_TRUE }]);

  const realReply: PbMessage = { type: 16, len: 0, f8: 0, f12: 0, f16: 0, payload: Buffer.alloc(0) };
  internals.dispatch(realReply);
  assert.equal(await pendingReply, realReply);
});

test("buildConnectRequest encodes the blank-line-terminated CONNECT text", () => {
  assert.deepEqual(buildConnectRequest(641), Buffer.from("CONNECT 641 EXECUTABLE\n\n", "latin1"));
  assert.deepEqual(buildConnectRequest(641, "DEBUGGER"), Buffer.from("CONNECT 641 DEBUGGER\n\n", "latin1"));
});

function wireMessageBytes(type: number, f8: number, f12: number, f16: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(20);
  header.writeInt32LE(type, 0);
  header.writeInt32LE(payload.length, 4);
  header.writeInt32LE(f8, 8);
  header.writeInt32LE(f12, 12);
  header.writeInt32LE(f16, 16);
  return Buffer.concat([header, payload]);
}

test("splitHandshakeFrame extracts the ACCEPT text and leaves the trailing MSG_HELLO bytes untouched", () => {
  // Live-captured shape (PLAN.md M10.1): ACCEPT reply immediately followed
  // by the binary MSG_HELLO, with no gap -- the parser must not consume a
  // single byte of it.
  const hello = wireMessageBytes(0, 0, 0, 0, Buffer.concat([nulString("/tmp/pbnet"), nulString("test.pb")]));
  const buf = Buffer.concat([Buffer.from("ACCEPT 641 EXECUTABLE\n  Encryption: 0\n\n", "latin1"), hello]);
  const frame = splitHandshakeFrame(buf);
  assert.equal(frame?.text, "ACCEPT 641 EXECUTABLE\n  Encryption: 0");
  assert.deepEqual(frame?.rest, hello);
});

test("splitHandshakeFrame returns undefined until the terminator has fully arrived", () => {
  const partial = Buffer.from("ACCEPT 641 EXECUTABLE\n  Encryption: 0\n", "latin1"); // only one trailing \n so far
  assert.equal(splitHandshakeFrame(partial), undefined);
  const complete = Buffer.concat([partial, Buffer.from("\n", "latin1")]);
  assert.equal(splitHandshakeFrame(complete)?.text, "ACCEPT 641 EXECUTABLE\n  Encryption: 0");
});

test("parseHandshakeReply decodes a successful ACCEPT", () => {
  assert.deepEqual(parseHandshakeReply("ACCEPT 641 EXECUTABLE\n  Encryption: 0"), {
    ok: true,
    version: 641,
    token: "EXECUTABLE",
    error: undefined,
  });
});

test("parseHandshakeReply decodes every documented ERROR keyword, with and without a Message line", () => {
  for (const keyword of ["WrongVersion", "InvalidRequest", "NoService", "NoDebugger"]) {
    assert.deepEqual(parseHandshakeReply(`ERROR 641 ${keyword}\n  Message: something went wrong`), {
      ok: false,
      version: 641,
      token: keyword,
      error: "something went wrong",
    });
  }
  assert.deepEqual(parseHandshakeReply("ERROR 641 NoDebugger"), {
    ok: false,
    version: 641,
    token: "NoDebugger",
    error: undefined,
  });
});

test("parseCompilerVersionBanner decodes the real live compiler banner into major*100+minor", () => {
  assert.equal(
    parseCompilerVersionBanner("PureBasic 6.41 (Linux - x64)\nLoading external modules...\nStarting compilation...\n"),
    641,
  );
});

test("parseCompilerVersionBanner returns undefined for unrecognizable text, never a guess", () => {
  assert.equal(parseCompilerVersionBanner(""), undefined);
  assert.equal(parseCompilerVersionBanner("some unrelated compiler output"), undefined);
});

test("allocateFreeTcpPort returns a port that can actually be bound", async () => {
  const port = await allocateFreeTcpPort();
  assert.ok(port > 0 && port < 65536);
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
});

/** `server.close()` alone only stops accepting *new* connections -- already
 *  accepted sockets stay open (and keep the event loop alive) until
 *  destroyed, so every fake-target test server here must track and destroy
 *  its accepted sockets on teardown. */
function closeServerAndSockets(server: net.Server, sockets: Set<net.Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  return new Promise((resolve) => server.close(() => resolve()));
}

test("connectTcp retries past an initial ECONNREFUSED instead of failing immediately (target not listening yet)", async () => {
  // Unlike a FIFO open (which blocks until the target opens its end), a TCP
  // connect attempt made before the target's own listen() call fails
  // immediately with ECONNREFUSED -- live-confirmed: launching a real
  // target and connecting right after spawn reliably refuses on the first
  // attempt. connectTcp must retry rather than surface that as a launch
  // failure.
  const port = await allocateFreeTcpPort();
  const hello = wireMessageBytes(0, 0, 0, 0, Buffer.alloc(0));
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("data", () => {
      socket.write(Buffer.concat([Buffer.from("ACCEPT 641 EXECUTABLE\n  Encryption: 0\n\n", "latin1"), hello]));
    });
  });
  // Start listening only after a short delay, simulating the real
  // spawn-to-listen() gap this retry loop exists to cover.
  const session = new PbDebugSession();
  const connectPromise = session.connectTcp(port, 641, 2000);
  await new Promise((resolve) => setTimeout(resolve, 150));
  try {
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    const msg = await connectPromise;
    assert.equal(msg.type, 0);
  } finally {
    session.close();
    await closeServerAndSockets(server, sockets);
  }
});

test("connectTcp resolves once ACCEPT and MSG_HELLO arrive in a single TCP write (the framing hazard, over a real socket)", async () => {
  const port = await allocateFreeTcpPort();
  const hello = wireMessageBytes(0, 0, 0, 0, Buffer.concat([nulString("/tmp/pbnet"), nulString("test.pb")]));
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("data", () => {
      socket.write(Buffer.concat([Buffer.from("ACCEPT 641 EXECUTABLE\n  Encryption: 0\n\n", "latin1"), hello]));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const session = new PbDebugSession();
  try {
    const msg = await session.connectTcp(port, 641);
    assert.equal(msg.type, 0, "connectTcp should resolve with the parsed MSG_HELLO, not just an ack");
  } finally {
    session.close();
    await closeServerAndSockets(server, sockets);
  }
});

test("connectTcp rejects with the target's error keyword on a version mismatch", async () => {
  const port = await allocateFreeTcpPort();
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("data", () => {
      socket.write(Buffer.from("ERROR 641 WrongVersion\n  Message: version mismatch\n\n", "latin1"));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  try {
    const session = new PbDebugSession();
    await assert.rejects(session.connectTcp(port, 1), /WrongVersion/);
  } finally {
    await closeServerAndSockets(server, sockets);
  }
});

test("attachTransport wires the error listener only once when read and write streams are the same object (TCP)", () => {
  // Regression test: TCP hands the same net.Socket to both roles. Attaching
  // the shared "error" handler to each field independently (as if they were
  // always-distinct FIFO streams) would fire it twice for one real error.
  const session = new PbDebugSession();
  const internals = session as unknown as {
    attachTransport(readStream: PbReadable, writeStream: PbWritable, timeoutMs: number, seed?: Buffer): Promise<PbMessage>;
  };
  let errorCount = 0;
  session.on("error", () => errorCount++);

  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const fakeSocket: PbReadable & PbWritable = {
    on(event: string, listener: (...args: unknown[]) => void) {
      (listeners.get(event) ?? listeners.set(event, []).get(event)!).push(listener);
      return fakeSocket;
    },
    write: () => true,
    destroy: () => undefined,
    end: () => undefined,
  } as unknown as PbReadable & PbWritable;

  // Reject the connect promise immediately after -- this test only cares
  // about how many listeners attachTransport registers, not the HELLO wait.
  internals.attachTransport(fakeSocket, fakeSocket, 5).catch(() => undefined);
  for (const listener of listeners.get("error") ?? []) listener(new Error("boom"));

  assert.equal(errorCount, 1, "a shared read/write stream must only fire the error handler once per real error");
});

test("connectTcp shares one overall timeout budget across connect/handshake/hello instead of tripling it", async () => {
  // Regression test: each phase used to get a fresh `timeoutMs` of its own,
  // so a target that never completes the handshake could take up to 3x the
  // requested timeout to fail instead of respecting the caller's budget.
  const port = await allocateFreeTcpPort();
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    // Accept the connection but never reply -- the handshake phase should
    // be the one that times out, and it must do so within the shared
    // budget, not a fresh 300ms window of its own.
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  try {
    const session = new PbDebugSession();
    const start = Date.now();
    await assert.rejects(session.connectTcp(port, 641, 300), /timed out/);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 600, `connectTcp should fail within roughly one timeout budget, took ${elapsed}ms`);
  } finally {
    await closeServerAndSockets(server, sockets);
  }
});
