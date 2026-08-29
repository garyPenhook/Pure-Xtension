import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadOrBuildBuiltinIndex } from "../server/src/builtinIndex";
import { loadOrFetchHelpIndex } from "../server/src/onlineHelpIndex";

/** A page with `n` valid command links, shaped like the real commandindex.html. */
function pageWithCommands(n: number): string {
  let html = "<html><body>";
  for (let i = 0; i < n; i++) html += `<a href=../test/cmd${i}.html>Cmd${i}</a>`;
  return html + "</body></html>";
}

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
    new Response(`<a href=../test/${command.toLowerCase()}.html>${command}</a>${pageWithCommands(600)}`, {
      status: 200,
    });

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

test("a page-layout change that parses too few commands keeps serving the last known-good cache", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pure-xtension-help-layout-test-"));
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => new Response(pageWithCommands(600), { status: 200 });
    const good = await loadOrFetchHelpIndex(dir);
    assert.equal(Object.keys(good?.commands ?? {}).length, 600);

    // Simulate the live page's markup changing so LINK_RE stops matching
    // almost everything, instead of the command reference actually shrinking.
    globalThis.fetch = async () => new Response(pageWithCommands(3), { status: 200 });
    const stillGood = await loadOrFetchHelpIndex(dir, true);
    assert.equal(Object.keys(stillGood?.commands ?? {}).length, 600, "must not adopt the truncated parse");

    const onDisk = JSON.parse(await readFile(path.join(dir, "help-index-v2.json"), "utf8"));
    assert.equal(Object.keys(onDisk.commands).length, 600, "must not persist the truncated parse either");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("an empty parse is rejected and does not overwrite or get cached as a good index", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pure-xtension-help-empty-test-"));
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => new Response("<html><body>no commands here</body></html>", { status: 200 });
    const result = await loadOrFetchHelpIndex(dir);
    assert.equal(result, undefined, "an empty parse with no prior cache must not be treated as a good index");

    const entries = await readdir(dir).catch(() => []);
    assert.equal(entries.length, 0, "an empty/invalid parse must not be written to disk");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a cache write that fails partway through leaves the previous good cache file intact", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pure-xtension-help-write-test-"));
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => new Response(pageWithCommands(600), { status: 200 });
    const good = await loadOrFetchHelpIndex(dir);
    assert.equal(Object.keys(good?.commands ?? {}).length, 600);
    const beforeBytes = await readFile(path.join(dir, "help-index-v2.json"), "utf8");

    // Make the cache directory unwritable so the atomic tmp-file write fails
    // partway through, simulating an interrupted/failed write.
    await chmod(dir, 0o500);
    globalThis.fetch = async () => new Response(pageWithCommands(700), { status: 200 });
    const fallback = await loadOrFetchHelpIndex(dir, true);
    assert.equal(Object.keys(fallback?.commands ?? {}).length, 600, "must fall back to the last good cache");

    await chmod(dir, 0o700);
    const afterBytes = await readFile(path.join(dir, "help-index-v2.json"), "utf8");
    assert.equal(afterBytes, beforeBytes, "the on-disk cache must be untouched by the failed write");

    const leftovers = (await readdir(dir)).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "no partial tmp file should remain");
  } finally {
    await chmod(dir, 0o700).catch(() => {});
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});
