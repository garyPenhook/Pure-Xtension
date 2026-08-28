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

const cachedAvailability = new Map<string, Promise<boolean>>();

/**
 * Bounded, side-effect-free async probe, memoized process-wide (per
 * `gdbPath`) so repeated or concurrent callers (multiple Pause clicks,
 * multiple debug sessions) never spawn more than one `gdb --version` check
 * for the same path. launch()/attach() are still the real capability check --
 * this only decides whether attempting them is worth it. Replaces a prior
 * synchronous `spawnSync()` version that blocked the whole extension host's
 * event loop for up to 3s on the first Pause.
 */
export function gdbEngineAvailable(gdbPath = "gdb"): Promise<boolean> {
  if (process.platform !== "linux") return Promise.resolve(false);
  let probeResult = cachedAvailability.get(gdbPath);
  if (!probeResult) {
    probeResult = new Promise<boolean>((resolve) => {
      let probe: cp.ChildProcess;
      try {
        probe = cp.spawn(gdbPath, ["--version"]);
      } catch {
        resolve(false);
        return;
      }
      let stdout = "";
      const timer = setTimeout(() => {
        probe.kill("SIGKILL");
        resolve(false);
      }, 3000);
      probe.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      probe.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      probe.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code === 0 && /GNU gdb/i.test(stdout));
      });
    }).then((available) => {
      // Only memoize a positive result forever -- gdb won't uninstall
      // itself mid-session. A negative one could be a one-off (PATH
      // momentarily wrong, a spawn race, the probe's own 3s timeout
      // tripping under load), and permanently caching that would silently
      // disable Force Pause for every future Pause and every future debug
      // session in this same extension host, with no re-probe and no
      // visible signal, over what might never recur.
      if (!available) cachedAvailability.delete(gdbPath);
      return available;
    });
    cachedAvailability.set(gdbPath, probeResult);
  }
  return probeResult;
}

/**
 * Synchronous variant retained only for test `{ skip }` conditions, which
 * must be known synchronously at `test()` registration time, before any
 * async work can run. Never call this from production/extension-host code --
 * use the async `gdbEngineAvailable()` above there.
 */
export function gdbEngineAvailableSync(gdbPath = "gdb"): boolean {
  if (process.platform !== "linux") return false;
  const probe = cp.spawnSync(gdbPath, ["--version"], { encoding: "utf8", timeout: 3000 });
  return probe.status === 0 && /GNU gdb/i.test(probe.stdout ?? "");
}

const DEFAULT_COMMAND_TIMEOUT_MS = 5000;
const DEFAULT_STOP_WAIT_TIMEOUT_MS = 15000;

export interface GdbMiPtraceEngineOptions {
  /** Path to the gdb executable to spawn. Defaults to "gdb", resolved via PATH. */
  gdbPath?: string;
  /** Bound on any single MI command's round trip (startup/attach/detach commands included). */
  commandTimeoutMs?: number;
  /** Bound on waiting for the asynchronous `*stopped` record after a resume/attach. */
  stopWaitTimeoutMs?: number;
  /** Overrides the environment gdb itself (not the inferior -- see launch()'s
   *  `-gdb-set environment`) is spawned with. Test-only hook for driving a
   *  fake gdb fixture script through env vars without touching the real
   *  process.env; production code never sets this. */
  env?: NodeJS.ProcessEnv;
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
  private readonly gdbPath: string;
  private readonly commandTimeoutMs: number;
  private readonly stopWaitTimeoutMs: number;
  private readonly env?: NodeJS.ProcessEnv;
  private token = 1;
  private lastThreadId = 1;
  private inferiorPid = -1;
  private lastStop?: MiStoppedRecord;
  private closed = false;

  constructor(options: GdbMiPtraceEngineOptions = {}) {
    super();
    this.gdbPath = options.gdbPath ?? "gdb";
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.stopWaitTimeoutMs = options.stopWaitTimeoutMs ?? DEFAULT_STOP_WAIT_TIMEOUT_MS;
    this.env = options.env;
  }

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
    this.gdb = cp.spawn(this.gdbPath, ["--quiet", "--interpreter=mi2"], { cwd, stdio: ["pipe", "pipe", "pipe"], env: this.env });
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

  /**
   * Sends one MI command and bounds how long it waits for the matching
   * `N^done`/`N^running` reply -- a GDB that goes silent (killed externally,
   * wedged, or simply never implements a given command the way expected)
   * would otherwise leave the caller awaiting forever, since nothing but a
   * matching token or the process actually exiting ever settles this
   * promise. On timeout the pending entry is dropped so a late, mismatched
   * reply arriving afterward is silently ignored by onLine() rather than
   * resolving/rejecting a promise nothing is awaiting anymore.
   */
  private command(
    command: string,
    accepted: readonly string[] = ["done"],
    timeoutMs = this.commandTimeoutMs,
  ): Promise<MiResultRecord> {
    const gdb = this.gdb;
    if (!gdb || this.closed || !gdb.stdin.writable) return Promise.reject(new Error("GDB MI engine is not running"));
    const token = this.token++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(token);
        reject(new Error(`GDB MI command timed out after ${timeoutMs}ms: ${command}`));
      }, timeoutMs);
      this.pending.set(token, {
        resolve: (record) => {
          clearTimeout(timer);
          resolve(record);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        accepted: new Set(accepted),
      });
      gdb.stdin.write(`${token}${command}\n`, (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(token);
        reject(err);
      });
    });
  }

  /**
   * Waits for the next asynchronous `*stopped` record, bounded so a resume
   * or attach that never actually stops (a GDB bug, a killed process, or the
   * engine being disposed out from under an in-flight attach -- see
   * pbDebugAdapter.ts's `forcePauseAttaching`) rejects instead of hanging
   * the caller forever. dispose() emits "aborted" specifically so a stop-wait
   * in flight when the engine is torn down rejects immediately rather than
   * waiting out the full timeout.
   */
  private waitForStop(timeoutMs = this.stopWaitTimeoutMs): { promise: Promise<MiStoppedRecord>; cancel: () => void } {
    let stoppedListener!: () => void;
    let abortedListener!: (err: Error) => void;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      this.off("stopped", stoppedListener);
      this.off("aborted", abortedListener);
      clearTimeout(timer);
    };
    const promise = new Promise<MiStoppedRecord>((resolve, reject) => {
      stoppedListener = () => {
        cleanup();
        resolve(this.lastStop ?? { text: "*stopped" });
      };
      abortedListener = (err) => {
        cleanup();
        reject(err);
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out after ${timeoutMs}ms waiting for GDB to report a stop`));
      }, timeoutMs);
      this.on("stopped", stoppedListener);
      this.on("aborted", abortedListener);
    });
    // Every caller here creates this promise and then `await`s something
    // ELSE first (the command that triggers the stop) before ever awaiting
    // `.promise` itself -- so this timer (or an "aborted" emitted by a
    // concurrent dispose()) can fire and reject it during that gap, with
    // nothing attached yet. A `.catch` here marks it handled for Node's
    // unhandled-rejection tracking without consuming the rejection --
    // `.promise` still delivers it normally to whichever caller does
    // eventually `await` it, or leaves it (safely, since nothing then
    // observes it) if a caller's own cancel()/earlier failure means they
    // never do.
    promise.catch(() => {});
    return { promise, cancel: cleanup };
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
    if (!(await gdbEngineAvailable(this.gdbPath))) throw new Error("GDB/MI is unavailable (expected GNU gdb on Linux)");
    // A dispose() concurrent with the awaited probe above (this engine
    // cancelled before it ever got as far as owning a gdb process) must not
    // be undone by starting one anyway -- startGdb() itself resets `closed`
    // to false the moment it spawns, so this has to be checked before that.
    if (this.closed) throw new Error("GDB MI engine disposed");
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
    if (!(await gdbEngineAvailable(this.gdbPath))) throw new Error("GDB/MI is unavailable (expected GNU gdb on Linux)");
    // See launch()'s identical check: a dispose() concurrent with the
    // awaited probe above must not be undone by starting gdb anyway.
    if (this.closed) throw new Error("GDB MI engine disposed");
    await this.startGdb(process.cwd());
    // Declared here, not inside the try, so the catch below can always
    // reach it: if `-target-attach` itself rejects (e.g. its own command
    // timeout), `stopped.promise` is abandoned mid-wait, still listening for
    // "aborted" -- dispose() emits exactly that on the way out, which would
    // otherwise reject an orphaned promise nothing is awaiting anymore.
    // cancel() unsubscribes it first so it's left permanently (harmlessly)
    // pending instead.
    const stopped = this.waitForStop();
    try {
      await this.command(`-target-attach ${pid}`);
      await stopped.promise;
      return this.readRip();
    } catch (err) {
      stopped.cancel();
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
    // Set/emitted unconditionally, even if gdb was never spawned yet (e.g.
    // disposed while attach()/launch() are still awaiting the async
    // gdbEngineAvailable() probe, before startGdb() runs) or already exited.
    // Without `closed` being set here regardless of `gdb`, a dispose() that
    // lands in that pre-spawn window did nothing observable: attach() would
    // resume once its awaited probe settled and go on to actually spawn gdb
    // and ptrace-attach the target, unaware it had already been cancelled --
    // self-correcting only later via pbDebugAdapter.ts's `pauseGeneration`
    // check, after a full spawn/MI-handshake/attach round trip the caller
    // meant to skip entirely. An in-flight waitForStop() (same scenario, or
    // a "Force Pause" attach that never got as far as forcePauseEngine, see
    // pbDebugAdapter.ts's `forcePauseAttaching`) must also reject immediately
    // on dispose rather than hang until its own timeout, since nothing will
    // ever emit "stopped" for a GDB process that's about to be killed.
    this.closed = true;
    this.emit("aborted", new Error("GDB MI engine disposed"));
    const gdb = this.gdb;
    if (!gdb) return;
    // In non-stop mode GDB can defer every MI command (including
    // `-gdb-exit`) while an inferior thread is running. Do not make DAP
    // disconnect hang behind that queue; this is an engine-owned GDB process
    // and SIGKILL reliably releases both its ptrace tracee and MI pipes.
    if (!gdb.killed) gdb.kill("SIGKILL");
    this.gdb = undefined;
    this.breakpoints.clear();
    this.rejectPending(new Error("GDB MI engine disposed"));
  }
}
