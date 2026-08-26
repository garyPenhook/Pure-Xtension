import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  Breakpoint,
  DebugSession,
  InitializedEvent,
  OutputEvent,
  Scope,
  Source,
  StackFrame,
  StoppedEvent,
  TerminatedEvent,
  Thread,
  Variable,
} from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";
import { Backend, resolveBackendSilent, resolveCompilerPath } from "../config";
import { PbDebugSession, PbVariable } from "./pbSession";

const MAIN_THREAD_ID = 1;
// variablesReference values for compound (structure/array/list/map)
// children live in a disjoint range above the small 1..N frame-scope refs
// scopesRequest hands out (N = frame count, always small), so the two
// numbering schemes can share one field without collision.
const COMPOUND_REF_BASE = 100000;

type CompoundHandle =
  | { kind: "struct"; children: PbVariable[] }
  | { kind: "array" | "list" | "map"; expression: string };

interface LaunchArgs extends DebugProtocol.LaunchRequestArguments {
  program: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stopOnEntry?: boolean;
  backend?: Backend;
  compilerArgs?: string[];
}

/**
 * Launch, line breakpoints, pause/continue, native PureBasic stepping, stack
 * trace, locals (including array/list/map/structure expansion), and
 * evaluate/setVariable. The execution controls are captured from PureBasic
 * 6.41's standalone debugger (PLAN.md M9), not reconstructed from line
 * breakpoints.
 */
export class PureBasicDebugSession extends DebugSession {
  private pb = new PbDebugSession();
  private child?: cp.ChildProcess;
  private workDir?: string;
  private fifoDir?: string;
  private sourcePath = "";
  /**
   * True once `this.pb.connect()` has actually opened the FIFOs. VS Code
   * sends `setBreakpoints` as soon as `initialized` fires — which happens
   * well before `launchRequest` finishes compiling and connecting — so
   * `setBreakPointsRequest` can run while `this.pb`'s write stream doesn't
   * exist yet. Writing to it then throws synchronously inside an async
   * handler, which becomes a silently-unhandled rejection (dispatchRequest's
   * try/catch only covers synchronous throws), so the breakpoint response
   * never gets sent and every breakpoint appears ignored. This flag lets
   * setBreakPointsRequest track the desired state locally and defer the
   * actual wire writes to `flushBreakpointsToWire()` once connected.
   */
  private pbConnected = false;
  /** 1-based line the target last stopped at (StoppedEvent's `line`/`msg.f8`), used as the innermost/main frame's current line since opcode 16 never carries it. */
  private lastStopLine = 0;
  /**
   * Per-stop map from DAP frameId to what that frame actually is: a procedure
   * frame (addressable by its opcode-17 index) or the synthetic module/main
   * frame. Rebuilt every stackTraceRequest. Opcode 16 only ever reports
   * *procedure* frames — and none at all when the target is stopped at module
   * scope — so the adapter synthesizes a main frame beneath them; without it a
   * top-level stop would hand VS Code zero frames, and with zero frames the
   * client can't request scopes/variables at all (they hang off a frameId), so
   * nothing would be inspectable.
   */
  private frameHandles = new Map<number, { kind: "main" } | { kind: "proc"; pbIndex: number }>();
  /** Guards against sending TerminatedEvent twice — the wire session's `close` and the child's `exit` both fire on every teardown. */
  private terminated = false;
  /** Structure/array/list/map handles for the current stop, keyed by a variablesReference >= COMPOUND_REF_BASE. Rebuilt on every stop. */
  private compoundHandles = new Map<number, CompoundHandle>();
  private nextCompoundRef = COMPOUND_REF_BASE;
  /** Resolves once VS Code sends configurationDone (i.e. setBreakpoints has landed), so the initial continue() can't race ahead of it. */
  private configurationDone: Promise<void>;
  private resolveConfigurationDone!: () => void;
  /** The real (user-set) line breakpoints currently active on the wire. */
  private activeBreakpoints = new Set<number>();
  /** True from a native step command until its matching stopped notification. */
  private stepInProgress = false;
  /** True while stopOnEntry is advancing from the debugger runtime's
   * line-less startup wait to the first executable source statement. */
  private entryDiscoveryInProgress = false;
  /**
   * Temporary all-line breakpoints used only to discover the exact entry
   * source line. Native stepping never uses this coverage.
   */
  private entryTempLines = new Set<number>();
  /** Source line count at debug-build time, used only by entry-line discovery. */
  private totalLines = 0;

  constructor() {
    super();
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
    this.configurationDone = new Promise((resolve) => {
      this.resolveConfigurationDone = resolve;
    });
    this.pb.on("stopped", ({ line, reason }: { line: number; reason: number }) => {
      // The target protocol reports its compiled-line index (0-based); DAP
      // source lines are 1-based. Breakpoint requests use the same inverse
      // conversion at every add/remove call below.
      line += 1;
      // Capture the stop line before the state checks below so it is available
      // to the stack trace requested immediately after the stop event.
      this.lastStopLine = line;
      this.compoundHandles.clear();
      this.frameHandles.clear();
      this.nextCompoundRef = COMPOUND_REF_BASE;
      if (this.stepInProgress) {
        this.stepInProgress = false;
        this.sendEvent(new StoppedEvent("step", MAIN_THREAD_ID));
        return;
      }
      if (this.entryDiscoveryInProgress) return;
      this.sendEvent(new StoppedEvent(reason === 7 ? "breakpoint" : "pause", MAIN_THREAD_ID));
    });
    this.pb.on("terminated", () => this.notifyTerminated());
    this.pb.on("close", () => this.notifyTerminated());
    this.pb.on("error", (err) => this.logError(err));
    // `Debug` statement text is sent over the wire (this event) instead of
    // the target's stdout once an external debugger is attached (confirmed
    // by disassembly: PB_DEBUGGER_PrintString picks one path or the other,
    // never both) -- child.stdout below never sees it. Surfacing it here is
    // the only way it reaches the Debug Console at all. The text itself is
    // confirmed truncated by a bug in PureBasic's own debugger.a runtime
    // (see parseDebugOutputText's doc comment for the live-tested evidence)
    // -- there is no way to recover the missing half from this side of the
    // connection, so the marker below is honest, not a hedge.
    this.pb.on("debugOutput", (text: string) => {
      this.sendEvent(new OutputEvent(`${text} [Debug output — may be truncated]\n`, "console"));
    });
  }

  private logError(err: unknown): void {
    this.sendEvent(new OutputEvent(`Pure Xtension debugger: ${String(err)}\n`, "stderr"));
  }

  /** Completes a DAP request with an actionable error when its asynchronous
   * wire operation fails. DebugSession's dispatcher does not await async
   * handlers, so an uncaught rejection would otherwise leave the client
   * waiting forever for a response. */
  private sendAsyncRequestError(
    response: DebugProtocol.Response,
    operation: string,
    err: unknown,
  ): void {
    const detail = err instanceof Error ? err.message : String(err);
    this.logError(err);
    this.sendErrorResponse(response, 1090, `Pure Xtension: ${operation} failed: ${detail}`);
  }

  private notifyTerminated(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.sendEvent(new TerminatedEvent());
  }

  /** Removes the compile-output and FIFO temp dirs. Safe to call more than once and from any error path. */
  private cleanupTempDirs(): void {
    if (this.workDir) {
      fs.rmSync(this.workDir, { recursive: true, force: true });
      this.workDir = undefined;
    }
    if (this.fifoDir) {
      fs.rmSync(this.fifoDir, { recursive: true, force: true });
      this.fifoDir = undefined;
    }
  }

  protected initializeRequest(
    response: DebugProtocol.InitializeResponse,
    _args: DebugProtocol.InitializeRequestArguments,
  ): void {
    response.body = response.body ?? {};
    response.body.supportsConfigurationDoneRequest = true;
    // Native PureBasic 6.41 command 1 supports step into, over, and out. DAP
    // step-in targets (choosing among several calls on one line) are separate
    // and are not provided by the target protocol.
    response.body.supportsStepInTargetsRequest = false;
    response.body.supportsEvaluateForHovers = true;
    response.body.supportsSetVariable = true;
    this.sendResponse(response);
    this.sendEvent(new InitializedEvent());
  }

  protected configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse,
    args: DebugProtocol.ConfigurationDoneArguments,
  ): void {
    super.configurationDoneRequest(response, args);
    this.resolveConfigurationDone();
  }

  protected async launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: LaunchArgs,
  ): Promise<void> {
    let responseSent = false;
    try {
    this.sourcePath = args.program;
    const backend = args.backend ?? resolveBackendSilent() ?? "asm";
    const compiler = resolveCompilerPath(backend);
    if (!compiler) {
      this.sendErrorResponse(response, 1001, "Pure Xtension: no PureBasic compiler found for the selected backend.");
      return;
    }

    this.workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pure-xtension-debug-"));
    const outBinary = path.join(this.workDir, "target.bin");
    const compileArgs = ["-d", "-ds", "-l", "-o", outBinary, ...(args.compilerArgs ?? []), args.program];
    const compileResult = cp.spawnSync(compiler, compileArgs, { encoding: "utf8" });
    if (compileResult.status !== 0) {
      this.sendEvent(new OutputEvent(compileResult.stdout ?? "", "stdout"));
      this.sendEvent(new OutputEvent(compileResult.stderr ?? "", "stderr"));
      this.sendErrorResponse(response, 1002, "Pure Xtension: compile (debug build) failed — see debug console.");
      this.cleanupTempDirs();
      return;
    }
    try {
      this.totalLines = fs.readFileSync(args.program, "utf8").split("\n").length;
    } catch (err) {
      this.logError(err);
    }

    if (process.platform === "win32") {
      // FIFOs (POSIX-only) are the only transport this adapter implements —
      // fail clearly instead of letting execFileSync("mkfifo", ...) throw an
      // uncaught ENOENT before any of the surrounding cleanup can run.
      this.sendErrorResponse(
        response,
        1006,
        "Pure Xtension: the FIFO-based debugger transport isn't supported on Windows yet.",
      );
      this.cleanupTempDirs();
      return;
    }

    this.fifoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pure-xtension-fifo-"));
    const outFifo = path.join(this.fifoDir, "pb_out");
    const inFifo = path.join(this.fifoDir, "pb_in");
    cp.execFileSync("mkfifo", [outFifo, inFifo]);

    this.child = cp.spawn(outBinary, args.args ?? [], {
      cwd: args.cwd ?? path.dirname(args.program),
      env: {
        ...process.env,
        ...args.env,
        PB_DEBUGGER_Communication: `FifoFiles;${outFifo};${inFifo}`,
      },
    });
    this.child.stdout?.on("data", (d) => this.sendEvent(new OutputEvent(d.toString(), "stdout")));
    this.child.stderr?.on("data", (d) => this.sendEvent(new OutputEvent(d.toString(), "stderr")));
    this.child.on("exit", (code) => {
      this.sendEvent(new OutputEvent(`target exited (${code})\n`));
      this.notifyTerminated();
    });

    try {
      await this.pb.connect(outFifo, inFifo);
      await this.pb.drainStartupAnnouncement();
    } catch (err) {
      this.sendErrorResponse(
        response,
        1003,
        `Pure Xtension: failed to connect to the target's debugger (${String(err)}). Is "${path.basename(outBinary)}" a real -d debug build?`,
      );
      // SIGTERM (the default) is confirmed ineffective against a running
      // -d target (PLAN.md M5: live-tested, the process just ignores it) —
      // SIGKILL is the only signal verified to actually terminate it.
      this.child.kill("SIGKILL");
      this.pb.close();
      this.cleanupTempDirs();
      return;
    }

    // setBreakPointsRequest may already have run (and recorded into
    // activeBreakpoints) while the compile/connect above was in flight —
    // push that state to the wire now that it's actually safe to.
    this.pbConnected = true;
    this.flushBreakpointsToWire();

    this.sendResponse(response);
    responseSent = true;

    if (args.stopOnEntry) {
      // PB_DEBUGGER_Start's implicit startup wait happens before the target
      // has selected a source line, and it emits no stopped notification.
      // Advance under temporary all-line breakpoint coverage so the first
      // real executable statement supplies an exact line before we expose
      // the DAP entry stop. See discoverEntryLine().
      await this.configurationDone;
      const foundEntry = await this.discoverEntryLine();
      if (foundEntry) this.sendEvent(new StoppedEvent("entry", MAIN_THREAD_ID));
    } else {
      // Wait for configurationDone (fired once setBreakpoints has landed)
      // before releasing the target, so first-run breakpoints actually bind.
      await this.configurationDone;
      this.pb.continue();
    }
    } catch (err) {
      this.pb.close();
      this.child?.kill("SIGKILL");
      this.cleanupTempDirs();
      if (responseSent) {
        this.logError(err);
      } else {
        this.sendAsyncRequestError(response, "debug launch", err);
      }
    }
  }

  protected async setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments,
  ): Promise<void> {
    try {
    const lines = args.breakpoints?.map((b) => b.line) ?? args.lines ?? [];

    // This adapter only ever compiles/debugs one module (args.program from
    // launchRequest) — there's no confirmed moduleId scoping for the wire
    // protocol's breakpoint opcode (PLAN.md M5), so clearAllLineBreakpoints()
    // is target-wide. VS Code sends one setBreakpoints call per file with
    // breakpoints; without this guard, setting a breakpoint in an unrelated
    // open file would wipe (and never restore) the real session's
    // breakpoints in the file actually being debugged.
    if (args.source.path && args.source.path !== this.sourcePath) {
      response.body = { breakpoints: lines.map((line) => new Breakpoint(false, line)) };
      this.sendResponse(response);
      return;
    }

    this.activeBreakpoints.clear();
    for (const line of lines) this.activeBreakpoints.add(line);
    // Before the target is connected (still compiling, in launchRequest),
    // there's no wire to write to yet — activeBreakpoints above is the
    // record launchRequest replays via flushBreakpointsToWire() once
    // connected. Writing here regardless would throw on the not-yet-open
    // FIFO stream.
    if (this.pbConnected) this.flushBreakpointsToWire();
    response.body = {
      breakpoints: lines.map((line) => new Breakpoint(true, line)),
    };
    this.sendResponse(response);
    } catch (err) {
      this.sendAsyncRequestError(response, "setting breakpoints", err);
    }
  }

  /** Replays active user breakpoints and any entry-discovery coverage onto the wire. Only safe once `pbConnected` is true. */
  private flushBreakpointsToWire(): void {
    this.pb.clearAllLineBreakpoints();
    for (const line of this.activeBreakpoints) this.pb.addLineBreakpoint(line - 1);
    if (this.entryDiscoveryInProgress) {
      // A breakpoint edit clears target-wide state, so restore the temporary
      // coverage that stopOnEntry uses to find the first executable line.
      this.entryTempLines.clear();
      for (let line = 1; line <= this.totalLines; line++) {
        if (!this.activeBreakpoints.has(line)) {
          this.pb.addLineBreakpoint(line - 1);
          this.entryTempLines.add(line);
        }
      }
    }
  }

  /**
   * Resolves PureBasic's real entry line without trying to parse source text.
   * The debugger runtime initially waits inside PB_DEBUGGER_Start, before any
   * source line is current and without sending a stopped message. Breakpoint
   * opcode 3 accepts every requested source line and snaps non-executable
   * lines to real statements, so covering the whole compiled module and
   * continuing once stops at the first statement before it executes. The
   * normal stopped listener records that exact line in lastStopLine while
   * entryDiscoveryInProgress suppresses its internal breakpoint event.
   */
  private async discoverEntryLine(): Promise<boolean> {
    this.entryDiscoveryInProgress = true;
    try {
      this.entryTempLines.clear();
      for (let line = 1; line <= this.totalLines; line++) {
        if (!this.activeBreakpoints.has(line)) {
          this.pb.addLineBreakpoint(line - 1);
          this.entryTempLines.add(line);
        }
      }
      return (await this.continueUntilStopOrClose()) === "stopped";
    } finally {
      // A breakpoint edit during this internal run can promote a temporary
      // line to a real breakpoint, so activeBreakpoints remains authoritative.
      for (const line of this.entryTempLines) {
        if (!this.activeBreakpoints.has(line)) this.pb.removeLineBreakpoint(line - 1);
      }
      this.entryTempLines.clear();
      this.entryDiscoveryInProgress = false;
    }
  }

  /** Continue once, resolving on either the next stop or any session-ending
   * event. Listeners are installed first so even an immediate stop is safe. */
  private continueUntilStopOrClose(): Promise<"stopped" | "closed"> {
    return new Promise((resolve) => {
      const cleanup = () => {
        this.pb.off("stopped", onStopped);
        this.pb.off("terminated", onClosed);
        this.pb.off("close", onClosed);
        this.pb.off("error", onClosed);
      };
      const onStopped = () => {
        cleanup();
        resolve("stopped");
      };
      const onClosed = () => {
        cleanup();
        resolve("closed");
      };
      this.pb.once("stopped", onStopped);
      this.pb.once("terminated", onClosed);
      this.pb.once("close", onClosed);
      this.pb.once("error", onClosed);
      this.pb.continue();
    });
  }

  protected continueRequest(
    response: DebugProtocol.ContinueResponse,
    _args: DebugProtocol.ContinueArguments,
  ): void {
    // A client should not normally continue while a native step is pending.
    // Do not turn that into a second competing execution-control command.
    if (this.stepInProgress) {
      this.sendResponse(response);
      return;
    }
    this.pb.continue();
    this.sendResponse(response);
  }

  protected pauseRequest(response: DebugProtocol.PauseResponse, _args: DebugProtocol.PauseArguments): void {
    try {
      this.pb.pause();
      this.sendResponse(response);
    } catch (err) {
      this.sendAsyncRequestError(response, "pausing execution", err);
    }
  }

  protected nextRequest(response: DebugProtocol.NextResponse, _args: DebugProtocol.NextArguments): void {
    this.sendNativeStep(response, "over");
  }

  protected stepInRequest(response: DebugProtocol.StepInResponse, _args: DebugProtocol.StepInArguments): void {
    this.sendNativeStep(response, "in");
  }

  protected stepOutRequest(response: DebugProtocol.StepOutResponse, _args: DebugProtocol.StepOutArguments): void {
    this.sendNativeStep(response, "out");
  }

  /**
   * Dispatches a native opcode-1 PureBasic step. The target emits a normal
   * MSG_STOPPED (reason 8) when the operation completes; the persistent
   * listener above turns it into the DAP `step` stop event. No temporary line
   * breakpoints or stack-depth reconstruction are involved, so step-in can
   * genuinely enter a called procedure.
   */
  private sendNativeStep(response: DebugProtocol.Response, mode: "in" | "over" | "out"): void {
    if (this.stepInProgress) {
      this.sendResponse(response);
      return;
    }
    this.stepInProgress = true;
    try {
      if (mode === "in") this.pb.stepInto();
      else if (mode === "over") this.pb.stepOver();
      else this.pb.stepOut();
      this.sendResponse(response);
    } catch (err) {
      this.stepInProgress = false;
      this.sendAsyncRequestError(response, "stepping execution", err);
    }
  }

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    response.body = { threads: [new Thread(MAIN_THREAD_ID, "main")] };
    this.sendResponse(response);
  }

  protected async stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    _args: DebugProtocol.StackTraceArguments,
  ): Promise<void> {
    try {
    const pbFrames = await this.pb.stackTrace(); // opcode 16: procedure frames only, outermost-first
    this.frameHandles.clear();
    const source = new Source(path.basename(this.sourcePath), this.sourcePath);
    const procInnermostFirst = [...pbFrames].reverse();
    const frames: StackFrame[] = [];
    let id = 0;
    // Per-frame current line: the innermost procedure is at the actual stop
    // line; each outer frame is at the call site *inside* it that invoked the
    // next-inner frame — which opcode 16 reports as that inner frame's
    // callSiteLine0 (its return address in the caller), not the inner frame's
    // own line. The old code used each frame's own callSiteLine0 as its line,
    // which put the arrow on the caller's call site instead of the frame's
    // current line, and dropped the stop line entirely.
    let line = this.lastStopLine || 1;
    for (let j = 0; j < procInnermostFirst.length; j++) {
      const frame = procInnermostFirst[j];
      const pbIndex = pbFrames.length - 1 - j; // opcode-17 frame index (0 = outermost)
      this.frameHandles.set(id, { kind: "proc", pbIndex });
      frames.push(new StackFrame(id, frame.display, source, line));
      id++;
      line = frame.callSiteLine0 + 1;
    }
    // Synthetic module/main frame beneath every procedure frame — the only
    // frame when stopped at module scope (opcode 16 empty), and the missing
    // bottom of the stack when stopped inside a procedure (opcode 16 never
    // includes it). Its locals come from opcode 9 + evaluate (see variablesRequest).
    this.frameHandles.set(id, { kind: "main" });
    frames.push(new StackFrame(id, `${path.basename(this.sourcePath)} (main)`, source, line));

    response.body = { stackFrames: frames, totalFrames: frames.length };
    this.sendResponse(response);
    } catch (err) {
      this.sendAsyncRequestError(response, "reading the stack trace", err);
    }
  }

  protected scopesRequest(
    response: DebugProtocol.ScopesResponse,
    args: DebugProtocol.ScopesArguments,
  ): void {
    // variablesReference encodes frameId (the synthetic DAP-order id
    // stackTraceRequest assigned — 0 = innermost, resolved back to a real
    // frame via frameHandles), offset by 1 so 0 stays reserved for "no
    // children".
    response.body = { scopes: [new Scope("Locals", args.frameId + 1, false)] };
    this.sendResponse(response);
  }

  /** Registers a compound-value handle and returns the variablesReference for it. */
  private registerCompound(handle: CompoundHandle): number {
    const ref = this.nextCompoundRef++;
    this.compoundHandles.set(ref, handle);
    return ref;
  }

  /** Converts a scalar-stream record into a DAP Variable, giving structure children their own expandable reference. */
  private toDapVariable(v: PbVariable): Variable {
    if (v.children) {
      return new Variable(v.name, "{...}", this.registerCompound({ kind: "struct", children: v.children }));
    }
    return new Variable(v.name, v.value ?? "");
  }

  protected async variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments,
  ): Promise<void> {
    try {
    const ref = args.variablesReference;

    if (ref >= COMPOUND_REF_BASE) {
      const handle = this.compoundHandles.get(ref);
      if (!handle) {
        response.body = { variables: [] };
        this.sendResponse(response);
        return;
      }
      if (handle.kind === "struct") {
        response.body = { variables: handle.children.map((v) => this.toDapVariable(v)) };
        this.sendResponse(response);
        return;
      }
      // Array/list/map: opcode 15 fetches element data lazily, only once
      // this specific container is actually expanded.
      const result = await this.pb.examineExpression(handle.expression);
      let variables: Variable[];
      if (result.kind === "array" || result.kind === "list") {
        variables = result.elements.map((e) => new Variable(`[${e.index}]`, e.value));
      } else if (result.kind === "map") {
        variables = result.elements.map((e) => new Variable(e.key, e.value));
      } else if (result.kind === "unsupported") {
        // Confirmed live only for List<String> so far (PLAN.md M5): the
        // target's own SendListData mistags string elements' type and never
        // puts the text on the wire (see parseListElements in pbSession.ts
        // for the full root-cause trail) — this is a target-engine bug, not
        // an undecoded format, and there's no way to recover every
        // element's text from this opcode. The Expression evaluator (opcode
        // 33) doesn't have that bug and can read the list's *current*
        // element, so that's surfaced here as a labeled best-effort
        // fallback instead of leaving this dead-ended.
        variables = [new Variable("<unsupported>", `per-element text not available (target debugger bug, ${result.raw.length} raw bytes)`)];
        const current = await this.pb.evaluate(handle.expression);
        if (current.kind === 4 && current.value !== undefined) {
          variables.push(new Variable("<current element>", current.value));
        }
      } else {
        variables = [new Variable("<error>", result.message)];
      }
      response.body = { variables };
      this.sendResponse(response);
      return;
    }

    const frameId = ref - 1;
    const handle = this.frameHandles.get(frameId);
    // Arrays/lists/maps (opcodes 12-14) only have a confirmed way to target
    // the current/topmost frame (PLAN.md M5) — there's no opcode-17-style
    // explicit frame index for them, so they attach only to the innermost
    // (topmost) DAP frame, which is frameId 0 whether that's a procedure or,
    // at a module-scope stop, the synthetic main frame.
    const isInnermost = frameId === 0;

    // Enumerate containers only for the innermost frame — the only frame they
    // can be rendered on (opcodes 12-14 target the current/topmost frame) and
    // the only place their names are needed to filter the main frame's scalar
    // list (evaluating a bare array/list/map name is rejected by the target's
    // evaluator). Best-effort — a scalars-only view is still useful if
    // enumeration fails. (Expanding an *outer* main frame while stopped inside
    // a procedure therefore skips this; a module-level container would then
    // show as an evaluate error row rather than being filtered out — a rare
    // edge not worth three extra wire round-trips on every such expansion.)
    let arrays: Awaited<ReturnType<PbDebugSession["examineArrays"]>> = [];
    let lists: Awaited<ReturnType<PbDebugSession["examineLists"]>> = [];
    let maps: Awaited<ReturnType<PbDebugSession["examineMaps"]>> = [];
    if (isInnermost) {
      try {
        [arrays, lists, maps] = await Promise.all([
          this.pb.examineArrays(),
          this.pb.examineLists(),
          this.pb.examineMaps(),
        ]);
      } catch (err) {
        this.logError(err);
      }
    }

    let variables: Variable[];
    if (handle?.kind === "proc") {
      variables = (await this.pb.examineFrame(handle.pbIndex)).map((v) => this.toDapVariable(v));
    } else {
      // Main/module scope (also the fallback for an unknown/stale ref). Opcode
      // 9 lists the names; each scalar's value is read via evaluate (opcode
      // 33), which — unlike opcode 11/16 — returns module-scope values from any
      // stop context. Container names are excluded here and rendered below.
      const containerNames = new Set<string>([
        ...arrays.map((a) => a.name),
        ...lists.map((l) => l.name),
        ...maps.map((m) => m.name),
      ]);
      variables = [];
      const decls = await this.pb.examineModuleScope();
      for (const d of decls) {
        if (containerNames.has(d.name)) continue;
        if (d.children) {
          const expression = d.name.split(".", 1)[0];
          const children: PbVariable[] = [];
          for (const field of d.children) {
            const result = await this.pb.evaluate(`${expression}\\${field.name}`);
            children.push({
              type: field.type,
              kind: field.kind,
              name: field.name,
              value: result.value ?? result.error ?? "<unavailable>",
            });
          }
          variables.push(
            new Variable(d.name, "{...}", this.registerCompound({ kind: "struct", children })),
          );
          continue;
        }
        // evaluate() always runs against the currently-stopped line
        // (frameContext -1, the only mode PLAN.md's spike live-tested — see
        // evaluateRequest's doc comment) rather than a mode scoped to this
        // synthetic main frame specifically. Stopped deep inside a
        // procedure whose local shadows a same-named Global, this resolves
        // to the local, not the global — a known display-correctness gap,
        // not fixable without a confirmed frame-scoped evaluate mode.
        const result = await this.pb.evaluate(d.name);
        // result.value is set for kinds 1-4 (numeric/string); every other
        // kind (0 = error, 5 = structure/unsupported) carries its message in
        // result.error instead, so check value's presence rather than kind
        // to avoid silently rendering a blank row for kind 5.
        variables.push(new Variable(d.name, result.value ?? result.error ?? "<unavailable>"));
      }
    }

    if (isInnermost) {
      for (const a of arrays) {
        variables.push(new Variable(a.name, "Array", this.registerCompound({ kind: "array", expression: `${a.name}()` })));
      }
      for (const l of lists) {
        variables.push(
          new Variable(l.name, `LinkedList[${l.count}]`, this.registerCompound({ kind: "list", expression: `${l.name}()` })),
        );
      }
      for (const m of maps) {
        variables.push(
          new Variable(m.name, `Map[${m.size}]`, this.registerCompound({ kind: "map", expression: `${m.name}()` })),
        );
      }
    }

    response.body = { variables };
    this.sendResponse(response);
    } catch (err) {
      this.sendAsyncRequestError(response, "reading variables", err);
    }
  }

  protected async evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments,
  ): Promise<void> {
    try {
    // frameId isn't threaded through here yet — every evaluate runs against
    // the currently-stopped line (frameContext -1), the only case PLAN.md's
    // M5 spike live-tested. Evaluating in an outer frame's context is an
    // open question, not a confirmed capability, so it's not wired up as
    // if it were.
    const result = await this.pb.evaluate(args.expression);
    if (result.kind === 0) {
      this.sendErrorResponse(response, 1004, result.error ?? "evaluate failed");
      return;
    }
    response.body = { result: result.value ?? "", variablesReference: 0 };
    this.sendResponse(response);
    } catch (err) {
      this.sendAsyncRequestError(response, "evaluating the expression", err);
    }
  }

  protected async setVariableRequest(
    response: DebugProtocol.SetVariableResponse,
    args: DebugProtocol.SetVariableArguments,
  ): Promise<void> {
    try {
    // Same frame-context caveat as evaluateRequest: only the currently-
    // stopped line's scope is wired up, since that's the only case PLAN.md's
    // M5 spike live-tested for opcode 35.
    const result = await this.pb.setVariable(args.name, args.value);
    if (result.kind === 0) {
      this.sendErrorResponse(response, 1005, result.error ?? "setVariable failed");
      return;
    }
    response.body = { value: result.value ?? "" };
    this.sendResponse(response);
    } catch (err) {
      this.sendAsyncRequestError(response, "setting the variable", err);
    }
  }

  protected disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    _args: DebugProtocol.DisconnectArguments,
  ): void {
    // No clean-disconnect opcode exists (PLAN.md M5: confirmed by decoding
    // ExternalDebugger_CommunicationsThread's read-error path — any FIFO
    // read failure other than EAGAIN unconditionally calls exit(1) in the
    // target itself, with no flag to suppress it or opcode to gate it;
    // Control opcode 0, the only candidate, was live-tested and doesn't
    // change this). So closing the FIFOs is the actual termination
    // mechanism here, not just cleanup — it reliably fires even while the
    // target's main thread is stuck in a tight loop, since the comms
    // thread's blocked fread() is what hits the fatal path. The
    // child.kill() below is a fallback for the case the FIFO close didn't
    // land (e.g. target never got that far); it must be SIGKILL — SIGTERM
    // (Node's default) is confirmed ineffective against a running -d
    // target, live-tested (the process just ignores it and keeps running).
    this.pb.close();
    this.child?.kill("SIGKILL");
    this.cleanupTempDirs();
    this.sendResponse(response);
  }
}
