# Code Review TODO

Created from the full Linux code review on 2026-08-28. Check an item only after the implementation, regression tests, and any affected documentation are complete.

## High priority

- [x] **H1 — Make TCP debugger startup reliable.**
  - Retry expected transient connection failures such as `ECONNREFUSED` while the newly spawned PureBasic target starts listening.
  - Use one bounded startup deadline and close every failed socket before retrying.
  - Make the real TCP launch case in [test/pbDebugAdapter.e2e.test.ts](test/pbDebugAdapter.e2e.test.ts) pass consistently, including repeated launches.
  - Relevant code: [src/debug/pbSession.ts](src/debug/pbSession.ts), [src/debug/pbDebugAdapter.ts](src/debug/pbDebugAdapter.ts).

- [x] **H2 — Do not enable the TCP debugger on Windows until it is validated there.**
  - Gate the experimental transport to platforms with a completed integration pass.
  - Align the runtime gate, contribution/configuration text, and [README.md](README.md).
  - Before enabling Windows, run compile, launch, breakpoint, stepping, variable, evaluate, termination, and cleanup tests on a real Windows host.

- [x] **H3 — Handle target process spawn failures.**
  - Add an `error` listener to the target returned by `child_process.spawn()`.
  - Report invalid working directories, missing executables, and permission failures as clean DAP errors instead of unhandled process events.
  - Ensure the launch request completes exactly once and all partial resources are cleaned up.
  - Add regression tests in [test/pbSession.test.ts](test/pbSession.test.ts).

- [x] **H4 — Remove synchronous compiler execution from the extension host.**
  - Replace `spawnSync()` in the debug compile path with asynchronous execution.
  - Add cancellation, a finite timeout, and bounded stdout/stderr collection.
  - Confirm an indefinitely stalled compiler cannot freeze the VS Code extension host.
  - Relevant code: [src/debug/pbSession.ts](src/debug/pbSession.ts).

- [x] **H5 — Make LSP rename symbol-aware and syntax-safe.**
  - Restrict prepare/rename to supported user-defined symbols instead of any word under the cursor.
  - Preserve PureBasic sigils such as `#` and validate replacement identifiers.
  - Reject keywords, built-ins, comments, strings, invalid names, and unsupported symbol kinds.
  - Add coverage for constants, procedures, variables, structures, modules, keywords such as `If`, and invalid replacements.
  - Relevant code: [server/src/server.ts](server/src/server.ts).

- [x] **H6 — Decode debugger values according to their PureBasic types.**
  - Stop treating every non-structure variable and evaluate result as a signed 64-bit integer.
  - Establish the exact wire layout for integer widths, floats, doubles, strings, pointers, structures, arrays, lists, and maps before decoding them.
  - Display `.f` and `.d` values numerically and handle string/local layouts correctly.
  - Offer data breakpoints only for types and storage locations that can be watched correctly.
  - Add protocol fixtures and live integration coverage for each supported type; return an explicit unsupported result for unknown layouts.
  - Relevant code: [src/debug/pbDebugAdapter.ts](src/debug/pbDebugAdapter.ts), [test/pbDebugAdapter.e2e.test.ts](test/pbDebugAdapter.e2e.test.ts).

- [x] **H7 — Decode array, list, and map elements using the reply's real element type.**
  - **Added 2026-08-28T13:37:40-04:00:** `parseArrayElements()`, `parseListElements()`, and `parseMapElements()` currently assume every element value is a signed 64-bit integer; `examineExpression()` does not pass `MSG_*Data.f8` (`CommandInfo\Value1`) through as the element type. Byte/word/long/float/double/string/pointer and structure containers can therefore be misrendered or parsed at the wrong byte boundaries even though H6 is checked complete.
  - Use the target's element type to consume the correct value width and representation, including pointer-width differences and the structure-field map that precedes structure container data.
  - Return an explicit unsupported result for layouts that are not decoded; never reuse the integer parser for an unknown type.
  - Add captured-wire fixtures and live tests for each supported array/list/map element type on 64-bit, with a documented 32-bit strategy.
  - Upstream evidence: `PureBasicDebugger/VariableDebug.pb` reads `Command\Value1` as `type` for ArrayData/ListData/MapData and advances with `GetValueSize(type, ...)`; `PureBasicDebugger/Misc.pb` defines the variable widths. Reference checkout: `/home/gary/apps/purebasic-devel`.
  - Relevant code: [src/debug/pbSession.ts](src/debug/pbSession.ts), [src/debug/pbDebugAdapter.ts](src/debug/pbDebugAdapter.ts), [test/pbSession.test.ts](test/pbSession.test.ts).
  - **Fixed 2026-08-28T14:00:54-04:00:** opcode-15 decoding now consumes `f8`'s element type, target pointer width from ExeMode, and structure field maps; structured elements expand in DAP. Unknown/truncated layouts remain explicit unsupported results. PureBasic 6.41's target-side `List<String>` wire bug remains on the existing unsupported/current-element fallback because the text is not transmitted.

- [x] **H8 — Gate debugging to validated platforms, including macOS.**
  - **Added 2026-08-28T13:37:40-04:00:** the README says macOS debugging is not enabled, but `shouldRefuseUnvalidatedWindowsLaunch()` rejects only `win32`; its test explicitly accepts `darwin`, so a normal macOS launch proceeds into the unvalidated FIFO path.
  - Make normal launch eligibility an allowlist of validated platforms (currently Linux), while retaining a clearly internal test override if needed.
  - Keep the runtime error, debug contribution text, tests, and README aligned before enabling another host OS.
  - Relevant code: [src/debug/pbSession.ts](src/debug/pbSession.ts), [src/debug/pbDebugAdapter.ts](src/debug/pbDebugAdapter.ts), [test/pbSession.test.ts](test/pbSession.test.ts), [README.md](README.md).
  - **Fixed 2026-08-28:** normal debug launch is now explicitly Linux-only, before compiler invocation or transport setup. The undocumented `transport` hook remains a test-only override for protocol coverage. The runtime diagnostic, debugger contribution label, README, and unit coverage now agree that macOS and Windows are not enabled pending real-machine validation.

- [x] **H9 — Make rename atomic across include files and module-qualified symbols.**
  - **Added 2026-08-28T13:37:40-04:00:** rename resolves its target from the whole include graph but emits edits only for the current document. Renaming a call whose declaration is in an included file therefore changes the call without changing its declaration and can immediately break the build.
  - `RenameSymbol` also discards `WorkspaceSymbol.module`; a reproduced rename on `A::Run()` selected every `Run` declaration/reference in both modules A and B (six edits), despite the qualified target.
  - Build a symbol identity that includes URI, declaration kind, module, and lexical scope; either produce a complete multi-document `WorkspaceEdit` or reject targets whose safe edit set cannot be established.
  - Cover same-named module members, same-named locals/globals, declarations in included files, `Module::Symbol` references, and mixed open/on-disk documents.
  - Relevant code: [server/src/server.ts](server/src/server.ts), [server/src/rename.ts](server/src/rename.ts), [server/src/includeGraph.ts](server/src/includeGraph.ts), [test/rename.test.ts](test/rename.test.ts).
  - **Fixed 2026-08-28:** rename now retains the resolved declaration identity (URI, kind, module, and lexical scope) instead of reducing it to spelling. It walks every reachable include source and returns one multi-document `WorkspaceEdit`, reading closed included files from disk while preserving open-buffer text. Module members are limited to their own `DeclareModule`/`Module` blocks plus matching `Module::Symbol` references, so `A::Run` never edits `B::Run`; ambiguous unqualified duplicate declarations are rejected rather than guessed. Coverage includes the module-collision scanner case and a bundled-server IPC test that verifies a main-file rename edits both the main call and an on-disk included declaration/use. `npm test` passes (157/157).

- [x] **H10 — Add included-source/module mapping to the debugger.**
  - **Added 2026-08-28T13:37:40-04:00:** `setBreakPointsRequest()` rejects every source path other than the launch file, and every stack frame is labeled with that one path. Breakpoints and frame locations are therefore unavailable or wrong for code compiled through `IncludeFile`/`XIncludeFile`.
  - Preserve the startup `#COMMAND_Init` payload (`Value1 = NbIncludedFiles`) and request `#COMMAND_GetModules`/parse `#COMMAND_Modules`, as the official debugger does, then map DAP sources to the module id encoded with line breakpoints.
  - Verify breakpoints, stack frames, stepping, and stop locations in nested includes and duplicate basenames.
  - Upstream evidence: `PureBasicDebugger/Communication.pb` stores the included-file list from `#COMMAND_Init` and requests module names; `PureBasicDebugger/DebuggerCommon.pb` defines the module commands. Reference checkout: `/home/gary/apps/purebasic-devel`.
  - Relevant code: [src/debug/pbSession.ts](src/debug/pbSession.ts), [src/debug/pbDebugAdapter.ts](src/debug/pbDebugAdapter.ts), [test/pbDebugAdapter.e2e.test.ts](test/pbDebugAdapter.e2e.test.ts).
  - **Fixed 2026-08-28:** the adapter now retains Init's source-root/main/include table, requests and validates `GetModules`, and packs/unpacks PureBasic's 12-bit source ID plus 20-bit line number consistently. Breakpoints are maintained per source file even when VS Code configures included-file breakpoints before target startup; stops and stack frames now use the matching included source path. Unit fixtures cover Init/Modules and packed locations, while the real FIFO adapter integration test compiles a nested include and verifies both its breakpoint and frame source.

## Medium priority

- [x] **M1 — Accept valid variable-originated data-breakpoint requests.**
  - Do not reject a request solely because VS Code supplies `variablesReference` for the containing scope.
  - Accept eligible scalar variables and continue rejecting compound children or values without a stable address.
  - Test the real VS Code Variables-view flow, not only name-only synthetic requests.
  - Relevant code: [src/debug/pbSession.ts](src/debug/pbSession.ts), [test/vscodeIntegration/suite/debugSession.test.ts](test/vscodeIntegration/suite/debugSession.test.ts).

- [x] **M2 — Put deadlines on normal debugger protocol operations.**
  - Bound stack, scope/variable, container, and evaluate requests rather than waiting indefinitely for the target.
  - On timeout or cancellation, reject the active DAP request, close or resynchronize the transport safely, and leave the session in a defined state.
  - Add stalled-target tests for each request family.
  - Relevant code: [src/debug/pbDebugAdapter.ts](src/debug/pbDebugAdapter.ts).

- [x] **M3 — Restart the language server when `purebasicHome` changes.**
  - Invalidate caches and restart/reinitialize the server so diagnostics, built-ins, compiler paths, and help data all use the new installation.
  - Add a configuration-change regression test.
  - Relevant code: [src/client.ts](src/client.ts), [src/config.ts](src/config.ts).
  - **Fixed 2026-08-28:** `onDidChangeConfiguration` in [src/extension.ts](src/extension.ts) called `invalidateHomeCache()` on a `purebasicHome` change but never restarted the client, so a running server kept the compiler path (and cacheDir-scoped built-in/help data) it started with until an unrelated `backend`/`compilerPath` change happened to trigger a restart. `purebasicHome` now joins that same restart condition. Regression coverage added in [test/vscodeIntegration/suite/configRestart.test.ts](test/vscodeIntegration/suite/configRestart.test.ts), driven through a `getRestartCount()` counter exposed via `activate()`'s return value (`PureXtensionExports`) rather than by importing `src/client.ts` directly, since the test process and the bundled `dist/extension.js` VS Code actually runs are separate module instances. Could not visually confirm this specific test's pass/fail through `npm run test:vscode` — its output/exit-code unreliability is the same pre-existing gap M8 documents; verified instead via `tsc --noEmit` (clean) and the full `npm test` unit suite (128/128 passing, no regressions).

- [x] **M4 — Load the built-in index before answering the first built-in hover.**
  - Await the built-in index readiness path during hover handling.
  - Verify that the first hover in a fresh session succeeds without another request warming the cache.
  - Relevant code: [server/src/server.ts](server/src/server.ts), [server/src/builtinIndex.ts](server/src/builtinIndex.ts).
  - **Fixed 2026-08-28:** `connection.onHover` read the module-level `builtinIndex` variable directly instead of calling `ensureBuiltinIndex()` like `onCompletion`/`onSignatureHelp` both correctly do, and nothing else in the server eagerly loads it. Since hover was the only handler that never triggered the load, the very first hover in a session returned nothing for any built-in function or structure unless a completion/signature-help request happened to run first. `onHover` now awaits `ensureBuiltinIndex()` once and reuses the result for both the function and structure/interface lookups. Regression coverage added in [test/hoverBuiltinIndex.e2e.test.ts](test/hoverBuiltinIndex.e2e.test.ts), which forks the real bundled `dist/server.js` over its actual IPC transport and sends `textDocument/hover` as the session's first request after `didOpen` — confirmed to fail against the pre-fix code (`hover` resolves to `null`) and pass after the fix, by manually reverting and rebuilding `dist/server.js` and rerunning the test in isolation. Also added [test/vscodeIntegration/suite/hoverFirstRequest.test.ts](test/vscodeIntegration/suite/hoverFirstRequest.test.ts) for the real-VS-Code path, though per M8 that harness's pass/fail can't currently be trusted or observed. `npm run compile` and the full `npm test` unit suite (129/129 passing) are clean.

- [x] **M5 — Expand the workspace parser to cover major PureBasic constructs.**
  - Honor `IncludePath` when resolving later includes.
  - Index `Declare`, `DeclareModule`, module-qualified symbols, and procedure parameters in nested containers.
  - Parse inherited structure fields introduced through `Extends`.
  - Include dynamic `Array`, `List`, and `Map` fields in structures.
  - Add focused parser tests based on PureBasic 6.41 syntax and multi-file/module fixtures.
  - Relevant code: [server/src/includeGraph.ts](server/src/includeGraph.ts), [server/src/workspaceSymbols.ts](server/src/workspaceSymbols.ts), [test/workspaceSymbols.test.ts](test/workspaceSymbols.test.ts).
  - **Fixed 2026-08-28:** All five gaps verified against PureBasic's own documentation (`purebasic.com/documentation/reference/{module,includes,structures}.html`, scraped copy under the local `purebasic-v6.41` install) before implementing. `IncludePath "path"` is now tracked per-file and tried as an additional base for every later `IncludeFile`/`XIncludeFile` in that same file ([server/src/includeGraph.ts](server/src/includeGraph.ts)). `Declare[C/DLL/CDLL]` forward declarations are now indexed as procedure symbols; every symbol declared inside a `DeclareModule`/`Module` block is tagged with that module's name (`WorkspaceSymbol.module`), and `qualifiedWordAt` (new, in [server/src/textUtils.ts](server/src/textUtils.ts)) lets `onHover`/`onDefinition` resolve a `Module::Symbol` reference to that module's own symbol instead of the first same-named one anywhere -- `resolveIncludeGraphSymbols` also now drops a `Declare` stub in favor of a real `Procedure` body found elsewhere in the graph, so go-to-definition doesn't land on the bodyless forward declaration. A structure's `Extends <name>` clause is now captured (previously only interfaces captured theirs), and `resolveStructureFields` walks the chain, module-scoped, parent fields first, cycle-safe, falling back to a builtin/main-code lookup when nothing else matches. Dynamic `Array`/`List`/`Map` structure fields and a bare `Name$` field with no `.Type` at all (both real, docs-verified syntax) are now parsed too; the latter surfaced a related pre-existing gap fixed alongside it -- `#Name$ = ...` string constants weren't recognized either. Also fixed in review before landing: `resolveStructureFields` initially resolved a bare structure name across the *whole* symbol table with no module scoping, so two modules (or a module and main code) declaring same-named structures -- exactly the case PB modules exist to allow -- could silently resolve to the wrong one's fields; it now scopes the initial lookup and each `Extends` hop to the structure's own module first. New coverage: [test/workspaceSymbols.test.ts](test/workspaceSymbols.test.ts) (parser-level, all pure unit tests), [test/includeGraph.test.ts](test/includeGraph.test.ts) (IncludePath resolution and cross-file forward-declaration dedup against real on-disk fixtures), [test/textUtils.test.ts](test/textUtils.test.ts) (`qualifiedWordAt`), and two new e2e tests against the real bundled `dist/server.js` over IPC ([test/hoverModuleQualified.e2e.test.ts](test/hoverModuleQualified.e2e.test.ts), extended [test/hoverBuiltinIndex.e2e.test.ts](test/hoverBuiltinIndex.e2e.test.ts) via a shared [test/support/lspServerHarness.ts](test/support/lspServerHarness.ts)) -- both confirmed to fail against the pre-fix code and pass after, by temporarily reverting and rebuilding. `npm run compile` and the full `npm test` unit suite (148/148 passing) are clean. Not covered: `structureFieldCompletions`' own `variable\field` completion path still resolves the variable's structure type by bare name with no module scoping (out of scope here -- that path has no module context available at all yet, unlike the qualified-reference case).

- [x] **M6 — Fix included-file diagnostic ownership and stale async results.**
  - Aggregate or reference-count diagnostics contributed by each main document so closing one main file does not erase diagnostics still owned by another.
  - Recheck the generation/version after every awaited document load before publishing results.
  - Test shared includes, close/reopen behavior, rapid edits, and deliberately reordered async completion.
  - Relevant code: [src/build/diagnostics.ts](src/build/diagnostics.ts).
  - **Fixed 2026-08-28:** Diagnostics are now retained as per-main-document contributions and merged at publish time, so closing or recompiling one main file removes only its own entries and cannot erase a shared include's diagnostics owned by another main file. A generation is rechecked after every awaited included-document load and immediately before publication; a close also cancels a pending debounce timer. Unit coverage verifies shared-include ownership, replacement/removal, and rapid edit/close/reopen invalidation.

- [x] **M7 — Publish compiler problems for every task mode.**
  - Attach the PureBasic problem matcher to build, build-and-run, debug, console, and syntax-check tasks where compiler output is available.
  - Verify each task mode populates and clears VS Code Problems correctly.
  - Relevant code: [src/build/taskProvider.ts](src/build/taskProvider.ts), [src/build/problemMatcher.ts](src/build/problemMatcher.ts).
  - **Fixed 2026-08-28:** Every task mode now receives the contributed `$purebasic` matcher: build, build-and-run, debug build, console build, and syntax check. The matcher is attached to the compiler task itself, so VS Code owns compiler diagnostics and clears them on the task's next clean output. A bundled task-provider regression test verifies every mode's matcher assignment without requiring an extension host.

- [x] **M8 — Make real Linux debugger coverage a release gate.**
  - Stop allowing the PureBasic compiler/GDB integration suite to silently self-skip in the only required CI job.
  - Add an appropriately licensed runner or a documented protocol fixture strategy that exercises the same launch and debug lifecycle.
  - Run `npm run test:vscode` in a required workflow.
  - Require TCP and FIFO launch coverage before release packaging.
  - **Newly discovered while verifying M1 (2026-08-28), live-confirmed, not yet fixed:** `npm run test:vscode`'s own process exit code does not reflect whether its mocha tests actually passed. VS Code's `--extensionTestsPath` machinery runs the suite in a separate extension-host process and does not reliably propagate a failed run (rejected `run()` promise, or even the extension host calling `process.exit(1)` directly) into a non-zero exit code on the outer `@vscode/test-electron` process — confirmed by deliberately breaking an assertion and observing `Exit code: 0` regardless. A same-filesystem sentinel-file side channel was attempted as a fix and also failed for reasons not root-caused (even an unconditional file write at the very start of `run()`, to an absolute hardcoded path, never happened) before the investigation was stopped as out of scope for M1. **Net effect: today, `npm run test:vscode` can never fail — it always exits 0 — so it must not be trusted as a release gate or CI check until this is actually fixed.** This makes fixing this part of M8 more urgent, not less: a suite that can't fail is worse than one that self-skips, since it gives false confidence.
  - Relevant workflows: [.github/workflows/ci.yml](.github/workflows/ci.yml), [.github/workflows/release.yml](.github/workflows/release.yml).
  - **Fixed 2026-08-28:** CI and tag releases now require the documented licensed `self-hosted`, `linux`, `purebasic-6.41` runner, validate its PureBasic 6.41 and Xvfb prerequisites, run `npm test` (which discovers the compiler through `PUREBASIC_HOME` and therefore executes both FIFO and TCP coverage), and run the real VS Code suite under Xvfb before packaging. The extension-host test runner now atomically reports Mocha's passed/failed state through a per-run result file; the parent rejects a missing or failed record after Electron exits, eliminating the prior false-success exit code.

- [ ] **M9 — Bound and cancel every GDB/MI operation.**
  - **Added 2026-08-28T13:37:40-04:00:** MI `command()` and `waitForStop()` have no deadlines. A GDB process that starts but stops responding can hang Force Pause/attach indefinitely; disconnect cannot dispose an attaching engine because it is not assigned to `forcePauseEngine` until after attach completes.
  - Replace the extension-host `spawnSync("gdb", ["--version"])` capability probe (up to three seconds of UI blocking on the first Pause) with an asynchronous, shared probe.
  - Give startup, attach, command, stop-wait, detach, and dispose one cancellation-aware budget; kill the owned GDB process and leave the target/session state defined on failure.
  - Add fake-MI tests for a silent process, missing result record, missing `*stopped`, disconnect during attach, and late records after cancellation.
  - Relevant code: [src/debug/ptraceEngine.ts](src/debug/ptraceEngine.ts), [src/debug/pbDebugAdapter.ts](src/debug/pbDebugAdapter.ts), [test/ptraceEngine.test.ts](test/ptraceEngine.test.ts).

- [ ] **M10 — Make all LSP symbol features scope- and module-aware.**
  - **Added 2026-08-28T13:37:40-04:00:** completion publishes every parsed procedure local/parameter regardless of cursor scope; unqualified hover/definition/signature help select the first same-spelled symbol in include order; references are a spelling-only scan of the current file. Module qualification is handled only in hover/definition, not consistently across completion, signature help, references, or rename.
  - Resolve a symbol identity at the cursor using module visibility, procedure bounds, declaration kind, and include provenance, then reuse that identity for every language feature.
  - Ensure locals never leak into other procedures, module-private names do not leak globally, and same-named symbols do not cross-contaminate results.
  - Include escaped strings/comments and nested-call signature-help cases in the scanner tests.
  - Relevant code: [server/src/server.ts](server/src/server.ts), [server/src/workspaceSymbols.ts](server/src/workspaceSymbols.ts), [server/src/textUtils.ts](server/src/textUtils.ts), [server/src/rename.ts](server/src/rename.ts).

- [ ] **M11 — Queue language-server restarts instead of dropping configuration changes.**
  - **Added 2026-08-28T13:37:40-04:00:** `restartLanguageClient()` coalesces every call into the current promise. If a second compiler/home/backend change arrives after the first restart has already resolved its compiler path but before `newClient.start()` finishes, the second call schedules no follow-up and the server can remain on the superseded configuration.
  - Track a dirty generation and run one additional restart after the active one whenever a newer configuration generation exists.
  - Test two deliberately reordered configuration changes and assert the final server initialization options use the last values.
  - Relevant code: [src/extension.ts](src/extension.ts), [src/client.ts](src/client.ts), [test/vscodeIntegration/suite/configRestart.test.ts](test/vscodeIntegration/suite/configRestart.test.ts).

- [ ] **M12 — Parse included-file diagnostics in task problem matching.**
  - **Added 2026-08-28T13:37:40-04:00:** the contributed `$purebasic` matcher accepts only `Error|Warning: Line ...` after the synthetic main-file marker. PureBasic's two-line `Error|Warning: in included file '...'` plus `Line ...` form is handled by background diagnostics but not by tasks, so even after M7 attaches the matcher to every mode, include-file task errors will not be owned by the correct file.
  - Extend the contributed matcher/output normalization to cover the same formats as `parseCompilerOutput()` and verify file ownership and stale-problem clearing.
  - Relevant code: [package.json](package.json), [src/build/problemMatcher.ts](src/build/problemMatcher.ts), [src/build/taskProvider.ts](src/build/taskProvider.ts).

- [ ] **M13 — Use the configured backend-selection flow for debug launches.**
  - **Added 2026-08-28T13:37:40-04:00:** when auto mode is ambiguous, `launchRequest()` falls back to `"asm"` (`resolveBackendSilent() ?? "asm"`) instead of prompting/persisting the user's choice like build tasks do. Debug builds can silently use a different backend than the rest of the workspace.
  - Resolve the backend before constructing the inline adapter or pass the resolved choice in the debug configuration; cancellation must cleanly cancel launch rather than choose a backend implicitly.
  - Add coverage for explicit ASM/C, unambiguous auto, ambiguous auto selection, and cancelled selection.
  - Relevant code: [src/debug/pbDebugAdapter.ts](src/debug/pbDebugAdapter.ts), [src/debug/debugConfigProvider.ts](src/debug/debugConfigProvider.ts), [src/config.ts](src/config.ts).

## Lower priority

- [ ] **L1 — Complete a task execution only once when child startup fails.**
  - Guard the task completion callback so an `error` event followed by `close` cannot emit duplicate exits.
  - Add a missing-executable regression test.
  - Relevant code: [src/build/taskProvider.ts](src/build/taskProvider.ts).

- [ ] **L2 — Make editor indentation work with lowercase/mixed-case PureBasic keywords.**
  - Update [language-configuration.json](language-configuration.json) with case-insensitive matching supported by VS Code's language-configuration regex engine.
  - Test representative lowercase, uppercase, and mixed-case block pairs.

- [ ] **L3 — Reject and safely recover from invalid online-help refreshes.**
  - Treat an HTTP 200 response that parses to an empty or implausibly small index as a refresh failure.
  - Keep serving the last known-good cache when fresh content is invalid.
  - Do not cache an empty index for 30 days, and write successful cache updates atomically.
  - Add tests for page-layout changes, empty parses, stale-cache fallback, and interrupted writes.
  - Relevant code: [server/src/onlineHelpIndex.ts](server/src/onlineHelpIndex.ts), [test/cacheRefresh.test.ts](test/cacheRefresh.test.ts).

- [ ] **L4 — Clean temporary debugger artifacts on natural termination.**
  - Remove temporary binaries, FIFOs, sockets, and related state on normal exit as well as disconnect and error paths.
  - Make cleanup idempotent so competing termination paths are harmless.
  - Assert filesystem cleanup after natural termination in integration tests.
  - Relevant code: [src/debug/pbSession.ts](src/debug/pbSession.ts), [src/debug/pbDebugAdapter.ts](src/debug/pbDebugAdapter.ts).

- [ ] **L5 — Resolve or explicitly mitigate the development dependency advisories.**
  - Review the Mocha dependency chain for `diff` (`GHSA-73rr-hh4g-fpgx`) and `serialize-javascript` (`GHSA-5c6j-r48x-rmvq`, `GHSA-qj8w-gfj5-8c6v`).
  - Upgrade safely where possible; do not accept a forced major/downgrade without running the full test suite.
  - Keep `npm audit --omit=dev` clean and document any temporarily accepted development-only risk.

- [ ] **L6 — Avoid repeated/unsolicited backend prompts during task discovery.**
  - **Added 2026-08-28T13:37:40-04:00:** `provideTasks()` calls interactive `resolveBackend()` once per five task specs. In ambiguous auto mode, cancelling the picker can produce five consecutive prompts, and ordinary VS Code task discovery can invoke the provider before the user explicitly runs a build.
  - Resolve once per provider call, use a non-interactive discovery path where appropriate, and test selection and cancellation.
  - Relevant code: [src/build/taskProvider.ts](src/build/taskProvider.ts), [src/config.ts](src/config.ts).

- [ ] **L7 — Remove the include graph's silent depth truncation and use standards-based file URIs.**
  - **Added 2026-08-28T13:37:40-04:00:** `resolveIncludeGraphSymbols()` silently stops after eight include edges even though canonical visited-file tracking already terminates cycles, so legitimate deeper include chains lose symbols without a diagnostic.
  - The hand-built `file://` conversion uses `encodeURI()`, which leaves URI delimiters such as `#` and `?` unescaped in valid filenames and does not robustly cover UNC/platform URI rules; returned definition locations can identify the wrong resource.
  - Use the LSP/VS Code URI implementation, remove or make the safety limit explicit/configurable, and test deep chains, spaces, `%`, `#`, `?`, non-ASCII paths, Windows drives, and UNC paths.
  - Relevant code: [server/src/includeGraph.ts](server/src/includeGraph.ts), [test/includeGraph.test.ts](test/includeGraph.test.ts).

- [ ] **L8 — Validate the built-in symbol cache before trusting it.**
  - **Added 2026-08-28T13:37:40-04:00:** a valid-JSON cache is accepted after checking only `compilerVersion`; malformed `functions`/`structures`/`interfaces` shapes can later throw in completion/hover instead of triggering a rebuild. A forced rebuild can also race an already-running ordinary load because the server clears and replaces the shared promise without cancelling or sequencing the old load.
  - Validate the complete cache schema, write atomically, and serialize forced refreshes after existing loads so stale results cannot overwrite the refresh.
  - Relevant code: [server/src/builtinIndex.ts](server/src/builtinIndex.ts), [server/src/server.ts](server/src/server.ts), [test/cacheRefresh.test.ts](test/cacheRefresh.test.ts).

- [ ] **L9 — Align the documented help shortcut with the contribution.**
  - **Added 2026-08-28T13:37:40-04:00:** [README.md](README.md) says the help command is bound to `F1`, while [package.json](package.json) contributes `Shift+F1` and the implementation comments use both descriptions.
  - Choose one binding and update the manifest, README, and code comments together.

## Completion checklist

Run this checklist after the fixes above are merged:

- [ ] `npm run compile`
- [ ] `npm test`, with no unexpected Linux debugger skips in the release environment
- [ ] `npm run test:vscode`
- [ ] Repeated real TCP and FIFO launch/debug/termination tests on Linux
- [ ] `npm run package` and validate the produced VSIX manifest/content
- [ ] `npm audit --omit=dev`
- [ ] `npm audit` and review every remaining development-only advisory
- [ ] Windows debugger validation before changing the Windows platform gate or documentation
- [ ] `git diff --check`
