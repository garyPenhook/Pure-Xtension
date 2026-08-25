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

// Breakpoint sub-commands (opcode 3's f8 field).
export const BP_ADD_LINE = 1;
export const BP_REMOVE_LINE = 2;
export const BP_BULK = 3;
export const BP_BULK_CLEAR_ALL = 0xffffffff;

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
  kind: number; // 0 = global/module scope, 3 = local
  name: string;
  /** Decimal string if the trailing 8 bytes parsed as a plausible number, else a hex dump. */
  value: string;
}

export interface PbEvaluateResult {
  /** Reply f12: 0 = error, 1-3 = numeric (int/double, tag not yet distinguished), 4 = string, 5 = structure. */
  kind: number;
  /** Set when kind is 0. */
  error?: string;
  /** Set when kind is 1-3; only the raw little-endian int64 reading has been live-confirmed so far. */
  value?: string;
}

// Reply format for opcodes 33/34 (PLAN.md M5, "Expression's read side"),
// live-confirmed for the numeric case only (kind 1-3): 8-byte little-endian
// raw value followed by the echoed expression text (payload-length bytes,
// no null terminator). Kind 0 (error) is the PB_Language_GetKey error
// string, NUL-terminated, followed by the echoed expression text. Kinds 4
// (string) and 5 (structure) are decoded from the disassembly but not
// live-tested, so they're surfaced as unsupported rather than guessed at.
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
  return { kind: msg.f12, error: `unsupported evaluate result kind ${msg.f12} (string/structure results are not decoded yet)` };
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

// Per-variable record: 7-byte header (type, flag, kind bytes + 4-byte
// reserved/proc-id field), a NUL-terminated name, then an 8-byte
// little-endian numeric value. Only confirmed for `.i`-typed scalars — see
// PLAN.md's "Per-variable wire record" note for what's still unconfirmed
// (strings, arrays/lists/maps, structures, and the exact terminator shape).
function parseVariables(payload: Buffer): PbVariable[] {
  const vars: PbVariable[] = [];
  let off = 0;
  while (off + 7 < payload.length) {
    const kind = payload.readUInt8(off + 2);
    off += 7;
    const nul = payload.indexOf(0, off);
    if (nul === -1) break;
    const name = payload.toString("latin1", off, nul);
    off = nul + 1;
    if (!name) break;
    let value: string;
    if (off + 8 <= payload.length) {
      value = payload.readBigInt64LE(off).toString();
      off += 8;
    } else {
      value = `0x${payload.subarray(off).toString("hex")}`;
      off = payload.length;
    }
    vars.push({ kind, name, value });
  }
  return vars;
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

  close(): void {
    this.readStream?.destroy();
    this.writeStream?.end();
    this.readStream = undefined;
    this.writeStream = undefined;
  }
}
