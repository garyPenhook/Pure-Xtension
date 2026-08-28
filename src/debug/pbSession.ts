// Reusable client for PureBasic's external-debugger wire protocol, extracted
// from the throwaway spikes in src/debug/spike/ once their findings were
// live-confirmed (see PLAN.md's M5 section for the full decode/verification
// trail). This file only encodes what was actually confirmed against a real
// running target, not the still-unconfirmed parts (stepping, data
// breakpoints, array/struct expansion).
import * as fs from "fs";
import { EventEmitter } from "events";

const HEADER_SIZE = 20;
// Sanity bound for a message's declared payload length (see drainMessages) —
// real payloads (variable/array/list dumps) are a few KB at most.
const MAX_MESSAGE_LEN = 16 * 1024 * 1024;

// Execution-control opcodes, captured from the real PureBasic 6.41 standalone
// debugger (PLAN.md M9). These are independent top-level commands; command 2
// is run/continue only, not a step sub-command as the older M5 experiments
// incorrectly inferred.
export const OP_PAUSE = 0; // cooperative: stops at the next PB_DEBUGGER_Check
export const OP_STEP = 1; // f8: positive count, -1 over, -2 out
export const OP_CONTINUE = 2; // f8=1 also requests MSG_CONTINUED acknowledgement
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
// Data-breakpoint sub-commands (opcode 3's f8 field), decoded from the
// official open-source fantaisie-software/purebasic debugger client
// (PureBasicDebugger/DataBreakPoints.pb) and confirmed live (PLAN.md M9.5).
// f12 on add is the procedure scope (-2 = all procedures, -1 = main body,
// else a procedure index); on remove, f12 is the numeric id assigned at add
// time. See removeDataBreakpoint's doc comment for the id-reuse invariant.
export const BP_ADD_DATA = 4;
export const BP_REMOVE_DATA = 5;
export const BP_CLEAR_ALL_DATA = 6;

// Message types seen on the wire (unsolicited unless noted).
export const MSG_HELLO = 0;
// PB_DEBUGGER_EndExternal sends this header-only message immediately before
// tearing down the external-debugger transport (live-confirmed; see PLAN.md
// M6). It is unsolicited, just like MSG_STOPPED, and must not be mistaken for
// the reply to an in-flight request.
export const MSG_TERMINATED = 1;
// PB_DEBUGGER_Start's own unconditional second startup announcement, sent
// once right after MSG_HELLO regardless of anything the client does (PLAN.md
// M5, "type=2, f12=0x20002"). Unsolicited, not a reply to any request.
export const MSG_STARTUP_ANNOUNCEMENT = 2;
export const MSG_STOPPED = 3; // f8 = 0-based compiled-line index (matches addLineBreakpoint's convention), f12 = stop-reason code
// A data breakpoint's condition became true (PLAN.md M9.6). This stop
// carries no id of its own -- correlate it to the firing breakpoint via the
// most recent MSG_DATA_BREAKPOINT/DBP_TRUE event, which PLAN.md confirms
// always arrives immediately before it.
export const STOP_REASON_DATA_BREAKPOINT = 9;
// Sent in response to OP_CONTINUE with f8=1. It is an acknowledgement, not a
// request/reply payload, so dispatch it as an event rather than allowing it to
// accumulate in the unmatched-message queue.
export const MSG_CONTINUED = 4;
// Debug-statement output notification (`Debug "..."`), confirmed live: fires
// as a side effect of a `Debug` statement executing, independent of the
// stdout capture pbDebugAdapter.ts already uses for the Debug Console.
// Unsolicited -- was previously unhandled by dispatch() and could be
// silently consumed as if it were the reply to an unrelated request issued
// shortly after a `continue` that runs past a `Debug` line (confirmed by
// live repro: evaluate() returned a bogus kind-0 "error" whose message was
// literally the executed line's Debug string).
export const MSG_DEBUG_OUTPUT = 5;
// ExternalDebugger_Expression's reply tag for both the read side (opcode 33)
// and, per PLAN.md M5, the write side (opcode 35, "shares opcode 33/34's
// layout") -- confirmed empirically here (not previously documented with a
// numeric value in PLAN.md): a live evaluate("a") request's matching reply
// arrived tagged type 36.
export const MSG_EVALUATE_REPLY = 36;
// DataBreakPoint status report (PLAN.md M9.5/M9.6, decoded from the official
// DataBreakPoints.pb): f8 is the status below, f12 is the numeric id echoed
// back from the add/remove request that triggered it.
export const MSG_DATA_BREAKPOINT = 39;
export const DBP_ADDED = 1;
export const DBP_COULD_NOT_ADD = 2;
export const DBP_EVAL_ERROR = 3; // payload: NUL-terminated latin1 error text
export const DBP_FALSE = 4;
export const DBP_TRUE = 5;

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

export interface PbGlobalDecl {
  /** Module/global-scope variable name. */
  name: string;
  /** Type tag byte (e.g. 0x15 = `.i`, 0x09 = `.f`, 0x08 = `.s`, 0x0d = `.q`). */
  type: number;
  /** 0 = module-scope `Define`, 1 = `Global` (the record's scope-flag byte). */
  kind: number;
  /** Nested declarations following a structure header (opcode 9's nonzero reserved/nesting field). */
  children?: PbGlobalDecl[];
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
export function parseEvaluateReply(msg: PbMessage): PbEvaluateResult {
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

/**
 * MSG_DEBUG_OUTPUT (type 5): a `Debug` statement's formatted text, sent
 * instead of (not in addition to) the target's stdout once an external
 * debugger is attached — a plain `-d` run with no debugger connected prints
 * `[Debugger] <text>` to stdout via a completely different code path
 * (`PB_DEBUGGER_xfprint_string`, confirmed by disassembly: `PB_DEBUGGER_
 * PrintString` branches on whether an external debugger is connected before
 * choosing stdout vs. this wire message, never both).
 *
 * **Confirmed truncation bug in PureBasic's own `debugger.a` runtime, not
 * fixable here.** `PB_DEBUGGER_PrintString` converts the statement's already
 * -UTF-16 text (confirmed live via gdb: the argument register points at a
 * proper 2-byte-per-character string right before the call) down to the
 * wire's single-byte encoding before sending. That conversion reliably
 * delivers only the first `floor(fullLength / 2)` bytes of the intended
 * text — confirmed across four independent live samples with a minimal
 * fixture compiled fresh for this: `"line4 c=3"` (10 bytes incl. NUL) → 5
 * real bytes then zero-padding; `"helloworld"` (11 bytes) → 5; `"a b c d e f
 * g"` (14 bytes) → 7; `"hi"` (3 bytes) → 1 — every case losing exactly the
 * back half, not a fixed byte count. The missing half is never transmitted
 * at all (confirmed: the wire message's own declared length still matches
 * the *full* intended size, only the payload content is short), so there is
 * no way to recover it from this side of the connection — this is a sender
 * -side bug, not a decode gap. Surfacing the surviving (correct, just
 * incomplete) prefix is still real diagnostic value, so this parser exposes
 * it plainly rather than discarding the message; callers should treat any
 * text from here as potentially truncated, not authoritative.
 */
export function parseDebugOutputText(payload: Buffer): string {
  const nul = payload.indexOf(0);
  return nul === -1 ? payload.toString("latin1") : payload.toString("latin1", 0, nul);
}

// Add-data-breakpoint payload: int32 id, followed by a NUL-terminated
// condition string. PLAN.md M9.5's live capture of the real GUI's own
// request used UTF-16LE, but that session explicitly set
// PB_DEBUGGER_Options' Unicode field to 1 (PLAN.md M9.3); this adapter never
// sets that env var, so the target defaults to ANSI -- confirmed live: a
// UTF-16LE payload here produced "Variable not found: 'c'" (the target read
// only the first single-byte character before hitting what it saw as a NUL
// terminator). latin1/single-NUL matches the convention every other string
// payload in this file already uses (evaluate()/setVariable() below).
export function encodeDataBreakpointPayload(id: number, condition: string): Buffer {
  const idBuf = Buffer.alloc(4);
  idBuf.writeInt32LE(id, 0);
  return Buffer.concat([idBuf, Buffer.from(condition, "latin1"), Buffer.from([0])]);
}

export interface PbDataBreakpointEvent {
  id: number;
  status: number;
  /** Set only when status is DBP_EVAL_ERROR. */
  error?: string;
}

export function parseDataBreakpointEvent(msg: PbMessage): PbDataBreakpointEvent {
  const status = msg.f8;
  const id = msg.f12;
  if (status === DBP_EVAL_ERROR) {
    // Same NUL-terminated latin1 shape as a Debug statement's text -- the
    // name is generic despite living next to the Debug-output-specific
    // doc comment above.
    return { id, status, error: parseDebugOutputText(msg.payload) };
  }
  return { id, status };
}

export function parseFrames(payload: Buffer): PbFrame[] {
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
/** Shared by parseVariables and parseGlobalDecls: the common 7-byte header (type, flag, kind/scope, 4-byte reserved) + NUL-terminated name every record starts with. Returns null at a truncated/empty-name record so callers can stop cleanly. */
function readHeaderAndName(
  payload: Buffer,
  off: number,
): { type: number; kind: number; nested: boolean; name: string; next: number } | null {
  if (off + 7 >= payload.length) return null;
  const type = payload.readUInt8(off);
  const kind = payload.readUInt8(off + 2);
  const nested = payload.readInt32LE(off + 3) !== 0;
  off += 7;
  const nul = payload.indexOf(0, off);
  if (nul === -1) return null;
  const name = payload.toString("latin1", off, nul);
  if (!name) return null;
  return { type, kind, nested, name, next: nul + 1 };
}

export function parseVariables(payload: Buffer): PbVariable[] {
  interface FlatRecord {
    type: number;
    kind: number;
    nested: boolean;
    name: string;
    value?: string;
  }
  const flat: FlatRecord[] = [];
  let off = 0;
  for (;;) {
    const header = readHeaderAndName(payload, off);
    if (!header) break;
    const { type, kind, nested, name } = header;
    off = header.next;
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

// Opcode 9 (ExamineVariables(-1)) reply: the module/global scope's variable
// declarations — *names and types only, no values*. Live-confirmed layout
// (PLAN.md M6): each record is the same 7-byte header as parseVariables
// (type, flag, kind/scope, 4-byte reserved) + a NUL-terminated name + a
// single trailing pad byte, with NO 8-byte value field. A 5-variable reply of
// mixed .i/.f/.s/.q/.i types measured exactly 14+10+11+11+11 = 57 bytes,
// matching this record shape for every name length. The value-bearing parts
// of parseVariables must NOT be reused here — a value-less opcode-9 payload
// would make it read across record boundaries — but the header+name scan
// itself is shared via readHeaderAndName. Values for these names are
// recovered separately via evaluate() (opcode 33), which resolves
// module-scope names from any stop context (live-confirmed from inside a
// procedure too).
//
// Module-scope structures were live-confirmed against fifo-globals-probe.mjs:
// their header and nested field records use the same trailing pad byte as
// scalars, and the reserved/nesting flag has the same meaning as opcode
// 11/17. Group those fields under their structure instead of exposing them as
// unrelated module variables.
export function parseGlobalDecls(payload: Buffer): PbGlobalDecl[] {
  const flat: Array<PbGlobalDecl & { nested: boolean }> = [];
  let off = 0;
  for (;;) {
    const header = readHeaderAndName(payload, off);
    if (!header) break;
    off = header.next + 1; // past the name's NUL terminator + 1 trailing pad byte (0x00 in every observed record)
    flat.push({ name: header.name, type: header.type, kind: header.kind, nested: header.nested });
  }
  const decls: PbGlobalDecl[] = [];
  for (const { nested, ...decl } of flat) {
    const parent = decls[decls.length - 1];
    if (nested && parent?.type === STRUCT_TYPE_TAG) {
      (parent.children ??= []).push(decl);
    } else {
      decls.push(decl);
    }
  }
  return decls;
}

// Declaration records from opcodes 12/13/14 (PLAN.md M5, live-confirmed
// against src/debug/spike/test-arrays.pb's `nums`/`names`+`counts`/`scores`
// via fifo-arrayslists.mjs).

// Array declaration: `<name>(<dims, not decoded>)\0` + 1 type byte + 1 kind
// byte. Only the bare name (up to "(") is extracted -- the dimension-string
// bytes between the parens weren't fully decoded (see PLAN.md), and aren't
// needed to enumerate which arrays exist.
export function parseArrayDecls(payload: Buffer): PbArrayDecl[] {
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
export function parseListDecls(payload: Buffer): PbListDecl[] {
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
export function parseMapDecls(payload: Buffer): PbMapDecl[] {
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
export function parseArrayElements(payload: Buffer): { name: string; elements: PbArrayElement[] } {
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
export function parseMapElements(payload: Buffer): { name: string; elements: PbMapElement[] } {
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
export function parseListElements(payload: Buffer, elementCount: number): { name: string; elements: PbListElement[] } | undefined {
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

interface PendingWaiter {
  resolve: (msg: PbMessage) => void;
  reject: (err: Error) => void;
  /** Which reply type(s) this waiter is allowed to accept; `undefined` accepts any. */
  expectedType?: number | number[];
}

/**
 * Live connection to a PureBasic `-d` build's embedded external debugger,
 * over the FIFO transport (`PB_DEBUGGER_Communication=FifoFiles;<out>;<in>`).
 * Emits `stopped` ({ line, reason }) for unsolicited stop notifications and
 * `debugOutput` (string, possibly truncated — see {@link parseDebugOutputText})
 * for `Debug` statement text; every other request/response pair is a simple
 * send-then-await-next-message, which is what PLAN.md's live spikes verified
 * is safe while the target is either stopped or the adapter isn't racing a
 * `continue` against a poll.
 */
export class PbDebugSession extends EventEmitter {
  private writeStream?: fs.WriteStream;
  private readStream?: fs.ReadStream;
  private recvBuffer = Buffer.alloc(0);
  private pending: PendingWaiter[] = [];
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
    this.readStream.on("close", () => {
      this.rejectPending(new Error("debugger connection closed"));
      this.emit("close");
    });
    this.readStream.on("error", (err: Error) => {
      this.rejectPending(err);
      this.emit("error", err);
    });
    this.writeStream = fs.createWriteStream(inFifo);
    this.writeStream.on("error", (err: Error) => {
      this.rejectPending(err);
      this.emit("error", err);
    });

    return this.nextMessageWithTimeout(timeoutMs, "the debugger to connect", MSG_HELLO);
  }

  private drainMessages(): void {
    for (;;) {
      if (this.recvBuffer.length < HEADER_SIZE) return;
      const len = this.recvBuffer.readInt32LE(4);
      // Sanity-bound len before waiting for it: a corrupt/desynced stream
      // (or a genuinely negative value) would otherwise make this loop wait
      // for a buffer size that never arrives, silently stalling every
      // subsequent message — including "stopped" — instead of surfacing an
      // error. Real payloads (variable/array/list dumps) are a few KB at most.
      if (len < 0 || len > MAX_MESSAGE_LEN) {
        this.emit("error", new Error(`corrupt or desynced debugger stream: header declares an implausible message length (${len})`));
        this.close();
        return;
      }
      const total = HEADER_SIZE + len;
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

  /** True if `msg.type` satisfies `expectedType` — `undefined` accepts any type
   * (used only where the confirmed reply type isn't fully known, e.g. an
   * expression-evaluator error reply's tag was never pinned down; see
   * {@link examineExpression}). */
  private static matchesType(msg: PbMessage, expectedType: PendingWaiter["expectedType"]): boolean {
    if (expectedType === undefined) return true;
    if (Array.isArray(expectedType)) return expectedType.includes(msg.type);
    return msg.type === expectedType;
  }

  private dispatch(msg: PbMessage): void {
    if (msg.type === MSG_TERMINATED) {
      this.emit("terminated");
      return;
    }
    if (msg.type === MSG_STOPPED) {
      this.emit("stopped", { line: msg.f8, reason: msg.f12 });
      return;
    }
    if (msg.type === MSG_CONTINUED) {
      this.emit("continued");
      return;
    }
    if (msg.type === MSG_DEBUG_OUTPUT) {
      this.emit("debugOutput", parseDebugOutputText(msg.payload));
      return;
    }
    if (msg.type === MSG_DATA_BREAKPOINT) {
      // Unsolicited, like MSG_DEBUG_OUTPUT above: a data breakpoint's
      // FALSE/TRUE re-evaluation can arrive interleaved with ordinary
      // request/reply traffic while the target runs, and must never be
      // mistaken for the reply to an unrelated in-flight request.
      this.emit("dataBreakpoint", parseDataBreakpointEvent(msg));
      return;
    }
    // Only ever one request in flight at a time (see serialize()), so the
    // front of the queue is the only waiter that could possibly be for this
    // message. Matching by type — not just "whichever waiter is next" — is
    // what stops an unsolicited notification (MSG_DEBUG_OUTPUT, or any other
    // spontaneous message the target sends between requests, confirmed live
    // in PLAN.md's M5 spike notes) from being silently handed to an unrelated
    // pending request as if it were that request's real reply.
    const front = this.pending[0];
    if (front && PbDebugSession.matchesType(msg, front.expectedType)) {
      this.pending.shift();
      front.resolve(msg);
    } else {
      this.unclaimed.push(msg);
    }
  }

  private nextMessage(expectedType?: number | number[]): Promise<PbMessage> {
    const index = this.unclaimed.findIndex((msg) => PbDebugSession.matchesType(msg, expectedType));
    if (index !== -1) return Promise.resolve(this.unclaimed.splice(index, 1)[0]);
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject, expectedType }));
  }

  /** Waits for one message without leaving an abandoned waiter behind when
   * the deadline expires. A stale waiter would consume the next real wire
   * message and permanently shift request/reply matching. */
  private nextMessageWithTimeout(timeoutMs: number, description: string, expectedType?: number | number[]): Promise<PbMessage> {
    const index = this.unclaimed.findIndex((msg) => PbDebugSession.matchesType(msg, expectedType));
    if (index !== -1) return Promise.resolve(this.unclaimed.splice(index, 1)[0]);

    return new Promise((resolve, reject) => {
      const waiter: PendingWaiter = {
        expectedType,
        resolve: (msg: PbMessage) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      // Deliberately not .unref()'d: this timer is the only thing that ever
      // settles this promise, so it must be allowed to keep the process
      // alive until it fires or is cleared. An unref'd timer can be skipped
      // entirely if nothing else refs the event loop at the moment it's
      // pending (e.g. this exact promise, awaited in isolation with no open
      // FIFO/child-process handles, as a unit test does) — Node can decide
      // the loop is done and exit without ever calling the callback,
      // leaving the promise permanently unsettled. Confirmed live: this is
      // what broke `nextMessageWithTimeout`'s own regression test in CI
      // (no compiler installed there, so no other handle keeps the loop
      // alive) while passing locally, where other live e2e tests in the
      // same run happen to keep the loop busy and mask it.
      const timer = setTimeout(() => {
        const idx = this.pending.indexOf(waiter);
        if (idx !== -1) this.pending.splice(idx, 1);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${description}`));
      }, timeoutMs);
      this.pending.push(waiter);
    });
  }

  /** Drains and rejects every outstanding request so a dead connection can't hang a caller forever. */
  private rejectPending(err: Error): void {
    const pending = this.pending.splice(0);
    for (const p of pending) p.reject(err);
  }

  private requestChain: Promise<unknown> = Promise.resolve();

  /**
   * Serializes request/response round-trips over the shared FIFO connection.
   * The wire protocol carries no request ID — replies are matched purely by
   * arrival order (see {@link nextMessage}/{@link dispatch}) — so two
   * overlapping requests (e.g. an `evaluate()` call racing `variablesRequest`'s
   * `Promise.all` of `examineArrays`/`examineLists`/`examineMaps`) could
   * otherwise hand one caller another caller's reply. Only `stopped` is
   * genuinely unsolicited (handled separately in {@link dispatch}), so
   * one-request-in-flight-at-a-time is actually correct here, not just a
   * workaround.
   */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.requestChain.then(fn, fn);
    // Swallow rejections in the chain itself so one failed/timed-out request
    // doesn't permanently wedge every later caller behind a rejected promise.
    this.requestChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private write(opcode: number, f8 = 0, f12 = 0, f16 = 0, payload?: Buffer, len = 0): void {
    const stream = this.writeStream;
    if (!stream) {
      throw new Error("debugger session closed");
    }
    const buf = Buffer.alloc(HEADER_SIZE);
    buf.writeInt32LE(opcode, 0);
    buf.writeInt32LE(len, 4);
    buf.writeInt32LE(f8, 8);
    buf.writeInt32LE(f12, 12);
    buf.writeInt32LE(f16, 16);
    stream.write(buf);
    if (payload) stream.write(payload);
  }

  /** Drain the unconditional startup announcement sent right after `hello`. Bounded the same way
   *  {@link connect} is — an unconditional await here would otherwise hang launchRequest forever
   *  if the target sent hello but never followed up with the announcement. */
  drainStartupAnnouncement(timeoutMs = 10000): Promise<PbMessage> {
    return this.nextMessageWithTimeout(timeoutMs, "the debugger's startup announcement", MSG_STARTUP_ANNOUNCEMENT);
  }

  /** Opcode 0: request a cooperative pause at the next PureBasic statement check. */
  pause(): void {
    this.write(OP_PAUSE);
  }

  /** Opcode 1: execute a positive number of PureBasic statement steps. */
  stepInto(count = 1): void {
    if (!Number.isInteger(count) || count <= 0 || count > 0x7fffffff) {
      throw new Error("stepInto count must be a positive int32");
    }
    this.write(OP_STEP, count);
  }

  /** Opcode 1/f8=-1: step over the current PureBasic statement. */
  stepOver(): void {
    this.write(OP_STEP, -1);
  }

  /** Opcode 1/f8=-2: step out of the current PureBasic procedure. */
  stepOut(): void {
    this.write(OP_STEP, -2);
  }

  /**
   * Opcode 2: clear the target's stop flag and let it run. `acknowledge`
   * mirrors the standalone debugger's f8=1 mode, which produces an
   * unsolicited MSG_CONTINUED acknowledgement; f8=0 remains available for
   * callers that do not need it.
   */
  continue(acknowledge = true): void {
    this.write(OP_CONTINUE, acknowledge ? 1 : 0);
  }

  /** Adds a breakpoint by the wire protocol's 0-based compiled-line index. */
  addLineBreakpoint(line: number, moduleId = 0): void {
    this.write(OP_BREAKPOINTS, BP_ADD_LINE, (moduleId << 20) | line);
  }

  /** Removes a breakpoint by the wire protocol's 0-based compiled-line index. */
  removeLineBreakpoint(line: number, moduleId = 0): void {
    this.write(OP_BREAKPOINTS, BP_REMOVE_LINE, (moduleId << 20) | line);
  }

  clearAllLineBreakpoints(): void {
    this.write(OP_BREAKPOINTS, BP_BULK, BP_BULK_CLEAR_ALL);
  }

  /** Arms a data breakpoint under a client-assigned numeric `id`. `condition`
   *  is an arbitrary PureBasic boolean expression, re-checked at every debug
   *  statement (not a memory-write trap -- see pbDebugAdapter.ts's re-arm
   *  logic for how "break on value change" is built on top of this).
   *  `procedureScope` defaults to -2 (all procedures). */
  addDataBreakpoint(id: number, condition: string, procedureScope = -2): void {
    const payload = encodeDataBreakpointPayload(id, condition);
    this.write(OP_BREAKPOINTS, BP_ADD_DATA, procedureScope, 0, payload, payload.length);
  }

  /** `id` must be the exact numeric id assigned when the breakpoint was
   *  added, and nothing else. The real PureBasic 6.41 GUI's own
   *  DataBreakPoints.pb sends a GUI heap pointer here instead of the
   *  breakpoint's ID field, so removal silently no-ops server-side while the
   *  GUI row disappears locally (PLAN.md M9.6) -- do not reproduce that. */
  removeDataBreakpoint(id: number): void {
    this.write(OP_BREAKPOINTS, BP_REMOVE_DATA, id);
  }

  clearAllDataBreakpoints(): void {
    this.write(OP_BREAKPOINTS, BP_CLEAR_ALL_DATA);
  }

  async stackTrace(): Promise<PbFrame[]> {
    return this.serialize(async () => {
      this.write(OP_STACK_TRACE);
      const msg = await this.nextMessage(0x16);
      return parseFrames(msg.payload);
    });
  }

  /**
   * Opcode 9: the module/global scope's variable *declarations* (names +
   * types, no values — see {@link parseGlobalDecls}). Values are read per-name
   * via {@link evaluate}. This is how the debug adapter populates the
   * synthetic "main" stack frame's locals: opcode 16 reports no frame and
   * opcode 11 no locals when the target is stopped at module scope (outside
   * any procedure), so the main-body variables are only reachable this way.
   */
  async examineModuleScope(): Promise<PbGlobalDecl[]> {
    return this.serialize(async () => {
      this.write(OP_EXAMINE_GLOBALS);
      const msg = await this.nextMessage(0xd);
      return parseGlobalDecls(msg.payload);
    });
  }

  async examineCurrentFrame(): Promise<PbVariable[]> {
    return this.serialize(async () => {
      this.write(OP_EXAMINE_CURRENT_FRAME);
      const msg = await this.nextMessage(0xf);
      return parseVariables(msg.payload);
    });
  }

  /** frameIndex is opcode-16 order: 0 = outermost caller, increasing toward the current frame. */
  async examineFrame(frameIndex: number): Promise<PbVariable[]> {
    return this.serialize(async () => {
      this.write(OP_EXAMINE_FRAME, frameIndex);
      const msg = await this.nextMessage(0x17);
      return parseVariables(msg.payload);
    });
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
    return this.serialize(async () => {
      this.write(OP_EXAMINE_ARRAYS, global ? 1 : 0);
      const msg = await this.nextMessage(0x10);
      return parseArrayDecls(msg.payload);
    });
  }

  /** Opcode 13: enumerate linked lists. Same f8/scope caveat as {@link examineArrays}. */
  async examineLists(global = false): Promise<PbListDecl[]> {
    return this.serialize(async () => {
      this.write(OP_EXAMINE_LISTS, global ? 1 : 0);
      const msg = await this.nextMessage(0x12);
      return parseListDecls(msg.payload);
    });
  }

  /** Opcode 14: enumerate maps. Same f8/scope caveat as {@link examineArrays}. */
  async examineMaps(global = false): Promise<PbMapDecl[]> {
    return this.serialize(async () => {
      this.write(OP_EXAMINE_MAPS, global ? 1 : 0);
      const msg = await this.nextMessage(0x14);
      return parseMapDecls(msg.payload);
    });
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
   *
   * Unlike the other request methods, this one's {@link nextMessage} call
   * deliberately accepts *any* reply type: the error path's own type tag was
   * never confirmed (PLAN.md M5 only pinned down the three success tags
   * above), so type-filtering here would make a genuine error reply time out
   * instead of surfacing, trading one bug for a worse one. This method keeps
   * its pre-existing best-effort behavior; it remains exposed to the same
   * unsolicited-message class of bug the other methods were just fixed
   * against, but no worse than before.
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
    return this.serialize(async () => {
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
    });
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
    return this.serialize(async () => {
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
      const msg = await this.nextMessage(MSG_EVALUATE_REPLY);
      return parseEvaluateReply(msg);
    });
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
    return this.serialize(async () => {
      const payload = Buffer.concat(
        [target, value].map((s) => Buffer.concat([Buffer.from(s, "latin1"), Buffer.from([0])])),
      );
      this.write(OP_MODIFY, 0, -1, 0, payload, payload.length);
      const msg = await this.nextMessage(MSG_EVALUATE_REPLY);
      return parseEvaluateReply(msg);
    });
  }

  close(): void {
    this.readStream?.destroy();
    this.writeStream?.end();
    this.readStream = undefined;
    this.writeStream = undefined;
    this.rejectPending(new Error("debugger session closed"));
  }
}
