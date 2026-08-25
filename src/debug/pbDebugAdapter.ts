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
import { PbDebugSession, PbFrame } from "./pbSession";

const MAIN_THREAD_ID = 1;

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
 * First `pbDebugAdapter.ts` pass: launch, line breakpoints, continue, stack
 * trace, and locals — the surface PLAN.md's M5 spike confirmed live. No
 * stepping (no dedicated step opcode has been found yet), no watch/evaluate,
 * no array/list/map or structure expansion.
 */
export class PureBasicDebugSession extends DebugSession {
  private pb = new PbDebugSession();
  private child?: cp.ChildProcess;
  private fifoDir?: string;
  private sourcePath = "";
  /** opcode-16 order (0 = outermost); cached per stop so scopes/variables can address into it. */
  private lastFrames: PbFrame[] = [];
  /** Guards against sending TerminatedEvent twice — the wire session's `close` and the child's `exit` both fire on every teardown. */
  private terminated = false;

  constructor() {
    super();
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
    this.pb.on("stopped", ({ reason }: { line: number; reason: number }) => {
      this.lastFrames = [];
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

  protected initializeRequest(
    response: DebugProtocol.InitializeResponse,
    _args: DebugProtocol.InitializeRequestArguments,
  ): void {
    response.body = response.body ?? {};
    response.body.supportsConfigurationDoneRequest = true;
    // No dedicated step opcode confirmed yet (PLAN.md M5 "still open" list) —
    // only run/continue is exposed until one is found.
    response.body.supportsStepInTargetsRequest = false;
    response.body.supportsEvaluateForHovers = true;
    response.body.supportsSetVariable = true;
    this.sendResponse(response);
    this.sendEvent(new InitializedEvent());
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

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pure-xtension-debug-"));
    const outBinary = path.join(workDir, "target.bin");
    const compileArgs = ["-d", "-ds", "-l", "-o", outBinary, ...(args.compilerArgs ?? []), args.program];
    const compileResult = cp.spawnSync(compiler, compileArgs, { encoding: "utf8" });
    if (compileResult.status !== 0) {
      this.sendEvent(new OutputEvent(compileResult.stdout ?? "", "stdout"));
      this.sendEvent(new OutputEvent(compileResult.stderr ?? "", "stderr"));
      this.sendErrorResponse(response, 1002, "Pure Xtension: compile (debug build) failed — see debug console.");
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
      return;
    }

    this.sendResponse(response);

    if (args.stopOnEntry) {
      // The target is already implicitly stopped-on-entry (PLAN.md M5:
      // PB_DEBUGGER_Start blocks until a continue clears its stop flag) —
      // no extra command needed to "arrive" at entry.
      this.sendEvent(new StoppedEvent("entry", MAIN_THREAD_ID));
    } else {
      this.pb.continue();
    }
  }

  protected async setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments,
  ): Promise<void> {
    this.pb.clearAllLineBreakpoints();
    const lines = args.breakpoints?.map((b) => b.line) ?? args.lines ?? [];
    for (const line of lines) {
      this.pb.addLineBreakpoint(line);
    }
    response.body = {
      breakpoints: lines.map((line) => new Breakpoint(true, line)),
    };
    this.sendResponse(response);
  }

  protected continueRequest(
    response: DebugProtocol.ContinueResponse,
    _args: DebugProtocol.ContinueArguments,
  ): void {
    this.pb.continue();
    this.sendResponse(response);
  }

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    response.body = { threads: [new Thread(MAIN_THREAD_ID, "main")] };
    this.sendResponse(response);
  }

  protected async stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    _args: DebugProtocol.StackTraceArguments,
  ): Promise<void> {
    this.lastFrames = await this.pb.stackTrace();
    // opcode 16 returns outermost-first; DAP wants innermost (current) frame first.
    const innermostFirst = [...this.lastFrames].reverse();
    const source = new Source(path.basename(this.sourcePath), this.sourcePath);
    response.body = {
      stackFrames: innermostFirst.map((frame, i) => {
        const dapId = innermostFirst.length - 1 - i; // matches examineFrame's pb-order index
        return new StackFrame(dapId, frame.display, source, frame.callSiteLine0 + 1);
      }),
      totalFrames: innermostFirst.length,
    };
    this.sendResponse(response);
  }

  protected scopesRequest(
    response: DebugProtocol.ScopesResponse,
    args: DebugProtocol.ScopesArguments,
  ): void {
    // variablesReference encodes the pb-order frame index (0 = outermost),
    // offset by 1 so 0 stays reserved for "no children".
    response.body = { scopes: [new Scope("Locals", args.frameId + 1, false)] };
    this.sendResponse(response);
  }

  protected async variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments,
  ): Promise<void> {
    const frameIndex = args.variablesReference - 1;
    const vars = await this.pb.examineFrame(frameIndex);
    response.body = {
      variables: vars.map((v) => new Variable(v.name, v.value)),
    };
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
    if (this.fifoDir) {
      fs.rmSync(this.fifoDir, { recursive: true, force: true });
    }
    this.sendResponse(response);
  }
}
