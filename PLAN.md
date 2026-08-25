# Pure_Xtension — VS Code Extension for PureBasic

**A full-featured VS Code language extension for PureBasic with deeply integrated
help, IntelliSense, build/run tasks, and a native debugger bridge.**

- Status: M2, M3 complete; M4 (deep help integration) in progress —
  online-docs deep-links (hover link, `F1` webview) done, completion docs
  and keyword/structure coverage still open
- Target VS Code engine: `^1.85.0` (matches the existing help-viewer prototype)
- Reference PureBasic install: `/home/gary/Apps/purebasic-v6.41` (v6.41, Linux x64)
- Language: TypeScript (extension host) + a small Language Server (Node)
- Date: 2026-08-24

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

**M4 — Deep help integration (0.5)** ← headline — in progress
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
- Remaining for M4: language-keyword hover/help (`If`, `For`, `Procedure`,
  ...) is still uncovered — those aren't in `builtinIndex` at all (that index
  only holds `-lf`/`-ls`/`-li` dump contents, which are functions/
  structures/interfaces, not language keywords), and `commandindex.html`
  doesn't list them either (verified: it's function/structure/interface
  commands only, not the `reference/*.html` keyword pages) — would need a
  separate, hand-maintained keyword → `reference/*.html` URL table. The
  sidebar has no search/filter box yet, just category browsing.

**M5 — Debugger (0.6)**
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
1. **pbdebugger control protocol is undocumented** — biggest unknown. M5 starts
   with a spike; the `Debug`/`OnError` fallback de-risks shipping *something*.
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
1. M0–M3 done. Start **M4 — deep help integration**: stand up the
   `pbdocmaker`/`.help` topic index, then wire hover docs, `F1` context help,
   the Help browser webview, and completion documentation on top of it.
2. Spike `pbdebugger` invocation early (in parallel with M4) to retire the
   biggest risk before M5.
3. Confirm scope/priorities (esp. whether the debugger or a Form Designer is
   in the 1.0 cut) before M5/M6.
