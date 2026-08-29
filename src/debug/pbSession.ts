// Reusable client for PureBasic's external-debugger wire protocol, extracted
// from the throwaway spikes in src/debug/spike/ once their findings were
// live-confirmed (see PLAN.md's M5 section for the full decode/verification
// trail). This file only encodes what was actually confirmed against a real
// running target, not the still-unconfirmed parts (stepping, data
// breakpoints, array/struct expansion).
import * as cp from "child_process";
import * as fs from "fs";
import * as net from "net";
import { EventEmitter } from "events";

const HEADER_SIZE = 20;
// Sanity bound for a message's declared payload length (see drainMessages) —
// real payloads (variable/array/list dumps) are a few KB at most.
const MAX_MESSAGE_LEN = 16 * 1024 * 1024;
// M2: bounds every ordinary in-session protocol request (stack trace,
// scope/variable examine, evaluate, setVariable, array/list/map enumerate)
// so a target that stops responding mid-session (wedged, blocked in a
// native call Force Pause doesn't cover, or otherwise gone quiet without
// actually closing the connection) fails each pending DAP request with a
// clear error instead of leaving it -- and the VS Code UI waiting on it --
// hung forever. Generous relative to a real round-trip (sub-millisecond to
// low tens of ms locally) but still short enough that a wedged target is
// caught well within normal interactive use, not just eventually.
const DEFAULT_REQUEST_TIMEOUT_MS = 8000;

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
// `#COMMAND_GetModules` is the last debugger->target command in PureBasic
// 6.41's ExternalCommands.h enumeration.  Its reply is MSG_MODULES below.
export const OP_GET_MODULES = 40;

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
// String type tag (PLAN.md M12, live-confirmed against an isolated `.s`
// local): unlike every numeric type below, a String record carries no
// inline value at all -- just a single trailing pad byte after the name
// (the same shape opcode 9's value-less module-scope declarations already
// use). The actual text has to come from a separate evaluate() call.
export const STRING_TYPE_TAG = 0x08;

/**
 * Per-scalar-type wire encoding of the value that trails a variable
 * record's header+name (opcode 11/17's ExamineCurrentFrame/ExamineFrame,
 * and the equivalent nested-field records inside a structure). PLAN.md M12
 * live-confirmed every entry here against a real PureBasic 6.41 x64 target:
 * each PB type was declared in isolation as a single `Protected` local and
 * examined through opcode 11, so the byte width/interpretation below is
 * measured, not inferred from documentation (there is none). Critically,
 * this is NOT a uniform 8-byte value for every type as earlier code
 * (incorrectly) assumed -- Byte/Ascii are 1 byte, Word/Unicode are 2,
 * Long/Character/Float are 4, and Integer/Quad/Double/Pointer are 8, each
 * with its own signedness or float width. Getting this wrong doesn't just
 * mis-render one variable: reading the wrong number of trailing bytes
 * desyncs every record that follows it in the same reply (live-reproduced
 * with a String local ahead of other variables, before this table existed).
 */
type ScalarValueKind = "int" | "float";
interface ScalarTypeInfo {
  kind: ScalarValueKind;
  /** Trailing value width in bytes. */
  valueBytes: 1 | 2 | 4 | 8;
  /** Only meaningful for kind "int". Pointers are unsigned and hex-formatted, not decimal. */
  signed?: boolean;
  pointer?: boolean;
}
const SCALAR_TYPES: Record<number, ScalarTypeInfo> = {
  0x01: { kind: "int", valueBytes: 1, signed: true }, // Byte .b
  0x18: { kind: "int", valueBytes: 1, signed: false }, // Ascii .a
  0x0b: { kind: "int", valueBytes: 4, signed: false }, // Character .c (Unicode code point)
  0x03: { kind: "int", valueBytes: 2, signed: true }, // Word .w
  0x19: { kind: "int", valueBytes: 2, signed: false }, // Unicode .u
  0x05: { kind: "int", valueBytes: 4, signed: true }, // Long .l
  0x15: { kind: "int", valueBytes: 8, signed: true }, // Integer .i
  0x0d: { kind: "int", valueBytes: 8, signed: true }, // Quad .q
  0x09: { kind: "float", valueBytes: 4 }, // Float .f
  0x0c: { kind: "float", valueBytes: 8 }, // Double .d
  0x95: { kind: "int", valueBytes: 8, signed: false, pointer: true }, // Pointer (`*var`, no `.type` suffix)
};

// The low six bits are the PureBasic base type.  The high bits carry
// modifiers such as "pointer" and "ByRef"; a pointer's on-wire value is
// always an address, regardless of the pointed-to base type.
const TYPE_MASK = 0x3f;
const TYPE_POINTER = 0x80;
const TYPE_STRING = 0x08;
const TYPE_FIXED_STRING = 0x0a;

/** Decodes `buf`'s first `info.valueBytes` bytes per SCALAR_TYPES' confirmed
 *  layout for `info`. Pointers render as `0x`-prefixed hex (the conventional,
 *  useful way to show an address), everything else as a decimal string. */
function decodeScalarValue(info: ScalarTypeInfo, buf: Buffer): string {
  if (info.kind === "float") {
    return (info.valueBytes === 4 ? buf.readFloatLE(0) : buf.readDoubleLE(0)).toString();
  }
  if (info.pointer) {
    return `0x${buf.readBigUInt64LE(0).toString(16)}`;
  }
  switch (info.valueBytes) {
    case 1:
      return (info.signed ? buf.readInt8(0) : buf.readUInt8(0)).toString();
    case 2:
      return (info.signed ? buf.readInt16LE(0) : buf.readUInt16LE(0)).toString();
    case 4:
      return (info.signed ? buf.readInt32LE(0) : buf.readUInt32LE(0)).toString();
    case 8:
      return (info.signed ? buf.readBigInt64LE(0) : buf.readBigUInt64LE(0)).toString();
  }
}

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
export const MSG_MODULES = 50;
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

/** A source file as assigned by PureBasic's debugger.  File id 0 is the
 * launch source; positive ids are `IncludeFile`/`XIncludeFile` sources. */
export interface PbSourceFile {
  id: number;
  path: string;
}

const DEBUGGER_LINE_BITS = 20;
const DEBUGGER_LINE_MASK = (1 << DEBUGGER_LINE_BITS) - 1;

/** PureBasic packs its source-file id and zero-based line into one int32. */
export function splitDebuggerLine(value: number): { moduleId: number; line: number } {
  const unsigned = value >>> 0;
  return { moduleId: unsigned >>> DEBUGGER_LINE_BITS, line: unsigned & DEBUGGER_LINE_MASK };
}

/** The inverse of {@link splitDebuggerLine}, with range checks before a value
 * is placed into the signed int32 protocol header. */
export function makeDebuggerLine(moduleId: number, line: number): number {
  if (!Number.isInteger(moduleId) || moduleId < 0 || moduleId > 0xfff) throw new Error("module id must fit in 12 bits");
  if (!Number.isInteger(line) || line < 0 || line > DEBUGGER_LINE_MASK) throw new Error("source line must fit in 20 bits");
  return ((moduleId << DEBUGGER_LINE_BITS) | line) | 0;
}

/** Parses Init's NUL-delimited source-root plus include-file payload.  The
 * main file is deliberately not in the payload: callers supply its real path
 * as id 0, then resolve the `Value1` included filenames against `sourceRoot`.
 * The target stores source names as UTF-8 (as the standalone debugger does). */
export function parseIncludedSources(payload: Buffer, includedFileCount: number): { sourceRoot?: string; mainPath?: string; includedPaths: string[] } {
  if (!Number.isInteger(includedFileCount) || includedFileCount < 0) throw new Error("included file count must be a non-negative integer");
  const strings: string[] = [];
  let offset = 0;
  // The first two strings are the source root and the main source's stored
  // relative filename. Positive debugger file ids begin only after those.
  while (offset < payload.length && strings.length < includedFileCount + 2) {
    const nul = payload.indexOf(0, offset);
    const end = nul === -1 ? payload.length : nul;
    strings.push(payload.toString("utf8", offset, end));
    if (nul === -1) break;
    offset = nul + 1;
  }
  if (strings.length < includedFileCount + 2) {
    throw new Error(`debugger Init declared ${includedFileCount} included files but supplied only ${Math.max(0, strings.length - 2)}`);
  }
  return { sourceRoot: strings[0] || undefined, mainPath: strings[1] || undefined, includedPaths: strings.slice(2) };
}

/** Parses `#COMMAND_Modules`: `Value1` NUL-terminated ASCII names.  Module
 * names are retained separately from source-file ids; they are useful
 * diagnostics, but only the Init include table defines line-file mapping. */
export function parseModuleNames(payload: Buffer, count: number): string[] {
  if (!Number.isInteger(count) || count < 0) throw new Error("module count must be a non-negative integer");
  const result: string[] = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const nul = payload.indexOf(0, offset);
    if (nul === -1) throw new Error(`debugger Modules declared ${count} names but payload ended at ${i}`);
    result.push(payload.toString("latin1", offset, nul));
    offset = nul + 1;
  }
  return result;
}

export interface PbFrame {
  /** 0-based call-site line number (verified against known source lines). */
  callSiteLine0: number;
  /** PureBasic source-file id encoded alongside `callSiteLine0`. */
  moduleId: number;
  /** Formatted "ProcName(arg1, arg2, ...)" display string. */
  display: string;
}

export interface PbVariable {
  type: number; // e.g. 0x15 for `.i`; 0x07 marks a structure header (see STRUCT_TYPE_TAG); see SCALAR_TYPES for every other confirmed tag
  kind: number; // 0 = global/module scope, 3 = local
  name: string; // structure headers carry the target's own "Name.TypeName" formatting
  /** Formatted per SCALAR_TYPES (decimal for ints, decimal for floats/doubles, `0x`-hex for pointers). Absent for a structure header (type === 0x07, no scalar value of its own) or a String (type === 0x08, whose real text needs a separate evaluate() call -- see STRING_TYPE_TAG). */
  value?: string;
  /** True when `type` isn't a recognized tag (SCALAR_TYPES/STRUCT_TYPE_TAG/STRING_TYPE_TAG) -- its value is unknown and, critically, so is its byte width, so parseVariables stops decoding the rest of this reply rather than guess and desync every record after it. */
  unsupported?: boolean;
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
  /** Present for a structure element; its fields are independently decoded. */
  children?: PbVariable[];
}

export interface PbListElement {
  index: string;
  value: string;
  children?: PbVariable[];
}

export interface PbMapElement {
  key: string;
  value: string;
  children?: PbVariable[];
}

export interface PbEvaluateResult {
  /** Reply f12: 0 = error, 1/2 = integer-family (live-confirmed: every int width plus pointers all arrive sign-extended to a full int64, regardless of the original PB type's actual width), 3 = floating point (live-confirmed: both `.f` and `.d` arrive as a full float64, PLAN.md M12), 4 = string, 5 = structure. */
  kind: number;
  /** Set when kind is 0. */
  error?: string;
  /** Set when kind is 1/2 (decimal int64), 3 (decimal float64), or 4 (string text). */
  value?: string;
}

// Reply format for opcodes 33/34 (PLAN.md M5, "Expression's read side"):
// an 8-byte little-endian value (kind 1-3) followed by the echoed
// expression text (payload-length bytes, no null terminator). Kind 0
// (error) is the PB_Language_GetKey error string, NUL-terminated, followed
// by the echoed expression text. Kind 4 (string) is a NUL-terminated value
// string followed by the echoed expression text (e.g. evaluating a
// List<String>'s bare `name()` returns its *current* element this way,
// live-tested against src/debug/spike/test-arrays.pb's `names()`: payload
// `"beta\0names()\0"`). Kind 5 (structure) is still only decoded from the
// disassembly, not live-tested, so it's surfaced as unsupported rather than
// guessed at. PLAN.md M12 live-confirmed the split within "numeric": kind
// 1/2 is always a plain int64 (every integer width and pointers arrive
// pre-sign-extended to the full 8 bytes, regardless of the source type's
// real width), while kind 3 is always a float64 -- a `.f` Float's value is
// promoted to double on the wire, not sent as 4 raw bytes.
export function parseEvaluateReply(msg: PbMessage): PbEvaluateResult {
  if (msg.f12 === 0) {
    const nul = msg.payload.indexOf(0);
    const error = nul === -1 ? msg.payload.toString("latin1") : msg.payload.toString("latin1", 0, nul);
    return { kind: 0, error };
  }
  if (msg.f12 === 1 || msg.f12 === 2) {
    const value = msg.payload.readBigInt64LE(0).toString();
    return { kind: msg.f12, value };
  }
  if (msg.f12 === 3) {
    // PLAN.md M12, live-confirmed: kind 3 is floating point, not another
    // int64 variant -- both `.f` (Float) and `.d` (Double) arrive here as a
    // full 8-byte float64 (a `.f`'s value is promoted on the wire, not
    // truncated to 4 bytes), so this is unconditionally a double read.
    const value = msg.payload.readDoubleLE(0).toString();
    return { kind: 3, value };
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
    const location = splitDebuggerLine(payload.readInt32LE(off));
    off += 4;
    const nul = payload.indexOf(0, off);
    const end = nul === -1 ? payload.length : nul;
    frames.push({ moduleId: location.moduleId, callSiteLine0: location.line, display: payload.toString("latin1", off, end) });
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
    unsupported?: boolean;
  }
  const flat: FlatRecord[] = [];
  let off = 0;
  for (;;) {
    const header = readHeaderAndName(payload, off);
    if (!header) break;
    const { type, kind, nested, name } = header;
    off = header.next;

    if (type === STRUCT_TYPE_TAG) {
      flat.push({ type, kind, nested, name });
      continue;
    }
    if (type === STRING_TYPE_TAG) {
      // No inline value -- one trailing pad byte, the same shape opcode 9
      // uses for every value-less module-scope declaration (see
      // parseGlobalDecls below). The real text needs a separate evaluate()
      // call (see toDapVariable in pbDebugAdapter.ts).
      flat.push({ type, kind, nested, name });
      off += 1;
      continue;
    }
    const info = SCALAR_TYPES[type];
    if (!info || off + info.valueBytes > payload.length) {
      // Unknown type, or a known one truncated mid-value: its true byte
      // width is unknown either way, so guessing would desync every record
      // after it in this reply. Surface this one as explicitly unsupported
      // and stop -- a partial, honest result beats a corrupted one.
      flat.push({ type, kind, nested, name, unsupported: true });
      break;
    }
    const value = decodeScalarValue(info, payload.subarray(off, off + info.valueBytes));
    off += info.valueBytes;
    flat.push({ type, kind, nested, name, value });
  }
  const result: PbVariable[] = [];
  for (const rec of flat) {
    const parent = result[result.length - 1];
    const child: PbVariable = { type: rec.type, kind: rec.kind, name: rec.name, value: rec.value, unsupported: rec.unsupported };
    if (rec.nested && parent && parent.type === STRUCT_TYPE_TAG) {
      (parent.children ??= []).push(child);
    } else {
      result.push(child);
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

export interface ContainerFormat {
  pointerBytes: 4 | 8;
}

const DEFAULT_CONTAINER_FORMAT: ContainerFormat = { pointerBytes: 8 };

function readExternalString(payload: Buffer, off: number, unicode: boolean): { value: string; next: number } | undefined {
  if (!unicode) {
    const nul = payload.indexOf(0, off);
    if (nul === -1) return undefined;
    return { value: payload.toString("latin1", off, nul), next: nul + 1 };
  }
  for (let end = off; end + 1 < payload.length; end += 2) {
    if (payload.readUInt16LE(end) === 0) return { value: payload.toString("utf16le", off, end), next: end + 2 };
  }
  return undefined;
}

function readPointer(payload: Buffer, off: number, pointerBytes: 4 | 8, signed: boolean): string | undefined {
  if (off + pointerBytes > payload.length) return undefined;
  if (pointerBytes === 4) return (signed ? payload.readInt32LE(off) : payload.readUInt32LE(off)).toString();
  return (signed ? payload.readBigInt64LE(off) : payload.readBigUInt64LE(off)).toString();
}

/** Decode one value exactly as the upstream debugger's GetValueSize() does.
 * `undefined` means the payload cannot safely be advanced for this type. */
function readContainerValue(
  type: number,
  payload: Buffer,
  off: number,
  format: ContainerFormat,
): { value: string; next: number } | undefined {
  if ((type & TYPE_POINTER) !== 0) {
    const value = readPointer(payload, off, format.pointerBytes, false);
    if (value === undefined) return undefined;
    return { value: `0x${BigInt(value).toString(16)}`, next: off + format.pointerBytes };
  }
  const baseType = type & TYPE_MASK;
  if (baseType === TYPE_STRING || baseType === TYPE_FIXED_STRING) return readExternalString(payload, off, false);
  if (baseType === STRUCT_TYPE_TAG) return undefined; // handled through the field map below
  const info = SCALAR_TYPES[baseType];
  if (info) {
    const valueBytes = baseType === 0x15 ? format.pointerBytes : info.valueBytes;
    if (off + valueBytes > payload.length) return undefined;
    if (baseType === 0x15) {
      const value = readPointer(payload, off, format.pointerBytes, true);
      return value === undefined ? undefined : { value, next: off + valueBytes };
    }
    return { value: decodeScalarValue(info, payload.subarray(off, off + valueBytes)), next: off + valueBytes };
  }
  return undefined;
}

function readStructureFields(payload: Buffer, off: number): { fields: PbVariable[]; next: number } | undefined {
  const flat: Array<{ type: number; name: string; level: number }> = [];
  while (off < payload.length && payload.readInt8(off) !== -1) {
    if (off + 6 >= payload.length) return undefined;
    const type = payload.readUInt8(off);
    const level = payload.readInt32LE(off + 2);
    const nameStart = off + 6;
    const nul = payload.indexOf(0, nameStart);
    if (nul === -1) return undefined;
    flat.push({ type, level, name: payload.toString("latin1", nameStart, nul) });
    off = nul + 1;
  }
  if (off >= payload.length) return undefined;
  off += 1; // -1 field-map terminator

  const fields: PbVariable[] = [];
  const parents: Array<{ level: number; field: PbVariable }> = [];
  for (const entry of flat) {
    const field: PbVariable = { type: entry.type, kind: 0, name: entry.name };
    while (parents.length && parents[parents.length - 1].level >= entry.level) parents.pop();
    if (parents.length) (parents[parents.length - 1].field.children ??= []).push(field);
    else fields.push(field);
    if ((entry.type & TYPE_MASK) === STRUCT_TYPE_TAG && (entry.type & TYPE_POINTER) === 0) {
      parents.push({ level: entry.level, field });
    }
  }
  return { fields, next: off };
}

function decodeStructureValues(fields: PbVariable[], payload: Buffer, off: number, format: ContainerFormat): number | undefined {
  for (const field of fields) {
    if (field.children) {
      const next = decodeStructureValues(field.children, payload, off, format);
      if (next === undefined) return undefined;
      off = next;
      continue;
    }
    const decoded = readContainerValue(field.type, payload, off, format);
    if (!decoded) return undefined;
    field.value = decoded.value;
    off = decoded.next;
  }
  return off;
}

function readContainerHeader(payload: Buffer): { name: string; next: number } | undefined {
  const decoded = readExternalString(payload, 0, false);
  return decoded && { name: decoded.value, next: decoded.next };
}

function cloneStructureFields(fields: PbVariable[]): PbVariable[] {
  return fields.map((field) =>
    field.children ? { ...field, children: cloneStructureFields(field.children) } : { ...field },
  );
}

// Opcode-15 Array-data reply: external-format echoed name, then repeated
// ASCII dimension indices and target-typed values. `type` is Value1/f8.
export function parseArrayElements(
  payload: Buffer,
  type = 0x15,
  format: ContainerFormat = DEFAULT_CONTAINER_FORMAT,
): { name: string; elements: PbArrayElement[] } | undefined {
  const header = readContainerHeader(payload);
  if (!header) return undefined;
  let off = header.next;
  const structure = (type & TYPE_MASK) === STRUCT_TYPE_TAG && (type & TYPE_POINTER) === 0 ? readStructureFields(payload, off) : undefined;
  if ((type & TYPE_MASK) === STRUCT_TYPE_TAG && !structure) return undefined;
  if (structure) off = structure.next;
  const elements: PbArrayElement[] = [];
  while (off < payload.length) {
    const index = readExternalString(payload, off, false);
    if (!index) return undefined;
    off = index.next;
    if (structure) {
      const children = cloneStructureFields(structure.fields);
      const next = decodeStructureValues(children, payload, off, format);
      if (next === undefined) return undefined;
      off = next;
      elements.push({ index: index.value, value: "{...}", children });
    } else {
      const decoded = readContainerValue(type, payload, off, format);
      if (!decoded) return undefined;
      off = decoded.next;
      elements.push({ index: index.value, value: decoded.value });
    }
  }
  return { name: header.name, elements };
}

// Opcode-15 Map-data reply: external-format echoed name, then repeated
// external-format keys and target-typed values. `type` is Value1/f8.
export function parseMapElements(
  payload: Buffer,
  type = 0x15,
  format: ContainerFormat = DEFAULT_CONTAINER_FORMAT,
): { name: string; elements: PbMapElement[] } | undefined {
  const header = readContainerHeader(payload);
  if (!header) return undefined;
  let off = header.next;
  const structure = (type & TYPE_MASK) === STRUCT_TYPE_TAG && (type & TYPE_POINTER) === 0 ? readStructureFields(payload, off) : undefined;
  if ((type & TYPE_MASK) === STRUCT_TYPE_TAG && !structure) return undefined;
  if (structure) off = structure.next;
  const elements: PbMapElement[] = [];
  while (off < payload.length) {
    const key = readExternalString(payload, off, false);
    if (!key) return undefined;
    off = key.next;
    if (structure) {
      const children = cloneStructureFields(structure.fields);
      const next = decodeStructureValues(children, payload, off, format);
      if (next === undefined) return undefined;
      off = next;
      elements.push({ key: key.value, value: "{...}", children });
    } else {
      const decoded = readContainerValue(type, payload, off, format);
      if (!decoded) return undefined;
      off = decoded.next;
      elements.push({ key: key.value, value: decoded.value });
    }
  }
  return { name: header.name, elements };
}

// Opcode-15 List-data reply: external-format echoed name, followed by an
// Integer-sized sequence number and a target-typed value for each element.
export function parseListElements(
  payload: Buffer,
  elementCount: number,
  type = 0x15,
  format: ContainerFormat = DEFAULT_CONTAINER_FORMAT,
): { name: string; elements: PbListElement[] } | undefined {
  // PureBasic 6.41's external debugger sends only one NUL byte for each
  // List<String> value (a target bug); no parser can recover text it never
  // received. Preserve the existing explicit unsupported path for it.
  if ((type & TYPE_MASK) === TYPE_STRING || (type & TYPE_MASK) === TYPE_FIXED_STRING) return undefined;
  const header = readContainerHeader(payload);
  if (!header) return undefined;
  let off = header.next;
  const structure = (type & TYPE_MASK) === STRUCT_TYPE_TAG && (type & TYPE_POINTER) === 0 ? readStructureFields(payload, off) : undefined;
  if ((type & TYPE_MASK) === STRUCT_TYPE_TAG && !structure) return undefined;
  if (structure) off = structure.next;
  const elements: PbListElement[] = [];
  for (let i = 0; i < elementCount; i++) {
    const index = readPointer(payload, off, format.pointerBytes, true);
    if (index === undefined) return undefined;
    off += format.pointerBytes;
    if (structure) {
      const children = cloneStructureFields(structure.fields);
      const next = decodeStructureValues(children, payload, off, format);
      if (next === undefined) return undefined;
      off = next;
      elements.push({ index, value: "{...}", children });
    } else {
      const decoded = readContainerValue(type, payload, off, format);
      if (!decoded) return undefined;
      off = decoded.next;
      elements.push({ index, value: decoded.value });
    }
  }
  return off === payload.length ? { name: header.name, elements } : undefined;
}

interface PendingWaiter {
  resolve: (msg: PbMessage) => void;
  reject: (err: Error) => void;
  /** Which reply type(s) this waiter is allowed to accept; `undefined` accepts any. */
  expectedType?: number | number[];
}

// Minimal surface PbDebugSession actually uses from its transport streams --
// both fs.ReadStream/fs.WriteStream (FIFO) and net.Socket (TCP) satisfy
// these structurally, so no casts are needed at any call site. Narrowed
// (rather than typed as the concrete fs classes) specifically so a single
// net.Socket can serve both the read and write roles for TCP.
export interface PbReadable {
  on(event: "data", listener: (chunk: Buffer) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  destroy(): void;
}
export interface PbWritable {
  write(chunk: Buffer): boolean;
  on(event: "error", listener: (err: Error) => void): this;
  end(): void;
}

// TCP handshake (PLAN.md M10.1, live-confirmed against a real PureBasic
// 6.41 Linux build): a target started with
// PB_DEBUGGER_Communication=NetworkServer;<port> expects a plain-text,
// blank-line-terminated request before any binary protocol bytes.
const MAX_HANDSHAKE_LEN = 4096; // sanity bound, same spirit as MAX_MESSAGE_LEN

/** `<version>` must be the compiler's own major*100+minor (see
 *  {@link parseCompilerVersionBanner}) -- a mismatch produces
 *  `ERROR <version> WrongVersion`. `role` must be `EXECUTABLE`: the more
 *  obvious-looking `DEBUGGER` token is a confirmed dead-end trap in the
 *  target binary that always replies `ERROR <version> NoDebugger`. */
export function buildConnectRequest(version: number, role = "EXECUTABLE"): Buffer {
  return Buffer.from(`CONNECT ${version} ${role}\n\n`, "latin1");
}

export interface HandshakeFrame {
  text: string;
  /** Every byte received after the terminator, untouched -- may be part or
   *  all of the first binary MSG_HELLO; never re-parsed as text. */
  rest: Buffer;
}

/** Finds the blank-line terminator in an accumulating handshake buffer.
 *  Returns `undefined` if it hasn't arrived yet -- callers must wait for
 *  more data rather than guessing at a partial match. */
export function splitHandshakeFrame(buf: Buffer): HandshakeFrame | undefined {
  const idx = buf.indexOf("\n\n", 0, "latin1");
  if (idx === -1) return undefined;
  return { text: buf.toString("latin1", 0, idx), rest: Buffer.from(buf.subarray(idx + 2)) };
}

export interface HandshakeReply {
  ok: boolean;
  version: number;
  /** EXECUTABLE/role echo on success; the error Keyword (WrongVersion,
   *  InvalidRequest, NoService, NoDebugger) on failure. */
  token: string;
  error?: string;
}

/** Decodes `ACCEPT <version> <role>\n  Encryption: 0` or
 *  `ERROR <version> <Keyword>\n  Message: <text>` (PLAN.md M10.1's live-
 *  confirmed shapes). */
export function parseHandshakeReply(text: string): HandshakeReply {
  const lines = text.split("\n");
  const [status, versionStr, token] = (lines[0] ?? "").trim().split(/\s+/);
  const messageLine = lines.find((l) => l.trim().startsWith("Message:"));
  const error = messageLine ? messageLine.slice(messageLine.indexOf(":") + 1).trim() : undefined;
  return { ok: status === "ACCEPT", version: Number(versionStr), token: token ?? "", error };
}

/**
 * Debugging has been validated only on Linux. A normal launch on any other
 * platform must therefore fail before compiling or opening a transport. An
 * explicit transport remains an internal/test-only override so protocol tests
 * can exercise an otherwise non-native transport on Linux. This pure function
 * keeps the gate unit-testable without faking `process.platform` for a whole
 * spawned adapter process (which would also break compiler-path resolution).
 */
export function shouldRefuseUnvalidatedPlatformLaunch(platform: string, transport?: "fifo" | "tcp"): boolean {
  return platform !== "linux" && transport === undefined;
}

/**
 * -ds (--debugsymbols) is a valid cross-platform flag on Linux but is
 * rejected outright by the Windows compiler ("-ds: Unknown switch",
 * confirmed against a real Windows PureBasic 6.41 install under Wine) --
 * it fails the whole compile there, not just a warning. It's orthogonal to
 * the wire debugger protocol itself (-d alone enables that): a debug build
 * compiled without it still connects, breaks, and steps identically,
 * confirmed live over the same TCP transport Windows launches use.
 */
export function debugCompileFlags(platform: string): string[] {
  return platform === "linux" ? ["-d", "-ds", "-l"] : ["-d", "-l"];
}

/**
 * Real (non-test-override) launches select FIFO on POSIX platforms (where
 * `mkfifo` exists) and TCP on Windows, which has no FIFO equivalent this
 * codebase uses. An explicit `transport` remains an internal/test-only
 * override so protocol tests can exercise the non-native transport on
 * Linux (see pbDebugAdapter.e2e.test.ts's "TCP transport" case) -- this
 * pure function keeps the choice unit-testable the same way
 * shouldRefuseUnvalidatedPlatformLaunch() is.
 */
export function shouldUseTcpTransport(platform: string, transport?: "fifo" | "tcp"): boolean {
  return transport ? transport === "tcp" : platform === "win32";
}

/**
 * Converts a Linux absolute path to the Windows-style path Wine's own `Z:`
 * drive mapping exposes it as (e.g. `/home/gary/x.pb` ->
 * `Z:\home\gary\x.pb`) -- test-only, for compiler command-line arguments
 * (`-o <output>`, `<source file>`) specifically, since those are parsed by
 * the Windows PE compiler process itself and must be paths it understands.
 * Nothing else in the adapter needs this: the exeRunner-wrapped spawn calls
 * themselves already accept a plain Linux path (Wine resolves it), and
 * every other path the adapter tracks (source identity, breakpoints,
 * frames) stays a normal Linux path used only on the Node.js host side.
 */
export function toWinePath(linuxPath: string): string {
  return `Z:${linuxPath.replace(/\//g, "\\")}`;
}

/** Parses PureBasic's own compiler-stdout version banner (its first printed
 *  line on every invocation, e.g. `"PureBasic 6.41 (Linux - x64)"`, already
 *  captured by pbDebugAdapter.ts's launchRequest but unused on success)
 *  into the `major*100+minor` form the TCP handshake's CONNECT request
 *  requires. Returns `undefined` -- never a guessed fallback -- when the
 *  banner doesn't match, so callers fail clearly instead of sending a bogus
 *  version and getting a confusing target-side WrongVersion error. */
export function parseCompilerVersionBanner(stdout: string): number | undefined {
  const match = /PureBasic\s+(\d+)\.(\d+)/.exec(stdout);
  if (!match) return undefined;
  return Number(match[1]) * 100 + Number(match[2]);
}

/** Binds a throwaway server to port 0, lets the OS assign a free port,
 *  then releases it for the caller to reuse -- the standard way to hand a
 *  spawned target a free TCP port before it starts (it can't report one
 *  back). Accepts the inherent small race window (something else could
 *  claim the port before the target binds it). */
export function allocateFreeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("could not determine an allocated TCP port"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

/**
 * H3: `connect()`'s `fs.createReadStream(outFifo)`/`fs.createWriteStream(inFifo)`
 * each start a blocking POSIX `open()` on a libuv threadpool worker that only
 * returns once *something* opens the FIFO's other end. If the target process
 * never starts (bad cwd, missing binary, permission error -- see
 * pbDebugAdapter.ts's spawn 'error' handling), nothing ever will, and that
 * worker stays blocked in the kernel forever; `.destroy()`ing the stream
 * object doesn't cancel the in-flight syscall, only defers cleanup until it
 * eventually completes. Opening each FIFO's complementary end ourselves,
 * even just to immediately close it again, completes the kernel-level
 * rendezvous from both sides so the stuck opens return and the worker is
 * freed -- live-confirmed against a real mkfifo pair with no target. This
 * is intentionally fire-and-forget: callers have already sent their DAP
 * error response and are cleaning up, and there is nothing to do differently
 * if this best-effort unstick itself fails.
 */
export function unstickFifoRendezvous(outFifo: string, inFifo: string): void {
  fs.open(outFifo, "w", (err, fd) => {
    if (!err) fs.close(fd, () => {});
  });
  fs.open(inFifo, "r", (err, fd) => {
    if (!err) fs.close(fd, () => {});
  });
}

export interface CompileResult {
  /** Exit code, or `null` if the compiler never started (spawn error) or was killed for timing out. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** True if the compiler was killed after exceeding the timeout rather than exiting on its own. */
  timedOut: boolean;
}

// A few KB is typical for a real compile; this is generous headroom while
// still bounding memory if a compiler invocation goes pathological (e.g.
// runs away printing in a loop) instead of accumulating output forever.
const MAX_COMPILE_OUTPUT_BYTES = 2 * 1024 * 1024;
const TRUNCATION_MARKER = "\n[Pure Xtension: output truncated]\n";
export const DEFAULT_COMPILE_TIMEOUT_MS = 120_000;

function boundedAppend(current: string, chunk: Buffer): string {
  if (current.endsWith(TRUNCATION_MARKER)) return current;
  if (current.length >= MAX_COMPILE_OUTPUT_BYTES) return current + TRUNCATION_MARKER;
  return current + chunk.toString("utf8");
}

/**
 * H4: async replacement for `cp.spawnSync(compiler, ...)` in the debug
 * launch path -- spawnSync blocks the extension host's entire event loop
 * (all UI, all other requests, everything) for as long as the compile
 * takes, with no way to time out a stalled/hung compiler and no way to
 * cancel it if the user stops the debug session mid-compile. This spawns
 * asynchronously instead, returning the child immediately (so the caller
 * can track it and kill it on disconnect -- see pbDebugAdapter.ts's
 * `compileChild`) alongside a promise that resolves once the compiler exits,
 * is killed for exceeding `timeoutMs`, or fails to start at all (mirrors
 * H3's spawn 'error' handling: reported as `status: null`, not left to
 * throw unhandled).
 */
export function compileAsync(
  compiler: string,
  args: string[],
  timeoutMs = DEFAULT_COMPILE_TIMEOUT_MS,
  cwd?: string,
): { child: cp.ChildProcess; result: Promise<CompileResult> } {
  const child = cp.spawn(compiler, args, cwd ? { cwd } : undefined);
  const result = new Promise<CompileResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = boundedAppend(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: boundedAppend(stderr, Buffer.from(`${err.message}\n`)), timedOut: false });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr, timedOut });
    });
  });
  return { child, result };
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
  private writeStream?: PbWritable;
  private readStream?: PbReadable;
  private recvBuffer = Buffer.alloc(0);
  private pending: PendingWaiter[] = [];
  private unclaimed: PbMessage[] = [];
  /** Set from MSG_STARTUP_ANNOUNCEMENT / ExeMode before container requests. */
  private containerFormat: ContainerFormat = { ...DEFAULT_CONTAINER_FORMAT };

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
    return this.attachTransport(fs.createReadStream(outFifo), fs.createWriteStream(inFifo), timeoutMs);
  }

  /**
   * Opens a TCP connection to a target started with
   * `PB_DEBUGGER_Communication=NetworkServer;<port>` (PLAN.md M10), performs
   * the text handshake, and resolves once the `hello` message arrives —
   * the TCP counterpart to {@link connect}. `version` must be the compiler's
   * own `major*100+minor` (see {@link parseCompilerVersionBanner}); the
   * target rejects a mismatched one with `ERROR <version> WrongVersion`.
   *
   * `timeoutMs` is one overall budget shared across all three phases
   * (socket connect, text handshake, HELLO wait), matching {@link connect}'s
   * single-budget FIFO behavior -- each phase gets only the time left, not
   * a fresh `timeoutMs` of its own (which would let the worst case take up
   * to 3x the requested timeout).
   */
  async connectTcp(port: number, version: number, timeoutMs = 10000, host = "127.0.0.1"): Promise<PbMessage> {
    const deadline = Date.now() + timeoutMs;
    const remaining = () => Math.max(0, deadline - Date.now());
    const socket = await this.openTcpSocket(host, port, remaining());
    socket.write(buildConnectRequest(version));
    const leftover = await this.readHandshake(socket, remaining());
    return this.attachTransport(socket, socket, remaining(), leftover);
  }

  /**
   * A FIFO open() blocks until the target opens its end (see connect()'s
   * doc comment) -- TCP has no equivalent rendezvous. The target needs a
   * moment after spawning to reach its own `listen()` call, and connecting
   * before then fails immediately with ECONNREFUSED (confirmed live: the
   * very first attempt right after spawn reliably refuses), not by hanging
   * the way a not-yet-open FIFO would. This retries on ECONNREFUSED/ECONNRESET
   * with a short fixed delay until either a connection succeeds or the
   * overall `timeoutMs` budget is exhausted, so TCP gets the same
   * "wait for the target to be ready" behavior FIFO gets for free.
   */
  private openTcpSocket(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
    const deadline = Date.now() + timeoutMs;
    const RETRY_DELAY_MS = 50;
    // Settled once either the retry loop or the timeout below wins --
    // guards against the two things a naive Promise.race between them would
    // get wrong: a connection that completes *after* the timeout already
    // rejected must be destroyed, not left as a live, unused, leaked socket
    // (a real launch keeps the extension host process alive on that handle
    // indefinitely); and the timeout timer itself must be cleared on the
    // success path so it doesn't fire uselessly later. `currentSocket`
    // additionally lets the timeout path destroy a connection attempt that
    // is still pending (neither connected nor errored) when time runs out
    // -- e.g. a firewall silently dropping the SYN rather than refusing it.
    let settled = false;
    let currentSocket: net.Socket | undefined;
    const attempt = (): Promise<net.Socket> =>
      new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port });
        currentSocket = socket;
        socket.once("connect", () => resolve(socket));
        socket.once("error", (err: NodeJS.ErrnoException) => {
          socket.destroy();
          reject(err);
        });
      });
    const loop = async (): Promise<net.Socket> => {
      for (;;) {
        try {
          const socket = await attempt();
          if (settled) {
            socket.destroy();
            throw new Error("connectTcp: connection arrived after the overall timeout already gave up");
          }
          return socket;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (settled || !(code === "ECONNREFUSED" || code === "ECONNRESET") || Date.now() >= deadline) {
            throw err;
          }
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
      }
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        currentSocket?.destroy();
        reject(new Error(`timed out after ${timeoutMs}ms connecting to the debugger TCP port`));
      }, timeoutMs);
      loop().then(
        (socket) => {
          if (settled) return; // the timeout already rejected; loop() already destroyed this socket
          settled = true;
          clearTimeout(timer);
          resolve(socket);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /**
   * Reads and validates the TCP handshake (PLAN.md M10.1's live-confirmed
   * `CONNECT`/`ACCEPT`/`ERROR` text framing), then resolves with any bytes
   * received past the terminator. Those bytes are not scratch/discardable —
   * a single TCP `data` event can contain the handshake reply and part or
   * all of the very first binary `MSG_HELLO` concatenated together, so the
   * leftover must flow into {@link attachTransport}'s `seed`, never be
   * dropped or re-parsed as text.
   */
  private readHandshake(socket: net.Socket, timeoutMs: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("close", onClose);
        socket.off("error", onError);
      };
      // On every reject path the socket is not (yet) handed to
      // attachTransport, so nothing else will ever destroy it -- an
      // un-destroyed but still-connected socket keeps the event loop (and,
      // in a real launch, the process) alive indefinitely.
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length > MAX_HANDSHAKE_LEN) {
          cleanup();
          socket.destroy();
          reject(new Error("debugger TCP handshake exceeded the sanity length bound before a terminator arrived"));
          return;
        }
        const frame = splitHandshakeFrame(buf);
        if (!frame) return; // terminator hasn't arrived yet -- wait for more data
        cleanup();
        const reply = parseHandshakeReply(frame.text);
        if (!reply.ok) {
          socket.destroy();
          reject(new Error(`debugger TCP handshake rejected: ${reply.token}${reply.error ? ` (${reply.error})` : ""}`));
          return;
        }
        resolve(frame.rest);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("debugger connection closed during TCP handshake"));
      };
      const onError = (err: Error) => {
        cleanup();
        socket.destroy();
        reject(err);
      };
      const timer = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new Error(`timed out after ${timeoutMs}ms waiting for the TCP handshake`));
      }, timeoutMs);
      socket.on("data", onData);
      socket.on("close", onClose);
      socket.on("error", onError);
    });
  }

  /**
   * Wires the data/close/error handling shared by every transport and
   * resolves once the `hello` message arrives. `seed`, when given (TCP's
   * handshake leftover bytes), is drained immediately, before waiting for
   * the next message, since no further `data` event may arrive in time
   * otherwise. For TCP, `readStream` and `writeStream` are the *same*
   * socket object -- `close()`'s `.destroy()` then `.end()` stays a safe
   * no-op sequence on one object (`Socket.end()` no-ops once destroyed), but
   * this is a new invariant that wasn't true when the two fields were
   * always independent FIFO streams.
   */
  private attachTransport(readStream: PbReadable, writeStream: PbWritable, timeoutMs: number, seed?: Buffer): Promise<PbMessage> {
    this.readStream = readStream;
    this.writeStream = writeStream;
    readStream.on("data", (chunk) => {
      this.recvBuffer = Buffer.concat([this.recvBuffer, chunk]);
      this.drainMessages();
    });
    readStream.on("close", () => {
      this.rejectPending(new Error("debugger connection closed"));
      this.emit("close");
    });
    readStream.on("error", (err: Error) => {
      this.rejectPending(err);
      this.emit("error", err);
    });
    // For TCP, readStream and writeStream are the *same* socket object --
    // attaching a second "error" listener to it would fire this handler
    // twice for one real error (double rejectPending/emit). Only wire it
    // once when the two are already the same EventEmitter.
    if ((writeStream as unknown) !== (readStream as unknown)) {
      writeStream.on("error", (err: Error) => {
        this.rejectPending(err);
        this.emit("error", err);
      });
    }
    if (seed && seed.length) {
      this.recvBuffer = Buffer.concat([this.recvBuffer, seed]);
      this.drainMessages();
    }

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
      const location = splitDebuggerLine(msg.f8);
      this.emit("stopped", { ...location, reason: msg.f12 });
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
        // The wire protocol carries no request ID (see serialize()'s doc
        // comment), so a reply that eventually does show up for *this*
        // abandoned wait has no way to be told apart from the reply to
        // whatever request comes next -- it would silently get matched to
        // that unrelated later caller instead, corrupting every request/
        // reply pairing from that point on. Closing the whole connection
        // once any wait has been given up on is what actually prevents
        // that: there is no later caller left to corrupt. Safe to call
        // unconditionally (idempotent) even for callers (connect()'s own
        // handshake) that already close on their own timeout error.
        this.close();
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
   * arrival order (see {@link nextMessageWithTimeout}/{@link dispatch}) — so two
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
  async drainStartupAnnouncement(timeoutMs = 10000): Promise<PbMessage> {
    const msg = await this.nextMessageWithTimeout(timeoutMs, "the debugger's startup announcement", MSG_STARTUP_ANNOUNCEMENT);
    // ExeMode's Value1 (the f8 header field) advertises the target width in
    // bit 2. Container names, map keys, and String values themselves stay
    // single-byte external-protocol strings even when bit 0 says the target
    // is Unicode (confirmed on a real Unicode x64 target: f8=5 and
    // `nums()`/map keys are still NUL-terminated ASCII). Only use this
    // announcement for the architecture-dependent fields.
    this.containerFormat = {
      pointerBytes: (msg.f8 & (1 << 2)) !== 0 ? 8 : 4,
    };
    return msg;
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
    this.write(OP_BREAKPOINTS, BP_ADD_LINE, makeDebuggerLine(moduleId, line));
  }

  /** Removes a breakpoint by the wire protocol's 0-based compiled-line index. */
  removeLineBreakpoint(line: number, moduleId = 0): void {
    this.write(OP_BREAKPOINTS, BP_REMOVE_LINE, makeDebuggerLine(moduleId, line));
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

  async stackTrace(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<PbFrame[]> {
    return this.serialize(async () => {
      this.write(OP_STACK_TRACE);
      const msg = await this.nextMessageWithTimeout(timeoutMs, "the stack trace", 0x16);
      return parseFrames(msg.payload);
    });
  }

  /** Requests the target's named PureBasic modules.  This is intentionally
   * separate from Init's source-file table: a module name is not necessarily
   * a source filename, while only the latter can decode a packed line id. */
  async getModules(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<string[]> {
    return this.serialize(async () => {
      this.write(OP_GET_MODULES);
      const msg = await this.nextMessageWithTimeout(timeoutMs, "the debugger module names", MSG_MODULES);
      return parseModuleNames(msg.payload, msg.f8);
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
  async examineModuleScope(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<PbGlobalDecl[]> {
    return this.serialize(async () => {
      this.write(OP_EXAMINE_GLOBALS);
      const msg = await this.nextMessageWithTimeout(timeoutMs, "the module scope's declarations", 0xd);
      return parseGlobalDecls(msg.payload);
    });
  }

  async examineCurrentFrame(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<PbVariable[]> {
    return this.serialize(async () => {
      this.write(OP_EXAMINE_CURRENT_FRAME);
      const msg = await this.nextMessageWithTimeout(timeoutMs, "the current frame's variables", 0xf);
      return parseVariables(msg.payload);
    });
  }

  /** frameIndex is opcode-16 order: 0 = outermost caller, increasing toward the current frame. */
  async examineFrame(frameIndex: number, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<PbVariable[]> {
    return this.serialize(async () => {
      this.write(OP_EXAMINE_FRAME, frameIndex);
      const msg = await this.nextMessageWithTimeout(timeoutMs, "a stack frame's variables", 0x17);
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
  async examineArrays(global = false, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<PbArrayDecl[]> {
    return this.serialize(async () => {
      this.write(OP_EXAMINE_ARRAYS, global ? 1 : 0);
      const msg = await this.nextMessageWithTimeout(timeoutMs, "the array list", 0x10);
      return parseArrayDecls(msg.payload);
    });
  }

  /** Opcode 13: enumerate linked lists. Same f8/scope caveat as {@link examineArrays}. */
  async examineLists(global = false, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<PbListDecl[]> {
    return this.serialize(async () => {
      this.write(OP_EXAMINE_LISTS, global ? 1 : 0);
      const msg = await this.nextMessageWithTimeout(timeoutMs, "the linked-list list", 0x12);
      return parseListDecls(msg.payload);
    });
  }

  /** Opcode 14: enumerate maps. Same f8/scope caveat as {@link examineArrays}. */
  async examineMaps(global = false, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<PbMapDecl[]> {
    return this.serialize(async () => {
      this.write(OP_EXAMINE_MAPS, global ? 1 : 0);
      const msg = await this.nextMessageWithTimeout(timeoutMs, "the map list", 0x14);
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
   * Unlike the other request methods, this one's {@link nextMessageWithTimeout} call
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
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
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
      const msg = await this.nextMessageWithTimeout(timeoutMs, "the array/list/map expression result");
      const echoesExpression = msg.payload.length >= expression.length && msg.payload.toString("latin1", 0, expression.length) === expression;
      if (msg.type === 0x11 && echoesExpression) {
        const result = parseArrayElements(msg.payload, msg.f8, this.containerFormat);
        if (!result) return { kind: "unsupported", raw: msg.payload };
        const { name, elements } = result;
        return { kind: "array", name, elements };
      }
      if (msg.type === 0x15 && echoesExpression) {
        const result = parseMapElements(msg.payload, msg.f8, this.containerFormat);
        if (!result) return { kind: "unsupported", raw: msg.payload };
        const { name, elements } = result;
        return { kind: "map", name, elements };
      }
      if (msg.type === 0x13 && echoesExpression) {
        const listResult = parseListElements(msg.payload, msg.f12, msg.f8, this.containerFormat);
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
  async evaluate(expression: string, frameContext = -1, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<PbEvaluateResult> {
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
      const msg = await this.nextMessageWithTimeout(timeoutMs, "the evaluate result", MSG_EVALUATE_REPLY);
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
  async setVariable(target: string, value: string, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<PbEvaluateResult> {
    return this.serialize(async () => {
      const payload = Buffer.concat(
        [target, value].map((s) => Buffer.concat([Buffer.from(s, "latin1"), Buffer.from([0])])),
      );
      this.write(OP_MODIFY, 0, -1, 0, payload, payload.length);
      const msg = await this.nextMessageWithTimeout(timeoutMs, "the setVariable result", MSG_EVALUATE_REPLY);
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
