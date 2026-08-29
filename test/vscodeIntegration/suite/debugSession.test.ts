// Real VS Code UI verification (PLAN.md §8 risk 1's long-standing "never
// verified through a real VS Code window" gap). Runs inside an actual
// activated extension host, driving the real `vscode.debug` API -- the
// real DebugConfigurationProvider, the real DebugAdapterDescriptorFactory,
// the real breakpoint manager -- unlike test/pbDebugAdapter.e2e.test.ts,
// which talks to the standalone adapter binary directly and never touches
// any of that.
import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";

interface DapMessage {
  type: string;
  event?: string;
  body?: Record<string, unknown>;
}

async function waitFor<T>(
  predicate: () => T | undefined | null | false,
  description: string,
  timeoutMs = 20000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

suite("Real VS Code debug session (purebasic)", () => {
  const fixtureDir = path.resolve(__dirname, "..", "fixture");
  const programPath = path.join(fixtureDir, "test-step.pb");

  test("extension activates", async () => {
    const ext = vscode.extensions.getExtension("local.pure-xtension");
    assert.ok(ext, "extension local.pure-xtension not found");
    await ext!.activate();
    assert.ok(ext!.isActive, "extension did not activate");
  });

  test("launch -> procedure breakpoint -> step -> evaluate -> module breakpoint -> continue -> terminate", async function () {
    this.timeout(90000);

    const uri = vscode.Uri.file(programPath);
    // Line 4 (1-based): `Debug "line4 c=" + Str(c)` inside Add() -- procedure scope.
    // Line 13 (1-based): `Debug "line13 z=" + Str(z)` at module scope.
    const bpProcedure = new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(3, 0)));
    const bpModule = new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(12, 0)));
    vscode.debug.addBreakpoints([bpProcedure, bpModule]);

    const stoppedEvents: Array<Record<string, unknown>> = [];
    const outputChunks: string[] = [];
    let terminated = false;

    const trackerRegistration = vscode.debug.registerDebugAdapterTrackerFactory("purebasic", {
      createDebugAdapterTracker() {
        return {
          onDidSendMessage(message: DapMessage) {
            if (message.type !== "event") return;
            if (message.event === "stopped" && message.body) stoppedEvents.push(message.body);
            if (message.event === "output" && typeof message.body?.output === "string") {
              outputChunks.push(message.body.output as string);
            }
            if (message.event === "terminated") terminated = true;
          },
        };
      },
    });

    try {
      const folder = vscode.workspace.workspaceFolders?.[0];
      const started = await vscode.debug.startDebugging(folder, {
        type: "purebasic",
        request: "launch",
        name: "integration test launch",
        program: programPath,
        stopOnEntry: false,
        // Explicit, not auto: on a machine with both the ASM and C backends
        // installed (this runner included) and no persisted
        // pureXtension.backend setting, an unspecified backend hits
        // launchRequest()'s interactive resolveBackend() picker (M13) --
        // which the real test extension host's DialogService refuses to
        // show, resolving to undefined and cleanly cancelling the launch
        // instead of ever reaching a breakpoint. Live-confirmed on this
        // runner: "Pure Xtension: no PureBasic compiler backend selected —
        // debug launch cancelled."
        backend: "asm",
      });
      assert.ok(started, "vscode.debug.startDebugging returned false");

      const session = await waitFor(() => vscode.debug.activeDebugSession, "an active debug session");
      assert.strictEqual(session.type, "purebasic");

      // --- 1. Procedure-scope breakpoint (line 4) ---
      await waitFor(() => stoppedEvents.length >= 1, "first stopped event (procedure breakpoint)");
      assert.strictEqual(stoppedEvents[0].reason, "breakpoint", `expected reason 'breakpoint', got: ${JSON.stringify(stoppedEvents[0])}`);

      const threadsResp = await session.customRequest("threads");
      const threadId = threadsResp.threads[0].id as number;

      let stackResp = await session.customRequest("stackTrace", { threadId });
      let frames = stackResp.stackFrames as Array<{ id: number; line: number; name: string }>;
      assert.ok(frames.length >= 2, `expected >=2 frames at procedure scope (real + synthesized main), got ${frames.length}: ${JSON.stringify(frames)}`);
      assert.strictEqual(frames[0].line, 4, `innermost frame should report line 4, got: ${JSON.stringify(frames[0])}`);
      assert.match(frames[0].name, /Add/, `innermost frame name should mention Add, got: ${frames[0].name}`);

      let scopesResp = await session.customRequest("scopes", { frameId: frames[0].id });
      let localsScope = scopesResp.scopes[0];
      let varsResp = await session.customRequest("variables", { variablesReference: localsScope.variablesReference });
      let vars = varsResp.variables as Array<{ name: string; value: string }>;
      const cVar = vars.find((v) => v.name === "c");
      assert.ok(cVar, `expected local 'c' at line 4, got: ${JSON.stringify(vars)}`);
      assert.strictEqual(cVar!.value, "3", `expected c=3 (a+b, before increment) at line 4, got c=${cVar!.value}`);

      // --- 1b. Data breakpoint info for 'c', driven exactly the way the real
      // Variables-view "Add Data Breakpoint" context menu action does: with
      // the containing scope's own variablesReference alongside the plain
      // variable name (per the DAP spec, that reference identifies the
      // *container*, not "this is a compound value"). A prior bug rejected
      // every such request outright, since it only ever tested a bare
      // {name} with no variablesReference at all -- which the real UI never
      // actually sends.
      const dataBreakpointInfo = await session.customRequest("dataBreakpointInfo", {
        variablesReference: localsScope.variablesReference,
        name: "c",
      });
      assert.ok(
        dataBreakpointInfo.dataId,
        `expected a real Variables-view request for local 'c' to be accepted, got: ${JSON.stringify(dataBreakpointInfo)}`,
      );

      // --- 2. Step (next) once, should land on line 5 (c = c + 1, not yet executed) ---
      await session.customRequest("next", { threadId });
      await waitFor(() => stoppedEvents.length >= 2, "second stopped event (step)");
      assert.strictEqual(stoppedEvents[1].reason, "step", `expected reason 'step', got: ${JSON.stringify(stoppedEvents[1])}`);

      stackResp = await session.customRequest("stackTrace", { threadId });
      frames = stackResp.stackFrames;
      assert.notStrictEqual(frames[0].line, 4, "step should have moved off line 4");

      // --- 3. Evaluate (watch expression) against the current frame ---
      const evalResp = await session.customRequest("evaluate", {
        expression: "c",
        frameId: frames[0].id,
        context: "watch",
      });
      assert.ok(evalResp.result, `evaluate('c') returned no result: ${JSON.stringify(evalResp)}`);

      // --- 4. Continue to the module-scope breakpoint (line 13) ---
      await session.customRequest("continue", { threadId });
      await waitFor(() => stoppedEvents.length >= 3, "third stopped event (module breakpoint)");
      assert.strictEqual(stoppedEvents[2].reason, "breakpoint", `expected reason 'breakpoint', got: ${JSON.stringify(stoppedEvents[2])}`);

      stackResp = await session.customRequest("stackTrace", { threadId });
      frames = stackResp.stackFrames;
      assert.strictEqual(frames.length, 1, `expected exactly 1 (synthesized main) frame at module scope, got ${frames.length}: ${JSON.stringify(frames)}`);
      assert.strictEqual(frames[0].line, 13, `module-scope frame should report line 13, got: ${JSON.stringify(frames[0])}`);

      scopesResp = await session.customRequest("scopes", { frameId: frames[0].id });
      localsScope = scopesResp.scopes[0];
      varsResp = await session.customRequest("variables", { variablesReference: localsScope.variablesReference });
      vars = varsResp.variables;
      const zVar = vars.find((v) => v.name === "z");
      assert.ok(zVar, `expected module-scope global 'z' at line 13, got: ${JSON.stringify(vars)}`);
      assert.strictEqual(zVar!.value, "4", `expected z=4 (Add(1,2) -> 3, +1 -> 4), got z=${zVar!.value}`);

      // --- 5. Continue to natural program termination ---
      await session.customRequest("continue", { threadId });
      await waitFor(() => terminated, "terminated event after natural program end", 20000);

      // `Debug` statement text arrives over the wire, not the target's
      // stdout, once an external debugger is attached -- and PureBasic's
      // own debugger.a runtime reliably truncates it to floor(fullLength/2)
      // bytes (confirmed live, PLAN.md M7 item b; not fixable from this
      // side). "line13 z=4" and "line15 w=5" both truncate to the identical
      // 5-byte prefix "line1" (11-byte full length ÷ 2, floored), so they
      // can't be told apart by content alone -- asserting on confirmed
      // surviving prefixes plus a per-statement truncation-marker count,
      // not on text this protocol is confirmed to never fully deliver.
      const fullOutput = outputChunks.join("");
      for (const survivingPrefix of ["line4", "line6", "line1"]) {
        assert.ok(fullOutput.includes(survivingPrefix), `expected Debug Console output to include "${survivingPrefix}"; got: ${fullOutput}`);
      }
      const truncationMarkerCount = fullOutput.split("may be truncated").length - 1;
      assert.strictEqual(truncationMarkerCount, 4, `expected 4 Debug statements to surface (line4, line6, line13, line15), got ${truncationMarkerCount} in: ${fullOutput}`);
    } finally {
      trackerRegistration.dispose();
      vscode.debug.removeBreakpoints([bpProcedure, bpModule]);
      if (vscode.debug.activeDebugSession) {
        await vscode.debug.stopDebugging(vscode.debug.activeDebugSession);
      }
    }
  });
});
