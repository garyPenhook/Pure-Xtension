# Changelog

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
