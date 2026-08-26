// GDB/MI execution-control engine for the PureBasic debug adapter.
//
// PureBasic's FIFO protocol stops only at PB_DEBUGGER_Check calls between
// statements. A machine breakpoint is still required to interrupt a target
// blocked in a GUI/event-loop or library call. GDB 17.2's MI2 interface was
// live-validated with the FIFO transport (PLAN.md M8/M9); radare2 was not
// reliable because its Linux debug launcher clears the inferior environment.

import * as cp from "child_process";
import { EventEmitter } from "events";
import * as readline from "readline";

export interface PtraceEngine extends EventEmitter {
  launch(program: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number>;
  setBreakpoint(addr: number): Promise<void>;
  removeBreakpoint(addr: number): Promise<void>;
  continueToStop(): Promise<number>;
  singleStep(): Promise<number>;
  runToAddress(addr: number): Promise<number>;
  readRip(): Promise<number>;
  readMemory(addr: number, length: number): Promise<Buffer>;
  dispose(): Promise<void>;
}

export interface MiResultRecord {
  token: number;
  klass: string;
  text: string;
}

export interface MiStoppedRecord {
  reason?: string;
  threadId?: number;
  address?: number;
  text: string;
}

/** Parses a tokenized GDB/MI result record, for example `12^done,bkpt=...`. */
export function parseMiResultRecord(line: string): MiResultRecord | undefined {
  const match = /^(\d+)\^([A-Za-z-]+)(?:,(.*))?$/.exec(line.trim());
  if (!match) return undefined;
  return { token: Number(match[1]), klass: match[2], text: match[3] ?? "" };
}

/** Extracts the fields this engine needs from an asynchronous `*stopped` MI record. */
export function parseMiStoppedRecord(line: string): MiStoppedRecord | undefined {
  const text = line.trim();
  if (!text.startsWith("*stopped")) return undefined;
  const reason = /(?:^|,)reason="((?:\\.|[^"\\])*)"/.exec(text)?.[1];
  const thread = /(?:^|,)thread-id="(\d+)"/.exec(text)?.[1];
  // Normally embedded in `frame={addr="0x...",...}`; also covers a direct addr field.
  const address = /(?:^|[,{])addr="(0x[0-9a-fA-F]+)"/.exec(text)?.[1];
  return {
    reason: reason?.replace(/\\([\\"])/g, "$1"),
    threadId: thread === undefined ? undefined : Number(thread),
    address: address === undefined ? undefined : Number(address),
    text,
  };
}

function miQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n")}"`;
}

function unquoteMi(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/\\([\\"nrt])/g, (_all, escaped: string) => {
    if (escaped === "n") return "\n";
    if (escaped === "r") return "\r";
    if (escaped === "t") return "\t";
    return escaped;
  });
}

function resultError(record: MiResultRecord): Error {
  const message = unquoteMi(/(?:^|,)msg="((?:\\.|[^"\\])*)"/.exec(record.text)?.[1]);
  return new Error(`gdb MI command failed${message ? `: ${message}` : ` (${record.klass})`}`);
}

function parseAddress(text: string): number {
  // GDB appends a symbol annotation when one resolves at the address (e.g.
  // `value="0x7fd63cb12cb2 <__internal_syscall_cancel+130>"`, live-confirmed
  // via `attach()` against a symbol-bearing libc) -- the numeric token can be
  // followed by whitespace, not just the closing quote.
  const match = /(?:^|,)value="(0x[0-9a-fA-F]+|\d+)(?:[\s"]|$)/.exec(text);
  if (!match) throw new Error(`GDB did not return an address: ${text}`);
  return Number(match[1]);
}

function parseMemory(text: string): Buffer {
  const contents = /(?:^|,)contents="([0-9a-fA-F]*)"/.exec(text)?.[1];
  if (contents === undefined || contents.length % 2 !== 0) throw new Error(`GDB did not return readable memory: ${text}`);
  return Buffer.from(contents, "hex");
}

/** A bounded, side-effect-free probe. launch() is still the real capability check. */
export function gdbEngineAvailable(gdbPath = "gdb"): boolean {
  if (process.platform !== "linux") return false;
  const probe = cp.spawnSync(gdbPath, ["--version"], { encoding: "utf8", timeout: 3000 });
  return probe.status === 0 && /GNU gdb/i.test(probe.stdout ?? "");
}

interface PendingCommand {
  resolve: (record: MiResultRecord) => void;
  reject: (err: Error) => void;
  accepted: ReadonlySet<string>;
}

/**
 * Tokenized GDB/MI2 implementation. Each command gets a monotonically
 * increasing token; only its matching `N^done`/`N^running` completes it.
 * `*stopped` stays asynchronous, so prompt ordering cannot misroute replies.
 */
export class GdbMiPtraceEngine extends EventEmitter implements PtraceEngine {
  private gdb?: cp.ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly breakpoints = new Map<number, string>();
  private token = 1;
  private lastThreadId = 1;
  private inferiorPid = -1;
  private lastStop?: MiStoppedRecord;
  private closed = false;

  private rejectPending(err: Error): void {
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }

  private onLine(line: string): void {
    const pid = /^=thread-group-started,.*(?:^|,)pid="(\d+)"/.exec(line.trim())?.[1];
    if (pid !== undefined) {
      this.inferiorPid = Number(pid);
      return;
    }
    const result = parseMiResultRecord(line);
    if (result) {
      const pending = this.pending.get(result.token);
      if (!pending) return;
      this.pending.delete(result.token);
      if (result.klass === "error") pending.reject(resultError(result));
      else if (pending.accepted.has(result.klass)) pending.resolve(result);
      else pending.reject(new Error(`unexpected GDB MI result ^${result.klass} for command ${result.token}`));
      return;
    }
    const stopped = parseMiStoppedRecord(line);
    if (!stopped) return;
    this.lastStop = stopped;
    if (stopped.threadId !== undefined) this.lastThreadId = stopped.threadId;
    this.emit("stopped", stopped.address ?? -1);
  }

  private async startGdb(cwd: string): Promise<void> {
    this.gdb = cp.spawn("gdb", ["--quiet", "--interpreter=mi2"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.closed = false;
    const gdb = this.gdb;
    gdb.on("error", (err) => this.rejectPending(err));
    gdb.on("exit", (code, signal) => {
      this.gdb = undefined;
      this.rejectPending(new Error(`gdb exited (${signal ?? code ?? "unknown"})`));
    });
    readline.createInterface({ input: gdb.stdout }).on("line", (line) => this.onLine(line));
    gdb.stderr.on("data", (data: Buffer) => this.emit("output", data.toString()));
    await this.command("-gdb-set pagination off");
    await this.command("-gdb-set non-stop on");
  }

  private command(command: string, accepted: readonly string[] = ["done"]): Promise<MiResultRecord> {
    const gdb = this.gdb;
    if (!gdb || this.closed || !gdb.stdin.writable) return Promise.reject(new Error("GDB MI engine is not running"));
    const token = this.token++;
    return new Promise((resolve, reject) => {
      this.pending.set(token, { resolve, reject, accepted: new Set(accepted) });
      gdb.stdin.write(`${token}${command}\n`, (err) => {
        if (!err) return;
        this.pending.delete(token);
        reject(err);
      });
    });
  }

  private waitForStop(): { promise: Promise<MiStoppedRecord>; cancel: () => void } {
    let listener!: () => void;
    const promise = new Promise<MiStoppedRecord>((resolve) => {
      listener = () => {
        this.off("stopped", listener);
        resolve(this.lastStop ?? { text: "*stopped" });
      };
      this.on("stopped", listener);
    });
    return {
      promise,
      cancel: () => this.off("stopped", listener),
    };
  }

  private async resumeAndWait(command: string): Promise<number> {
    // Subscribe before sending: a fast inferior can stop before ^running arrives.
    const stopped = this.waitForStop();
    try {
      await this.command(command, ["running", "done"]);
    } catch (err) {
      stopped.cancel();
      throw err;
    }
    const record = await stopped.promise;
    return record.address ?? this.readRip();
  }

  async launch(program: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
    if (!gdbEngineAvailable()) throw new Error("GDB/MI is unavailable (expected GNU gdb on Linux)");
    await this.startGdb(cwd);
    try {
      await this.command(`-environment-cd ${miQuote(cwd)}`);
      // Set the inferior's environment through MI: unlike radare2, this
      // preserves the FIFO transport even when GDB's own parent differs.
      for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) await this.command(`-gdb-set environment ${key}=${value}`);
      }
      await this.command(`-file-exec-and-symbols ${miQuote(program)}`);
      if (args.length) await this.command(`-exec-arguments ${args.map(miQuote).join(" ")}`);
      await this.command("-exec-run", ["running"]);
      // A running non-stop inferior may defer -thread-info indefinitely. GDB
      // emits this synchronous-to-launch notification before its ^running
      // record, so it is the bounded source of the Linux inferior pid.
      return this.inferiorPid;
    } catch (err) {
      await this.dispose();
      throw err;
    }
  }

  /**
   * Attaches to an already-running process instead of launching a fresh one
   * (used for a lazy "Force Pause" fallback — see pbDebugAdapter.ts — rather
   * than launching every target under GDB from the start). Live-confirmed:
   * `-target-attach` in non-stop mode immediately ptrace-stops every thread
   * of the target and emits a `*stopped` record shortly after its own
   * `^done`, independent of whatever the target was doing (including inside
   * a blocking syscall) — this is the actual capability wire-only pause
   * lacks. Returns the stopped PC.
   */
  async attach(pid: number): Promise<number> {
    if (!gdbEngineAvailable()) throw new Error("GDB/MI is unavailable (expected GNU gdb on Linux)");
    await this.startGdb(process.cwd());
    try {
      const stopped = this.waitForStop();
      await this.command(`-target-attach ${pid}`);
      await stopped.promise;
      return this.readRip();
    } catch (err) {
      await this.dispose();
      throw err;
    }
  }

  /**
   * Detaches and resumes the attached process normally — required before
   * disposing this engine's GDB process for a clean handoff, not just
   * cleanup. Live-confirmed on this machine: after `-target-detach`, the
   * target is still running (`TracerPid: 0`, state unchanged). Also
   * confirmed as a fallback fact (not relied on as the primary path): even
   * an unclean SIGKILL of GDB with no explicit detach leaves the tracee
   * alive and un-traced — the kernel detaches a ptrace tracee automatically
   * when its tracer dies, since GDB does not set PTRACE_O_EXITKILL for a
   * process it merely attached to (as opposed to one it launched).
   */
  async detach(): Promise<void> {
    if (!this.gdb || this.closed) return;
    await this.command("-target-detach");
  }

  async setBreakpoint(addr: number): Promise<void> {
    if (this.breakpoints.has(addr)) return;
    const result = await this.command(`-break-insert *0x${addr.toString(16)}`);
    const id = /(?:^|[,{])number="([^"]+)"/.exec(result.text)?.[1];
    if (!id) throw new Error(`GDB did not return a breakpoint id: ${result.text}`);
    this.breakpoints.set(addr, id);
  }

  async removeBreakpoint(addr: number): Promise<void> {
    const id = this.breakpoints.get(addr);
    if (!id) return;
    await this.command(`-break-delete ${id}`);
    this.breakpoints.delete(addr);
  }

  async continueToStop(): Promise<number> {
    return this.resumeAndWait(`-exec-continue --thread ${this.lastThreadId}`);
  }

  async singleStep(): Promise<number> {
    return this.resumeAndWait(`-exec-step-instruction --thread ${this.lastThreadId}`);
  }

  async runToAddress(addr: number): Promise<number> {
    const result = await this.command(`-break-insert -t *0x${addr.toString(16)}`);
    const id = /(?:^|[,{])number="([^"]+)"/.exec(result.text)?.[1];
    if (!id) throw new Error(`GDB did not return a temporary breakpoint id: ${result.text}`);
    try {
      return await this.continueToStop();
    } finally {
      // GDB normally deletes a -t breakpoint on hit; ignore an already-gone id.
      try { await this.command(`-break-delete ${id}`); } catch { /* auto-deleted */ }
    }
  }

  async readRip(): Promise<number> {
    return parseAddress((await this.command("-data-evaluate-expression $rip")).text);
  }

  async readMemory(addr: number, length: number): Promise<Buffer> {
    if (!Number.isInteger(length) || length < 0) throw new Error("memory length must be a non-negative integer");
    const data = parseMemory((await this.command(`-data-read-memory-bytes 0x${addr.toString(16)} ${length}`)).text);
    if (data.length !== length) throw new Error(`GDB returned ${data.length} memory bytes, expected ${length}`);
    return data;
  }

  async dispose(): Promise<void> {
    const gdb = this.gdb;
    if (!gdb) return;
    // In non-stop mode GDB can defer every MI command (including
    // `-gdb-exit`) while an inferior thread is running. Do not make DAP
    // disconnect hang behind that queue; this is an engine-owned GDB process
    // and SIGKILL reliably releases both its ptrace tracee and MI pipes.
    this.closed = true;
    if (!gdb.killed) gdb.kill("SIGKILL");
    this.gdb = undefined;
    this.breakpoints.clear();
    this.rejectPending(new Error("GDB MI engine disposed"));
  }
}
