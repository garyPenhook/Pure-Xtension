// Standalone stdio entry point for the PureBasic debug adapter.
//
// Inside VS Code the adapter runs in-process via
// DebugAdapterInlineImplementation (see debugConfigProvider.ts), so this file
// is never loaded there. Its purpose is to let the exact same
// PureBasicDebugSession run as an out-of-process DAP server over stdin/stdout,
// which is what the end-to-end test harness (test/pbDebugAdapter.e2e.test.ts)
// drives against the real pbcompiler/pbdebugger — no VS Code, and no X display,
// required. That closes PLAN.md §8's long-standing "debug adapter never
// verified end-to-end" gap, which was previously blocked only on the sandbox
// having no display.
//
// When bundled for that harness (esbuild.adapter.mjs) the bare `vscode` import
// pulled in transitively via ../config is aliased to test/support/vscode-stub.js,
// since there's no extension host to provide the real module.
import { DebugSession } from "@vscode/debugadapter";
import { PureBasicDebugSession } from "./pbDebugAdapter";

DebugSession.run(PureBasicDebugSession);
