# Pure Xtension

[![CI](https://github.com/garyPenhook/Pure-Xtension/actions/workflows/ci.yml/badge.svg)](https://github.com/garyPenhook/Pure-Xtension/actions/workflows/ci.yml)

A VS Code extension that turns VS Code into a PureBasic IDE: syntax
highlighting, IntelliSense backed by the real compiler, build/run tasks with
inline diagnostics, deep links into PureBasic's live online documentation,
and a debugger.

Language support, IntelliSense, build/diagnostics, and help all work on
Windows, macOS, and Linux (the extension auto-detects a PureBasic install on
each). **Debugging is fully supported and verified on Linux**, built on
POSIX FIFOs plus a GDB/ptrace-backed Force Pause for targets blocked in
native calls. **On Windows, the debugger wire protocol has also been
implemented, over a TCP transport instead** — PureBasic's `-d` builds
support this natively — and it has been protocol-verified end-to-end using
the identical code path against a Linux PureBasic install (`NetworkServer`
mode). It has not yet been run on a real Windows machine, so launching a
debug session on Windows still fails with a clear error until that
validation pass happens, the same as macOS (where debugging isn't
implemented at all yet) — neither platform silently gets an unverified
debugger.

## Features

### Language support
- Syntax highlighting, bracket/comment/indentation rules, and folding for
  `.pb` / `.pbi` / `.pbf` / `.pbp` files, matching PureBasic's own
  `;-Section` folding convention.
- A snippet library for common constructs: procedures, structures, loops,
  `Select`, `OpenWindow` boilerplate, and more.

### IntelliSense (Language Server)
- Completion, hover, signature help, go-to-definition, document symbols,
  single-file references/rename, and structure-field completion.
- Built from the **real compiler's own dumps**, not a hand-maintained
  keyword list, so it stays accurate across PureBasic versions and covers
  user-defined procedures/structures/interfaces too.
- Understands the `IncludeFile`/`XIncludeFile` graph, so symbols defined in
  included files resolve, hover, and jump correctly from the including file.

### Build & diagnostics
- Task provider for Build, Build and Run, Syntax Check, Build (debug), and
  Build (console), backend-aware and resolving the active editor's file
  automatically.
- Background syntax checking publishes errors and warnings straight to the
  Problems panel, including errors reported inside `XIncludeFile`d files.
- Status bar items for Build / Run / backend toggle.
- Supports both of PureBasic's compiler backends — the self-contained ASM
  backend (via bundled `fasm`) and the C backend (via a system C toolchain) —
  auto-detected, with a one-time prompt if both are available.

### Deep help integration
- Hover cards and `Shift+F1` open the matching page on purebasic.com for the
  built-in function, structure, interface, or language keyword under the
  cursor, rendered in a sandboxed in-editor webview.
- A searchable **Help browser** in the Explorer sidebar, organized by library
  category, plus a command-palette help search.
- Completion items carry full documentation (description + doc link) pulled
  from the same live index.

### Debugging — ⚠️ Linux fully verified; not yet enabled on Windows or macOS (see below)
Standard VS Code debugging for PureBasic programs, via a `purebasic` launch
configuration:
- Launch, line breakpoints, continue, step-over/into/out, and a real
  multi-frame call stack.
- Locals for the current frame, including expandable arrays, lists, maps,
  and structures. Container elements are decoded using their actual
  PureBasic type (including floats, strings, pointers, and structure fields),
  rather than being treated as generic integers.
- Evaluate expressions in the Debug Console/hover/watch, including writing
  back to a variable.
- Data breakpoints on simple scalar variables. Add them while execution is
  paused at a PureBasic source breakpoint; they watch for the next value
  change after that stop.

## Requirements

- A PureBasic install (tested against v6.41 on Linux x64; Windows/macOS
  install-detection is implemented but not yet verified against a real
  install on those platforms). The extension auto-detects `purebasic*`
  installs under common locations, or you can set
  `pureXtension.purebasicHome` explicitly.
- The C backend additionally requires a system C toolchain (gcc/clang) if
  you choose it over the self-contained ASM backend.

## Release validation

CI and tag releases run on the `self-hosted`, `linux`, `purebasic-6.41`
runner label. That runner provides the licensed PureBasic 6.41 Linux x64
installation at `/opt/purebasic-6.41`, the direct Insiders executable at
`/usr/share/code-insiders/code-insiders`, and `xvfb-run`. It runs the real FIFO
and TCP debugger lifecycle tests through `npm test`, then runs the extension
host suite through `xvfb-run -a npm run test:vscode`. The latter has an
extension-host result record checked by its parent process, so a failed Mocha
suite cannot be mistaken for Electron's successful exit.

## Settings

| Setting | Description |
|---|---|
| `pureXtension.purebasicHome` | Path to the PureBasic install directory. Auto-detected if empty. |
| `pureXtension.backend` | `auto` \| `asm` \| `c` — which compiler backend to use. `auto` detects and asks once. |
| `pureXtension.compilerPath.asm` | Explicit override for the ASM-backend compiler. |
| `pureXtension.compilerPath.c` | Explicit override for the C-backend compiler. |

## Commands

- **Pure Xtension: Build** / **Build and Run** / **Check Syntax**
- **Pure Xtension: Select Compiler Backend**
- **Pure Xtension: Rebuild Symbol Cache**
- **Pure Xtension: Refresh Help Index from purebasic.com**
- **Pure Xtension: Open Help for Symbol Under Cursor** (bound to `Shift+F1`)
- **Pure Xtension: Search Help**

## Debugging a program

**Linux is fully verified.** Windows has a protocol-verified TCP transport implemented, but launching still fails with a clear error there until it's been validated end-to-end on real Windows hardware; macOS debugging isn't implemented yet — see the platform note above.

Add a launch configuration to your workspace's `.vscode/launch.json`:

```json
{
  "type": "purebasic",
  "request": "launch",
  "name": "Debug current PureBasic file",
  "program": "${file}"
}
```

Then start it from the Run and Debug view, or press F5 with a `.pb` file
open (a default configuration is offered automatically if none exists yet).

## License

MIT
