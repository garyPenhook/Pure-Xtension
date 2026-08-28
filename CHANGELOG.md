# Changelog

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
