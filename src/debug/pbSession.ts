// Reusable client for PureBasic's external-debugger wire protocol, extracted
// from the throwaway spikes in src/debug/spike/ once their findings were
// live-confirmed (see PLAN.md's M5 section for the full decode/verification
// trail). This file only encodes what was actually confirmed against a real
// running target, not the still-unconfirmed parts (stepping, data
// breakpoints, array/struct expansion).
import * as fs from "fs";
import { EventEmitter } from "events";

const HEADER_SIZE = 20;

// Opcodes confirmed live (PLAN.md M5).
export const OP_CONTROL = 0; // sub-commands via f8; only "continue" (below) is used here
export const OP_CONTINUE = 2; // Control, unconditionally clears the stop flag
export const OP_BREAKPOINTS = 3; // 7-way sub-dispatch on f8
export const OP_EXAMINE_GLOBALS = 9; // ExamineVariables(-1)
export const OP_EXAMINE_CONTINUE = 10;
export const OP_EXAMINE_CURRENT_FRAME = 11;
export const OP_STACK_TRACE = 16;
export const OP_EXAMINE_FRAME = 17; // f8 = frame index, 0 = outermost
export const OP_EVALUATE = 33; // ExternalDebugger_Expression read side; 34 is byte-identical
export const OP_MODIFY = 35; // ExternalDebugger_Expression write side (ModifyVariable)

// ExternalDebugger_ArraysLists opcodes (PLAN.md M5, live-tested against
// src/debug/spike/test-arrays.pb via fifo-arrayslists.mjs). f8=0 selects
// the current/topmost frame's declarations; only that value is
// live-tested (the f8!=0 "global scope" branch is static-decode-only).
export const OP_EXAMINE_ARRAYS = 12; // ExamineArrays/NextArray, reply type 0x10
export const OP_EXAMINE_LISTS = 13; // ExamineLinkedLists/NextLinkedList, reply type 0x12
export const OP_EXAMINE_MAPS = 14; // ExamineMaps/NextMap, reply type 0x14
export const OP_EXAMINE_EXPRESSION = 15; // parse expr, dispatch to SendArrayData/SendListData/SendMapData

// Structure header type tag from the opcode-11/17 scalar variable stream
// (PLAN.md M5, live-confirmed against a `p.Point` local): a record with
// this type byte carries no trailing 8-byte value, and any immediately
// following records whose 4-byte "reserved" field is nonzero are that
// structure's fields, not new top-level variables.
const STRUCT_TYPE_TAG = 0x07;

// Breakpoint sub-commands (opcode 3's f8 field).
export const BP_ADD_LINE = 1;
export const BP_REMOVE_LINE = 2;
export const BP_BULK = 3;
// -1, not 0xffffffff: same 4-byte wire pattern (0xffffffff), but
// Buffer.writeInt32LE only accepts the signed int32 range and throws
// (ERR_OUT_OF_RANGE) on the unsigned literal -- a real crash discovered
// live while smoke-testing clearAllLineBreakpoints() during the M5
// ArraysLists work (PLAN.md), not a hypothetical.
export const BP_BULK_CLEAR_ALL = -1;

// Message types seen on the wire (unsolicited unless noted).
export const MSG_HELLO = 0;
export const MSG_STOPPED = 3; // f8 = 1-based line, f12 = stop-reason code

export interface PbMessage {
  type: number;
  len: number;
  f8: number;
  f12: number;
  f16: number;
  payload: Buffer;
}

export interface PbFrame {
  /** 0-based call-site line number (verified against known source lines). */
  callSiteLine0: number;
  /** Formatted "ProcName(arg1, arg2, ...)" display string. */
  display: string;
}

export interface PbVariable {
  type: number; // e.g. 0x15 for `.i`; 0x07 marks a structure header (see STRUCT_TYPE_TAG)
  kind: number; // 0 = global/module scope, 3 = local
  name: string; // structure headers carry the target's own "Name.TypeName" formatting
  /** Decimal string if the trailing 8 bytes parsed as a plausible number, else a hex dump. Absent for structure headers (type === 0x07), which have no scalar value of their own. */
  value?: string;
  /** Populated for structure headers from the nesting-flagged records that immediately follow them (PLAN.md M5, live-confirmed). */
  children?: PbVariable[];
}

export interface PbArrayDecl {
  /** Bare array name, truncated at "(" -- the dimension-string bytes between the parens are not decoded. */
  name: string;
}

export interface PbListDecl {
  name: string;
  count: number;
  /** 0-based "current element" position (PB_DEBUGGER_ListIndex). */
  currentIndex: number;
}

export interface PbMapDecl {
  name: string;
  size: number;
  currentKey?: string;
}

export interface PbArrayElement {
  index: string;
  value: string;
}

export interface PbListElement {
  index: string;
  value: string;
}

export interface PbMapElement {
  key: string;
  value: string;
}

export interface PbEvaluateResult {
  /** Reply f12: 0 = error, 1-3 = numeric (int/double, tag not yet distinguished), 4 = string, 5 = structure. */
  kind: number;
  /** Set when kind is 0. */
  error?: string;
  /** Set when kind is 1-3 (raw little-endian int64) or 4 (string text). */
  value?: string;
}

// Reply format for opcodes 33/34 (PLAN.md M5, "Expression's read side"),
// live-confirmed for the numeric case (kind 1-3): 8-byte little-endian raw
// value followed by the echoed expression text (payload-length bytes, no
// null terminator). Kind 0 (error) is the PB_Language_GetKey error string,
// NUL-terminated, followed by the echoed expression text. Kind 4 (string)
// is now live-confirmed too — a NUL-terminated value string followed by the
// echoed expression text (e.g. evaluating a List<String>'s bare `name()`
// returns its *current* element this way, live-tested against
// src/debug/spike/test-arrays.pb's `names()`: payload
// `"beta\0names()\0"`). Kind 5 (structure) is still only decoded from the
// disassembly, not live-tested, so it's surfaced as unsupported rather than
// guessed at.
function parseEvaluateReply(msg: PbMessage): PbEvaluateResult {
  if (msg.f12 === 0) {
    const nul = msg.payload.indexOf(0);
    const error = nul === -1 ? msg.payload.toString("latin1") : msg.payload.toString("latin1", 0, nul);
    return { kind: 0, error };
  }
  if (msg.f12 === 1 || msg.f12 === 2 || msg.f12 === 3) {
    const value = msg.payload.readBigInt64LE(0).toString();
    return { kind: msg.f12, value };
  }
  if (msg.f12 === 4) {
    const nul = msg.payload.indexOf(0);
    const value = nul === -1 ? msg.payload.toString("latin1") : msg.payload.toString("latin1", 0, nul);
    return { kind: 4, value };
  }
  return { kind: msg.f12, error: `unsupported evaluate result kind ${msg.f12} (structure results are not decoded yet)` };
}

function parseFrames(payload: Buffer): PbFrame[] {
  const frames: PbFrame[] = [];
  let off = 0;
  while (off + 4 <= payload.length) {
    const callSiteLine0 = payload.readInt32LE(off);
    off += 4;
    const nul = payload.indexOf(0, off);
    const end = nul === -1 ? payload.length : nul;
    frames.push({ callSiteLine0, display: payload.toString("latin1", off, end) });
    off = nul === -1 ? payload.length : nul + 1;
  }
  return frames;
}

// Per-variable record: 7-byte header (type byte, flag byte, kind byte,
// 4-byte "reserved" field), a NUL-terminated name, then an 8-byte
// little-endian value for scalar types. Confirmed for `.i`-typed scalars
// (PLAN.md's original "Per-variable wire record" note) and, as of this
// session, for structure locals too: a record whose type byte is
// STRUCT_TYPE_TAG (0x07) has NO trailing value at all (the name alone,
// e.g. "p.Point", is the whole record), and the 4-byte "reserved" field —
// previously seen as always 0 and assumed to be padding — turns out to be
// a nesting flag: any record immediately after a structure header whose
// reserved field is nonzero is that structure's field, not a new
// top-level variable (live-confirmed against a `p.Point` local with `x`/
// `y` fields, src/debug/spike/fifo-arrayslists.mjs). Strings and
// array/list/map-typed *scalar* variables (as opposed to the dedicated
// ArraysLists opcodes) are still not live-tested.
function parseVariables(payload: Buffer): PbVariable[] {
  interface FlatRecord {
    type: number;
    kind: number;
    nested: boolean;
    name: string;
    value?: string;
  }
  const flat: FlatRecord[] = [];
  let off = 0;
  while (off + 7 < payload.length) {
    const type = payload.readUInt8(off);
    const kind = payload.readUInt8(off + 2);
    const nested = payload.readInt32LE(off + 3) !== 0;
    off += 7;
    const nul = payload.indexOf(0, off);
    if (nul === -1) break;
    const name = payload.toString("latin1", off, nul);
    off = nul + 1;
    if (!name) break;
    let value: string | undefined;
    if (type !== STRUCT_TYPE_TAG) {
      if (off + 8 <= payload.length) {
        value = payload.readBigInt64LE(off).toString();
        off += 8;
      } else {
        value = `0x${payload.subarray(off).toString("hex")}`;
        off = payload.length;
      }
    }
    flat.push({ type, kind, nested, name, value });
  }
  const result: PbVariable[] = [];
  for (const rec of flat) {
    const parent = result[result.length - 1];
    if (rec.nested && parent && parent.type === STRUCT_TYPE_TAG) {
      (parent.children ??= []).push({ type: rec.type, kind: rec.kind, name: rec.name, value: rec.value });
    } else {
      result.push({ type: rec.type, kind: rec.kind, name: rec.name, value: rec.value });
    }
  }
  return result;
}

// Declaration records from opcodes 12/13/14 (PLAN.md M5, live-confirmed
// against src/debug/spike/test-arrays.pb's `nums`/`names`+`counts`/`scores`
// via fifo-arrayslists.mjs).

// Array declaration: `<name>(<dims, not decoded>)\0` + 1 type byte + 1 kind
// byte. Only the bare name (up to "(") is extracted -- the dimension-string
// bytes between the parens weren't fully decoded (see PLAN.md), and aren't
// needed to enumerate which arrays exist.
function parseArrayDecls(payload: Buffer): PbArrayDecl[] {
  const decls: PbArrayDecl[] = [];
  let off = 0;
  while (off < payload.length) {
    const paren = payload.indexOf(0x28, off); // "("
    if (paren === -1) break;
    const name = payload.toString("latin1", off, paren);
    const close = payload.indexOf(0x29, paren); // ")"
    if (close === -1) break;
    off = close + 1; // NUL terminator
    off += 1; // that NUL
    off += 2; // 1 type byte + 1 kind byte
    decls.push({ name });
  }
  return decls;
}

// Linked-list declaration: `<name>\0` + flag byte + type byte + kind byte
// + int64 LE ListCount + int64 LE ListIndex (0-based "current" position).
function parseListDecls(payload: Buffer): PbListDecl[] {
  const decls: PbListDecl[] = [];
  let off = 0;
  while (off < payload.length) {
    const nul = payload.indexOf(0, off);
    if (nul === -1) break;
    const name = payload.toString("latin1", off, nul);
    off = nul + 1;
    if (off + 3 + 16 > payload.length) break;
    off += 3; // flag, type, kind bytes
    const count = Number(payload.readBigInt64LE(off));
    off += 8;
    const currentIndex = Number(payload.readBigInt64LE(off));
    off += 8;
    decls.push({ name, count, currentIndex });
  }
  return decls;
}

// Map declaration: `<name>\0` + flag byte + type byte + kind byte + int64
// LE MapSize + 1 byte hasCurrentKey + (if set) `<key>\0`.
function parseMapDecls(payload: Buffer): PbMapDecl[] {
  const decls: PbMapDecl[] = [];
  let off = 0;
  while (off < payload.length) {
    const nul = payload.indexOf(0, off);
    if (nul === -1) break;
    const name = payload.toString("latin1", off, nul);
    off = nul + 1;
    if (off + 3 + 8 + 1 > payload.length) break;
    off += 3; // flag, type, kind bytes
    const size = Number(payload.readBigInt64LE(off));
    off += 8;
    const hasCurrentKey = payload.readUInt8(off) !== 0;
    off += 1;
    let currentKey: string | undefined;
    if (hasCurrentKey) {
      const knul = payload.indexOf(0, off);
      if (knul !== -1) {
        currentKey = payload.toString("latin1", off, knul);
        off = knul + 1;
      }
    }
    decls.push({ name, size, currentKey });
  }
  return decls;
}

// Opcode-15 Array-data reply (type 0x11): `<echoed expr>\0` + repeated
// (`<decimal index string>\0` + int64 LE value). Confirmed only for a
// numeric (.i) element type.
function parseArrayElements(payload: Buffer): { name: string; elements: PbArrayElement[] } {
  const nul = payload.indexOf(0);
  const name = nul === -1 ? payload.toString("latin1") : payload.toString("latin1", 0, nul);
  let off = nul === -1 ? payload.length : nul + 1;
  const elements: PbArrayElement[] = [];
  while (off < payload.length) {
    const inul = payload.indexOf(0, off);
    if (inul === -1) break;
    const index = payload.toString("latin1", off, inul);
    off = inul + 1;
    if (off + 8 > payload.length) break;
    const value = payload.readBigInt64LE(off).toString();
    off += 8;
    elements.push({ index, value });
  }
  return { name, elements };
}

// Opcode-15 Map-data reply (type 0x15): `<echoed expr>\0` + repeated
// (`<key string>\0` + int64 LE value). Confirmed for a string-keyed,
// numeric-valued map.
function parseMapElements(payload: Buffer): { name: string; elements: PbMapElement[] } {
  const nul = payload.indexOf(0);
  const name = nul === -1 ? payload.toString("latin1") : payload.toString("latin1", 0, nul);
  let off = nul === -1 ? payload.length : nul + 1;
  const elements: PbMapElement[] = [];
  while (off < payload.length) {
    const knul = payload.indexOf(0, off);
    if (knul === -1) break;
    const key = payload.toString("latin1", off, knul);
    off = knul + 1;
    if (off + 8 > payload.length) break;
    const value = payload.readBigInt64LE(off).toString();
    off += 8;
    elements.push({ key, value });
  }
  return { name, elements };
}

// Opcode-15 List-data reply (type 0x13, the SAME tag SendListData uses for
// its own generic error replies -- see the caller for the disambiguation
// this requires): `<echoed expr>\0` + repeated (int64 LE index + int64 LE
// value), 16 bytes/element. Confirmed ONLY for a numeric (.i) element type.
//
// A string-element list's reply is 9 bytes/element instead (18 bytes total
// for 2 elements): an 8-byte LE sequence number identical in shape to the
// numeric case's index, plus a single trailing byte that's always 0 for
// real "alpha"/"beta" strings in a live test. Disassembling
// ExternalDebugger_SendListData (debugger.a, ExternalDebugger.o+0x4f10)
// confirms why: it writes that 8-byte field itself, then delegates the
// *value* to a shared `CopyValue` helper (ExternalDebugger.o+0x960) keyed
// off a type tag. CopyValue's String case (+0xa50) does copy real
// characters -- but for a `NewList x.s()`'s element, whatever type tag
// SendListData actually passes takes CopyValue's default single-byte
// fallback path (+0x9f0: `*dest = *src as byte; return 1`) instead, so the
// wire genuinely never carries the string text; this is not a decoding
// gap, it's a mistagged-type bug in the target's own debugger runtime.
// (`ExternalDebugger_Variables`'s string handling is a separate code path
// and isn't affected -- only this list-element helper is.) Confirmed
// workaround: `PbDebugSession.evaluate("<name>()")` (Expression opcode 33,
// kind 4) DOES return the list's real *current* element text -- live
// output `"beta\0names()\0"` for this exact fixture -- so a per-index dump
// isn't recoverable this way, but the current element is.
function parseListElements(payload: Buffer, elementCount: number): { name: string; elements: PbListElement[] } | undefined {
  const nul = payload.indexOf(0);
  if (nul === -1) return undefined;
  const name = payload.toString("latin1", 0, nul);
  const off0 = nul + 1;
  if (payload.length - off0 !== elementCount * 16) return undefined; // not the confirmed numeric layout
  const elements: PbListElement[] = [];
  let off = off0;
  for (let i = 0; i < elementCount; i++) {
    const index = payload.readBigInt64LE(off).toString();
    off += 8;
    const value = payload.readBigInt64LE(off).toString();
    off += 8;
    elements.push({ index, value });
  }
  return { name, elements };
}

/**
 * Live connection to a PureBasic `-d` build's embedded external debugger,
 * over the FIFO transport (`PB_DEBUGGER_Communication=FifoFiles;<out>;<in>`).
 * Emits `stopped` ({ line, reason }) for unsolicited stop notifications;
 * every other request/response pair is a simple send-then-await-next-message,
 * which is what PLAN.md's live spikes verified is safe while the target is
 * either stopped or the adapter isn't racing a `continue` against a poll.
 */
export class PbDebugSession extends EventEmitter {
  private writeStream?: fs.WriteStream;
  private readStream?: fs.ReadStream;
  private recvBuffer = Buffer.alloc(0);
  private pendingResolvers: ((msg: PbMessage) => void)[] = [];
  private unclaimed: PbMessage[] = [];

  /**
   * Opens both FIFO ends and resolves once the `hello` message arrives.
   * Uses async streams (not readSync/writeSync) so a slow/blocked target
   * never freezes the extension host's event loop — the rendezvous opens
   * themselves are the only blocking-ish step, mirroring the spikes.
   *
   * A FIFO opened for reading blocks until *some* writer opens the other
   * end; if the target dies (or was never a real `-d` build) before it
   * ever calls `FifoConnect`, that open — and this promise — would
   * otherwise hang forever. `timeoutMs` bounds that wait.
   */
  connect(outFifo: string, inFifo: string, timeoutMs = 10000): Promise<PbMessage> {
    this.readStream = fs.createReadStream(outFifo);
    this.readStream.on("data", (chunk) => {
      this.recvBuffer = Buffer.concat([this.recvBuffer, chunk as Buffer]);
      this.drainMessages();
    });
    this.readStream.on("close", () => this.emit("close"));
    this.readStream.on("error", (err) => this.emit("error", err));
    this.writeStream = fs.createWriteStream(inFifo);
    this.writeStream.on("error", (err) => this.emit("error", err));

    const hello = this.nextMessage();
    const timeout = new Promise<PbMessage>((_, reject) => {
      setTimeout(
        () => reject(new Error(`timed out after ${timeoutMs}ms waiting for the debugger to connect`)),
        timeoutMs,
      ).unref();
    });
    return Promise.race([hello, timeout]);
  }

  private drainMessages(): void {
    for (;;) {
      if (this.recvBuffer.length < HEADER_SIZE) return;
      const len = this.recvBuffer.readInt32LE(4);
      const total = HEADER_SIZE + Math.max(0, len);
      if (this.recvBuffer.length < total) return;
      const msg: PbMessage = {
        type: this.recvBuffer.readInt32LE(0),
        len,
        f8: this.recvBuffer.readInt32LE(8),
        f12: this.recvBuffer.readInt32LE(12),
        f16: this.recvBuffer.readInt32LE(16),
        payload: len > 0 ? Buffer.from(this.recvBuffer.subarray(HEADER_SIZE, total)) : Buffer.alloc(0),
      };
      this.recvBuffer = this.recvBuffer.subarray(total);
      this.dispatch(msg);
    }
  }

  private dispatch(msg: PbMessage): void {
    if (msg.type === MSG_STOPPED) {
      this.emit("stopped", { line: msg.f8, reason: msg.f12 });
      return;
    }
    const resolver = this.pendingResolvers.shift();
    if (resolver) {
      resolver(msg);
    } else {
      this.unclaimed.push(msg);
    }
  }

  private nextMessage(): Promise<PbMessage> {
    const buffered = this.unclaimed.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve) => this.pendingResolvers.push(resolve));
  }

  private write(opcode: number, f8 = 0, f12 = 0, f16 = 0, payload?: Buffer, len = 0): void {
    const buf = Buffer.alloc(HEADER_SIZE);
    buf.writeInt32LE(opcode, 0);
    buf.writeInt32LE(len, 4);
    buf.writeInt32LE(f8, 8);
    buf.writeInt32LE(f12, 12);
    buf.writeInt32LE(f16, 16);
    this.writeStream!.write(buf);
    if (payload) this.writeStream!.write(payload);
  }

  /** Drain the unconditional startup announcement sent right after `hello`. */
  drainStartupAnnouncement(): Promise<PbMessage> {
    return this.nextMessage();
  }

  /** Opcode 2: unconditionally clears the target's stop flag and lets it run. */
  continue(): void {
    this.write(OP_CONTINUE, 0);
  }

  addLineBreakpoint(line: number, moduleId = 0): void {
    this.write(OP_BREAKPOINTS, BP_ADD_LINE, (moduleId << 20) | line);
  }

  removeLineBreakpoint(line: number, moduleId = 0): void {
    this.write(OP_BREAKPOINTS, BP_REMOVE_LINE, (moduleId << 20) | line);
  }

  clearAllLineBreakpoints(): void {
    this.write(OP_BREAKPOINTS, BP_BULK, BP_BULK_CLEAR_ALL);
  }

  async stackTrace(): Promise<PbFrame[]> {
    this.write(OP_STACK_TRACE);
    const msg = await this.nextMessage();
    return parseFrames(msg.payload);
  }

  async examineGlobals(): Promise<PbVariable[]> {
    this.write(OP_EXAMINE_GLOBALS);
    const msg = await this.nextMessage();
    return parseVariables(msg.payload);
  }

  async examineCurrentFrame(): Promise<PbVariable[]> {
    this.write(OP_EXAMINE_CURRENT_FRAME);
    const msg = await this.nextMessage();
    return parseVariables(msg.payload);
  }

  /** frameIndex is opcode-16 order: 0 = outermost caller, increasing toward the current frame. */
  async examineFrame(frameIndex: number): Promise<PbVariable[]> {
    this.write(OP_EXAMINE_FRAME, frameIndex);
    const msg = await this.nextMessage();
    return parseVariables(msg.payload);
  }

  /**
   * Opcode 12: enumerate arrays. `global` selects ExamineArrays(-1) (f8!=0,
   * static-decode-only); the default (f8=0) is the current/topmost frame's
   * arrays, the only case live-tested (PLAN.md M5,
   * src/debug/spike/fifo-arrayslists.mjs). There is no confirmed way to
   * target an arbitrary non-topmost frame the way opcode 17 does for
   * scalars.
   */
  async examineArrays(global = false): Promise<PbArrayDecl[]> {
    this.write(OP_EXAMINE_ARRAYS, global ? 1 : 0);
    const msg = await this.nextMessage();
    return parseArrayDecls(msg.payload);
  }

  /** Opcode 13: enumerate linked lists. Same f8/scope caveat as {@link examineArrays}. */
  async examineLists(global = false): Promise<PbListDecl[]> {
    this.write(OP_EXAMINE_LISTS, global ? 1 : 0);
    const msg = await this.nextMessage();
    return parseListDecls(msg.payload);
  }

  /** Opcode 14: enumerate maps. Same f8/scope caveat as {@link examineArrays}. */
  async examineMaps(global = false): Promise<PbMapDecl[]> {
    this.write(OP_EXAMINE_MAPS, global ? 1 : 0);
    const msg = await this.nextMessage();
    return parseMapDecls(msg.payload);
  }

  /**
   * Opcode 15: parse `expression` (e.g. `"nums()"`, `"scores()"`) and fetch
   * that array/list/map's element data. Returns `undefined` if the target
   * rejected the expression (not an Array/LinkedList/Map, or a parse
   * error) or if the reply's shape didn't match a confirmed layout (the
   * List<String> case — see {@link parseListElements}).
   *
   * Reply type 0x11 = Array data, 0x15 = Map data, 0x13 = List data OR a
   * generic error (SendListData hardcodes the same type tag ArraysLists'
   * own "not a container"/parse-error path uses — PLAN.md M5). The two are
   * disambiguated here by checking whether the payload's echoed name
   * matches the expression actually sent; a real reply always echoes it
   * verbatim, an error message never does.
   */
  async examineExpression(
    expression: string,
    frameContext = -1,
  ): Promise<
    | { kind: "array"; name: string; elements: PbArrayElement[] }
    | { kind: "map"; name: string; elements: PbMapElement[] }
    | { kind: "list"; name: string; elements: PbListElement[] }
    | { kind: "unsupported"; raw: Buffer }
    | { kind: "error"; message: string }
  > {
    const payload = Buffer.concat([Buffer.from(expression, "latin1"), Buffer.from([0])]);
    this.write(OP_EXAMINE_EXPRESSION, 0, frameContext, 0, payload, payload.length);
    const msg = await this.nextMessage();
    const echoesExpression = msg.payload.length >= expression.length && msg.payload.toString("latin1", 0, expression.length) === expression;
    if (msg.type === 0x11 && echoesExpression) {
      const { name, elements } = parseArrayElements(msg.payload);
      return { kind: "array", name, elements };
    }
    if (msg.type === 0x15 && echoesExpression) {
      const { name, elements } = parseMapElements(msg.payload);
      return { kind: "map", name, elements };
    }
    if (msg.type === 0x13 && echoesExpression) {
      const listResult = parseListElements(msg.payload, msg.f12);
      if (listResult) return { kind: "list", name: listResult.name, elements: listResult.elements };
      return { kind: "unsupported", raw: msg.payload };
    }
    // Not a recognized data reply, or the echoed-name check failed: treat
    // the whole payload as the target's own error string.
    const nul = msg.payload.indexOf(0);
    const message = nul === -1 ? msg.payload.toString("latin1") : msg.payload.toString("latin1", 0, nul);
    return { kind: "error", message };
  }

  /**
   * Opcode 33 (`evaluate`/watch/hover read): `expression` is parsed by the
   * target's real expression evaluator (`a+b` works, not just bare names).
   * `frameContext` is passed as the request's f12 (`GetLineContext` arg);
   * `-1` means "the currently-stopped line", the only value live-tested so
   * far (PLAN.md M5) — evaluating in an outer stack frame's context is an
   * open question, not yet confirmed to work or to even be meaningful here.
   */
  async evaluate(expression: string, frameContext = -1): Promise<PbEvaluateResult> {
    const payload = Buffer.concat([Buffer.from(expression, "latin1"), Buffer.from([0])]);
    // len must be the full byte count actually sent (incl. the NUL) — the
    // comm thread reads exactly `len` payload bytes off the wire before
    // dispatching, regardless of where ParseExpressionExternal's own
    // estrlen finds the string end. Sending len = expression.length
    // (excl. NUL, matching the throwaway spike's convention) leaves one
    // stray byte unread in the FIFO, which silently shifts and hangs the
    // *next* request's header framing — only surfaces across two
    // sequential requests on one connection, not a single one-off call.
    this.write(OP_EVALUATE, 0, frameContext, 0, payload, payload.length);
    const msg = await this.nextMessage();
    return parseEvaluateReply(msg);
  }

  /**
   * Opcode 35 (`setVariable`/`setExpression` write side): payload is two
   * back-to-back NUL-terminated strings, `target` (parsed lvalue-mode) then
   * `value` (parsed value-mode). Reply shares opcode 33/34's layout (8-byte
   * LE result, or a NUL-terminated error string when `f12 === 0`) with the
   * echoed `target`/`value` strings trailing it, which `parseEvaluateReply`
   * already ignores. Live-confirmed: `a` went from `5` to `99` and read back
   * as `99` on a subsequent opcode-33 evaluate (see PLAN.md's M5 section) —
   * the earlier "Missing a value to assign." failure was this same
   * len-must-include-every-NUL framing bug found for opcode 33, not a real
   * target-side `ModifyVariable` problem.
   */
  async setVariable(target: string, value: string): Promise<PbEvaluateResult> {
    const payload = Buffer.concat(
      [target, value].map((s) => Buffer.concat([Buffer.from(s, "latin1"), Buffer.from([0])])),
    );
    this.write(OP_MODIFY, 0, -1, 0, payload, payload.length);
    const msg = await this.nextMessage();
    return parseEvaluateReply(msg);
  }

  close(): void {
    this.readStream?.destroy();
    this.writeStream?.end();
    this.readStream = undefined;
    this.writeStream = undefined;
  }
}
