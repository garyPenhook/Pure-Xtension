import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rm, mkdir, writeFile } from "node:fs/promises";
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

function isBuiltinFunction(value: unknown): value is BuiltinFunction {
  if (!value || typeof value !== "object") return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.name === "string" &&
    typeof f.signature === "string" &&
    typeof f.params === "string" &&
    typeof f.description === "string"
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

// L8: a valid-JSON cache was previously accepted after checking only
// compilerVersion — a malformed functions/structures/interfaces shape (e.g.
// truncated by an interrupted write, or from some future/incompatible schema
// change) would parse fine here and only throw later, deep inside
// completion/hover, instead of triggering a rebuild.
function isValidBuiltinIndex(value: unknown, expectedVersion: string): value is BuiltinIndex {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.compilerVersion === expectedVersion &&
    Array.isArray(v.functions) &&
    v.functions.every(isBuiltinFunction) &&
    isStringArray(v.structures) &&
    isStringArray(v.interfaces)
  );
}

/** Writes `index` to `file` atomically: a reader (or a crash/interrupted
 *  process) can never observe a partially-written cache file. */
async function writeCacheAtomic(file: string, index: BuiltinIndex): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(index), "utf8");
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Loads the built-in index from disk cache, rebuilding via the compiler if missing/stale/invalid. */
export async function loadOrBuildBuiltinIndex(
  compilerPath: string,
  cacheDir: string,
  forceRebuild = false,
): Promise<BuiltinIndex> {
  const version = await detectVersion(compilerPath);
  const file = cacheFile(cacheDir, version);

  if (!forceRebuild) {
    try {
      const cached: unknown = JSON.parse(await readFile(file, "utf8"));
      if (isValidBuiltinIndex(cached, version)) return cached;
    } catch {
      // no cache yet, or unreadable — fall through and rebuild.
    }
  }

  const index = await buildBuiltinIndex(compilerPath, version);
  await mkdir(cacheDir, { recursive: true });
  await writeCacheAtomic(file, index);
  return index;
}
