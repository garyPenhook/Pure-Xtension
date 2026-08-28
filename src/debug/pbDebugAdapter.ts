import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  Breakpoint,
  BreakpointEvent,
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
import {
  allocateFreeTcpPort,
  compileAsync,
  DBP_COULD_NOT_ADD,
  DBP_EVAL_ERROR,
  DBP_TRUE,
  DEFAULT_COMPILE_TIMEOUT_MS,
  parseCompilerVersionBanner,
  PbDataBreakpointEvent,
  PbDebugSession,
  PbEvaluateResult,
  PbMessage,
  PbSourceFile,
  PbVariable,
  parseIncludedSources,
  shouldRefuseUnvalidatedPlatformLaunch,
  STOP_REASON_DATA_BREAKPOINT,
  STRING_TYPE_TAG,
  unstickFifoRendezvous,
} from "./pbSession";
import { GdbMiPtraceEngine, gdbEngineAvailable } from "./ptraceEngine";

const MAIN_THREAD_ID = 1;
/** Bounded wait for the cooperative wire pause (opcode 0) before falling back
 * to a GDB attach (see armForcePauseFallback()). The launch/dispose and
 * attach/detach regression tests in test/ptraceEngine.test.ts complete in
 * ~200-280ms with no compile step involved, so this has real headroom over
 * ordinary latency; test/pbDebugAdapter.e2e.test.ts's forced-pause case
 * confirms it in practice against a real blocked target. */
const FORCE_PAUSE_FALLBACK_MS = 750;
// variablesReference values for compound (structure/array/list/map)
// children live in a disjoint range above the small 1..N frame-scope refs
// scopesRequest hands out (N = frame count, always small), so the two
// numbering schemes can share one field without collision.
const COMPOUND_REF_BASE = 100000;

type CompoundHandle =
  | { kind: "struct"; children: PbVariable[]; expression: string }
  | { kind: "array" | "list" | "map"; expression: string };

/** A data breakpoint currently armed on the wire. `condition` is the exact
 *  PureBasic boolean expression last sent; for the default (non-`userCondition`)
 *  case it's re-synthesized on every hit (see rearmDataBreakpoint()) so
 *  "break on value change" keeps working after the first hit. */
interface ArmedDataBreakpoint {
  wireId: number;
  /** Both DAP's `dataId` and the wire expression's variable name -- v1 only
   *  supports bare top-level scalars, so the two are always identical. */
  name: string;
  /** Set when the client supplied a raw PB expression via `condition` — left
   *  untouched by rearmDataBreakpoint() rather than being overwritten with a
   *  synthesized value-changed check. */
  userCondition?: string;
  condition: string;
}

/** Formats an evaluate() result as a PureBasic literal usable in a
 *  `<> <literal>` comparison. `undefined` means "can't be watched" (error,
 *  or an unsupported/structure kind). Numeric kinds 1-3 are passed through
 *  as-is; PbEvaluateResult doesn't yet distinguish int from double there
 *  (see its doc comment), so a double being watched compares against its
 *  raw int64-reinterpreted bits, not its true value -- a known v1 gap in
 *  evaluate() itself, not something this feature attempts to fix. */
function formatDataBreakpointLiteral(result: PbEvaluateResult): string | undefined {
  if (result.value === undefined) return undefined;
  if (result.kind === 4) {
    // Plain PB string literals have no escape mechanism at all (confirmed:
    // `"He said ""hi"""` fails to compile, "Garbage at the end of the
    // line") -- the tilde-prefixed form (`~"...\"..."`) is required for a
    // value that may itself contain a quote or backslash.
    const escaped = result.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `~"${escaped}"`;
  }
  if (result.kind >= 1 && result.kind <= 3) return result.value;
  return undefined;
}

interface LaunchArgs extends DebugProtocol.LaunchRequestArguments {
  program: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stopOnEntry?: boolean;
  backend?: Backend;
  compilerArgs?: string[];
  /** Internal/test-only override of the automatic FIFO(non-Windows)/
   *  TCP(Windows) transport selection. Not declared in package.json's launch
   *  config schema and never documented user-facing -- it exists purely so
   *  the local e2e suite can exercise the TCP/NetworkServer path on Linux,
   *  since there's no Windows machine here to make process.platform pick it
   *  naturally. */
  transport?: "fifo" | "tcp";
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
  /** The debug-build compiler invocation in flight during launchRequest, if
   *  any -- tracked so disconnectRequest can kill it if the user stops the
   *  session while a (possibly stalled) compile is still running. */
  private compileChild?: cp.ChildProcess;
  private workDir?: string;
  private fifoDir?: string;
  private sourcePath = "";
  /** PureBasic's source-file ids (0 = launch file) keyed by normalized local
   * path.  The Init payload establishes these ids for IncludeFile sources. */
  private sourcesByPath = new Map<string, PbSourceFile>();
  private sourcesById = new Map<number, PbSourceFile>();
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
  /** True only while the target is stopped at a PureBasic statement boundary.
   * Data-breakpoint setup has to evaluate the current value before it can
   * synthesize the target-side change condition, so it is not meaningful
   * (and the target cannot service the request reliably) while executing. */
  private targetStopped = false;
  /** 1-based line the target last stopped at (StoppedEvent's `line`/`msg.f8`), used as the innermost/main frame's current line since opcode 16 never carries it. */
  private lastStopLine = 0;
  private lastStopModuleId = 0;
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
  private activeBreakpoints = new Map<string, Set<number>>();
  /** Armed data breakpoints, keyed by the wire's numeric id -- the only key
   *  ever looked up by (correlating a dataBreakpoint event/re-arming);
   *  setDataBreakpointsRequest always fully clears and rebuilds rather than
   *  diffing by DAP's `dataId`, so no second index is needed. */
  private dataBreakpointsByWireId = new Map<number, ArmedDataBreakpoint>();
  /** Client-assigned wire ids for data breakpoints. Monotonic and never
   *  reused -- see removeDataBreakpoint()'s doc comment for why an id must
   *  never be anything other than the exact value assigned here. */
  private nextDataBreakpointWireId = 1;
  /** Set by the "dataBreakpoint" listener on a DBP_TRUE status and consumed
   *  by the "stopped" listener's reason-9 branch -- MSG_STOPPED carries no
   *  id of its own, so this is how the two unsolicited events are
   *  correlated (PLAN.md M9.6/M9.7 confirm the TRUE status always precedes
   *  its matching stop). */
  private lastDataBreakpointHitWireId?: number;
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
  /**
   * GDB "Force Pause" fallback state (see armForcePauseFallback()/forcePause()).
   * Wire pause/breakpoints are cooperative -- they only take effect when the
   * target's main thread reaches PB_DEBUGGER_Check between statements, which
   * never happens for a target blocked in an unbounded native call (e.g.
   * WaitWindowEvent() with no timeout). GDB's ptrace attach can stop such a
   * target regardless of what it's doing, at the cost of landing outside the
   * wire's wait loop, where wire requests hang (live-confirmed,
   * src/debug/spike/spike3.mjs) -- so this state deliberately does not
   * attempt to bridge into full PB variable introspection; see
   * stackTraceRequest/variablesRequest below.
   */
  private forcePauseEngine?: GdbMiPtraceEngine;
  private forcePauseActive = false;
  /** GDB-read PC at the moment forcePause() attached, used only to label the synthetic frame stackTraceRequest returns while forcePauseActive. */
  private forcePauseNativeAddress = 0;
  /** True from pauseRequest until either a cooperative wire stop or the forced-pause fallback resolves. */
  private pausePending = false;
  /** Invalidates an in-flight forcePause() attempt/timer when superseded by a real event (a cooperative stop, a second pause, continue, disconnect). */
  private pauseGeneration = 0;
  private forcePauseTimer?: ReturnType<typeof setTimeout>;
  /** Memoizes gdbEngineAvailable() per session -- it synchronously spawns `gdb --version` (spawnSync), which would otherwise block the extension host's event loop on every single Pause click, not just once. */
  private gdbAvailableCache?: boolean;

  constructor() {
    super();
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
    this.configurationDone = new Promise((resolve) => {
      this.resolveConfigurationDone = resolve;
    });
    this.pb.on("stopped", async ({ moduleId, line, reason }: { moduleId: number; line: number; reason: number }) => {
      // A genuine cooperative wire stop always supersedes any in-flight
      // Force Pause attempt/timer -- it arrived, so the fallback (which
      // would only yield a degraded GDB-only stop) must not also fire.
      this.cancelForcePauseFallback();
      // The target protocol reports its compiled-line index (0-based); DAP
      // source lines are 1-based. Breakpoint requests use the same inverse
      // conversion at every add/remove call below.
      line += 1;
      // Capture the stop line before the state checks below so it is available
      // to the stack trace requested immediately after the stop event.
      this.lastStopLine = line;
      this.lastStopModuleId = moduleId;
      this.targetStopped = true;
      this.compoundHandles.clear();
      this.frameHandles.clear();
      this.nextCompoundRef = COMPOUND_REF_BASE;
      // Checked before stepInProgress: a step's own statement can equally
      // trip a separately-armed data breakpoint (the wire condition is
      // re-checked at every debug statement regardless of what caused it,
      // per PLAN.md M9.5), so a step-in-flight must not swallow reason 9 as
      // a plain step completion -- that would both skip the re-arm (leaving
      // the breakpoint stuck) and leave stepInProgress set, which silently
      // no-ops every future step request (see sendNativeStep's guard).
      if (reason === STOP_REASON_DATA_BREAKPOINT) {
        this.stepInProgress = false;
        const hitWireId = this.lastDataBreakpointHitWireId;
        this.lastDataBreakpointHitWireId = undefined;
        const armed = hitWireId !== undefined ? this.dataBreakpointsByWireId.get(hitWireId) : undefined;
        // armed can be missing if setDataBreakpointsRequest's clear/replace
        // raced an in-flight hit that the target had already sent before our
        // clear reached it (fire-and-forget wire writes, no ack ordering
        // guarantee against an already-in-transit stop). The target is
        // genuinely stopped either way, so still notify the client, just
        // without claiming a since-removed breakpoint caused it.
        if (armed) {
          // Re-arm before notifying the client, not lazily on the next
          // continue -- otherwise a client that continues immediately could
          // run past this breakpoint before it's reseeded with the new
          // value. A user-supplied raw condition (bp.condition) is left
          // as-is: it's not a value-changed check, so there's nothing to
          // reseed.
          if (!armed.userCondition) await this.rearmDataBreakpoint(armed);
          this.sendEvent(new StoppedEvent("data breakpoint", MAIN_THREAD_ID, `${armed.name} changed`));
        } else {
          this.sendEvent(new StoppedEvent("pause", MAIN_THREAD_ID));
        }
        return;
      }
      if (this.stepInProgress) {
        this.stepInProgress = false;
        this.sendEvent(new StoppedEvent("step", MAIN_THREAD_ID));
        return;
      }
      if (this.entryDiscoveryInProgress) return;
      this.sendEvent(new StoppedEvent(reason === 7 ? "breakpoint" : "pause", MAIN_THREAD_ID));
    });
    this.pb.on("dataBreakpoint", (evt: PbDataBreakpointEvent) => {
      const armed = this.dataBreakpointsByWireId.get(evt.id);
      if (evt.status === DBP_TRUE) {
        // MSG_STOPPED (reason 9) carries no id -- this is the only record of
        // which breakpoint fired, consumed by the "stopped" listener above.
        this.lastDataBreakpointHitWireId = evt.id;
        return;
      }
      if (evt.status === DBP_COULD_NOT_ADD || evt.status === DBP_EVAL_ERROR) {
        this.sendEvent(new OutputEvent(`Pure Xtension: data breakpoint on ${armed?.name ?? `id ${evt.id}`} failed to arm${evt.error ? `: ${evt.error}` : ""}.\n`, "stderr"));
        if (armed) {
          const dap = new Breakpoint(false);
          dap.setId(evt.id);
          // The Breakpoint class implements DebugProtocol.Breakpoint at
          // runtime (it's a plain object) but its .d.ts only declares
          // `verified`/`setId`, so `message` needs an explicit cast.
          (dap as DebugProtocol.Breakpoint).message = evt.error ?? "could not add data breakpoint";
          this.sendEvent(new BreakpointEvent("changed", dap));
        }
      }
      // DBP_ADDED / DBP_FALSE are the expected steady state -- nothing to surface.
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
    this.pbConnected = false;
    this.targetStopped = false;
    // A pending (not yet fired) Force Pause timer captured this.child's pid
    // by reading it fresh only when it fires, not at arm time -- without
    // this, a target that exits while the timer is still pending would leave
    // it to fire later against a dead (or, worse, OS-reused) pid.
    this.cancelForcePauseFallback();
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
    response.body.supportsDataBreakpoints = true;
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

  private canonicalSourcePath(file: string): string {
    return path.resolve(file);
  }

  /** Retains Init's source-root/include table before any breakpoint is sent.
   * The debugger's main source is not listed in that payload, so it is always
   * assigned id 0 from the launch configuration. */
  private setSourceFiles(init: PbMessage): void {
    const { sourceRoot, includedPaths } = parseIncludedSources(init.payload, init.f8);
    this.sourcesByPath.clear();
    this.sourcesById.clear();
    const add = (id: number, file: string) => {
      const source = { id, path: this.canonicalSourcePath(file) };
      this.sourcesByPath.set(source.path, source);
      this.sourcesById.set(id, source);
    };
    add(0, this.sourcePath);
    const root = sourceRoot ? this.canonicalSourcePath(sourceRoot) : path.dirname(this.sourcePath);
    includedPaths.forEach((included, index) => add(index + 1, path.isAbsolute(included) ? included : path.resolve(root, included)));
  }

  private sourceForId(moduleId: number): PbSourceFile {
    return this.sourcesById.get(moduleId) ?? { id: moduleId, path: this.sourcePath };
  }

  private sourceForPath(file: string | undefined): PbSourceFile | undefined {
    const canonical = file ? this.canonicalSourcePath(file) : this.sourcePath;
    // setBreakpoints may arrive while the target is still compiling, before
    // Init has supplied its include table. The launch file is already known
    // at that point and is always debugger source id 0.
    if (canonical === this.sourcePath) return this.sourcesById.get(0) ?? { id: 0, path: this.sourcePath };
    return this.sourcesByPath.get(canonical);
  }

  private sourceForFrame(moduleId: number): Source {
    const file = this.sourceForId(moduleId).path;
    return new Source(path.basename(file), file);
  }

  protected async launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: LaunchArgs,
  ): Promise<void> {
    let responseSent = false;
    try {
    this.sourcePath = this.canonicalSourcePath(args.program);
    // Linux is the only platform with a complete, real-machine debugger
    // validation pass. `transport` is deliberately an undocumented test hook
    // (used to exercise NetworkServer on Linux); it may opt out of this gate.
    if (shouldRefuseUnvalidatedPlatformLaunch(process.platform, args.transport)) {
      this.sendErrorResponse(
        response,
        1006,
        `Pure Xtension: debugging is currently enabled only on Linux; ${process.platform} has not been validated end-to-end yet (see README.md).`,
      );
      return;
    }

    const backend = args.backend ?? resolveBackendSilent() ?? "asm";
    const compiler = resolveCompilerPath(backend);
    if (!compiler) {
      this.sendErrorResponse(response, 1001, "Pure Xtension: no PureBasic compiler found for the selected backend.");
      return;
    }

    this.workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pure-xtension-debug-"));
    const outBinary = path.join(this.workDir, "target.bin");
    const compileArgs = ["-d", "-ds", "-l", "-o", outBinary, ...(args.compilerArgs ?? []), args.program];
    // H4: spawnSync used to block the entire extension host -- all UI, all
    // other requests -- for however long the compile took, with no timeout
    // and no way to cancel a stalled compiler. compileAsync() hands back the
    // child immediately so disconnectRequest can kill it if the user stops
    // the session mid-compile (see this.compileChild).
    const { child: compileChild, result: compileResultPromise } = compileAsync(compiler, compileArgs);
    this.compileChild = compileChild;
    const compileResult = await compileResultPromise;
    this.compileChild = undefined;
    if (compileResult.status !== 0) {
      this.sendEvent(new OutputEvent(compileResult.stdout, "stdout"));
      this.sendEvent(new OutputEvent(compileResult.stderr, "stderr"));
      this.sendErrorResponse(
        response,
        1002,
        compileResult.timedOut
          ? `Pure Xtension: compile (debug build) timed out after ${DEFAULT_COMPILE_TIMEOUT_MS / 1000}s and was killed — see debug console.`
          : "Pure Xtension: compile (debug build) failed — see debug console.",
      );
      this.cleanupTempDirs();
      return;
    }
    try {
      this.totalLines = fs.readFileSync(args.program, "utf8").split("\n").length;
    } catch (err) {
      this.logError(err);
    }

    // The transport override is internal-only. Only an explicit "fifo" opts
    // out of TCP; any other value falls back to FIFO.
    const useTcp = args.transport === "fifo" ? false : args.transport === "tcp";

    let transportEnv: Record<string, string>;
    let doConnect: () => Promise<PbMessage>;
    let fifoPaths: { outFifo: string; inFifo: string } | undefined;

    if (useTcp) {
      // PureBasic's TCP handshake requires the compiler's own numeric
      // version (PLAN.md M10.1) -- parsed from the version banner every
      // compiler invocation already prints as its first stdout line, so no
      // extra invocation is needed. Never guess a version: a wrong one
      // produces a confusing target-side ERROR ... WrongVersion instead of
      // this clear, adapter-side explanation.
      const version = parseCompilerVersionBanner(compileResult.stdout);
      if (version === undefined) {
        this.sendErrorResponse(
          response,
          1007,
          "Pure Xtension: could not determine the PureBasic compiler's version from its own build output; cannot perform the TCP debugger handshake.",
        );
        this.cleanupTempDirs();
        return;
      }
      let port: number;
      try {
        port = await allocateFreeTcpPort();
      } catch (err) {
        this.sendErrorResponse(response, 1008, `Pure Xtension: could not allocate a free TCP port for the debugger connection (${String(err)}).`);
        this.cleanupTempDirs();
        return;
      }
      transportEnv = { PB_DEBUGGER_Communication: `NetworkServer;${port}` };
      doConnect = () => this.pb.connectTcp(port, version);
    } else {
      this.fifoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pure-xtension-fifo-"));
      const outFifo = path.join(this.fifoDir, "pb_out");
      const inFifo = path.join(this.fifoDir, "pb_in");
      cp.execFileSync("mkfifo", [outFifo, inFifo]);
      transportEnv = { PB_DEBUGGER_Communication: `FifoFiles;${outFifo};${inFifo}` };
      doConnect = () => this.pb.connect(outFifo, inFifo);
      fifoPaths = { outFifo, inFifo };
    }

    this.child = cp.spawn(outBinary, args.args ?? [], {
      cwd: args.cwd ?? path.dirname(args.program),
      env: {
        ...process.env,
        ...args.env,
        ...transportEnv,
      },
    });
    // Node never throws synchronously for a bad cwd, missing executable, or
    // permission failure here -- spawn() reports those asynchronously via
    // this 'error' event instead. An EventEmitter with no 'error' listener
    // re-throws on emit, which would otherwise surface as an unhandled
    // exception (it fires after spawn() has already returned, so outside
    // this function's try/catch) and could take down the whole extension
    // host. This permanent listener covers the entire session lifetime, not
    // just the launch race below -- e.g. a broken-pipe write error long
    // after a successful launch must not crash the extension host either.
    this.child.on("error", (err) => this.logError(err));
    // Racing the same event against doConnect() below turns what would
    // otherwise be a several-second wait for a generic connect timeout into
    // an immediate, specific spawn error, just during this launch window.
    let spawnError: Error | undefined;
    const spawnFailure = new Promise<never>((_resolve, reject) => {
      this.child?.once("error", (err) => {
        spawnError = err;
        reject(err);
      });
    });
    this.child.stdout?.on("data", (d) => this.sendEvent(new OutputEvent(d.toString(), "stdout")));
    this.child.stderr?.on("data", (d) => this.sendEvent(new OutputEvent(d.toString(), "stderr")));
    this.child.on("exit", (code) => {
      this.sendEvent(new OutputEvent(`target exited (${code})\n`));
      this.notifyTerminated();
    });

    try {
      await Promise.race([
        (async () => {
          const init = await doConnect();
          this.setSourceFiles(init);
          await this.pb.drainStartupAnnouncement();
          await this.pb.getModules();
        })(),
        spawnFailure,
      ]);
    } catch (err) {
      this.sendErrorResponse(
        response,
        1003,
        spawnError
          ? `Pure Xtension: failed to start the target process (${spawnError.message}). Check that "${path.basename(outBinary)}" exists, is executable, and the working directory is valid.`
          : `Pure Xtension: failed to connect to the target's debugger (${String(err)}). Is "${path.basename(outBinary)}" a real -d debug build?`,
      );
      // SIGTERM (the default) is confirmed ineffective against a running
      // -d target (PLAN.md M5: live-tested, the process just ignores it) —
      // SIGKILL is the only signal verified to actually terminate it. Safe
      // to call even when spawn() itself failed (no pid): kill() is then a
      // harmless no-op rather than a throw.
      this.child.kill("SIGKILL");
      this.pb.close();
      // doConnect() above already started (and, on this failure path, will
      // never finish) fs.createReadStream(outFifo)/createWriteStream(inFifo)'s
      // blocking opens -- pb.close()'s destroy()/end() only defers cleanup
      // until those opens eventually complete, which never happens on their
      // own once the target never started. See unstickFifoRendezvous's doc
      // comment for why this is needed and how it's safe.
      if (fifoPaths) unstickFifoRendezvous(fifoPaths.outFifo, fifoPaths.inFifo);
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

    const source = this.sourceForPath(args.source.path);
    // The line-breakpoint list is target-wide, but each packed breakpoint
    // carries the Init-assigned source-file id.  Reject only files not part
    // of this compiled include graph; replacing breakpoints in one included
    // file must preserve every other source's set.
    if (!source && this.pbConnected) {
      response.body = { breakpoints: lines.map((line) => new Breakpoint(false, line)) };
      this.sendResponse(response);
      return;
    }

    // Configuration requests normally arrive before the target's Init
    // message. Keep a prospective include-file set by canonical path until
    // Init supplies the authoritative id table; flushBreakpointsToWire()
    // will then replay it if it is genuinely part of this compilation.
    const sourcePath = source?.path ?? this.canonicalSourcePath(args.source.path!);
    this.activeBreakpoints.set(sourcePath, new Set(lines));
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
    for (const [sourcePath, lines] of this.activeBreakpoints) {
      const source = this.sourcesByPath.get(sourcePath);
      if (!source) continue;
      for (const line of lines) this.pb.addLineBreakpoint(line - 1, source.id);
    }
    if (this.entryDiscoveryInProgress) {
      // A breakpoint edit clears target-wide state, so restore the temporary
      // coverage that stopOnEntry uses to find the first executable line.
      this.entryTempLines.clear();
      for (let line = 1; line <= this.totalLines; line++) {
        if (!this.activeBreakpoints.get(this.sourcePath)?.has(line)) {
          this.pb.addLineBreakpoint(line - 1, 0);
          this.entryTempLines.add(line);
        }
      }
    }
  }

  /** Evaluates `name` and formats it for use in a `<name> <> <literal>`
   *  data-breakpoint condition -- the one sequence every data-breakpoint call
   *  site needs (dataBreakpointInfoRequest, setDataBreakpointsRequest,
   *  rearmDataBreakpoint), each of which only differs in what it does with a
   *  failure. `value` is the unformatted display value (for UI text);
   *  `literal` is the PB-syntax form (quoted/escaped for strings). */
  private async seedDataBreakpointLiteral(name: string): Promise<{ value: string; literal: string } | { error: string }> {
    const result = await this.pb.evaluate(name);
    const literal = formatDataBreakpointLiteral(result);
    if (literal === undefined || result.value === undefined) {
      return { error: result.error ?? `'${name}' cannot be watched (unsupported value type).` };
    }
    return { value: result.value, literal };
  }

  /** Re-seeds a "value changed" data breakpoint's condition against the
   *  variable's new current value and re-arms it under the exact same wire
   *  id, so the next change is also caught. Must reuse `armed.wireId`
   *  verbatim on both the remove and the add -- see removeDataBreakpoint()'s
   *  doc comment for why. */
  private async rearmDataBreakpoint(armed: ArmedDataBreakpoint): Promise<void> {
    try {
      const seed = await this.seedDataBreakpointLiteral(armed.name);
      if ("error" in seed) {
        this.logError(new Error(`cannot re-arm data breakpoint on '${armed.name}': ${seed.error}`));
        return;
      }
      armed.condition = `${armed.name} <> ${seed.literal}`;
      this.pb.removeDataBreakpoint(armed.wireId);
      this.pb.addDataBreakpoint(armed.wireId, armed.condition);
    } catch (err) {
      this.logError(err);
    }
  }

  /** Only a bare identifier is supported as a v1 data-breakpoint target --
   *  struct fields/array elements/list-map entries are rejected via
   *  `variablesReference` above this check, but a raw expression string
   *  (e.g. `a+b`) could still reach here and would evaluate fine yet make no
   *  sense as a "value changed" watch target, so it's rejected too. */
  private static readonly DATA_BREAKPOINT_NAME_RE = /^[A-Za-z_]\w*$/;

  /** Returns a DAP error instead of attempting a write through a transport
   * that has already gone away. Unlike source breakpoints, data breakpoints
   * require a live evaluation of the currently stopped target to establish
   * their initial value. */
  private requireStoppedDataBreakpointTarget(response: DebugProtocol.Response): boolean {
    if (this.forcePauseActive) {
      this.sendErrorResponse(response, 1094, "Pure Xtension: data breakpoints are unavailable during a forced pause (target is not at a PureBasic statement boundary). Continue to resume.");
      return false;
    }
    if (!this.pbConnected || this.terminated) {
      this.sendErrorResponse(response, 1095, "Pure Xtension: data breakpoints are unavailable because the debug session has ended. Start a new session and pause at a source breakpoint before adding one.");
      return false;
    }
    if (!this.targetStopped) {
      this.sendErrorResponse(response, 1096, "Pure Xtension: data breakpoints can only be added while execution is paused at a PureBasic source breakpoint. Pause the target, then add the data breakpoint from Variables.");
      return false;
    }
    return true;
  }

  protected async dataBreakpointInfoRequest(
    response: DebugProtocol.DataBreakpointInfoResponse,
    args: DebugProtocol.DataBreakpointInfoArguments,
  ): Promise<void> {
    if (!this.requireStoppedDataBreakpointTarget(response)) return;
    // `variablesReference`, per the DAP spec, is the *containing* variable
    // container -- for a plain top-level local that's just the scope's own
    // reference (scopesRequest's `frameId + 1`, always below
    // COMPOUND_REF_BASE), not a signal that `name` itself is a compound
    // value. VS Code's real Variables-view "Add Data Breakpoint" flow
    // always sends the scope reference alongside the variable's name, so
    // rejecting whenever *any* variablesReference was present (the old
    // behavior) rejected every real UI-driven request outright — only a
    // compound container's own reference (>= COMPOUND_REF_BASE, meaning
    // `name` names a struct field/array element/list-map entry with no
    // stable address in this v1) should be rejected.
    const isCompoundChild = args.variablesReference !== undefined && args.variablesReference >= COMPOUND_REF_BASE;
    if (isCompoundChild || !PureBasicDebugSession.DATA_BREAKPOINT_NAME_RE.test(args.name)) {
      response.body = { dataId: null, description: "Pure Xtension only supports data breakpoints on a simple top-level variable name." };
      this.sendResponse(response);
      return;
    }
    try {
      const seed = await this.seedDataBreakpointLiteral(args.name);
      if ("error" in seed) {
        response.body = { dataId: null, description: seed.error };
        this.sendResponse(response);
        return;
      }
      response.body = {
        dataId: args.name,
        description: `Break when '${args.name}' changes (current value: ${seed.value})`,
        accessTypes: ["write"],
        canPersist: false,
      };
      this.sendResponse(response);
    } catch (err) {
      this.sendAsyncRequestError(response, "getting data breakpoint info", err);
    }
  }

  protected async setDataBreakpointsRequest(
    response: DebugProtocol.SetDataBreakpointsResponse,
    args: DebugProtocol.SetDataBreakpointsArguments,
  ): Promise<void> {
    if (!this.requireStoppedDataBreakpointTarget(response)) return;
    try {
      this.pb.clearAllDataBreakpoints();
      this.dataBreakpointsByWireId.clear();

      const results: DebugProtocol.Breakpoint[] = [];
      for (const bp of args.breakpoints) {
        if (bp.hitCondition) {
          this.sendEvent(new OutputEvent(`Pure Xtension: data breakpoint hitCondition on '${bp.dataId}' is not supported and will be ignored.\n`, "stderr"));
        }

        let condition: string;
        let userCondition: string | undefined;
        if (bp.condition) {
          condition = bp.condition;
          userCondition = bp.condition;
        } else {
          const seed = await this.seedDataBreakpointLiteral(bp.dataId);
          if ("error" in seed) {
            const failed = new Breakpoint(false);
            (failed as DebugProtocol.Breakpoint).message = seed.error;
            results.push(failed);
            continue;
          }
          condition = `${bp.dataId} <> ${seed.literal}`;
        }

        const wireId = this.nextDataBreakpointWireId++;
        const armed: ArmedDataBreakpoint = { wireId, name: bp.dataId, userCondition, condition };
        this.dataBreakpointsByWireId.set(wireId, armed);
        this.pb.addDataBreakpoint(wireId, condition);

        const ok = new Breakpoint(true);
        ok.setId(wireId);
        results.push(ok);
      }

      response.body = { breakpoints: results };
      this.sendResponse(response);
    } catch (err) {
      this.sendAsyncRequestError(response, "setting data breakpoints", err);
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
        if (!this.activeBreakpoints.get(this.sourcePath)?.has(line)) {
          this.pb.addLineBreakpoint(line - 1, 0);
          this.entryTempLines.add(line);
        }
      }
      return (await this.continueUntilStopOrClose()) === "stopped";
    } finally {
      // A breakpoint edit during this internal run can promote a temporary
      // line to a real breakpoint, so activeBreakpoints remains authoritative.
      for (const line of this.entryTempLines) {
        if (!this.activeBreakpoints.get(this.sourcePath)?.has(line)) this.pb.removeLineBreakpoint(line - 1, 0);
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

  protected async continueRequest(
    response: DebugProtocol.ContinueResponse,
    _args: DebugProtocol.ContinueArguments,
  ): Promise<void> {
    // Invalidate a Force Pause timer that's still pending (armed by an
    // earlier pauseRequest but not yet fired) unconditionally, not just an
    // already-active one (resumeFromForcePauseIfActive only handles that
    // case): without this, pausing and then continuing within
    // FORCE_PAUSE_FALLBACK_MS would leave the old timer to fire later and
    // freeze the target well after the user already resumed it.
    this.cancelForcePauseFallback();
    // A client should not normally continue while a native step is pending.
    // Do not turn that into a second competing execution-control command.
    if (this.stepInProgress) {
      this.sendResponse(response);
      return;
    }
    try {
      if (this.forcePauseActive) await this.resumeFromForcePauseIfActive();
      else this.pb.continue();
      this.targetStopped = false;
      this.sendResponse(response);
    } catch (err) {
      this.sendAsyncRequestError(response, "continuing execution", err);
    }
  }

  protected pauseRequest(response: DebugProtocol.PauseResponse, _args: DebugProtocol.PauseArguments): void {
    try {
      // Opcode 0 is cooperative -- it only takes effect once the target's
      // main thread reaches PB_DEBUGGER_Check between statements, so this
      // alone can never interrupt a target blocked in an unbounded native
      // call (e.g. WaitWindowEvent() with no timeout). armForcePauseFallback
      // covers that gap; see the class-level Force Pause doc comment.
      this.pb.pause();
      this.sendResponse(response);
      this.armForcePauseFallback();
    } catch (err) {
      this.sendAsyncRequestError(response, "pausing execution", err);
    }
  }

  private isGdbAvailable(): boolean {
    if (this.gdbAvailableCache === undefined) this.gdbAvailableCache = gdbEngineAvailable();
    return this.gdbAvailableCache;
  }

  /** Starts (or restarts) the bounded wait after a cooperative pause request, after which forcePause() takes over if no wire stop arrived. */
  private armForcePauseFallback(): void {
    if (!this.isGdbAvailable() || process.platform !== "linux" || !this.child?.pid) return;
    this.pausePending = true;
    if (this.forcePauseTimer) clearTimeout(this.forcePauseTimer);
    const generation = this.pauseGeneration;
    this.forcePauseTimer = setTimeout(() => {
      this.forcePauseTimer = undefined;
      void this.forcePause(generation);
    }, FORCE_PAUSE_FALLBACK_MS);
  }

  /** Cancels any pending Force Pause timer/attempt without touching an already-active one (see resumeFromForcePauseIfActive for that). Called whenever a cooperative wire stop arrives -- which can only happen for a target that was never actually GDB-frozen, since a frozen target cannot run far enough to send one. */
  private cancelForcePauseFallback(): void {
    this.pausePending = false;
    this.pauseGeneration++;
    if (this.forcePauseTimer) {
      clearTimeout(this.forcePauseTimer);
      this.forcePauseTimer = undefined;
    }
  }

  /**
   * Attaches GDB to the already-running target and reports a degraded stop.
   * Live-confirmed (src/debug/spike/spike3.mjs) that a raw ptrace stop lands
   * the target outside its wire wait loop, where wire requests simply hang
   * -- so this deliberately does not attempt PB-level introspection; see
   * stackTraceRequest/variablesRequest.
   */
  private async forcePause(generation: number): Promise<void> {
    if (generation !== this.pauseGeneration || !this.pausePending) return;
    const pid = this.child?.pid;
    if (!pid) return;
    const engine = new GdbMiPtraceEngine();
    let pc: number;
    try {
      pc = await engine.attach(pid);
    } catch (err) {
      this.logError(err);
      return;
    }
    if (generation !== this.pauseGeneration) {
      // A cooperative stop (or a newer pause/continue/disconnect) won the
      // race while attaching -- undo the attach rather than surface a stale
      // forced stop on top of (or instead of) the real one.
      try {
        await engine.detach();
      } catch (err) {
        this.logError(err);
      } finally {
        await engine.dispose();
      }
      return;
    }
    this.pausePending = false;
    this.forcePauseActive = true;
    this.forcePauseEngine = engine;
    this.forcePauseNativeAddress = pc;
    this.compoundHandles.clear();
    this.frameHandles.clear();
    this.nextCompoundRef = COMPOUND_REF_BASE;
    this.sendEvent(
      new OutputEvent(
        `Pure Xtension: forced pause via GDB -- the target was not at a PureBasic statement boundary ` +
          `(e.g. blocked in a native call), so PureBasic locals/stack are unavailable until Continue. ` +
          `Stopped at native address 0x${pc.toString(16)}.\n`,
      ),
    );
    this.sendEvent(new StoppedEvent("pause", MAIN_THREAD_ID));
  }

  /** Detaches/disposes an active Force Pause engine and clears the wire's cooperative pause flag (opcode 2), if one is active; a no-op otherwise. Every resume path (continue/step/disconnect) must go through this before touching `this.pb` again. */
  private async resumeFromForcePauseIfActive(): Promise<void> {
    if (!this.forcePauseActive) return;
    this.pauseGeneration++;
    this.forcePauseActive = false;
    this.targetStopped = false;
    const engine = this.forcePauseEngine;
    this.forcePauseEngine = undefined;
    // pauseRequest's wire pause() (opcode 0) left the target's cooperative
    // stop flag armed; continue()/opcode 2 is what clears it (see
    // pbSession.ts's continue() doc comment). This must happen BEFORE
    // detach() below, not after: the FIFO comms thread can keep accepting
    // writes independently of whatever GDB has ptrace-stopped, so sending it
    // first guarantees the flag is already clear by the time the main
    // thread can next reach PB_DEBUGGER_Check. Detaching first would leave a
    // window where the target could resume, immediately reach its next
    // statement check with the old pause flag still armed, and cooperatively
    // re-stop on its own — an extra, spurious wire `stopped` event racing
    // against this same resume.
    this.pb.continue();
    if (engine) {
      try {
        await engine.detach();
      } catch (err) {
        this.logError(err);
      } finally {
        await engine.dispose();
      }
    }
  }

  protected nextRequest(response: DebugProtocol.NextResponse, _args: DebugProtocol.NextArguments): Promise<void> {
    return this.sendNativeStep(response, "over");
  }

  protected stepInRequest(response: DebugProtocol.StepInResponse, _args: DebugProtocol.StepInArguments): Promise<void> {
    return this.sendNativeStep(response, "in");
  }

  protected stepOutRequest(response: DebugProtocol.StepOutResponse, _args: DebugProtocol.StepOutArguments): Promise<void> {
    return this.sendNativeStep(response, "out");
  }

  /**
   * Dispatches a native opcode-1 PureBasic step. The target emits a normal
   * MSG_STOPPED (reason 8) when the operation completes; the persistent
   * listener above turns it into the DAP `step` stop event. No temporary line
   * breakpoints or stack-depth reconstruction are involved, so step-in can
   * genuinely enter a called procedure.
   */
  private async sendNativeStep(response: DebugProtocol.Response, mode: "in" | "over" | "out"): Promise<void> {
    // Same reasoning as continueRequest: invalidate a still-pending Force
    // Pause timer unconditionally, not just an already-active one.
    this.cancelForcePauseFallback();
    if (this.stepInProgress) {
      this.sendResponse(response);
      return;
    }
    if (this.forcePauseActive) {
      // There is no wire statement-boundary context at a forced pause (see
      // the class-level Force Pause doc comment), so a native step isn't
      // meaningful here -- resume instead, same as continueRequest.
      try {
        await this.resumeFromForcePauseIfActive();
        this.sendEvent(new OutputEvent("Pure Xtension: stepping isn't available from a forced pause; resuming instead.\n"));
        this.sendResponse(response);
      } catch (err) {
        this.sendAsyncRequestError(response, "resuming from a forced pause", err);
      }
      return;
    }
    this.stepInProgress = true;
    try {
      if (mode === "in") this.pb.stepInto();
      else if (mode === "over") this.pb.stepOver();
      else this.pb.stepOut();
      this.targetStopped = false;
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
    if (this.forcePauseActive) {
      // this.pb.stackTrace() would hang here -- the main thread is
      // GDB-frozen outside its wire wait loop and cannot answer (live-
      // confirmed, src/debug/spike/spike3.mjs). Report a single synthetic
      // frame from the GDB-read PC instead of blocking the client forever.
      const source = this.sourceForFrame(this.lastStopModuleId);
      this.frameHandles.clear();
      this.frameHandles.set(0, { kind: "main" });
      const frame = new StackFrame(0, `native code (paused) — 0x${this.forcePauseNativeAddress.toString(16)}`, source, this.lastStopLine || 1);
      response.body = { stackFrames: [frame], totalFrames: 1 };
      this.sendResponse(response);
      return;
    }
    try {
    const pbFrames = await this.pb.stackTrace(); // opcode 16: procedure frames only, outermost-first
    this.frameHandles.clear();
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
      const moduleId = j === 0 ? this.lastStopModuleId : frame.moduleId;
      frames.push(new StackFrame(id, frame.display, this.sourceForFrame(moduleId), line));
      id++;
      line = frame.callSiteLine0 + 1;
    }
    // Synthetic module/main frame beneath every procedure frame — the only
    // frame when stopped at module scope (opcode 16 empty), and the missing
    // bottom of the stack when stopped inside a procedure (opcode 16 never
    // includes it). Its locals come from opcode 9 + evaluate (see variablesRequest).
    this.frameHandles.set(id, { kind: "main" });
    const mainSource = this.sourceForFrame(procInnermostFirst.length === 0 ? this.lastStopModuleId : pbFrames[0].moduleId);
    frames.push(new StackFrame(id, `${path.basename(mainSource.path!)} (main)`, mainSource, line));

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

  /**
   * Converts a scalar-stream record into a DAP Variable, giving structure
   * children their own expandable reference. `parentExpression`, set only
   * when converting a struct's own field records, qualifies a String
   * field's name into a real evaluatable expression (e.g. `p\label`) --
   * see the String-handling branch below for why that lookup is needed at
   * all.
   */
  private async toDapVariable(v: PbVariable, parentExpression?: string): Promise<Variable> {
    if (v.children) {
      return new Variable(
        v.name,
        "{...}",
        this.registerCompound({ kind: "struct", children: v.children, expression: v.name }),
      );
    }
    if (v.unsupported) {
      // PLAN.md M12: an unrecognized wire type tag -- its value (and, while
      // parsing, its byte width) genuinely isn't known, so this is an
      // honest "can't decode" instead of a guessed/blank/garbage value.
      return new Variable(v.name, `<unsupported type 0x${v.type.toString(16)}>`);
    }
    if (v.type === STRING_TYPE_TAG) {
      // A String scalar's ExamineCurrentFrame/ExamineFrame record carries
      // no inline value at all (PLAN.md M12) -- only evaluate() can recover
      // the actual text. The module-scope struct-field path already
      // populates v.value itself (it evaluates every field up front,
      // regardless of type) -- trust that instead of a redundant re-fetch.
      // Otherwise, a top-level local's own name is already a valid
      // expression; a struct field needs the parent's expression prefixed
      // with PureBasic's field-access backslash.
      if (v.value !== undefined) return new Variable(v.name, v.value);
      const expr = parentExpression ? `${parentExpression}\\${v.name}` : v.name;
      const result = await this.pb.evaluate(expr);
      return new Variable(v.name, result.value ?? result.error ?? "<unavailable>");
    }
    return new Variable(v.name, v.value ?? "");
  }

  protected async variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments,
  ): Promise<void> {
    if (this.forcePauseActive) {
      // Any this.pb call would hang here for the same reason noted in
      // stackTraceRequest -- fail fast with an explanatory error instead.
      this.sendErrorResponse(response, 1091, "Pure Xtension: locals are unavailable during a forced pause (target is not at a PureBasic statement boundary). Continue to resume.");
      return;
    }
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
        response.body = {
          variables: await Promise.all(handle.children.map((v) => this.toDapVariable(v, handle.expression))),
        };
        this.sendResponse(response);
        return;
      }
      // Array/list/map: opcode 15 fetches element data lazily, only once
      // this specific container is actually expanded.
      const result = await this.pb.examineExpression(handle.expression);
      let variables: Variable[];
      if (result.kind === "array" || result.kind === "list") {
        variables = result.elements.map((e) =>
          e.children
            ? new Variable(
                `[${e.index}]`,
                e.value,
                this.registerCompound({ kind: "struct", children: e.children, expression: handle.expression }),
              )
            : new Variable(`[${e.index}]`, e.value),
        );
      } else if (result.kind === "map") {
        variables = result.elements.map((e) =>
          e.children
            ? new Variable(
                e.key,
                e.value,
                this.registerCompound({ kind: "struct", children: e.children, expression: handle.expression }),
              )
            : new Variable(e.key, e.value),
        );
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
      variables = await Promise.all((await this.pb.examineFrame(handle.pbIndex)).map((v) => this.toDapVariable(v)));
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
            new Variable(d.name, "{...}", this.registerCompound({ kind: "struct", children, expression })),
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
    if (this.forcePauseActive) {
      this.sendErrorResponse(response, 1092, "Pure Xtension: evaluate is unavailable during a forced pause (target is not at a PureBasic statement boundary). Continue to resume.");
      return;
    }
    try {
    // frameId isn't threaded through here yet — every evaluate runs against
    // the currently-stopped line (frameContext -1), the only case PLAN.md's
    // M5 spike live-tested. Evaluating in an outer frame's context is an
    // open question, not a confirmed capability, so it's not wired up as
    // if it were.
    const result = await this.pb.evaluate(args.expression);
    if (result.kind === 0) {
      // Hover and Watch fire automatically -- a hover over an identifier
      // that's momentarily out of scope, or a stale Watch entry left over
      // from an unrelated debug session (VS Code re-evaluates every Watch
      // expression against any new session regardless of language), is
      // routine, not an actionable error. An error *response* here makes
      // VS Code pop a notification toast instead of just rendering the
      // message inline in the Watch/hover UI the way other kinds of
      // "unavailable" values already do -- respond successfully with the
      // message as the result instead. A Debug Console (repl) evaluate is
      // a deliberate user action, so it keeps the real error response.
      if (args.context === "hover" || args.context === "watch") {
        response.body = { result: result.error ?? "not available", variablesReference: 0 };
        this.sendResponse(response);
        return;
      }
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
    if (this.forcePauseActive) {
      this.sendErrorResponse(response, 1093, "Pure Xtension: setVariable is unavailable during a forced pause (target is not at a PureBasic statement boundary). Continue to resume.");
      return;
    }
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

  protected async disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    _args: DebugProtocol.DisconnectArguments,
  ): Promise<void> {
    this.cancelForcePauseFallback();
    if (this.forcePauseEngine) {
      // SIGKILLing the target below works fine even while GDB still has it
      // ptrace-attached (SIGKILL cannot be intercepted or deferred by a
      // tracer), but detach first anyway for a clean handoff and to avoid
      // leaving an orphaned GDB process behind on an early return above.
      const engine = this.forcePauseEngine;
      this.forcePauseEngine = undefined;
      this.forcePauseActive = false;
      try {
        await engine.detach();
      } catch (err) {
        this.logError(err);
      } finally {
        await engine.dispose();
      }
    }
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
    // H4: launchRequest's compile step is async now (see compileAsync), so
    // it's possible to reach here while a (possibly stalled) compile is
    // still running -- e.g. Stop pressed before the debug build finishes.
    // Without this, that compiler process would keep running orphaned after
    // the session it belongs to is gone.
    this.compileChild?.kill("SIGKILL");
    this.cleanupTempDirs();
    this.sendResponse(response);
  }
}
