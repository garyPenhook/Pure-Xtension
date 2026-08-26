# Pure Xtension

[![CI](https://github.com/garyPenhook/Pure-Xtension/actions/workflows/ci.yml/badge.svg)](https://github.com/garyPenhook/Pure-Xtension/actions/workflows/ci.yml)

A VS Code extension that turns VS Code into a PureBasic IDE on Linux: syntax
highlighting, IntelliSense backed by the real compiler, build/run tasks with
inline diagnostics, deep links into PureBasic's live online documentation,
and a debugger.

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
- Hover cards and `F1` open the matching page on purebasic.com for the
  built-in function, structure, interface, or language keyword under the
  cursor, rendered in a sandboxed in-editor webview.
- A searchable **Help browser** in the Explorer sidebar, organized by library
  category, plus a command-palette help search.
- Completion items carry full documentation (description + doc link) pulled
  from the same live index.

### Debugging
Standard VS Code debugging for PureBasic programs, via a `purebasic` launch
configuration:
- Launch, line breakpoints, continue, step-over/into/out, and a real
  multi-frame call stack. (The underlying wire protocol has no native step
  opcode, so stepping is emulated via temporary breakpoints — functionally
  equivalent, but each step briefly sets a breakpoint on every line of the
  file.)
- Locals for the current frame, including expandable arrays, lists, maps,
  and structures.
- Evaluate expressions in the Debug Console/hover/watch, including writing
  back to a variable.
- One known limitation: a `List<String>` can't show every element's text
  individually (a limitation of PureBasic's own debugger, not this
  extension) — its current element is shown instead. To inspect every string,
  temporarily iterate the list inside the PureBasic program with `ForEach`
  and `Debug`, or evaluate a watch expression while the program itself moves
  the list cursor. The external debugger cannot move that cursor for you.

## Requirements

- A PureBasic install (tested against v6.41 on Linux x64). The extension
  auto-detects `purebasic*` installs under common locations, or you can set
  `pureXtension.purebasicHome` explicitly.
- The C backend additionally requires a system C toolchain (gcc/clang) if
  you choose it over the self-contained ASM backend.

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
- **Pure Xtension: Open Help for Symbol Under Cursor** (bound to `F1`)
- **Pure Xtension: Search Help**

## Debugging a program

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
