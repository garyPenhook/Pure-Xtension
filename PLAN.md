# Pure_Xtension — VS Code Extension for PureBasic

**A full-featured VS Code language extension for PureBasic with deeply integrated
help, IntelliSense, build/run tasks, and a native debugger bridge.**

- Status: M2 complete (build & diagnostics); M3 (language server IntelliSense) in progress
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
Data pipeline options (pick per platform at build time):

1. **Primary (Linux/all):** run `pbdocmaker` once to render `purebasic.help` into
   an HTML topic tree in `globalStorage`; build a topic index (`command → topic`).
2. **Fallback:** parse the `.help` archive directly (it is a zlib topic archive
   with anchors like `reference/ide_start`; the existing help-viewer already reads
   `.help`/`.chm` — reuse its reader in `node_modules/chmlib-ts`).

Features on top of the topic index:
- **Hover docs**: server hover returns a Markdown summary; the client enriches it
  with a "Open full help" command link.
- **Context help command** `pureXtension.openHelpForSymbol` (bind to `F1` within
  `.pb` files via `keybindings` + `when: editorLangId == purebasic`): resolves the
  word under cursor → topic → opens the Help webview at that anchor.
- **Help browser webview** (`pureXtension.helpBrowser`): sidebar view + full panel;
  contents tree, per-topic navigation, in-page + cross-topic search box,
  back/forward, "Insert example into editor". Runs sandboxed with a strict CSP and
  `asWebviewUri` for local assets.
- **Completion documentation**: each built-in completion item's `documentation`
  field is lazily filled from the topic index (`resolveCompletionItem`).
- **Settings**: `pureXtension.help.language` (english/german/french → pick
  `.help` variant), `pureXtension.help.source` (auto/docmaker/rawHelp), and
  `pureXtension.compilerPath` / `pureXtension.purebasicHome`.

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

**M3 — Language Server IntelliSense (0.4)** 🚧 in progress
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
- Remaining for M3: `signatureHelp`, `rename`, `references`, cross-file
  symbol resolution via the `IncludeFile`/`XIncludeFile` graph, structure
  field completion (via the already-parsed but not-yet-wired `-qs` field
  data), and `-sb` standby-mode investigation for faster incremental
  rebuilds. Full in-editor GUI smoke test still pending a working display
  (same X/pointer limitation as M1/M2).

**M4 — Deep help integration (0.5)** ← headline
- `pbdocmaker`/`.help` pipeline → topic index; hover docs, `F1` context help, Help
  browser webview with search, completion docs.

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
2. **`.help` binary format** — mitigated by preferring `pbdocmaker`-generated HTML
   and reusing the existing help-viewer's `.help` reader as fallback.
3. **`-sb` standby protocol** for fast incremental checks may need reverse
   engineering; fallback is plain per-check `pbcompiler -k` with debounce.
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
1. Confirm scope/priorities (esp. whether the debugger or a Form Designer is in
   the 1.0 cut).
2. M0 scaffold + M1 grammar so there's a testable extension against the real
   `examples/sources` files within the first iteration.
3. Spike `pbdebugger` invocation early (in parallel with M1–M4) to retire the
   biggest risk before M5.
