# Pure_Xtension — VS Code Extension for PureBasic

**A full-featured VS Code language extension for PureBasic with deeply integrated
help, IntelliSense, build/run tasks, and a native debugger bridge.**

- Status: M2, M3, M4 (deep help integration) complete. M5 (debugger) protocol
  spike well underway — wire opcodes mapped, FIFO transport confirmed
  working end to end with a real throwaway client
  (`src/debug/spike/fifo-client.mjs`); the multi-frame call-stack opcode
  (16) is decoded but its live behavior (why it reads back empty) is still
  an open question. DAP scaffolding (`pbDebugAdapter.ts`) not started yet.
- Target VS Code engine: `^1.85.0` (matches the existing help-viewer prototype)
- Reference PureBasic install: `/home/gary/Apps/purebasic-v6.41` (v6.41, Linux x64)
- Language: TypeScript (extension host) + a small Language Server (Node)
- Date: 2026-08-25

---

## 1. Goals

Build one cohesive extension (`pure-xtension`) that makes VS Code a first-class
PureBasic IDE on Linux (and portable to Windows/macOS), covering:

1. **Language support** — syntax highlighting, folding, indentation, brackets,
   comments, snippets.
2. **IntelliSense** — completion, signature help, hover, go-to-definition,
   document/workspace symbols, rename, references — powered by a Language Server.
3. **Deep help integration** — this is the headline feature:
   - Hover cards pull the exact reference topic for a built-in command.
   - `F1`/context command opens the matching help topic for the symbol under the
     cursor, rendered inside VS Code.
   - A dedicated searchable Help browser (webview) with index + full-text search.
   - Completion items carry documentation drawn from the help database.
4. **Build & run** — task provider + commands wrapping `pbcompiler` with problem
   matchers that surface compiler errors as VS Code diagnostics.
5. **Debugging** — a Debug Adapter (DAP) that drives PureBasic's `-d` debug builds,
   with breakpoints, stepping, variable/watch inspection, and the debug console.
6. **Bells & whistles** — status bar items, output channels, quick-pick command
   palette, form/structure browsers, snippet library, settings UI, walkthrough.

Non-goals (initial): a visual Form Designer GUI (tracked as a stretch goal), and
Windows-specific `.chm` rendering (Linux uses the `.help`/HTML pipeline).

---

## 2. Known assets & constraints (verified on this machine)

| Asset | Path / fact | Use |
|-------|-------------|-----|
| Compiler (ASM) | `compilers/pbcompiler` (→ `~/.local/bin/pbcompiler`) | build via fasm, symbol dumps |
| Compiler (C) | `compilers/pbcompilerc` | build via system C toolchain |
| Assembler | `compilers/fasm` (Flat Assembler) | backend used by the ASM compiler |
| PB home | `/home/gary/Apps/purebasic-v6.41` | resolve libraries, help, examples |
| Debugger | `compilers/pbdebugger` | external debugger backend for DAP |
| Doc maker | `compilers/pbdocmaker` | convert help → HTML for the viewer |
| Lib helper | `compilers/pbpurelibraryhelper` | enumerate library commands |
| Help data | `purebasic.help` (+ `_german`, `_french`) | zlib-compressed topic archive |
| Existing ext | `~/.vscode-insiders/extensions/local.purebasic-help-viewer-0.1.0` | reuse `.help`/`.chm` reader, webview host |

**Compiler flags we rely on** (`pbcompiler --help`, verified):

- `-k, --check` — syntax check only (fast diagnostics, no output binary).
- `-d, --debugger` — enable debugger in the produced executable.
- `-o, --output <file>` — output path.
- `-lf, --listfunctions` — dump all built-in commands to a file (IntelliSense DB).
- `-ls, --liststructures` / `-li, --listinterfaces` — dump structures/interfaces.
- `-qs, --querystructure <name>` — dump a single structure definition (on-demand).
- `-sb, --standby` — **standby/remote-control mode**; keeps the compiler resident
  for fast repeated compiles (use for the LSP's incremental checks).
- `-ds, --debugsymbols` / `-l, --linenumbering` — debug symbols + OnError lines.
- `-co, --constant Name=Value` — inject constants (surface as a task/setting).
- `-g, --language`, `-cl, --console`, `-z, --optimizer`, `-t, --thread`.

These flags are the contract the extension builds on — no guessing required.

### 2.1 Two compiler backends (verified)

PureBasic ships **two separate compiler binaries** that take the *same* flag set;
they differ only in what they generate on the way to the executable:

| | `pbcompiler` (ASM backend) | `pbcompilerc` (C backend) |
|---|---|---|
| Intermediate (`-c`) | `purebasic.asm` | `purebasic.c` |
| Reassemble/recompile (`-ra`) | `.asm` → exe via bundled **fasm** | `.c` → exe via system C toolchain |
| Assembler/toolchain | self-contained `compilers/fasm` | needs gcc/clang installed |
| Typical trade-off | fastest compile; x86/x64 focus | portability / other CPU targets; leans on the C optimizer |
| Symbol dumps / `-d` / `-k` | identical | identical |

**Design consequence:** the extension is *backend-agnostic at the flag level* — it
only chooses **which binary path** to spawn. This is captured by a single setting:

- `pureXtension.backend`: `"auto" | "asm" | "c"` (default `auto`).
  - `auto` → **ask on first use**: on the first build/check in a workspace, detect
    which binaries exist. If both are present, prompt once (QuickPick: ASM vs C,
    with a one-line trade-off) and persist the answer to **workspace** settings
    (`pureXtension.backend` = `asm`/`c`). If only one exists, pick it silently. If
    the C backend is chosen but no gcc/clang is found, warn and offer to switch.
  - Resolved once in `config.ts`; every subsystem (tasks, diagnostics, symbol DB,
    debug) reads the resolved binary path — no other code branches on backend.
  - Re-prompt available anytime via the status-bar toggle or a
    `pureXtension.selectBackend` command.
- `pureXtension.compilerPath.asm` / `.c` — explicit overrides for each binary.
- The backend choice is surfaced in the **status bar** (click to toggle) and is a
  per-launch/per-task option so a project can build C-backend even if ASM is default.

**Feature this unlocks — "View generated intermediate":** command
`pureXtension.showGeneratedCode` runs the active backend with `-c` and opens the
resulting `purebasic.asm` **or** `purebasic.c` in a read-only editor beside the
source (with the matching language mode for syntax highlighting). Handy for
learning/optimization and a natural differentiator vs the stock IDE.

**Symbol DB / diagnostics note:** `-lf/-ls/-li` and `-k` behave identically on both
binaries, so IntelliSense and error-checking work regardless of which backend is
installed or selected — the server just uses whichever `config.ts` resolves.

---

## 3. High-level architecture

```
┌────────────────────────────────────────────────────────────────┐
│  VS Code Extension Host  (src/extension.ts)                     │
│                                                                 │
│  ├─ Language client  ──LSP──►  Language Server (server/)        │
│  │      completion, hover, symbols, diagnostics, defs           │
│  │                                                              │
│  ├─ Help subsystem                                              │
│  │      HelpDatabase (parse .help / pbdocmaker HTML)            │
│  │      HelpViewer webview  +  hover/completion doc provider    │
│  │                                                              │
│  ├─ Build subsystem                                            │
│  │      PbTaskProvider (pbcompiler)  +  ProblemMatcher          │
│  │                                                              │
│  └─ Debug subsystem                                            │
│         PureBasicDebugAdapter (DAP)  ──►  pbdebugger process    │
└────────────────────────────────────────────────────────────────┘
```

Two processes we own: the **extension host** (UI, tasks, debug, help webview) and a
**Language Server** child process (heavy analysis, reused across the workspace).
Everything else (`pbcompiler`, `pbdebugger`, `pbdocmaker`) is an external tool we
spawn and speak to over stdio/sockets.

---

## 4. Feature breakdown & VS Code contribution points

### 4.1 Language basics (no server required)
- **`languages`** contribution: id `purebasic`, extensions `.pb`, `.pbi`, `.pbf`,
  `.pbp` (project), aliases.
- **TextMate grammar** (`syntaxes/purebasic.tmLanguage.json`): keywords, built-in
  commands, types (`.a .b .c .l .q .f .d .s .i` suffixes), strings, `;` comments,
  compiler directives (`CompilerIf`, `EnableExplicit`, `Procedure`…), pointers,
  labels, `#Constants`, `@Address`.
- **`language-configuration.json`**: comment token `;`, bracket pairs, auto-close,
  indentation rules for `If/EndIf`, `Procedure/EndProcedure`, `For/Next`,
  `Select/EndSelect`, `Structure/EndStructure`, etc.
- **Snippets** (`snippets/purebasic.json`): procedures, structures, common
  loops, `OpenWindow`/event loop boilerplate.
- **Folding**: region markers + syntactic folding for the block keywords above.

### 4.2 IntelliSense (Language Server — `vscode-languageserver`)
- **Symbol DB build**: on activation, run `pbcompiler -lf/-ls/-li` into a temp dir,
  parse the dumps into an in-memory index of commands, structures, interfaces,
  and constants. Cache to `globalStorage`, keyed by compiler version.
- **Workspace symbols**: parse open `.pb`/`.pbi` for `Procedure`, `Structure`,
  `Macro`, `#Constant`, `Global`, `Declare`, and `IncludeFile`/`XIncludeFile`
  graph so definitions resolve across includes.
- Providers: `completion` (built-ins + user symbols, with help docs attached),
  `signatureHelp` (parameter lists from `-lf` dump), `hover`, `definition`,
  `references`, `documentSymbol`, `rename` (user symbols only), `documentHighlight`.
- **Diagnostics**: debounce-run `pbcompiler -k --quiet` on save/idle; parse
  `filename (line) : error message` output via a shared parser into `Diagnostic`s.
  Use `-sb` standby mode to avoid per-check process startup cost.

### 4.3 Help integration (the differentiator)
**Data source: `purebasic.com`'s live online documentation, not the local
`.help` file.** The two offline pipelines originally sketched here turned out
not to be viable — see M4 notes (§6) for what was actually checked:
`pbdocmaker` has no CLI/batch mode (GUI-only, hangs headlessly), and there is
no existing `.help` parser to reuse (the local file is a proprietary
`2zlpc>`-magic binary format, and the "existing help-viewer" extension never
parsed it — it just iframed the online docs too). Fetching live docs is also
simply better here: always current, no reverse-engineering, no display
dependency.

- `server/src/onlineHelpIndex.ts` fetches
  `purebasic.com/documentation/reference/commandindex.html` (one page, every
  command → its doc URL) and caches the parsed map for 30 days.
- **Hover docs** ✅: server hover already returns the `-lf`-dump signature +
  description for built-ins; now appends `[Open documentation](url)` once the
  online index resolves.
- **Context help command** `pureXtension.openHelpForSymbol` ✅ (bound to `F1`
  within `.pb` files, `when: editorLangId == purebasic`): resolves the word
  under cursor via the language server, opens the matching purebasic.com page
  in a sandboxed webview (`src/help/helpViewer.ts`, CSP restricted to
  `frame-src https://www.purebasic.com`).
- **Still open:** a dedicated Help browser sidebar/tree view (contents
  navigation, in-page search) — deferred; the deep-link webview covers the
  common case for now. Completion-item `documentation` fields aren't wired to
  the online index yet. Hover/`F1` only cover built-in *functions* today —
  structures, interfaces, and language keywords (`If`, `For`, ...) aren't
  resolvable yet (no URL mapping source for keywords was investigated).
- No `pureXtension.help.language`/`.source` settings — those only made sense
  for the abandoned local `.help` pipeline; the online docs are English-only
  and always the current version.

### 4.4 Build & run
- **Task provider** (`tasks` type `purebasic`): tasks for *Build*, *Build+Run*,
  *Syntax Check*, *Build (debug)*, *Build (console)*, plus *Build (C backend)* /
  *Build (ASM backend)* variants. Each maps to a `pbcompiler`/`pbcompilerc`
  invocation (binary chosen by `pureXtension.backend` or a per-task `backend`
  field); args derived from settings + the active file / project file.
- **Problem matcher** (`pureXtension.problemMatcher`): regex for PB's
  `source (line) : message` format so errors land in the Problems panel and gutter.
- **Commands + status bar**: ▶ Run, ⚙ Build, 🐞 Debug buttons; output to a
  dedicated `PureBasic` OutputChannel.
- **Project awareness**: parse `.pbp` project files to know the main file, output
  path, and compiler options; expose a "Set as main file" command.

### 4.5 Debugging (Debug Adapter Protocol)
- **`debuggers` contribution**: type `purebasic`, with a `launch.json` schema
  (`program`, `args`, `stopOnEntry`, `compilerArgs`, `cwd`, `env`).
- **DebugAdapter** (`src/debug/pbDebugAdapter.ts`, built on
  `@vscode/debugadapter`): 
  1. Compile the target with the selected backend binary
     (`pbcompiler`/`pbcompilerc`) `-d -ds -l -o <tmp>` (debug build). `launch.json`
     accepts a `backend` field so a debug session can force ASM or C.
  2. Launch under `pbdebugger` (the standalone debugger backend in `compilers/`).
  3. Bridge DAP requests ↔ pbdebugger control channel: breakpoints, `continue`,
     `next`, `stepIn/Out`, `pause`, `stackTrace`, `scopes`, `variables`,
     `evaluate` (watch/hover), `setVariable`, and program stdout/stderr → debug
     console.
- **Investigation task (first debug milestone):** determine pbdebugger's control
  interface. Candidates to probe: a socket/pipe protocol, the documented
  **Debugger** library / `DebuggerCommand`, or the SDK debugger hooks in
  `sdk/`. Prototype a minimal "launch + breakpoint + continue" before building out
  the full adapter. Fallback if no programmatic channel exists: drive the built-in
  `Debug`/`OnError` output + `#PB_Debugger` line info for a lighter "trace" debugger.
- **Breakpoints**: map editor breakpoints to source lines; verify against the
  compiled line table. Support conditional/logpoints if pbdebugger allows.

### 4.6 Extra polish
- **Walkthrough** (`walkthroughs`): "Set up PureBasic" — locate compiler, open
  help, run first program, start a debug session.
- **Views**: an activity-bar container with *Help*, *Symbols* (outline of
  procedures/structures), and *Examples* (browse `examples/sources`) tree views.
- **Formatter**: `documentFormattingProvider` — keyword casing + block indent
  normalization (opt-in, config `pureXtension.format.keywordCase`).
- **Semantic tokens**: optional semantic highlighting from the server for
  user-defined procedures/constants vs built-ins.
- **Command palette**: Open Help, Search Help, Build, Run, Debug, Check Syntax,
  Insert Snippet, Locate Compiler, Rebuild Symbol Cache.

---

## 5. Repository layout

```
Pure_Xtension/
├─ package.json                 # manifest: contributes, activation, scripts
├─ language-configuration.json
├─ syntaxes/purebasic.tmLanguage.json
├─ snippets/purebasic.json
├─ src/
│  ├─ extension.ts              # activate(): wire all subsystems
│  ├─ config.ts                 # settings + compiler/home discovery
│  ├─ client.ts                 # LanguageClient bootstrap
│  ├─ help/
│  │  ├─ helpDatabase.ts        # .help/docmaker parse + topic index
│  │  ├─ helpViewer.ts          # webview + tree provider
│  │  └─ media/                 # webview html/css/js
│  ├─ build/
│  │  ├─ taskProvider.ts
│  │  └─ problemMatcher.ts
│  └─ debug/
│     ├─ debugConfigProvider.ts
│     └─ pbDebugAdapter.ts
├─ server/                      # Language Server (separate tsconfig/bundle)
│  └─ src/{server.ts, symbolIndex.ts, pbCheck.ts, providers/*}
├─ test/                        # @vscode/test-electron + unit tests
├─ .vscode/{launch.json, tasks.json}
├─ esbuild.mjs                  # bundle host + server
└─ PLAN.md
```

---

## 6. Milestones (incremental, each independently useful)

**M0 — Scaffold (0.1)**
- Yeoman/manual scaffold, `package.json` manifest, esbuild build, CI, publish
  dry-run (`vsce package`). Language id + basic activation.

**M1 — Static language support (0.2)** ✅ done
- TextMate grammar, language-configuration, snippets, folding. Manual test against
  `examples/sources/*.pb`. No server yet.
- Grammar covers comments, strings, numbers (hex/binary/float/decimal), compiler
  directives, `#Constants`, control/declaration/storage keywords, operators,
  `@`/`*` pointer-address, function-call names (`entity.name.function`), and
  `.type` suffixes (`storage.type.suffix`) split from variable names.
- Folding fixed to match PureBasic's real IDE convention (`;-Section` markers,
  verified against `examples/**/*.pb`) — the original `;{{{`/`;}}}` markers were
  never a PureBasic convention and have been removed.
- Snippet library added (`snippets/purebasic.json`): `proc`, `procs`, `if`,
  `ifelse`, `for`, `foreach`, `while`, `repeat`, `select`, `struct`, `enum`,
  `macro`, `openwindow`, `fold`.
- Verified: `tsc --noEmit` + esbuild clean; launched the real Extension
  Development Host against `examples/3d/MouseRayCast.pb` with no activation
  errors. (Screenshot-based visual QA was not possible — this sandbox's X
  display has no working pointer/window grab.)

**M2 — Build & diagnostics (0.3)** ✅ done
- `src/config.ts`: `purebasicHome`/compiler discovery (setting → `PUREBASIC_HOME`
  env → scan `~/Apps`, `/opt`, `/usr/local`, `/usr/share` for a `purebasic*` dir
  containing `compilers/pbcompiler`); `resolveBackend()` implements the
  auto-detect-and-ask-once-then-persist-to-workspace-settings flow from §2.1;
  `resolveBackendSilent()` (no prompt) is used by background diagnostics so
  save-triggered checks never pop a QuickPick.
- `src/build/problemMatcher.ts`: parses real `pbcompiler -k -q` output —
  single-line `Error:`/`Warning: Line N - message` and the two-line
  `Error: in included file '<path>'` / `Line N - message` form used for
  `XIncludeFile`d files (verified against the actual compiler, not guessed).
- `src/build/diagnostics.ts`: debounced (400ms) `-k -q` check on document
  open/save, published to a `DiagnosticCollection`; correctly attaches
  diagnostics to the *included* file's own document when the error is
  reported there.
- `src/build/taskProvider.ts`: `TaskProvider` for type `purebasic` — Build,
  Build and Run, Syntax Check, Build (debug) (`-d -ds -l`), Build (console)
  (`-cl`); tasks are backend-aware and resolve the active editor's file when
  none is specified in the task definition.
- `src/build/statusBar.ts`: Build/Run/backend-toggle status bar items, shown
  only for `purebasic` documents.
- `package.json`: `taskDefinitions` for type `purebasic`, a `$purebasic`
  problem matcher (uses an echoed `PUREBASIC_SOURCE_FILE:` sentinel line since
  the compiler's own output never names the file being checked), 4 new
  commands, `onLanguage:purebasic` activation.
- Verified: `tsc --noEmit` + esbuild clean; `parseCompilerOutput` unit-verified
  against real `pbcompiler -k -q` stdout for clean/error/included-file cases
  (bundled standalone with a stub `vscode` module, since this sandbox's
  Extension Development Host can't reliably launch — same X/pointer
  limitation noted under M1). Full in-editor GUI smoke test still pending a
  working display.

**M3 — Language Server IntelliSense (0.4)** ✅ done (GUI smoke test still pending a display)
- `server/`: separate `vscode-languageserver` process, bundled by esbuild to
  `dist/server.js` and started over IPC via `vscode-languageclient` from
  `src/client.ts`. Wired into `extension.ts` activation and into
  `pureXtension.selectBackend`/backend config-change so the client
  (re)starts once a compiler backend is resolved.
- `server/src/dumpParsers.ts`: pure parsers for the `-lf`/`-ls`/`-li`/`-qs`
  dump formats — verified against real `pbcompiler 6.41` output, not
  guessed. Notable quirks the parser had to handle: `-lf`/`-ls`/`-li` write
  to the file given by `-o`, not an argument of their own; some function
  entries have no ` - description` at all (e.g. `AddSplinePoint`); param
  lists can contain their own nested empty parens (`List()`,
  `@Callback()`), which needs a depth-aware scan rather than a
  first-`)`-wins regex.
- `server/src/builtinIndex.ts`: builds the built-in symbol index by running
  the resolved compiler once against a stub source, caches it to
  `globalStorage` keyed by `pbcompiler -v` output (note: `-v` exits with
  status 1 despite succeeding — verified, not assumed), and reloads from
  cache on matching version. `pureXtension.rebuildSymbolCache` command
  forces a rebuild.
- `server/src/workspaceSymbols.ts`: regex/line-based extraction of
  user-defined `Procedure`/`Structure`/`Interface`/`Macro`/`#Constant` from
  a single document — verified against `examples/sources/*.pb`.
- Providers wired: `completion` (built-ins + current-document symbols),
  `hover`, `documentSymbol`, `definition` (current document only).
- Verified: `tsc --noEmit` clean for both `tsconfig.json` and
  `server/tsconfig.json`; esbuild bundles both entry points; parsers
  smoke-tested against real `pbcompiler -lf/-ls/-qs` dumps (1823/571
  entries, all edge cases above) and real example sources; `builtinIndex`
  round-tripped through a real build + disk-cache load. Self-review caught
  and fixed an out-of-spec LSP `uinteger` (`Number.MAX_SAFE_INTEGER` used
  as a character offset) and an unguarded `client.start()` that could leave
  the client in a half-started state on failure.
- `server/src/includeGraph.ts`: walks the `IncludeFile`/`XIncludeFile` graph
  from the active document (paths resolved relative to the including file's
  directory, cycle-safe via a visited-URI set, depth-capped at 8), reading
  unopened files straight off disk and open ones through the LSP's own
  `TextDocuments` cache. Every symbol it returns is tagged with the URI it
  was declared in. `completion`, `hover`, and `definition` were switched from
  single-document `extractWorkspaceSymbols` to this, so a symbol defined in
  an included file now resolves, hovers, and jumps to the *included* file
  (not just the entry file) — verified against a synthetic
  `main.pb` → `XIncludeFile "lib.pbi"` fixture (`resolveIncludeGraphSymbols`
  correctly tags `LibFunc` with `lib.pbi`'s URI).
- `signatureHelp` (`server/src/server.ts`): depth-aware backward scan from
  the cursor finds the enclosing, still-open `(` and counts top-level commas
  for the active-parameter index; resolves against built-in functions (params
  from the `-lf` dump) or user procedures (params from
  `extractWorkspaceSymbols`, now include-graph-aware).
- `references`/`rename` (`onReferences`/`onPrepareRename`/`onRenameRequest`):
  word-boundary-aware occurrence search scoped to the **current document
  only** — cross-file rename/references were deliberately deferred (renaming
  across files without type-aware call-site verification risks silently
  corrupting unrelated identically-named symbols in other files; single-file
  scope is the safe default until real cross-file usage tracking exists).
- Structure field completion: `workspaceSymbols.ts` now parses fields inside
  `Structure`/`EndStructure` blocks (same field-line shape as the `-qs` dump,
  reusing `StructureField`) so user-defined structures get field completion
  for free; `builtinIndex.ts` adds an on-demand, per-name-cached `-qs <name>`
  query (`queryStructureFields`) for built-in structures. A first-occurrence
  `variable.TypeName` scan maps identifiers to their declared structure type,
  so typing `variable\` completion-triggers on either source. Verified `-qs`
  behavior directly against `pbcompiler 6.41`: it always exits 0, including
  for an unknown structure name (empty output file) — confirmed, not
  assumed, so `queryStructureFields`'s try/catch is a defensive backstop, not
  the primary "not found" path (that's just an empty array). Field parsing
  verified against real structures in
  `purebasic-v6.41/examples/3d/TerrainPhysic.pb`.
- `-sb` standby-mode investigation (spike, not shipped): traced `pbcompiler
  -sb` under `strace -f` with a held-open FIFO on stdin (verified the FIFO
  itself doesn't spuriously EOF — a control test with a plain `while read`
  loop against the same FIFO setup stayed alive across multiple writes).
  Confirmed facts: it's a single process (no fork/exec of a worker), it
  writes `STARTING\t<ver>\t<name>\n` then `READY\n` to stdout, then
  `read(0, ...)`s one line from stdin. Sending a source filename (with or
  without leading `-k -q`) is read successfully, but the process then issues
  a second `read(0)` that returns 0 and calls `exit_group(0)` immediately —
  no compile output, no diagnostics, no second `READY`, even though stdin's
  write end was verifiably still held open. Whatever turns that one line
  into a "run a check and loop" action (a second line? a specific
  terminator? a different transport than piped stdin?) is not established by
  black-box testing, and PLAN.md's own fact-verification rule is to not ship
  a guess. **Decision: keep the per-check `pbcompiler -k -q <file>` spawn
  (`src/build/diagnostics.ts`, 400ms debounce) as the shipping diagnostics
  path**; `-sb` stays a documented open question (§8, risk 3) rather than a
  half-implemented feature.
- Cross-file references/rename: still deliberately out of scope (see above).
- M3 is otherwise feature-complete: completion, hover, documentSymbol,
  definition, signatureHelp, references/rename (single-file), and structure
  field completion all work across the include graph, backed by real
  `pbcompiler` dumps. Full in-editor GUI smoke test still pending a working
  display (same X/pointer limitation as M1/M2) — `tsc --noEmit` (both
  tsconfigs) and the esbuild bundle are clean, and the new parsing/resolution
  logic was smoke-tested against real PureBasic source and real `pbcompiler`
  output, not just typechecked.

**M4 — Deep help integration (0.5)** ← headline — ✅ done
- **Design change from the original plan (verified, not guessed):** the two
  offline pipelines in §4.3 don't actually exist. `pbdocmaker` is GUI-only —
  no `--help`, no flags in the binary's string table, and it opens a window
  that hangs headlessly (this sandbox has no working display, same limitation
  noted under M1). The "reuse the existing help-viewer's `.help` reader"
  assumption was also wrong: that extension's source (recovered from its
  bundled sourcemap) never parses `.help` at all — for `.help` files it just
  opens an iframe to the online docs; its `chmlib-ts` reader only handles
  real `.chm` files. `purebasic.help` itself is a proprietary binary format
  (`2zlpc>` magic, `1zlb`-tagged chunks) with no existing parser anywhere.
  **Decision: use `purebasic.com`'s live documentation instead** — always
  current, no reverse-engineering, no display dependency. Scope trimmed to
  deep-links (hover link + `F1` webview), not an offline full-text-search
  browser.
- `server/src/onlineHelpIndex.ts`: fetches
  `purebasic.com/documentation/reference/commandindex.html` — a single page
  listing every command as `<a href=../lib/name.html>Name</a>` (verified
  against the live page: 1888 entries, all matching that exact unquoted-href
  shape, no exceptions) — and parses it into a lowercase-name → full-URL map.
  Cached to `globalStorage/help-index.json` with a 30-day TTL; falls back to
  a stale cache if the fetch fails (offline-friendly). Verified end-to-end
  (real fetch, real parse, cache write + cache-hit reload) and spot-checked
  3 resolved URLs (`string/left.html`, `gadget/addgadgetitem.html`,
  `spline/addsplinepoint.html`) all return HTTP 200.
- `server/src/server.ts`: fetches the index in the background on
  `initialize` (never blocks hover/completion). `onHover` appends an `[Open
  documentation](url)` link to built-in function hovers once the index is
  loaded. New requests: `pureXtension/helpUrl` (resolve a symbol → URL, used
  by the `F1` command) and `pureXtension/rebuildHelpIndex` (force a re-fetch,
  mirrors `rebuildSymbolCache`).
- `src/help/helpViewer.ts`: single reused `WebviewPanel` (CSP restricted to
  `frame-src https://www.purebasic.com`) that iframes the resolved doc page —
  same pattern the old help-viewer extension used for its online fallback.
- `pureXtension.openHelpForSymbol` command, bound to `F1` when
  `editorLangId == purebasic`: resolves the word under the cursor via the
  language client, opens it in the help webview. `pureXtension.rebuildHelpIndex`
  command added alongside `rebuildSymbolCache` for parity.
- Verified: `tsc --noEmit` (both tsconfigs) and esbuild clean.
- **Completion documentation** (§4.3's last bullet) ✅: each built-in
  function's completion item now gets a Markdown `documentation` field
  (description + `[Open documentation](url)`) built eagerly from the
  in-memory help index — no `resolveCompletionItem` round-trip needed since
  the lookup is just an in-memory map read for all ~1823 functions.
- **Built-in structure/interface hover** ✅: `onHover` is now async and, for
  a built-in structure or interface name (from `builtinIndex.structures` /
  `.interfaces`, the `-ls`/`-li` dumps — names only, no descriptions),
  reuses the same on-demand `-qs <name>` field lookup
  (`getBuiltinStructureFields`, already built for structure-field
  completion) to show the field list, plus the doc link. Verified against
  the real compiler: `buildBuiltinIndex` + `queryStructureFields` round-
  tripped on a real built-in structure (`GdkEventAny`), fields matched the
  `-qs` dump shape (name/type/pointer/array-size). Interfaces have no field
  data (`-qs` is structures-only) so they only get name + link, not a
  method list — that's a real gap, not a bug: interface methods aren't
  captured by any dump parser yet.
- **Help browser sidebar** ✅ (started): `pureXtension.helpBrowser`, a
  `TreeDataProvider` under the Explorer view (`views.explorer` — no custom
  activity-bar icon asset needed for this). Two-level tree: 88 library
  categories (derived from the doc URL's path segment, e.g.
  `.../documentation/string/left.html` → category `string` — verified
  against all 1888 real entries, zero fell into the `other` fallback), each
  expanding to its commands sorted alphabetically; clicking a leaf opens it
  in the same help webview as `F1`. A refresh button (`$(refresh)` in the
  view title, bound to the existing `pureXtension.rebuildHelpIndex`) forces
  a re-fetch and repopulates the tree.
  - **Fixed before shipping:** `HelpIndex.commands` previously stored only
    the lowercase key with the URL as the value, discarding the real-case
    command name (`"AddGadgetItem"`) the tree needs to display — the map's
    value is now `{ name, url }` (`server/src/onlineHelpIndex.ts`).
  - **Fixed before shipping:** the tree's in-memory entry cache checked
    `if (!this.entries)`, but `listHelpEntries()` returns `[]` (not
    `undefined`) when the language client hasn't started yet (e.g. sidebar
    expanded before a compiler backend resolves) — `[]` is truthy, so that
    empty result would've been cached permanently and the tree would stay
    blank forever with no way to recover short of a manual refresh. Now
    retries on an empty result, and `extension.ts` also calls
    `helpTree.refresh()` every time the language client (re)starts (initial
    activation, backend switch, `pureXtension.compilerPath`/`backend`
    config changes) so a sidebar opened early self-heals once the client
    comes up.
  - **Fixed before shipping:** the `commands` shape change above also broke
    the disk cache written by the *previous* commit (which stored
    `Record<string, string>`, name→url) — an old cache would parse without
    error but hand back `entry.name`/`entry.url` as `undefined` for every
    tree node, silently, for up to the 30-day TTL. Renamed the cache file
    (`help-index.json` → `help-index-v2.json`) so an old-shape cache just
    misses and gets re-fetched, instead of being trusted as-is. Caught by
    the `/code-review` self-review pass, not by testing (there was no
    real on-disk cache from a live run to test against in this sandbox).
  - Verified: category-extraction regex tested against a real fetch of all
    1888 `commandindex.html` entries (88 categories, 0 uncategorized).
    `tsc --noEmit` (both tsconfigs) and esbuild clean.
- **Language-keyword hover/help** ✅: `server/src/keywordHelp.ts` is a
  hand-built `keyword → reference/*.html` table — there's no machine-
  readable index for this (`commandindex.html` only covers functions/
  structures/interfaces, confirmed empty for `Goto`/`End`/`Swap`/`And`/etc.),
  and several keywords share one prose topic page with no per-keyword
  anchor (`If`/`ElseIf`/`Else`/`EndIf` all → `if_endif.html`; `Goto`/`End`/
  `Swap` all → the catch-all `others.html`, confirmed by fetching that page
  and finding all three literally on it). Built by walking
  `documentation/index.html`'s "Language fundamentals" section and
  confirming every one of the 26 distinct target pages returns HTTP 200.
  Wired into `onHover` as the last fallback (after builtin functions,
  workspace symbols, builtin structures/interfaces) and into
  `pureXtension/helpUrl` (so `F1` resolves keywords too, not just
  functions). Verified: every one of the 70 keywords in
  `syntaxes/purebasic.tmLanguage.json`'s control/declaration/storage/
  operator patterns has a table entry (checked programmatically against
  the actual grammar file, not by eye) — zero gaps.
- **Help search** ✅: `pureXtension.searchHelp` (`src/help/helpTreeProvider.ts`)
  — a `QuickPick` over every entry in the online help index (name + category,
  `matchOnDescription` so typing a category like `string` narrows results
  too), reusing the same `listHelpEntries`/`openHelpEntry` path as the tree.
  Bound to a `$(search)` button in the Help browser's title bar (left of the
  existing refresh button) and to the command palette; guards against an
  empty index (client not started yet) with a message instead of showing a
  blank picker.
- **Remaining, accepted gaps (not blocking M4 completion):** interface hover
  still has no method list — `-qs` (the only per-symbol dump PureBasic's
  compiler exposes) is structures-only, confirmed against `pbcompiler
  --help`: there is no `-qi`/interface equivalent. Scraping each interface's
  individual purebasic.com page for its method table is possible in
  principle (interfaces do have doc pages, unlike keywords) but is new
  scope, not a fix to something broken — deferred rather than guessed at.
  Keyword hover also doesn't distinguish e.g. `Return` (Gosub) from
  `ProcedureReturn` semantically — both resolve correctly, the mapping is
  just per-token, not context-aware. Neither gap blocks real usage.

**M5 — Debugger (0.6)** — spike started
- **Protocol spike (verified against the real binaries, not guessed):**
  `compilers/pbdebugger` is itself a GTK GUI application (confirmed via
  `strings` — `gtk_scrolled_window_add_with_viewport` etc. — and `strace`,
  which shows it opening X11/GTK/dbus sockets on launch with no args). It is
  **not** a headless protocol daemon we spawn and talk to.
  - The debugger is actually embedded in the *compiled target executable*.
    A `pbcompiler -d` build run standalone (`strace -f`) does **no**
    fork/exec/socket at all — it just writes `[Debugger]  <value>` straight
    to stdout for each `Debug` statement. This confirms the §4.5 fallback
    ("`Debug`/`OnError` trace approach") works today with zero extra
    plumbing: redirecting/capturing a debug-build's stdout is a legitimate,
    already-working "debug console" for logpoint-style output.
  - For a *real* attached debugger, the target executable looks for
    `/tmp/.pbdebugger.out` (warns and ignores it if stale) and
    `~/.pbdebugger.prefs`; these are written by the real PureBasic IDE and
    are the connection handoff — a file-based rendezvous, not a fixed port.
  - `compilers/debugger.a` (the static lib linked into every `-d` build) is
    **unstripped** and was disassembled directly (`ar x` + `objdump -d -r
    -M intel`) — this is where the real protocol details came from:
    - Communication is pluggable: `PB_DEBUGGER_ClientPlugin` /
      `ServerPlugin` / `PipePlugin` / `FifoPlugin`, backed by
      `NetworkCommunication.o` (TCP) and `UnixPipeCommunication.o` (named
      FIFOs). `FifoConnect` parses the rendezvous file's contents with
      `strchr`, `fopen64`s a FIFO pair, sets them `O_NONBLOCK` via
      `fcntl64`, and spawns `ExternalDebugger_CommunicationsThread` on a
      `pthread`.
    - The TCP path (`ServerConnect`/`ClientConnect`) is a real, adoptable
      wire protocol: the target listens ("`[Debugger] Waiting for network
      connection on port %i.`" / "`...on %s (port %i).`"), the client sends
      `CONNECT %i DEBUGGER\n\n` (parsed with `sscanf`), and the server
      replies with an `ACCEPT`/`ERROR %i ... Message: %s` line handshake.
      An optional password/encryption step follows (`ENCRYPTION`,
      `EncryptionHash`, `[Debugger] Password: `, seeded from
      `/dev/urandom`) — `SetupEncryption.isra.0` gates both connect paths.
      Other framing keywords confirmed in the string table: `Length`,
      `WrongVersion`, `InvalidRequest`, `CallOnStart`/`CallOnEnd`,
      `Unicode`/`BigEndian` (so the protocol is endian/charset-negotiated,
      not fixed).
    - `ExternalDebugger.o` exports the full command surface as
      `PB_DEBUGGER_*` symbols — confirms this is a real, complete external
      debugger API, not a stub: `ExamineVariables`/`ModifyVariable`,
      `ExamineArrays`/`Maps`/`LinkedLists`/`Structures`, breakpoints
      (`AddDataBreakPoint`, `ClearDataBreakPoints`, `NbBreakPoints`,
      `BreakpointSort`, `ExecBreakPoints`), call-stack/procedure info
      (`GetProcedureCall`/`Name`/`ID`/`Module`), `IncomingCommand`/
      `CommandStack` with `ByteSwapIncomingCommand`/`ByteSwapOutgoingCommand`
      (binary, byte-order-aware framing after the text handshake).
  - **`IncomingCommand` opcode table — mapped (verified against the real
    `.o`, not guessed):** `ExternalDebugger.o`'s `PB_DEBUGGER_IncomingCommand`
    (`objdump -d -r` at offset `0x6ca0`) reads one message into a stack
    buffer, then linear-scans a 40-entry `{opcode:int, handler:funcptr}`
    table living in `.data.rel.ro` (relocations resolved by cross-referencing
    `readelf -r .rela.data.rel.ro` against `nm`'s local-symbol table) and
    calls the matching handler with `(buffer, payload, connection)`. The 40
    opcodes group into 9 handler functions — the *category* of every opcode
    0–40 is now known, though the sub-operation within a category isn't
    (each handler re-decodes that from the payload itself, which needs
    further per-handler disassembly, not just the dispatch table):
    - `0,1,2,36` → `ExternalDebugger_Control` (connection/session control)
    - `3` → `PB_DEBUGGER_ExternalBreakpoints` directly (breakpoint list, not
      routed through an `ExternalDebugger_*` wrapper)
    - `4,5,6,7` → `ExternalDebugger_Assembly`
    - `8,33,34,35` → `ExternalDebugger_Expression` (watch/hover eval)
    - `9,10,11,17` → `ExternalDebugger_Variables`
    - `12,13,14,15` → `ExternalDebugger_ArraysLists`
    - `16,28,29,30,31,32,38,39,40` → `ExternalDebugger_Misc`
    - `18,19,20` → `ExternalDebugger_Procedures` (call stack)
    - `21,22,23` → `ExternalDebugger_Watchlist`
    - `24,25,26,27` → `ExternalDebugger_Libraries`
    - opcode `37` is absent from the table (not a gap in the extraction —
      confirmed absent from all 40 entries).
    No SDK header (`sdk/c/PureLibraries/Debugger/DebuggerModule.h`) exposes
    these numbers — that header is the target-side library API, not the
    wire opcodes — so this table only exists from this disassembly.
  - **Per-category semantics — cross-checked (verified by which internal
    `PB_DEBUGGER_*` helpers each handler calls, from `objdump -d -r` on
    each function's address range, plus one handler fully instruction-level
    decoded):**
    - `ExternalDebugger_Control` (opcodes `0,1,2,36`) fully decoded at the
      instruction level: it re-switches on the *same* opcode field
      (buffer offset `0x0`) with a sub-command field at buffer offset
      `0x8` for opcode `1`. Confirmed cases: opcode `36` writes buffer
      offset `0x8` straight into the `PB_DEBUGGER_WarningMode` global
      (SetWarningMode); opcode `1` sub-command `-1` packs two 32-bit
      fields (buffer `0x48`/`0x18`) into one reply as an 8-byte pair
      (looks like a version/build-pair query); sub-command `-2`
      decrements a counter read from buffer `0x48` (0 clamps to an
      error reply); sub-command `-3` calls the exported
      `PB_DEBUGGER_GetExecutableLine(offset)` — i.e. an address→source-line
      lookup, the core of what a DAP `stackTrace`/breakpoint-line
      resolution needs; sub-command `>0` echoes it back tagged type `1`.
      Every reply path writes to a response struct at offsets `0x8`
      (type tag), `0xc`/`0x10`/`0x14` (payload), `0x24` (status/size) —
      this response struct's shape recurs across handlers and is the
      next thing worth nailing down precisely.
    - **Correction to first-pass guess, both now instruction-level decoded:**
      `ExternalDebugger_Procedures` (`18,19,20`) is **not** the call stack —
      it's the procedure name/module lookup table plus profiler call
      counts: opcode `18` loops `PB_DEBUGGER_ProcedureBank`'s count calling
      `GetProcedureID`/`GetProcedureName`/`GetProcedureModule` per index and
      concatenates the strings into one reply (a name table built once, not
      per-frame); opcode `19` reads a signed index from buffer offset `0x8`
      and zeroes one `ProcedureCounts[index]` entry, or all of them if the
      index is negative (a profiler-counter reset); opcode `20` sends the
      whole `ProcedureCounts` array, byte-swapped if `PB_DEBUGGER_ByteSwap`
      is set. This is the IDE's "procedure call statistics" panel, not
      `stackTrace`.
      **Second correction (opcode `6`'s `PrintStack` is NOT a call-frame
      walker either — decoded its actual object, `Stack.o`, not just the
      caller):** `PB_DEBUGGER_PrintStack` calls `PB_DEBUGGER_GetStackInfo`
      for one bound (either `PB_DEBUGGER_StackStart` for the main thread,
      or a thread-struct field for others — a single stack-base *address*,
      not a frame list), then walks raw CPU stack **memory** from the
      current stack pointer up to that base, calling a helper
      (`GetStackElementInfo`, decoded) per 8-byte slot that tries to match
      the slot's value against a known variable via
      `PB_DEBUGGER_ExamineVariables`/`NextVariable` and formats
      `"VarName = value"` (or `"$hex = value"` if no variable matches, or
      a signed/unsigned/pointer-typed rendering based on a type tag). **This
      is the raw "CPU Stack" memory-inspector view** (the kind shown in
      `debugger_*.png`-style screenshots), not a symbolic call-frame list —
      opcode `6` is off the table as a `stackTrace` source.
      **Net implication, at this point in the investigation:** no wire
      opcode found so far returns a multi-frame call stack with per-frame
      name/line — but see the **third correction** immediately below, which
      overturns this once opcode `16` (filed under `Misc`) got the same
      instruction-level treatment. Left in place so the record shows the
      reasoning wasn't skipped, only revised.
      **Third correction — opcode `16` (dispatched to `ExternalDebugger_Misc`,
      previously read as "grab-bag: profiler + module/file metadata, not
      relevant to a first pass") *is* a genuine multi-frame call stack.**
      The category-name heuristic used for the other opcodes (read off which
      exported `PB_DEBUGGER_*` helpers a handler calls) undersold this one —
      `Misc` is one function handling nine unrelated opcodes, and opcode
      `16`'s case block doesn't call anything with "stack" in the name, so
      the first pass filed it as irrelevant. Instruction-level decoding says
      otherwise:
      - **Method note:** `ExternalDebugger_Misc`'s internal opcode dispatch
        (a *second*, smaller jump table nested inside the `Misc` handler,
        separate from the top-level 40-entry `IncomingCommand` table) lives
        in `.rodata+0x1b8` as `R_X86_64_PC32` relocations against `.text`
        labels — these read as all-zero in a plain `objdump -d -r` on the
        relocatable `.o` (relocations are unresolved until link time), so
        the earlier per-category pass could only infer this block's
        boundaries from surrounding control flow, not confirm each case's
        target address. Forcing resolution — `ld -shared -o ext.so
        ExternalDebugger.o --unresolved-symbols=ignore-all -z notext`, then
        `objdump -d` on the resulting `.so` — turns those relocations into
        concrete addresses, so all 25 case targets (opcodes `16`–`40`) could
        be read directly out of the table instead of inferred. Confirms the
        table shape matches the outer opcode-category map exactly: opcodes
        `17`–`27` and `33`–`37` land on the shared default/no-op return
        (dispatched to the *other* eight handlers instead, so `Misc` never
        actually acts on them), and `16`, `28`–`32`, `38`–`40` land on 8
        distinct case blocks.
      - **Opcode `16`'s case block, fully decoded:** reads the per-thread
        struct (`PB_Object_GetThreadMemory` result, dereferenced — call it
        `Thread`; no DWARF survives in this `.o`, so field names below are
        inferred from behavior, not read off a symbol). `Thread+0x48` is a
        **count** used as a loop bound; `Thread+0x40` is a **32-byte-stride
        record array**. For `index` in `0..count-1`: `record =
        Thread+0x40 + index*32`; a 4-byte field at `record+0x10` is
        byte-swapped per the `PB_DEBUGGER_ByteSwap` global (same idiom seen
        in `Control`, §above) and copied straight into the outgoing buffer;
        then the *exported*, separately-decoded `PB_DEBUGGER_GetProcedureCall`
        is called with `(index, outBuf)` and appends a formatted string
        right after that 4-byte field. This repeats per index, so the reply
        is a **flat concatenation of `(int32, cstring)` pairs, one pair per
        active call**, sent as one `SendCommandWithData` reply tagged type
        `0x16`. `(int32, cstring)` per frame is exactly the minimum a
        `stackTrace` frame needs (line/id + display name).
      - **`PB_DEBUGGER_GetProcedureCall` itself** (exported, defined in
        `Procedures.o`, decoded separately from the `Misc` handler that
        calls it): given `index`, it re-derives the *same* 32-byte-stride
        record array via `Thread+0x40`, reads the record's first 4-byte
        field, and uses it as an index into a second global pointer table to
        fetch a call-signature descriptor string (procedure name plus a
        compact byte-code for its parameter types/count). It then formats a
        human-readable `ProcName(arg1, arg2, ...)` string by walking that
        byte-code through a large per-parameter-type switch (not decoded
        further — out of scope until `variables`/`evaluate` needs
        per-argument typed values rather than a display string).
      - **What `record+0x10` (the raw int32) actually represents is still
        unconfirmed** — plausibly a source line number or a return-address-
        derived value, but nothing in this stripped-of-DWARF object
        confirms which. Cheapest next check: run a real `-d` build with
        nested procedure calls, capture the FIFO traffic for opcode `16`'s
        reply, and diff the int32 against known source line numbers for
        each call site.
      - **Net implication for the DAP adapter's design (supersedes the
        single-frame conclusion above):** a real, walkable multi-frame
        `stackTrace` is possible after all — `Thread+0x48` active calls,
        each with a resolvable display name (`GetProcedureCall`) and an
        integer field of unconfirmed meaning (`record+0x10`, likely the
        line). `ExternalDebugger_Procedures` (opcodes `18`-`20`, a
        name/profiler table) and `PrintStack` (opcode `6`, a raw
        stack-memory dump) are still correctly ruled out, exactly as
        decoded above — the miss was scoping "call stack" search to opcodes
        whose *handler function name* suggested it, when the real one was
        filed under the generic `Misc` bucket. This removes M5's
        "synthetic single-frame `stackTrace`" fallback as the default plan;
        pending only the `record+0x10` field check above, a GDB-style
        multi-frame adapter is back on the table.
      - **Live wire test — connection setup and framing confirmed end to
        end; opcode `16`'s data content still unconfirmed.** Ran a real
        throwaway Node client (`src/debug/spike/fifo-client.mjs`, kept as
        the M5 spike's throwaway prototype — see next-spike-steps item 2)
        against a real `pbcompiler -e ./test.bin -d test.pb` build with two
        nested procedure calls (`Outer` → `Inner`, blocked in a `Delay`
        mid-call so there was something to inspect). Findings:
        - **The real connection setup is far simpler than the on-disk
          `/tmp/.pbdebugger.out` file this section previously described,
          and that file's format claim needs correcting.** Decoding
          `PB_DEBUGGER_InitExternal` (`ExternalDebugger.o`) shows the file
          is only a *fallback* checked after two other paths: `argv` flags
          (`--debuglisten`, `--debuglisten=`, `--debugconnect=`,
          `--password=`, scanned via `PB_ArgC`/`PB_ArgV`) and an
          environment variable, `PB_DEBUGGER_Communication`
          (string literal confirmed at `.rodata.str1.1+0x1a8`), checked
          *first* via `getenv`. Its value has the same shape the on-disk
          file's inner line does: `<PluginName>;<connect-string>`, split on
          the first `;`, where `PluginName` is matched against 4 exported
          plugin-descriptor globals (`.data.rel.local` in
          `UnixPipeCommunication.o`/`NetworkCommunication.o`, each
          `{name, flags, Connect, Send, Receive, Close}`, confirmed by
          resolving relocations rather than guessing) whose *actual* string
          names are `"NetworkClient"`, `"NetworkServer"`, `"Pipes"`, and
          **`"FifoFiles"`** — not the shorthand `"Fifo"` this section
          assumed earlier. Setting `PB_DEBUGGER_Communication=
          "FifoFiles;<outFifoPath>;<inFifoPath>"` before spawning the `-d`
          build skips the on-disk file, its timestamp-freshness check, and
          its multi-line format entirely — confirmed working live. The
          on-disk-file format itself turned out to be more elaborate than
          previously assumed too (a magic first line literally reading
          `PB_DEBUGGER_Communication`, a `%d` timestamp line checked against
          `PB_DEBUGGER_Timestamp()` with the same 19-second staleness
          window as before, then the actual descriptor line) — not
          re-verified live since the env var makes it moot for a tool that
          controls its own launch, as a DAP adapter does.
        - **Wire framing confirmed bidirectionally, live, not just from
          static decode.** Every message in both directions is a fixed
          20-byte header (`int32` type/opcode, `int32` payload length, 3
          more `int32` fields) optionally followed by exactly `header+0x4`
          bytes of payload — confirmed by instruction-level decoding
          `UnixPipeCommunication.o`'s `Send` (two `fwrite`s: `fwrite(header,
          1, 0x14, out)` unconditionally, then `fwrite(payload, 1,
          header[1], out)` only if length `>0`) and by the live capture
          matching that shape exactly on every message received.
        - **The target sends one unsolicited message immediately on
          connect**, before any request is sent: type `0`, payload = the
          two `PB_DEBUGGER_SourcePath`/`FileName` strings concatenated as
          `<dir>\0<file>\0` (confirmed live: `.../src/debug/spike\0test.pb\0`).
        - **The first request sent after that hello always gets back a
          generic `type=2, len=0` reply, regardless of its opcode** — tried
          this with both a raw opcode `16` request and a `Control` opcode
          `1` sub-command `-1` (version-pair query) as the first message;
          both got `type=2, len=0`. Only the *second* request onward gets
          dispatched to its real handler (confirmed: the second message,
          opcode `16` again, came back correctly tagged `type=22`). Not yet
          explained — plausibly a priming/handshake message the target
          expects before real dispatch starts, or an artifact of how
          `ExternalDebugger_CommunicationsThread`'s read loop drains its
          first buffered read. Workaround for now: always send one
          throwaway request immediately after the hello and discard its
          reply.
        - **Opcode `16`'s live reply was well-formed but empty** (`type=22,
          len=0`) even while the target was genuinely blocked inside two
          nested procedure calls. This means the "`Thread+0x48` active-call
          count" read in the static decode above was *not* counting
          `Outer`/`Inner` at the moment of the request — the multi-frame
          call-stack conclusion from the static decode is **not yet
          confirmed live and should be treated as unverified** until this
          is explained. Leading hypothesis, not yet tested: `Thread` comes
          from `PB_Object_GetThreadMemory()`, which is almost certainly
          per-*OS*-thread (TLS-style) data — and `ExternalDebugger_Misc`
          runs on the debugger's own `ExternalDebugger_CommunicationsThread`
          pthread, not the target program's main thread. If
          `PB_Object_GetThreadMemory` returns the *calling* thread's record
          (the comms thread's, which never enters `Inner`/`Outer`) rather
          than the target's main thread's, opcode `16` would always read
          back empty for a single-threaded target queried this way,
          regardless of real call depth. Needs one more experiment: check
          whether one of the header's three spare `int32` fields is a
          target-thread-ID selector (plausible given the `Libraries`
          category's `SuspendingThread`/`SuspensionFlag` — thread-scoped
          operations exist elsewhere in this protocol), or find where
          `PB_Object_GetThreadMemory` actually resolves "current thread".
        - The target printed `[Fatal Debugger Error] Broken communication
          pipe` when the script closed its FIFO file descriptors and
          exited — expected, not a bug: the script tore down the pipes
          without sending a clean disconnect message. The real DAP adapter
          will need a real disconnect opcode (likely in the `Control`
          category, unconfirmed which) sent before closing FIFOs.
    - `ExternalDebugger_Variables` (`9,10,11,17`) calls
      `ExamineVariables`/`NextVariable`/`ExamineStructure`/
      `NextStructureField`/`GetProcedureIndex` — DAP's `variables`
      request (locals in scope at the current line, given the single-frame
      model above — there's no "selected stack frame" to scope it to).
      Not yet instruction-level decoded.
    - `ExternalDebugger_ArraysLists` (`12,13,14,15`) calls
      `ExamineArrays`/`ExamineLinkedLists`/`ExamineMaps` +
      `NextArray`/`NextLinkedList`/`NextMap` + `ParseExpressionExternal` —
      structured-container variable expansion (array/list/map children in
      the variables view).
    - `ExternalDebugger_Expression` (`8,33,34,35`) calls
      `ParseExpressionExternal`, `ModifyVariable`, `GetLineContext`,
      `IsValidMemory` — DAP's `evaluate` (watch expressions) and
      `setVariable`.
    - `ExternalDebugger_Watchlist` (`21,22,23`) calls
      `CheckWatchlist`/`ExpressionFind`/`FindVariable`/`FindArray`/
      `FindMap`/`FindLinkedList`/`FindModule` — the persistent watch-list
      feature (distinct from one-shot `evaluate`).
    - `ExternalDebugger_Libraries` (`24,25,26,27`) calls
      `SendLibraries`/`SendLibraryData`/`SuspendingThread`/
      `SuspensionFlag` — library/module enumeration plus thread suspend
      state, not user-facing debugging (lower priority).
    - `ExternalDebugger_Misc` (`16,28-32,38-40`) calls `ExamineModules`,
      `IncludedFiles`/`NbIncludedFiles`/`FileName`/`SourcePath`,
      `GetProcedureCall`, and the `Profiler*` globals — a grab-bag: source
      file/module metadata plus the built-in profiler, confirming this
      category isn't relevant to a first "launch + breakpoint + continue
      + stack" adapter pass.
    - Everything here was found by grepping each address range's
      `objdump -d -r` output for `PB_DEBUGGER_*`/`R_X86_64_PLT32` call
      targets — a much cheaper technique than full instruction decode, and
      the exported function names are self-documenting enough that this
      is solid evidence, not a guess. Full instruction-level payload
      layouts (byte offsets within each request/response) are still only
      done for `Control`; `Procedures` and `Variables` are the next
      targets since those are what a minimal `stackTrace`/`variables`
      DAP implementation needs.
  - **`/tmp/.pbdebugger.out` format — decoded (verified via `FifoConnect`
    disassembly + a real `pbcompiler -d` build, not guessed):** confirmed
    the file-based rendezvous is FIFO-based, not the TCP path, by default —
    `strace -f` on a plain `-d` executable run with no rendezvous file
    present shows **zero** network/socket syscalls (only `[Debugger]`
    stdout lines), matching the earlier "no plumbing without the handoff
    file" finding. `FifoConnect` (`hello`'s disassembly, symbol table
    confirms the name) does `strchr(contents, ';')`, splits the file's
    contents into two paths on that separator, `fopen64`s the first path
    `"wb"` (→ `OutStream`, the target-to-debugger direction) and the second
    `"rb"` (→ `InStream`, debugger-to-target), sets both non-blocking via
    `fcntl64`, then spawns `ExternalDebugger_CommunicationsThread` on a
    pthread. So *`FifoConnect`'s own input string* is simply
    `<fifo-target-writes-to>;<fifo-target-reads-from>` — two named-pipe
    paths, semicolon-separated, no length prefix or binary header. **Correction
    (see the live-wire-test bullet below): this is not the full contents of
    `/tmp/.pbdebugger.out`.** Decoding `PB_DEBUGGER_InitExternal` (the actual
    caller that reads that file) shows it's a multi-line format — a magic
    first line, a `%d` timestamp line, then a descriptor line with this
    `plugin;path;path` shape — not this raw two-path content directly. The
    freshness check is real (confirmed: a `PB_DEBUGGER_Timestamp() -
    line2value > 0x13` (19-second) staleness check gates the parse, matching
    the `"...is too old and will be ignored"` string found via `strings`),
    but a *far simpler and fully-verified* alternative for a tool that
    controls its own launch (like a DAP adapter) is the
    `PB_DEBUGGER_Communication` environment variable — see below. The TCP
    path (`ServerConnect`/handshake strings documented above) is the *other*
    transport, selected by `~/.pbdebugger.prefs`, not yet decoded — same
    file confirmed to exist by name only.
- **Net effect on risk 1 (§8):** the wire transport itself is now fully
  de-risked — connection setup, framing, and the hello message are
  confirmed *live*, not just from static decode (see the "live wire test"
  bullet above), and the simplest connection method
  (`PB_DEBUGGER_Communication=FifoFiles;<out>;<in>` env var) is known and
  working. What's *not* yet de-risked, contrary to the previous pass's
  optimism: **opcode `16`'s call-stack claim is unconfirmed live** — the
  real reply came back empty while the target was genuinely mid-call, so
  the "real, walkable multi-frame call-stack" conclusion from the static
  decode is a hypothesis pending the thread-scoping question below, not a
  settled fact. `ExternalDebugger_Procedures` and `PrintStack` are still
  correctly ruled out as call-stack sources regardless of how opcode `16`
  shakes out. Remaining unknowns, reordered by what the live test surfaced:
  (a) why opcode `16` read back zero frames — leading hypothesis is
  `PB_Object_GetThreadMemory` scoping to the wrong (comms) thread, needs a
  thread-ID-selector check; (b) what the generic `type=2` first-reply
  artifact means; (c) what `record+0x10`'s int32 encodes, once (a) is fixed
  and opcode `16` actually returns frames to inspect; (d) `Variables`'
  exact request/response byte layout; (e) `~/.pbdebugger.prefs`' format for
  the TCP path.
- **Next spike steps:** (1) resolve why opcode `16` reads back zero active
  calls — check whether one of the header's 3 spare `int32` fields
  (offsets `0x8`/`0xc`/`0x10`) is a target-thread-ID selector by trying
  non-zero values there, and/or find where `PB_Object_GetThreadMemory`
  picks "current thread" (decode it directly — it's called from both the
  comms thread and, presumably, `PB_DEBUGGER_EnterProcedure`/
  `LeaveProcedure` in `Debugger.o`, which are almost certainly the
  compiler-inserted per-call instrumentation and the far more promising
  place to find how call records actually get pushed); (2) once opcode
  `16` returns real frames, empirically confirm what `record+0x10`'s
  per-frame integer is (line number is still the leading guess) by
  diffing captured ints against known call-site line numbers; (3) decode
  `ExternalDebugger_Variables`' request/response byte layout — together
  with a working `stackTrace` this covers "launch + breakpoint + continue
  + locals" for a first adapter pass; (4) only then start the real
  `pbDebugAdapter.ts` DAP scaffolding. The throwaway FIFO round-trip
  prototype this list used to call for for next steps is **done**:
  `src/debug/spike/fifo-client.mjs` + `test.pb` in this repo, confirmed
  working end to end (connects via the env var, decodes the hello message,
  sends/receives framed requests). (TCP path via `~/.pbdebugger.prefs`
  remains a fallback/alternative to spike later — FIFO is simpler to
  prototype from a CLI-launched debug session.)
- Probe pbdebugger protocol → minimal DAP (launch, breakpoint, continue, stack,
  variables) → full stepping/watch/eval.

**M6 — Polish & ship (1.0)**
- Walkthrough, tree views, formatter, semantic tokens, README/docs, marketplace
  metadata, icon, telemetry-off by default. Tests + CI green.

---

## 7. Testing, packaging, CI
- **Unit tests**: symbol-dump parser, help topic index, problem-matcher regex,
  include-graph resolver (pure functions — high coverage, fast).
- **Integration**: `@vscode/test-electron` opens a fixture workspace; assert
  completion/hover/diagnostics against known `examples/sources` files.
- **Debug smoke**: scripted launch of a tiny `.pb` under the adapter, assert a
  breakpoint hits and a variable reads back.
- **Packaging**: `vsce package` → `.vsix`; local install via
  `code --install-extension`. Keep engine `^1.85.0`.
- **CI** (GitHub Actions): typecheck, lint, unit tests, `vsce package` artifact.
  (No AI/Claude attribution in any commit, tag, or release text.)

---

## 8. Risks & open questions
1. **pbdebugger control protocol is undocumented** — spike well underway
   (see M5 notes): `pbdebugger.exe` itself is a GTK GUI, not the protocol
   endpoint; the real protocol is a FIFO (default) or TCP (`CONNECT %i
   DEBUGGER` → `ACCEPT`, optional password/encryption) transport built into
   every `-d` executable via `debugger.a`, with a rich `PB_DEBUGGER_*`
   command surface (variables, arrays, breakpoints, call stack). All 40
   `IncomingCommand` opcodes are mapped to their 9 handler categories, and
   opcode `16` is confirmed to be a real multi-frame call-stack reply (not
   the synthetic single-frame fallback an earlier pass concluded). Remaining
   unknowns: exact byte layout of `Variables`' request/response, and what
   opcode `16`'s per-frame integer field encodes (line number, unconfirmed).
   The `Debug`/`OnError` stdout fallback (verified working, zero plumbing)
   still de-risks shipping *something* even if further opcode decoding
   stalls.
2. **`.help` binary format** — resolved by sidestepping it: neither offline
   pipeline in the original plan actually worked (`pbdocmaker` is GUI-only;
   no `.help` parser exists to reuse — see M4 notes). Help integration now
   fetches purebasic.com's live docs instead. New, smaller risk this
   introduces: hover/`F1` help requires network access and go dark offline
   (the 30-day disk cache absorbs short outages, but a machine that's never
   been online won't have help links at all).
3. **`-sb` standby protocol** for fast incremental checks — spiked (see M3
   notes): confirmed handshake (`STARTING`/`READY`) and that it reads one
   stdin line, but it exits after that line instead of looping, and
   black-box testing couldn't establish what makes it stay resident.
   Shipping with the fallback (plain per-check `pbcompiler -k -q` with
   400ms debounce, already implemented in `src/build/diagnostics.ts`).
4. **Cross-platform** — pipeline assumes Linux paths/tools; Windows `.chm` + IDE
   paths differ. Ship Linux first; abstract tool discovery behind `config.ts`.
5. **Relationship to existing help-viewer extension** — decide: absorb it as the
   help subsystem (recommended) vs depend on it. Plan absorbs it.
6. **C backend needs a host C toolchain** — `pbcompilerc` depends on gcc/clang
   being installed; `auto` mode defaults to the self-contained ASM compiler to
   avoid a hard external dependency, and the extension should detect a missing C
   toolchain and warn (not fail) if the user selects the C backend.

---

## 9. Immediate next steps
1. M0–M4 done. **M5 — debugger** protocol spike is well underway (risk 1 in
   §8): opcode table mapped, and the FIFO transport verified live end to
   end via the throwaway `src/debug/spike/fifo-client.mjs` prototype
   (connects, decodes the hello message, round-trips framed requests).
   Continue per the "Next spike steps" list in the M5 section: the live
   test found opcode `16` (call stack) reads back empty against a real
   nested-call target, so the next session should resolve that (likely a
   thread-scoping issue in `PB_Object_GetThreadMemory`) before decoding
   `record+0x10`'s meaning or `Variables`' byte layout, and before starting
   the real `pbDebugAdapter.ts` DAP scaffolding.
2. Full in-editor GUI smoke test (M1–M4 features) is still pending a working
   X display in this sandbox — flag to the user to manually verify in a real
   VS Code session before any marketplace publish.
3. Confirm scope/priorities (esp. whether the debugger or a Form Designer is
   in the 1.0 cut) before M5/M6.
