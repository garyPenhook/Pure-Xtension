# Changelog

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
