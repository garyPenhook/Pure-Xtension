// Minimal `vscode` module stub for running the debug adapter standalone,
// outside the extension host (see esbuild.adapter.mjs, which aliases the bare
// `vscode` import to this file).
//
// The only surface the adapter's launch path reaches through ../config is
// `workspace.getConfiguration(section).get(key, default)` — every lookup here
// returns the caller's supplied default, so compiler/backend resolution falls
// through to the PUREBASIC_HOME / PATH detection in config.ts exactly as it
// would with no user settings configured. The window.* and ConfigurationTarget
// members exist only so config.ts's interactive-prompt helpers (never invoked
// on the launch path) still resolve their symbols if tree-shaking keeps them.
const emptyConfiguration = {
  get: (_key, defaultValue) => defaultValue,
  update: async () => {},
  has: () => false,
  inspect: () => undefined,
};

module.exports = {
  workspace: {
    getConfiguration: () => emptyConfiguration,
  },
  window: {
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showQuickPick: async () => undefined,
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
};
