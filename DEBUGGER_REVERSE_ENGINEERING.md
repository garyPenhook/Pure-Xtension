# How the PureBasic debugger was reverse-engineered

This extension's debug adapter (`src/debug/pbDebugAdapter.ts` +
`src/debug/pbSession.ts`) talks directly to the wire protocol PureBasic's
compiled `-d` (debug) executables use to communicate with an external
debugger. That protocol has no public specification — no header, no SDK
docs, nothing in `sdk/c/PureLibraries/Debugger/DebuggerModule.h` beyond the
target-side library API. Everything the adapter relies on was recovered by
reading the compiler's own shipped binaries and then proving each finding
against a real running target. This document explains that process and the
resulting design. The full, dated decode log — including corrections made
along the way — lives in `PLAN.md` (search for "M5" and "M6"); this is the
condensed narrative.

## Why static reading alone wasn't enough

The first assumption — that `compilers/pbdebugger` is a headless daemon the
adapter could spawn and pipe requests to — was wrong and was disproved with
`strace`/`strings` before any protocol work started: `pbdebugger` is a GTK
GUI app that opens X11/dbus sockets on launch, not a protocol server. The
real debugger is statically linked *into every `-d` build itself*
(`compilers/debugger.a`). A plain `-d` binary run standalone does no
fork/exec/socket calls at all; it only starts listening for an external
debugger if a connection is requested. That meant there was no daemon to
attach a network sniffer to — the only way to learn the protocol was to
disassemble the library that implements both ends of it and then validate
every claim live.

## Method: static disassembly, then live proof, repeated per opcode

`debugger.a` is unstripped, so the recovery loop for each piece of the
protocol was the same:

1. **Extract and disassemble.** `ar x debugger.a <object>.o`, then
   `objdump -d -r -M intel` on the relevant object (`ExternalDebugger.o`,
   `Debugger.o`, `UnixPipeCommunication.o`, `NetworkCommunication.o`,
   `Stack.o`, `Procedures.o`). Exported `PB_DEBUGGER_*` symbol names made
   call targets self-documenting even before full instruction decoding —
   grepping an address range's `objdump` output for `PB_DEBUGGER_*` /
   `R_X86_64_PLT32` call targets was often enough to identify a function's
   *category* cheaply, with full instruction-level decoding reserved for
   the handlers an adapter actually needed byte-exact.
2. **Resolve relocations that `objdump` on a bare `.o` can't show.** Two of
   the dispatch tables (the outer 40-opcode table, and `Misc`'s inner
   sub-table) live in `.data.rel.ro`/`.rodata` as unresolved
   `R_X86_64_PC32`/`R_X86_64_PLT32` relocations, which read as all-zero
   bytes in a plain `objdump -d -r` on the relocatable object. Forcing
   `ld -shared -o ext.so ExternalDebugger.o --unresolved-symbols=ignore-all
   -z notext` and disassembling the resulting `.so` resolves those
   relocations against real addresses, turning an inferred table boundary
   into a concrete list of case targets.
3. **Cross-check against `readelf -r` / `nm`.** Relocation entries were
   matched against `nm`'s local-symbol table to confirm which handler each
   opcode actually dispatches to, rather than trusting address-range
   proximity alone.
4. **Prove it live.** Every claim that mattered to the adapter was then
   tested against a real `pbcompiler -d` build using small, disposable Node
   scripts under `src/debug/spike/*.mjs` that speak the wire format
   directly (`fs.readSync`/`writeSync` on FIFO file descriptors — no
   framework, just enough to send one request and print the raw reply).
   Several static-decode conclusions were **revised or reversed** once
   tested live (see "Corrections" below) — this is why the spikes were
   kept as the extension's audit trail instead of being thrown away once
   `pbSession.ts` was written.

This two-step discipline (decode, then disprove-if-wrong live) is why
`pbSession.ts`'s header comment says it "only encodes what was actually
confirmed against a real running target" — anything that stayed
static-decode-only (data breakpoints, the TCP transport, structure
expansion beyond what was tested) is called out as such in code comments
rather than assumed to work.

## Finding the transport: environment-variable rendezvous

Static decode of `PB_DEBUGGER_InitExternal` showed a target looks for a
connection descriptor in three places, checked in order: a `--debuglisten`/
`--debugconnect` CLI flag, a `PB_DEBUGGER_Communication` environment
variable, and finally a rendezvous file (`/tmp/.pbdebugger.out`, the format
the real PureBasic IDE uses, complete with a 19-second staleness check).
The environment variable is the simplest for a tool that spawns its own
target, and it turned out to accept the same `<plugin>;<path>;<path>`
descriptor the rendezvous file's inner line uses. Setting

```
PB_DEBUGGER_Communication=FifoFiles;<out-fifo-path>;<in-fifo-path>
```

before spawning a `-d` build — after creating the two paths with `mkfifo`
— was confirmed live to connect an external debugger with no IDE and no
on-disk file involved at all. `pbDebugAdapter.ts`'s `launchRequest` does
exactly this: `mkfifo` two paths, spawn the compiled target with that
environment variable set, then start speaking the wire protocol over the
two FIFO file descriptors.

The wire framing itself — a fixed 20-byte header (`int32` opcode/type,
`int32` payload length, three more `int32` fields) optionally followed by
exactly `length` bytes of payload — was confirmed by decoding
`UnixPipeCommunication.o`'s `Send` (two unconditional `fwrite`s matching
that shape exactly) and by capturing real traffic that matched it on every
message in both directions.

## Finding the opcode table

`PB_DEBUGGER_IncomingCommand` linear-scans a 40-entry
`{opcode:int, handler:funcptr}` table to route every incoming message. That
table (recovered via the relocation-resolution technique above) groups the
40 opcodes into 9 handler functions:

| Opcodes | Handler | What it actually is |
|---|---|---|
| 0,1,2,36 | `Control` | connection/session control; **2 is continue/go** |
| 3 | `ExternalBreakpoints` | line + data breakpoints (its own 7-way sub-dispatch) |
| 4–7 | `Assembly` | disassembly view, not used |
| 8,33,34,35 | `Expression` | watch/hover evaluate (33/34) and modify (35); 8 is unrelated |
| 9,10,11,17 | `Variables` | scope/frame variable declarations and values |
| 12–15 | `ArraysLists` | array/list/map enumeration + element fetch |
| 16,28–32,38–40 | `Misc` | **16 is the real call stack**; the rest is profiler/module metadata |
| 18–20 | `Procedures` | procedure name table + profiler counters, *not* the call stack |
| 21–23 | `Watchlist` | persistent watch list (unused; one-shot evaluate covers this extension's needs) |
| 24–27 | `Libraries` | module/thread-suspend bookkeeping, not user-facing |

Two entries in this table are deliberately *not* what their category name
suggests, and both were corrected mid-investigation rather than assumed
from the first pass:

- **`Procedures` (18–20) is not the call stack.** It's a name/module lookup
  table plus profiler call counters — a name table built once, not a
  per-frame structure.
- **`Misc` opcode 16 *is* the call stack**, discovered only after
  instruction-level decoding of `Misc`'s own inner dispatch (a second,
  smaller jump table nested inside that one handler function, separately
  relocation-resolved). Opcode 6 (`PrintStack`, filed under `Assembly`) was
  also initially suspected as the call-stack source and ruled out the same
  way: it decodes to a raw CPU-stack memory walker (the debugger's "CPU
  Stack" inspector view), not a symbolic frame list.

## The "call stack is always empty" dead end, and what it actually meant

Early live testing sent opcode 16 against a target genuinely blocked
several calls deep and got back an empty reply every time. Several
explanations were tested and ruled out in turn — a cross-thread
thread-local-storage mismatch (disproved by disassembling
`PB_Object_GetThreadMemory` and `EnterProcedure`/`LeaveProcedure`: no
thread-ID parameter exists anywhere in that path), and a statement-boundary
timing artifact (disproved by rerunning with a spin-wait instead of a
blocking library call, which should have fixed the timing but didn't).

The actual answer, found by decoding `PB_DEBUGGER_Start`: connecting an
external debugger puts the target into an implicit **stop-on-entry** wait
before its first statement ever executes, confirmed directly with `gdb` —
a breakpoint on the target's own procedure-entry code never fired at all
while a debugger was connected and idle, and did fire the instant a second
client sent opcode `2`. The "empty call stack" was correct: the program was
truthfully still parked before line one, for lack of a continue command.
This also explained two previously-mysterious unsolicited messages the
target sends without being asked: an unconditional `type=2` startup
announcement immediately after connecting, and a `type=3` notification
(`StoppedExternal`) sent for every later stop.

Once opcode 2 was identified as continue, opcode 16 returned real,
correctly-ordered, correctly-named multi-frame stacks — verified by parking
a target two calls deep in a non-blocking loop and confirming the reply
held steady at 2 frames for the loop's full duration and dropped to 0 the
instant it returned. Each frame is a `(int32, cstring)` pair: a call-site
line number and a formatted `ProcName(arg1, arg2, ...)` display string. The
integer's meaning (0-based call-site line, one less than the source line
that made the call) was pinned down empirically by diffing known line
numbers in a test fixture against the values that came back — nothing in
the stripped object confirmed it by name.

## Breakpoints, variables, and evaluate

The same decode-then-live-test loop was applied to the opcodes the adapter
actually needed:

- **Opcode 3** (breakpoints) is its own 7-way sub-dispatch on a payload
  field, not a flat "set breakpoint" call: add/remove/bulk-clear a line
  breakpoint (keyed as `(moduleID << 20) | line`), and a separate
  add/remove/clear-all for data (watch) breakpoints. Add, remove, and
  bulk-clear were live-tested by setting a breakpoint inside a loop body
  and confirming the target did or didn't stop there depending on whether
  the breakpoint survived. Data breakpoints remain static-decode-only —
  the adapter doesn't use them.
- **Opcodes 9/10/11/17** (`Variables`) dispatch on the raw opcode value
  itself rather than a sub-command field: 9 is module/global-scope
  declarations, 11 is the current frame's locals, 17 is an explicit frame's
  locals addressed by index. Confirmed live against a two-procedure call
  stack that frame index 0 is the **outermost** caller — the opposite of
  DAP's own innermost-first convention — which is why
  `pbDebugAdapter.ts`'s `stackTraceRequest` explicitly reverses opcode 16's
  order before handing frames to VS Code.
- **Opcode 9's record layout is declarations only — no values** (names +
  types, discovered later while standing up the headless end-to-end test:
  `parseVariables`, written against opcode 11/17's layout, silently
  desynchronized when reused for opcode 9 because it assumed every record
  carries a trailing 8-byte value). This is why `pbSession.ts` has a
  separate `parseGlobalDecls` parser rather than reusing `parseVariables`.
- **Opcodes 33/34** are the real expression evaluator (byte-identical to
  each other in this handler) and are what backs DAP's `evaluate`
  (watch/hover). Opcode 8, despite living in the same category, is
  unrelated — live-testing it returned a memory-inspector "address/length"
  error, not a value.

## What the protocol genuinely cannot do, and how the adapter compensates

Two limitations aren't bugs in the adapter — they're confirmed absences in
the wire protocol itself, found by systematically trying every sub-command
value on the only opcode that looked step-shaped:

- **No dedicated step opcode exists.** Opcode 2's sub-command field was
  tested with every value across a fixture with five sequential
  non-looping statements (chosen so "stepped one line" and "ran free"
  can't be confused); all values produced byte-identical free-run
  behavior. `pbDebugAdapter.ts`'s `step()` compensates by temporarily
  breakpointing every compiled line of the module (in addition to the
  user's real breakpoints) and continuing once — `GetExecutableLine`
  snaps requested lines to the nearest real statement, so lines with no
  statement of their own are harmless no-ops, and the target reliably
  stops at the very next line that executes. "Over" and "out" additionally
  compare stack depth (from opcode 16) against the depth `step()` began at,
  auto-continuing through any stop that's still deeper than the starting
  frame.
- **Step-into cannot descend into a call**, confirmed live: continuing from
  a stop always runs the *entire current source line to completion*,
  including any procedure call on it, before breakpoints are honored
  again — so a breakpoint placed on a callee's first line never fires on
  the continue that's supposed to enter it. `step()`'s "in" mode is
  therefore documented as degrading to a line step (identical to "over" at
  a call site) rather than pretending to support something the wire
  protocol doesn't expose.

A third gap was closed rather than merely documented: when a target stops
at module scope (outside any procedure — the common case for a breakpoint
before the first `Procedure` call), opcode 16 returns zero frames and
opcode 11 returns zero locals, because both are procedure-scoped. A DAP
client can't request variables at all without a frame to hang them off of,
so the naive mapping showed nothing. `pbDebugAdapter.ts` now synthesizes a
`"<file> (main)"` frame beneath any real procedure frames, populated from
opcode 9's declarations (names only) resolved to values one at a time via
`evaluate` (opcode 33), which works from any stop context.

## Practical takeaway for anyone extending this adapter

`pbSession.ts` is deliberately narrow: it implements only what has been
live-confirmed, with each exported opcode constant commented with which
PLAN.md finding backs it. Extending the debugger (data breakpoints,
richer structure/array expansion, the TCP transport) should follow the
same discipline this document describes — treat a static disassembly
result as a hypothesis, not a fact, until a spike script under
`src/debug/spike/` proves it against a real `-d` build, and record the
proof (or the correction, if the first guess was wrong) in `PLAN.md` the
same way the M5/M6 entries do.
