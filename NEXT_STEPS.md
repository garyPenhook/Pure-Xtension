# Next steps — debugger validation and resolution

## Resolution (2026-08-26, validated on this machine)

The reported SIGKILL was **not caused by ClamAV, Suricata, AppArmor, OOM, or
the kernel**. There were two separate failures which had been conflated:

1. The agent command runner rejected a shell containing `rm -f` before Bash
   was created. That is why even a command placed before the spike appeared not
   to run. It was a pre-execution policy rejection, not a signal delivered to
   the shell or process tree.
2. Once that command was removed, `node -> r2 -> PB target -> FIFO` stayed
   alive. The real failure was a 10-second `PbDebugSession.connect()` timeout:
   radare2 had removed `PB_DEBUGGER_Communication` from libc's environment
   before `exec`, so the PureBasic target used its console debugger and never
   opened the FIFOs.

The shipping-engine decision is therefore **GDB/MI**, not radare2. The installed
GDB 17.2 was tested through `--interpreter=mi2` with the real `-d -l` target and
the real `PbDebugSession`. It preserved the FIFO environment, handled the two
PureBasic debugger threads, hit the line-13 machine breakpoint repeatedly after
the blocking `Delay(2000)`, and completed the stop-to-wire bridge described
below. The machine's AV/IDS services remained running throughout every passing
test; no service or security policy needs to be disabled.

The second open question is now resolved too. The real PureBasic 6.41 standalone
GUI debugger was driven through Stop, Step, Step Over, Step Out, Run, and data
breakpoint actions while `strace` captured both ends of its anonymous-pipe
transport. PureBasic has native wire stepping; the adapter's temporary
breakpoint-on-every-line reconstruction is unnecessary.

## Goal
Confirm-or-replace the two biggest reconstructions in the adapter by capturing
what the real PureBasic IDE actually sends, and by settling why the ptrace+FIFO
chain gets SIGKILLed.

## 1. Real GUI debugger wire capture — resolved

The tested binary was `/home/gary/Downloads/testPB_debugger/pbdebugger`, SHA-256
`f39b8a8b1d40cb4fb2f618026bc5dd965d197f36caff3d33a7b54a67d37e7a5f`.
It is byte-identical to the installed PureBasic 6.41 debugger. A long-running
fixture was compiled with debugger and line metadata, then launched as follows:

```sh
pbcompiler -d -l -o debugger_probe.bin debugger_probe.pb
GDK_BACKEND=x11 strace -ff -tt -xx -s 4096 \
  -e trace=read,write -o actions.trace \
  ./pbdebugger ./debugger_probe.bin
```

`GDK_BACKEND=x11` was needed only for automated GUI control. The debugger's
normal command line is `pbdebugger <exefile> [<exe arguments>...]`; additional
arguments are passed to the debuggee, not interpreted as source names. It also
supports `pbdebugger -o <options-file> [<exefile>] [<exe arguments>...]`.

The debugger launched the target with
`PB_DEBUGGER_Communication=Pipes;13;14` and
`PB_DEBUGGER_Options=1;0;0;0`. The options fields are Unicode,
CallDebuggerOnStart, CallDebuggerOnEnd, and big-endian. The target writes
notifications on file descriptor 13 and reads commands on descriptor 14. The
framing is the already-known five little-endian `int32` header fields:
`command`, `dataSize`, `value1`, `value2`, `timestamp`, followed by exactly
`dataSize` bytes.

### Live-confirmed control commands

| GUI action | command | value1 | Observed result |
|---|---:|---:|---|
| Stop/pause | 0 | 0 | Stops at the next PB line check; `MSG_STOPPED` reason 8 |
| Step / Step X | 1 | positive count | Native step-into/count; `1` entered the called procedure |
| Step Over | 1 | -1 | Stopped on the next line without descending |
| Step Out | 1 | -2 | Stopped in the caller immediately after return |
| Run/continue | 2 | 1 | Continues and requests the type-4 `Continued` acknowledgement |

The existing `PbDebugSession.continue()` sends command 2 with `value1=0`; that
still clears the stop flag, but the real GUI uses `value1=1` when it wants the
explicit continued acknowledgement. All step stops carried the expected
0-based source line in `MSG_STOPPED.value1` and stop reason 8 in `value2`.

The local debugger source independently names these exact values in
`PureBasicDebugger/StandaloneDebugger.pb` and the IDE uses the same command
construction in `PureBasicIDE/IDEDebugger.pb`. Default standalone shortcuts are
Run F7, Stop F6, Step F8, Step Over F10, and Step Out F11.

### Live-confirmed data breakpoints

Data breakpoints use command 3's remaining subcommands:

- `value1=4`: add. `value2` selects scope (`-2` all procedures, `-1` main,
  nonnegative procedure index). Payload is `int32 id` followed by the
  NUL-terminated PB Unicode condition. A live `total > 400` condition stopped
  correctly and the GUI reported it by name.
- `value1=5`: remove; the target expects the assigned breakpoint id in
  `value2`. **PureBasic 6.41's GUI has a live-confirmed bug here:** it sends the
  low 32 bits of its local `DataBreakPoint` structure pointer instead. The row
  disappears from the window, but the condition remains active in the target
  and still stops execution. In `PureBasicDebugger/DataBreakPoints.pb`, obtain
  the row's `*Point.DataBreakPoint` and send `*Point\ID`, not the raw result of
  `GetGadgetItemData()`.
- `value1=6`: clear all data breakpoints.
- A data-breakpoint hit emits `MSG_STOPPED` with reason 9. Executable-to-debugger
  message type 39 reports condition status in `value1`: 1 added, 2 rejected,
  3 evaluation error, 4 false, 5 true; `value2` is the id.

### Adapter consequence

Add native wire operations to `PbDebugSession` for command 0 (pause), command 1
(step count/over/out), and command 2 with optional acknowledgement. Replace
`pbDebugAdapter.ts`'s breakpoint-every-line `step()` with command 1. This fixes
the current documented inability to step into a called procedure and removes a
large amount of temporary-breakpoint and stack-depth machinery.

If DAP data breakpoints are added, retain the `int32 id` allocated for the add
payload and send that same numeric id in command 3/value1 5. Do not reproduce
the standalone debugger's pointer/id mix-up.

When native wire stepping is combined with GDB/MI, temporarily disable GDB's
machine breakpoints for the step. Otherwise GDB can stop at the next line's
machine breakpoint before `PB_DEBUGGER_Check` gets a chance to emit the wire
stop. Re-enable the machine breakpoints after `MSG_STOPPED`, exactly as the
existing stop-to-wire bridge already does for a normal continue.

Full command-line/options-file notes and the disposable fixture are in
`/home/gary/Downloads/testPB_debugger/RESULTS.md` and `debugger_probe.pb`.

## 2. SIGKILL attribution — resolved

### Evidence that this run was not OS-sandboxed

- `/proc/self/status`: `NoNewPrivs: 0`, `Seccomp: 0`.
- `/proc/self/attr/current`: `unconfined` (AppArmor is loaded globally, but did
  not confine this process).
- cgroup: the normal KDE Konsole user-session scope, not a sandbox cgroup.
- `kernel.yama.ptrace_scope = 0`.
- Kernel journal: no OOM kill, process-kill, or relevant AppArmor denial.
- `clamd` and `Suricata-Main` were active during the successful GDB/MI and FIFO
  runs. `kauditd` exists as a kernel thread, but auditing is disabled on this
  boot (`audit_enabled=0`).

The decisive reproduction was to run `spike3.mjs` without the rejected cleanup
command. Node, radare2, and `blk2.bin` all remained present; the target was alive
and sleeping in `Delay()`, traced by radare2. The eventual exit code 124 came
from the deliberately-added outer `timeout`, after `PbDebugSession.connect()`
reported its own 10-second timeout. No process received SIGKILL before cleanup.

### Actual radare2 root cause

This machine has radare2 6.1.5 (`git.6.1.0-936-g9819cf82b3`). Its checked-out
source at `/home/gary/apps/radare2/libr/io/p/io_debug.c` does this in the Linux
debug launch path:

```c
static void fork_child_callback(void *user) {
    /* ... */
    r_sys_clearenv();
    RRunProfile *rp = _get_run_profile(/* ... */);
    /* ... */
}
```

Without an explicit rarun2 profile, `_get_run_profile()` tries to create the
default profile from the environment **after it has been cleared**. Mutating
Node's `process.env` (what `R2PtraceEngine.launch()` currently does) therefore
cannot pass `PB_DEBUGGER_Communication` to libc `getenv()` in the target.
`/proc/<pid>/environ` is misleading here: it still exposes stale bytes from the
original process stack even though `clearenv()` replaced libc's live `environ`
pointer. This was confirmed by the target leaving the semicolon-delimited value
untouched and printing `[Debugger] ...` to its console instead of opening a FIFO.

An explicit rarun2 rule fixes that part:

```sh
r2 -NN -q -d \
  -R "setenv=PB_DEBUGGER_Communication=FifoFiles;/path/to/pb_out;/path/to/pb_in" \
  target.bin
```

With `-R setenv=...`, the target opened both FIFOs and sent its hello/startup
messages. However, this radare2 build then stalled in `dc` after PureBasic
created its two debugger threads; neither `dbg.threads=false` (the default) nor
`dbg.threads=true` reached the machine breakpoint. Thus the explicit profile is
a useful radare2 diagnostic/workaround, but **radare2 6.1.5 is still unsuitable
as this adapter's engine on this machine**. A newer radare2 could be retested
later, but the adapter should not depend on that.

## 3. Engine decision — GDB/MI, bridge proven

### Coexistence result

GDB 17.2 worked without changing AV/IDS, AppArmor, Yama, or system services. A
batch CLI test and a separate tokenized MI2 test both did the following:

- set `PB_DEBUGGER_Communication` in the inferior with
  `-gdb-set environment ...`;
- launch the real `blk2.bin` fixture;
- connect and drain the real FIFO hello/startup messages;
- release PureBasic's stop-on-entry with wire opcode 2;
- hit `0x405171` (source line 13) on two successive loop iterations, after the
  blocking `Delay(2000)` each time;
- remove the breakpoint, continue, receive all remaining wire debug-output and
  termination messages, and observe target completion.

The essential MI commands are:

```text
-gdb-set pagination off
-gdb-set non-stop on
-gdb-set environment PB_DEBUGGER_Communication=FifoFiles;<out>;<in>
-break-insert *0x405171
-exec-run
```

The test observed the normal MI records (`^running`, `*running`, then
`*stopped,reason="breakpoint-hit"`) and identified the exact address in the
stopped frame. This is the API surface the adapter should implement; no terminal
scraping is required.

### Stop -> wire introspection bridge (live-proven)

Wire introspection does not answer at the raw machine stop, even in GDB non-stop
mode. The solution proposed in PLAN.md works and is simpler than code injection:

1. Before running, pre-arm a PureBasic wire breakpoint on the same source line
   as the machine breakpoint (wire lines are 0-based, so source line 13 is `12`).
2. Let GDB stop the main thread at the line's `mov [PB_DEBUGGER_LineNumber], 13`.
   In MI non-stop mode the record confirmed `stopped-threads=["1"]`.
3. Temporarily remove/disable that machine breakpoint and issue
   `-exec-continue --thread 1`.
4. Execution advances a few instructions into the immediately-following
   `PB_DEBUGGER_Check`; the pre-armed wire breakpoint makes PureBasic enter its
   own external-debugger wait loop and emit `MSG_STOPPED`.
5. Use the existing wire implementation for stack, variables, evaluate, and
   modification. Restore machine breakpoints before the next real continue.

The live bridge stopped with `{line: 12, reason: 7}`. Opcode 16 returned an
empty procedure stack, which is expected at module scope (the adapter already
synthesizes its `main` frame). More importantly, opcode 9 returned the real
module variables `i` and `total`, and opcode 33 evaluated `total` to `2` on the
first loop iteration. This proves the wire channel was not merely connected; it
was servicing stateful introspection at the bridged machine stop.

### Implementation direction

Replace `R2PtraceEngine` with a GDB/MI implementation behind the existing
`PtraceEngine` interface:

- spawn `gdb --quiet --interpreter=mi2` directly (no shell);
- tokenize every command and match `N^done`/`N^running` plus async `*stopped`
  records; do not rely on prompt ordering;
- enable non-stop mode before `-exec-run`;
- set inferior args, cwd, and each environment entry with MI commands (especially
  the FIFO variable), rather than relying only on the GDB parent's environment;
- map addresses with the already-tested `lineAddressMap.ts`;
- implement the five-step wire bridge above for every user-visible stop;
- use a bounded capability probe (`gdb --version`, MI startup, launch test) and
  fall back to the existing wire-only engine with an explicit diagnostic if GDB
  is unavailable or ptrace is denied.

Do **not** stop ClamAV/Suricata or weaken AppArmor as part of setup; that is not a
solution to the reproduced failure.

## Discipline
Same as the spikes: raw capture → decode with `pbSession.ts` framing → record
confirmation-or-correction in PLAN.md the way M5/M6/M8 do.

For process-attribution work, also distinguish these three cases explicitly:
pre-execution command rejection, timeout exit (for example 124), and an actual
child `exit` event with `signal: "SIGKILL"`. They are not interchangeable.
