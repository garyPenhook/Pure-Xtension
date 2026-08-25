# Pure Xtension

A VS Code extension that turns VS Code into a PureBasic IDE on Linux: syntax
highlighting, IntelliSense backed by the real compiler, build/run tasks with
inline diagnostics, and deep links into PureBasic's live online documentation.

> Status: language support, IntelliSense, build/diagnostics, and help
> integration are implemented and usable. A debugger integration (breakpoints,
> stepping, variable inspection via VS Code's Debug Adapter Protocol) is under
> active research — see [Debugger support](#debugger-support-in-progress)
> below.

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
- Built from the **real compiler's own dumps** (`pbcompiler -lf/-ls/-li/-qs`),
  not a hand-maintained keyword list, so it stays accurate across PureBasic
  versions and covers user-defined procedures/structures/interfaces too.
- Understands the `IncludeFile`/`XIncludeFile` graph, so symbols defined in
  included files resolve, hover, and jump correctly from the including file.

### Build & diagnostics
- Task provider (type `purebasic`) for Build, Build and Run, Syntax Check,
  Build (debug), and Build (console), backend-aware and resolving the active
  editor's file automatically.
- Debounced background syntax checking (`pbcompiler -k -q`) publishes errors
  and warnings straight to the Problems panel, including errors reported
  inside `XIncludeFile`d files.
- Status bar items for Build / Run / backend toggle.
- Supports both of PureBasic's compiler backends — the self-contained ASM
  backend (`pbcompiler`, via bundled `fasm`) and the C backend (`pbcompilerc`,
  via a system C toolchain) — auto-detected, with a one-time prompt if both
  are available.

### Deep help integration
- Hover cards and `F1` open the matching page on purebasic.com for the
  built-in function, structure, interface, or language keyword under the
  cursor, rendered in a sandboxed in-editor webview.
- A searchable **Help browser** in the Explorer sidebar, organized by library
  category, plus a command-palette help search (`$(search)` in the sidebar
  title bar).
- Completion items carry full documentation (description + doc link) pulled
  from the same live index.

## Requirements

- A PureBasic install (tested against v6.41 on Linux x64). The extension
  auto-detects `purebasic*` installs under common locations, or you can set
  `pureXtension.purebasicHome` explicitly.
- The C backend (`pbcompilerc`) additionally requires a system C toolchain
  (gcc/clang) if you choose it over the self-contained ASM backend.

## Settings

| Setting | Description |
|---|---|
| `pureXtension.purebasicHome` | Path to the PureBasic install directory. Auto-detected if empty. |
| `pureXtension.backend` | `auto` \| `asm` \| `c` — which compiler backend to use. `auto` detects and asks once. |
| `pureXtension.compilerPath.asm` | Explicit override for the ASM-backend compiler (`pbcompiler`). |
| `pureXtension.compilerPath.c` | Explicit override for the C-backend compiler (`pbcompilerc`). |

## Commands

- **Pure Xtension: Build** / **Build and Run** / **Check Syntax**
- **Pure Xtension: Select Compiler Backend**
- **Pure Xtension: Rebuild Symbol Cache**
- **Pure Xtension: Refresh Help Index from purebasic.com**
- **Pure Xtension: Open Help for Symbol Under Cursor** (bound to `F1`)
- **Pure Xtension: Search Help**

## Debugger support (in progress)

PureBasic's external-debugger wire protocol isn't documented, so this part of
the project is an active reverse-engineering effort rather than a shipped
feature. Findings so far (see `PLAN.md` for the full, verified write-up):

- The debugger is embedded in every `-d` (debug) build itself, not a separate
  daemon — `pbdebugger` (the bundled GUI) is just one possible client.
- Connection is FIFO- or TCP-based, with a documented, byte-level wire framing
  (20-byte headers, opcode-dispatched) fully mapped across all 40 known
  opcodes and 9 handler categories.
- Continue/go, and a real multi-frame call stack, are both confirmed working
  against a live target (verified with gdb, not just static analysis).
- Line-breakpoint setting (add, remove-by-key, bulk-clear) is decoded and
  live-tested against a running target — the target genuinely stops on the
  breakpointed line and genuinely runs to completion once it's cleared.
  Data/watch-breakpoint setting is decoded from the binary but not yet
  live-tested.
- Variable inspection (global scope, current-frame locals, and explicit-frame
  locals) is decoded and live-tested against a running, stopped target — real
  variable names and values (including a live `ElapsedMilliseconds()` reading)
  round-tripped correctly over the wire.

Enough of the protocol (continue, breakpoints, call stack, variables) is now
confirmed working end to end to start the real `pbDebugAdapter.ts` DAP
implementation. Throwaway protocol-spike clients live in `src/debug/spike/`
for anyone following along or picking up the remaining work (structure/array
value expansion, stepping, watch expressions, and the adapter itself).

## Development

```bash
npm install
npm run compile     # typecheck + esbuild bundle: extension host + language server
```

Launch the **Run Extension** configuration from `.vscode/launch.json` to try
it in an Extension Development Host.

## License

MIT
