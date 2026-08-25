import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export type Backend = "asm" | "c";

const CONFIG_SECTION = "pureXtension";

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

function expandHome(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/** Directories to probe for a PureBasic install when no setting/env is given. */
function candidateHomes(): string[] {
  const home = os.homedir();
  const globPrefixes = [path.join(home, "Apps"), "/opt", "/usr/local", "/usr/share"];
  const found: string[] = [];
  for (const dir of globPrefixes) {
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (/^purebasic(-v[\d.]+)?$/i.test(entry)) {
          found.push(path.join(dir, entry));
        }
      }
    } catch {
      // directory doesn't exist or isn't readable — skip
    }
  }
  return found;
}

function looksLikePureBasicHome(dir: string): boolean {
  return fs.existsSync(path.join(dir, "compilers", "pbcompiler"));
}

// candidateHomes() does several readdirSync calls; resolvePureBasicHome() is
// called on every debounced diagnostics check (i.e. on every save), so cache
// the scan result for the life of the extension host and only redo it when
// the relevant settings change (see invalidateHomeCache below).
const CACHE_EMPTY = Symbol("unresolved");
let cachedHome: string | undefined | typeof CACHE_EMPTY;

export function invalidateHomeCache(): void {
  cachedHome = undefined;
}

/** Resolve the PureBasic install directory: setting > env > known locations. */
export function resolvePureBasicHome(): string | undefined {
  if (cachedHome !== undefined) {
    return cachedHome === CACHE_EMPTY ? undefined : cachedHome;
  }

  const resolved = resolvePureBasicHomeUncached();
  cachedHome = resolved ?? CACHE_EMPTY;
  return resolved;
}

function resolvePureBasicHomeUncached(): string | undefined {
  const setting = config().get<string>("purebasicHome", "").trim();
  if (setting) {
    const expanded = expandHome(setting);
    if (looksLikePureBasicHome(expanded)) {
      return expanded;
    }
  }

  const envHome = process.env.PUREBASIC_HOME;
  if (envHome && looksLikePureBasicHome(envHome)) {
    return envHome;
  }

  for (const candidate of candidateHomes()) {
    if (looksLikePureBasicHome(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function backendBinaryName(backend: Backend): string {
  return backend === "asm" ? "pbcompiler" : "pbcompilerc";
}

/** Resolve the compiler binary path for a specific backend, or undefined if not found. */
export function resolveCompilerPath(backend: Backend): string | undefined {
  const override = config().get<string>(`compilerPath.${backend}`, "").trim();
  if (override) {
    const expanded = expandHome(override);
    if (fs.existsSync(expanded)) {
      return expanded;
    }
  }

  const home = resolvePureBasicHome();
  if (!home) {
    return undefined;
  }
  const candidate = path.join(home, "compilers", backendBinaryName(backend));
  return fs.existsSync(candidate) ? candidate : undefined;
}

function commandExistsOnPath(cmd: string): boolean {
  const pathEnv = process.env.PATH ?? "";
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      if (fs.existsSync(path.join(dir, cmd + ext))) {
        return true;
      }
    }
  }
  return false;
}

export function hasCToolchain(): boolean {
  return commandExistsOnPath("gcc") || commandExistsOnPath("clang") || commandExistsOnPath("cc");
}

/**
 * Resolve which backend to use without ever prompting the user. Returns
 * undefined if `auto` mode is ambiguous (both backends present, no choice
 * persisted yet) — safe to call from background work like save-triggered
 * diagnostics.
 */
export function resolveBackendSilent(): Backend | undefined {
  const configured = config().get<string>("backend", "auto");
  if (configured === "asm" || configured === "c") {
    return configured;
  }

  const asmPath = resolveCompilerPath("asm");
  const cPath = resolveCompilerPath("c");
  if (asmPath && !cPath) {
    return "asm";
  }
  if (cPath && !asmPath) {
    return "c";
  }
  return undefined; // ambiguous — needs the interactive prompt
}

/**
 * Resolve which backend to use, prompting once on first ambiguous use and
 * persisting the answer to workspace settings (matches PLAN.md §2.1).
 */
export async function resolveBackend(): Promise<Backend | undefined> {
  const configured = config().get<string>("backend", "auto");
  if (configured === "asm" || configured === "c") {
    return configured;
  }

  const asmPath = resolveCompilerPath("asm");
  const cPath = resolveCompilerPath("c");

  if (asmPath && cPath) {
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: "ASM backend (pbcompiler)",
          description: "Fastest compile, bundled fasm assembler, x86/x64 focus",
          value: "asm" as Backend,
        },
        {
          label: "C backend (pbcompilerc)",
          description: "Portable, uses system gcc/clang",
          value: "c" as Backend,
        },
      ],
      { placeHolder: "Select the PureBasic compiler backend for this workspace" },
    );
    if (!pick) {
      return undefined;
    }
    await config().update("backend", pick.value, vscode.ConfigurationTarget.Workspace);
    return pick.value;
  }

  if (asmPath) {
    return "asm";
  }
  if (cPath) {
    if (!hasCToolchain()) {
      vscode.window.showWarningMessage(
        "Pure Xtension: only the C-backend compiler (pbcompilerc) was found, but no gcc/clang is on PATH. Builds will likely fail.",
      );
    }
    return "c";
  }

  return undefined;
}

export async function selectBackendCommand(): Promise<void> {
  const asmPath = resolveCompilerPath("asm");
  const cPath = resolveCompilerPath("c");
  const options: { label: string; description: string; value: Backend }[] = [];
  if (asmPath) {
    options.push({ label: "ASM backend (pbcompiler)", description: asmPath, value: "asm" });
  }
  if (cPath) {
    options.push({ label: "C backend (pbcompilerc)", description: cPath, value: "c" });
  }
  if (options.length === 0) {
    vscode.window.showErrorMessage(
      "Pure Xtension: no PureBasic compiler found. Set pureXtension.purebasicHome or pureXtension.compilerPath.*.",
    );
    return;
  }
  const pick = await vscode.window.showQuickPick(options, {
    placeHolder: "Select the PureBasic compiler backend for this workspace",
  });
  if (!pick) {
    return;
  }
  await config().update("backend", pick.value, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage(`Pure Xtension: backend set to ${pick.label}.`);
}
