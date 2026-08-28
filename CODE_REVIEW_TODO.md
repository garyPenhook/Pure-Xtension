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

- [ ] **M6 — Fix included-file diagnostic ownership and stale async results.**
  - Aggregate or reference-count diagnostics contributed by each main document so closing one main file does not erase diagnostics still owned by another.
  - Recheck the generation/version after every awaited document load before publishing results.
  - Test shared includes, close/reopen behavior, rapid edits, and deliberately reordered async completion.
  - Relevant code: [src/build/diagnostics.ts](src/build/diagnostics.ts).

- [ ] **M7 — Publish compiler problems for every task mode.**
  - Attach the PureBasic problem matcher to build, build-and-run, debug, console, and syntax-check tasks where compiler output is available.
  - Verify each task mode populates and clears VS Code Problems correctly.
  - Relevant code: [src/build/taskProvider.ts](src/build/taskProvider.ts), [src/build/problemMatcher.ts](src/build/problemMatcher.ts).

- [ ] **M8 — Make real Linux debugger coverage a release gate.**
  - Stop allowing the PureBasic compiler/GDB integration suite to silently self-skip in the only required CI job.
  - Add an appropriately licensed runner or a documented protocol fixture strategy that exercises the same launch and debug lifecycle.
  - Run `npm run test:vscode` in a required workflow.
  - Require TCP and FIFO launch coverage before release packaging.
  - **Newly discovered while verifying M1 (2026-08-28), live-confirmed, not yet fixed:** `npm run test:vscode`'s own process exit code does not reflect whether its mocha tests actually passed. VS Code's `--extensionTestsPath` machinery runs the suite in a separate extension-host process and does not reliably propagate a failed run (rejected `run()` promise, or even the extension host calling `process.exit(1)` directly) into a non-zero exit code on the outer `@vscode/test-electron` process — confirmed by deliberately breaking an assertion and observing `Exit code: 0` regardless. A same-filesystem sentinel-file side channel was attempted as a fix and also failed for reasons not root-caused (even an unconditional file write at the very start of `run()`, to an absolute hardcoded path, never happened) before the investigation was stopped as out of scope for M1. **Net effect: today, `npm run test:vscode` can never fail — it always exits 0 — so it must not be trusted as a release gate or CI check until this is actually fixed.** This makes fixing this part of M8 more urgent, not less: a suite that can't fail is worse than one that self-skips, since it gives false confidence.
  - Relevant workflows: [.github/workflows/ci.yml](.github/workflows/ci.yml), [.github/workflows/release.yml](.github/workflows/release.yml).

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

