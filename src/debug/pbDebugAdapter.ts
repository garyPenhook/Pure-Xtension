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
 * Launch, line breakpoints, continue, stepping (emulated — see step()),
 * stack trace, locals (including array/list/map/structure expansion), and
 * evaluate/setVariable — the surface PLAN.md's M5 spike confirmed live
 * against the wire protocol, plus step()'s breakpoint-driven emulation for
 * the one piece (single-instruction stepping) the protocol itself doesn't
 * expose.
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
  /** The real (user-set) line breakpoints currently active on the wire, mirrored here so step() can restore them after removing its temporary ones. */
  private activeBreakpoints = new Set<number>();
  /** True while step() owns the run/stop cycle — the persistent "stopped" listener must stay silent (no StoppedEvent) until step() itself decides it's done. */
  private stepInProgress = false;
  /**
   * Lines step() has temporarily breakpointed beyond `activeBreakpoints`,
   * live on the wire only while `stepInProgress` is true. Instance-level
   * (not local to step()) so setBreakPointsRequest — which VS Code can send
   * while the target is running, e.g. the user toggling a breakpoint mid-step
   * — can detect an in-flight step and re-establish full line coverage after
   * its own clearAllLineBreakpoints() wipes these out, instead of silently
   * leaving the step under-covered until it happens to land on a real
   * breakpoint or the program ends.
   */
  private stepTempLines = new Set<number>();
  /** Source line count at the moment the debug build was compiled, cached once so step()'s coverage matches the binary actually running even if the file is edited (but not recompiled) mid-session. */
  private totalLines = 0;

  constructor() {
    super();
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
    this.configurationDone = new Promise((resolve) => {
      this.resolveConfigurationDone = resolve;
    });
    this.pb.on("stopped", ({ line, reason }: { line: number; reason: number }) => {
      // Capture the stop line before the stepInProgress early-return below, so
      // it stays current through step()'s internal run/stop loop too — by the
      // time step() sends its own StoppedEvent, this holds the final line.
      this.lastStopLine = line;
      this.compoundHandles.clear();
      this.frameHandles.clear();
      this.nextCompoundRef = COMPOUND_REF_BASE;
      // While step() is driving its own run/stop loop (via the temporary
      // all-line breakpoints below), every intermediate stop is internal
      // bookkeeping, not a real user-visible stop — step() sends the one
      // StoppedEvent that actually matters once it's done deciding.
      if (this.stepInProgress) return;
      this.sendEvent(new StoppedEvent(reason === 7 ? "breakpoint" : "pause", MAIN_THREAD_ID));
    });
    this.pb.on("close", () => this.notifyTerminated());
    this.pb.on("error", (err) => this.logError(err));
  }

  private logError(err: unknown): void {
    this.sendEvent(new OutputEvent(`Pure Xtension debugger: ${String(err)}\n`, "stderr"));
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
    // The wire protocol has no dedicated step opcode (PLAN.md M5: all
    // Control sub-command values live-tested and ruled out) — next/stepIn/
    // stepOut are emulated in step() via temporary all-line breakpoints
    // instead. Note stepIn can't actually descend into a call (see step()'s
    // doc comment: the wire runs a whole call-line atomically), so it degrades
    // to a line step. supportsStepInTargetsRequest is a separate, unimplemented
    // feature (picking which call on a line to step into).
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

    if (args.stopOnEntry) {
      // The target is already implicitly stopped-on-entry (PLAN.md M5:
      // PB_DEBUGGER_Start blocks until a continue clears its stop flag) —
      // no extra command needed to "arrive" at entry.
      this.sendEvent(new StoppedEvent("entry", MAIN_THREAD_ID));
    } else {
      // Wait for configurationDone (fired once setBreakpoints has landed)
      // before releasing the target, so first-run breakpoints actually bind.
      await this.configurationDone;
      this.pb.continue();
    }
  }

  protected async setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments,
  ): Promise<void> {
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
  }

  /** Replays `activeBreakpoints` (and, if a step is mid-flight, its temporary full-line coverage) onto the wire. Only safe to call once `pbConnected` is true. */
  private flushBreakpointsToWire(): void {
    this.pb.clearAllLineBreakpoints();
    for (const line of this.activeBreakpoints) this.pb.addLineBreakpoint(line);
    if (this.stepInProgress) {
      // The clearAllLineBreakpoints() above just wiped step()'s full-line
      // temporary coverage too (it's target-wide, not scoped to "real"
      // breakpoints) — re-lay it now so the in-flight step still stops at
      // the very next line instead of silently running past it to wherever
      // the next *real* breakpoint (or program end) happens to be.
      this.stepTempLines.clear();
      for (let line = 1; line <= this.totalLines; line++) {
        if (!this.activeBreakpoints.has(line)) {
          this.pb.addLineBreakpoint(line);
          this.stepTempLines.add(line);
        }
      }
    }
  }

  protected continueRequest(
    response: DebugProtocol.ContinueResponse,
    _args: DebugProtocol.ContinueArguments,
  ): void {
    // A compliant DAP client (VS Code) won't normally send this while a
    // next/stepIn/stepOut is still in flight, but if it did, an extra
    // continue() here would race step()'s own continue()/await-stop cycle
    // against the target's actual run state — just no-op instead.
    if (this.stepInProgress) {
      this.sendResponse(response);
      return;
    }
    this.pb.continue();
    this.sendResponse(response);
  }

  protected nextRequest(response: DebugProtocol.NextResponse, _args: DebugProtocol.NextArguments): void {
    this.sendResponse(response);
    void this.step("over");
  }

  protected stepInRequest(response: DebugProtocol.StepInResponse, _args: DebugProtocol.StepInArguments): void {
    this.sendResponse(response);
    void this.step("in");
  }

  protected stepOutRequest(response: DebugProtocol.StepOutResponse, _args: DebugProtocol.StepOutArguments): void {
    this.sendResponse(response);
    void this.step("out");
  }

  /**
   * Emulates stepping over the wire protocol's confirmed absence of a step
   * opcode (PLAN.md M5): temporarily breakpoints every line of the single
   * module this adapter debugs (in addition to the user's real breakpoints,
   * which are left alone throughout), then continues. Because
   * `GetExecutableLine` snaps each requested line to the nearest real
   * statement (PLAN.md M5's opcode-3 decode notes), lines with no statement
   * of their own are harmless no-ops — the target stops at the very next line
   * that actually executes *within the current continue*.
   *
   * Important protocol limitation, confirmed live end-to-end (PLAN.md M6):
   * continuing from a stop runs the *entire current source line to completion*
   * — including any procedure it calls — before honoring breakpoints again, so
   * a breakpoint on a callee's body never fires on the continue that enters it
   * from the call site. That makes true **step-into impossible** here: "in"
   * therefore behaves as a line step (identical to "over" at a call site —
   * it advances past the call rather than descending into it). Stepping *within*
   * a procedure and *out* of one both work, since those stops aren't on a
   * call-site's own line.
   *
   * "over"/"out" compare stack depth (procedure-frame count from opcode 16,
   * which excludes the synthesized main frame — so main scope is depth 0)
   * against the depth when step() began, auto-continuing through any stop still
   * deeper than that baseline instead of surfacing it. "out" additionally
   * requires a strictly shallower depth, so it runs until the current procedure
   * returns.
   */
  private async step(mode: "in" | "over" | "out"): Promise<void> {
    if (this.stepInProgress) return;
    this.stepInProgress = true;
    try {
      const startDepth = (await this.pb.stackTrace()).length;

      this.stepTempLines.clear();
      for (let line = 1; line <= this.totalLines; line++) {
        if (!this.activeBreakpoints.has(line)) {
          this.pb.addLineBreakpoint(line);
          this.stepTempLines.add(line);
        }
      }

      for (;;) {
        // Races the next real stop against the connection dying mid-step
        // (target crash, FIFO read error, or the user hitting Stop) — the
        // wire protocol only ever emits "stopped", never a dedicated
        // give-up signal, so without this a step that never reaches another
        // executable line (target killed, connection dropped) would leave
        // this promise — and stepInProgress — pending forever. Listeners
        // must be attached before continue() fires, not after; each side
        // explicitly detaches the other so a long step-over/out (many
        // iterations of this loop) doesn't accumulate dangling `once`
        // listeners on `this.pb` and eventually hit Node's max-listeners
        // warning.
        const outcome = await new Promise<"stopped" | "closed">((resolve) => {
          const cleanup = () => {
            this.pb.off("stopped", onStopped);
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
          this.pb.once("close", onClosed);
          this.pb.once("error", onClosed);
          this.pb.continue();
        });
        if (outcome === "closed") return;
        if (mode === "in") break;
        const depth = (await this.pb.stackTrace()).length;
        if (mode === "over" && depth <= startDepth) break;
        if (mode === "out" && depth < startDepth) break;
      }
    } finally {
      // Only remove lines that are still ours: setBreakPointsRequest may
      // have re-laid this exact set (see its stepInProgress branch above)
      // after a concurrent edit, or promoted one of them into a real
      // breakpoint — either way activeBreakpoints is the source of truth
      // for what should survive.
      for (const line of this.stepTempLines) {
        if (!this.activeBreakpoints.has(line)) this.pb.removeLineBreakpoint(line);
      }
      this.stepTempLines.clear();
      this.stepInProgress = false;
    }
    this.sendEvent(new StoppedEvent("step", MAIN_THREAD_ID));
  }

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    response.body = { threads: [new Thread(MAIN_THREAD_ID, "main")] };
    this.sendResponse(response);
  }

  protected async stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    _args: DebugProtocol.StackTraceArguments,
  ): Promise<void> {
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
  }

  protected async evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments,
  ): Promise<void> {
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
  }

  protected async setVariableRequest(
    response: DebugProtocol.SetVariableResponse,
    args: DebugProtocol.SetVariableArguments,
  ): Promise<void> {
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
