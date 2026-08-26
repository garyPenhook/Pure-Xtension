import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseFunctionsDump,
  parseNameListDump,
  parseStructureFieldsDump,
  BuiltinFunction,
  StructureField,
} from "./dumpParsers";

export interface BuiltinIndex {
  compilerVersion: string;
  functions: BuiltinFunction[];
  structures: string[];
  interfaces: string[];
}

function runCompiler(compilerPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(compilerPath, args, { timeout: 30_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

// Verified against pbcompiler 6.41: `-v` prints the version banner but exits
// with status 1 (unlike every other flag used here, which exits 0), so it
// needs its own runner that doesn't treat that exit code as failure.
function runCompilerAllowingNonZeroExit(compilerPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(compilerPath, args, { timeout: 30_000 }, (error, stdout) => {
      if (stdout) resolve(stdout);
      else reject(error);
    });
  });
}

async function detectVersion(compilerPath: string): Promise<string> {
  const stdout = await runCompilerAllowingNonZeroExit(compilerPath, ["-v"]);
  return stdout.trim() || "unknown";
}

/** Builds the built-in symbol index by running pbcompiler's dump flags once.
 *  `knownVersion` lets a caller that already detected it (e.g. loadOrBuildBuiltinIndex,
 *  to pick a cache file) skip spawning `pbcompiler -v` a second time. */
export async function buildBuiltinIndex(compilerPath: string, knownVersion?: string): Promise<BuiltinIndex> {
  const version = knownVersion ?? (await detectVersion(compilerPath));
  const dir = await mkdtemp(join(tmpdir(), "pure-xtension-"));
  const stubSource = join(dir, "stub.pb");
  const funcsFile = join(dir, "funcs.txt");
  const structsFile = join(dir, "structs.txt");
  const ifacesFile = join(dir, "ifaces.txt");

  try {
    await writeFile(stubSource, "; symbol-dump stub\n", "utf8");
    await runCompiler(compilerPath, [stubSource, "-lf", "-o", funcsFile, "-k", "-q"]);
    await runCompiler(compilerPath, [stubSource, "-ls", "-o", structsFile, "-k", "-q"]);
    await runCompiler(compilerPath, [stubSource, "-li", "-o", ifacesFile, "-k", "-q"]);

    const [funcsText, structsText, ifacesText] = await Promise.all([
      readFile(funcsFile, "utf8"),
      readFile(structsFile, "utf8"),
      readFile(ifacesFile, "utf8"),
    ]);

    return {
      compilerVersion: version,
      functions: parseFunctionsDump(funcsText),
      structures: parseNameListDump(structsText),
      interfaces: parseNameListDump(ifacesText),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** On-demand `-qs <name>` lookup for a single built-in structure's fields. */
export async function queryStructureFields(
  compilerPath: string,
  structureName: string,
): Promise<StructureField[]> {
  const dir = await mkdtemp(join(tmpdir(), "pure-xtension-qs-"));
  try {
    const stubSource = join(dir, "stub.pb");
    const outFile = join(dir, "fields.txt");
    await writeFile(stubSource, "; symbol-dump stub\n", "utf8");
    await runCompiler(compilerPath, [stubSource, "-qs", structureName, "-o", outFile, "-k", "-q"]);
    const text = await readFile(outFile, "utf8");
    return parseStructureFieldsDump(text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function cacheFile(cacheDir: string, version: string): string {
  const safeVersion = version.replace(/[^\w.-]+/g, "_");
  return join(cacheDir, `symbol-cache-${safeVersion}.json`);
}

/** Loads the built-in index from disk cache, rebuilding via the compiler if missing/stale. */
export async function loadOrBuildBuiltinIndex(
  compilerPath: string,
  cacheDir: string,
  forceRebuild = false,
): Promise<BuiltinIndex> {
  const version = await detectVersion(compilerPath);
  const file = cacheFile(cacheDir, version);

  if (!forceRebuild) {
    try {
      const cached = JSON.parse(await readFile(file, "utf8")) as BuiltinIndex;
      if (cached.compilerVersion === version) return cached;
    } catch {
      // no cache yet, or unreadable — fall through and rebuild.
    }
  }

  const index = await buildBuiltinIndex(compilerPath, version);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(file, JSON.stringify(index), "utf8");
  return index;
}
