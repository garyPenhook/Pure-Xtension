// Minimal `vscode` module stub for running the debug adapter standalone,
// outside the extension host (see esbuild.adapter.mjs, which aliases the bare
// `vscode` import to this file).
//
// The surface the adapter's launch path reaches through ../config is
// `workspace.getConfiguration(section).get(key, default)` — every lookup here
// returns the caller's supplied default, so compiler/backend resolution falls
// through to the PUREBASIC_HOME / PATH detection in config.ts exactly as it
// would with no user settings configured. Since M13, an unspecified launch
// backend in ambiguous auto mode does reach `resolveBackend()`'s interactive
// prompt; `showQuickPick()` always resolving to undefined here simulates a
// dismissed picker (see the "ambiguous auto mode" test in
// pbDebugAdapter.e2e.test.ts), and `update()` is a no-op since there is no
// real configuration target to persist the choice to.
const emptyConfiguration = {
  get: (_key, defaultValue) => defaultValue,
  update: async () => {},
  has: () => false,
  inspect: () => undefined,
};

// Used by taskProvider.ts's CompileExecution (a vscode.Pseudoterminal) to
// report compiler output/exit to the task system.
class EventEmitter {
  constructor() {
    this._listeners = [];
    this.event = (listener) => {
      this._listeners.push(listener);
      return { dispose: () => {} };
    };
  }

  fire(value) {
    for (const listener of this._listeners) {
      listener(value);
    }
  }
}

module.exports = {
  workspace: {
    getConfiguration: () => emptyConfiguration,
  },
  window: {
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    // L6 regression coverage (test/taskProvider.test.ts) counts calls here
    // via globalThis -- shared with this same-process bundle even though
    // esbuild inlines a separate copy of this file's source per bundle,
    // because it's still one Node process/one V8 isolate at test run time.
    showQuickPick: async () => {
      globalThis.__pureXtensionTestQuickPickCalls = (globalThis.__pureXtensionTestQuickPickCalls ?? 0) + 1;
      return undefined;
    },
    // Lets taskProvider.test.ts simulate an active editor (this bundle has
    // no real one) without needing a full VS Code host: set
    // globalThis.__pureXtensionTestActiveFile before calling in.
    get activeTextEditor() {
      const fsPath = globalThis.__pureXtensionTestActiveFile;
      return fsPath ? { document: { uri: { fsPath } } } : undefined;
    },
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  EventEmitter,
};
