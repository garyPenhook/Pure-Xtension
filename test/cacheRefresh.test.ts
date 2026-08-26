import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadOrBuildBuiltinIndex } from "../server/src/builtinIndex";
import { loadOrFetchHelpIndex } from "../server/src/onlineHelpIndex";

test("forced symbol rebuild bypasses a valid same-version disk cache", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pure-xtension-cache-test-"));
  const compiler = path.join(dir, "fake-compiler.cjs");
  const symbolFile = path.join(dir, "symbol.txt");
  const countFile = path.join(dir, "count.txt");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("-v")) { process.stdout.write("PureBasic Test 1.0"); process.exit(1); }
const out = args[args.indexOf("-o") + 1];
const name = fs.readFileSync(${JSON.stringify(symbolFile)}, "utf8").trim();
const count = Number(fs.readFileSync(${JSON.stringify(countFile)}, "utf8")) + 1;
fs.writeFileSync(${JSON.stringify(countFile)}, String(count));
fs.writeFileSync(out, args.includes("-lf") ? name + " () - test\\n" : "\\n");
`;

  try {
    await writeFile(compiler, script, "utf8");
    await chmod(compiler, 0o755);
    await writeFile(symbolFile, "First", "utf8");
    await writeFile(countFile, "0", "utf8");

    const first = await loadOrBuildBuiltinIndex(compiler, dir);
    assert.equal(first.functions[0]?.name, "First");

    await writeFile(symbolFile, "Second", "utf8");
    const cached = await loadOrBuildBuiltinIndex(compiler, dir);
    assert.equal(cached.functions[0]?.name, "First");

    const rebuilt = await loadOrBuildBuiltinIndex(compiler, dir, true);
    assert.equal(rebuilt.functions[0]?.name, "Second");
    assert.equal(await readFile(countFile, "utf8"), "6");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("forced help refresh bypasses a fresh disk cache", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pure-xtension-help-test-"));
  const originalFetch = globalThis.fetch;
  let command = "First";
  globalThis.fetch = async () =>
    new Response(`<a href=../test/${command.toLowerCase()}.html>${command}</a>`, { status: 200 });

  try {
    const first = await loadOrFetchHelpIndex(dir);
    assert.equal(first?.commands.first?.name, "First");

    command = "Second";
    const cached = await loadOrFetchHelpIndex(dir);
    assert.equal(cached?.commands.first?.name, "First");

    const refreshed = await loadOrFetchHelpIndex(dir, true);
    assert.equal(refreshed?.commands.second?.name, "Second");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});
