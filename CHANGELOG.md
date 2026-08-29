# Changelog

## 0.1.16

- Fixed: `-ds` (debug symbols) is a valid cross-platform compiler flag on
  Linux but is rejected outright on Windows ("-ds: Unknown switch") --
  would have failed every debug-build compile there. Now Linux-only,
  shared between the debug launch and the "Build (debug)" task via one
  function instead of two duplicated copies.
- Fixed: a normal compile's stdout carries the version banner PureBasic's
  TCP handshake needs on Linux, but a real Windows install prints nothing
  at all on a normal build -- the handshake would never have worked
  there. Version detection is now a dedicated `-v` probe on every
  platform, tracked for disconnect cleanup, cwd-matched to the main
  compile, given a short dedicated timeout, and surfacing its own
  stdout/stderr on failure.
- Debug launches now auto-select TCP transport on win32 (mkfifo has no
  Windows equivalent) instead of always defaulting to FIFO.
- Added a Wine-hosted end-to-end test that compiles and runs the real
  Windows adapter/target binaries against a genuine Windows PureBasic
  install, exercising breakpoints, locals, evaluate, and native stepping
  through the production code path.

## 0.1.15

- Fixed: a debug session that ran to completion on its own (without the user
  explicitly stopping it) left its compiled binary and FIFO pair behind on
  disk -- cleanup now runs on every termination path, not just an explicit
  disconnect.
- Fixed: a debug launch with an ambiguous auto-detected compiler backend
  silently defaulted to the ASM backend instead of prompting, so a debug
  build could use a different backend than the rest of the workspace.
- Fixed: the online-help command index cache could be overwritten with an
  empty or truncated result if purebasic.com's page layout changed or a
  refresh was interrupted -- a bad refresh now falls back to the last known
  -good cache, and cache writes are atomic.
- Fixed: the built-in symbol cache was trusted after checking only its
  compiler version, so a corrupted cache file could later throw inside
  completion or hover instead of triggering a rebuild -- the full cache
  shape is now validated, cache writes are atomic, and a forced rebuild no
  longer races an already-running load.
- Fixed: an `IncludeFile` path containing `#`, `?`, or other URI-reserved
  characters could resolve go-to-definition/hover to the wrong file, due to
  a hand-rolled URI encoder -- now uses the same URI library VS Code itself
  relies on. A legitimately deep include chain (more than 8 files) no
  longer silently loses symbols either.
- Fixed: cancelling the compiler-backend picker during ordinary task
  discovery (not just an explicit build) could show up to five consecutive
  prompts, and discovery itself could prompt unsolicited before the user
  asked to build anything -- task discovery is now silent, and the
  interactive picker appears at most once, only when actually building.
- Fixed: a task whose compiler failed to spawn (e.g. a missing executable)
  could report its own exit twice.
- Fixed: editor auto-indent for `If`/`EndIf`, `Procedure`/`EndProcedure`,
  etc. only matched exact-case keywords; matching is now case-insensitive.
- Security: bumped transitive `diff`/`serialize-javascript` (pulled in by
  the dev-only `mocha` dependency) past their known advisories.

## 0.1.14

- Fixed: a compiler error reported inside an `XIncludeFile`d file could be
  duplicated in the Problems panel, or briefly flicker between one and two
  entries, because opening that included file (purely to compute the
  diagnostic's range) fired VS Code's own document-open event, which
  recursively scheduled a second, independent check that treated the
  include as its own main file and reported the same problem again under a
  separate ownership record.

## 0.1.13

- Fixed: launching via "Run Without Debugging" (or any launch config carrying
  `noDebug`) was rejected with "Property noDebug is not allowed" -- the
  `purebasic` launch schema now declares it, since this debugger always runs
  under the debug protocol regardless of that flag.
- Fixed: a compiler error reported inside an `XIncludeFile`d file during a
  build/check/debug/console task was silently dropped from the Problems
  panel instead of being attached to that included file, because the
  contributed task problem matcher only understood the single-line format
  used for errors in the file actually passed to the compiler. A second
  matcher now covers PureBasic's two-line included-file error format.
- Changed: language-server restarts triggered by rapid, back-to-back
  configuration changes (compiler path, PureBasic home, backend) no longer
  risk leaving the server on a superseded configuration -- a restart that
  arrives while one is already in flight is now queued instead of dropped.

## 0.1.12

- Fixed: a hung or unresponsive `gdb` process could freeze "Force Pause"
  indefinitely, and disconnecting while a Force Pause attach was still in
  flight leaked the owned `gdb` process and its ptrace attach past the end
  of the debug session. Every GDB/MI operation (startup, attach, command,
  stop-wait, detach, dispose) is now bounded and cancellable, and the
  `gdb --version` availability probe is asynchronous instead of blocking the
  extension host on the first Pause click.
- Fixed: completion, hover, go-to-definition, signature help, and
  find-references could resolve the wrong symbol when a name was reused
  across procedures or modules -- a procedure's local variables no longer
  leak into completion for other procedures, and a module's members no
  longer leak into (or get shadowed from) completion/hover/definition/
  signature help/references outside that module. Also fixes hover and
  go-to-definition on a `#CONSTANT`, which previously never resolved.

## 0.1.11

- Fixed: a data breakpoint persisted in the Breakpoints view was rejected
  with "the debug session has ended" when replayed by VS Code during launch
  configuration, before the target had even connected. Such requests are now
  queued and armed once the target reaches its first real stop, instead of
  being treated the same as a request arriving after the session actually
  ended.
- Fixed a related race where disconnecting could leave a request that lands
  in the gap before teardown fully completes with a raw "session closed"
  wire error instead of a clean rejection.
