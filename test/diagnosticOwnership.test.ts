import assert from "node:assert/strict";
import test from "node:test";
import { DiagnosticGenerations, DiagnosticOwnership } from "../src/build/diagnosticOwnership";

test("shared include diagnostics stay published until every owning main document clears them", () => {
  const ownership = new DiagnosticOwnership<string>();
  const include = "file:///workspace/shared.pbi";
  const mainA = "file:///workspace/a.pb";
  const mainB = "file:///workspace/b.pb";

  ownership.replace(mainA, new Map([[mainA, ["a-main"]], [include, ["a-include"]]]));
  ownership.replace(mainB, new Map([[mainB, ["b-main"]], [include, ["b-include"]]]));
  assert.deepEqual(ownership.merged(include), ["a-include", "b-include"]);

  assert.deepEqual([...ownership.remove(mainA)].sort(), [include, mainA].sort());
  assert.deepEqual(ownership.merged(include), ["b-include"]);
  assert.deepEqual(ownership.merged(mainA), []);
});

test("a newer result replaces only its own contribution and clears unreachable includes", () => {
  const ownership = new DiagnosticOwnership<string>();
  const oldInclude = "file:///workspace/old.pbi";
  const sharedInclude = "file:///workspace/shared.pbi";
  const owner = "file:///workspace/main.pb";
  const otherOwner = "file:///workspace/other.pb";

  ownership.replace(owner, new Map([[oldInclude, ["old"]], [sharedInclude, ["first"]]]));
  ownership.replace(otherOwner, new Map([[sharedInclude, ["other"]]]));
  const affected = ownership.replace(owner, new Map([[sharedInclude, ["fresh"]]]));

  assert.deepEqual([...affected].sort(), [oldInclude, sharedInclude].sort());
  assert.deepEqual(ownership.merged(oldInclude), []);
  assert.deepEqual(ownership.merged(sharedInclude), ["fresh", "other"]);
});

test("rapid edits and close/reopen invalidate every older asynchronous result", () => {
  const generations = new DiagnosticGenerations();
  const owner = "file:///workspace/main.pb";

  const beforeLoad = generations.advance(owner);
  // This models a save while the old run is awaiting openTextDocument().
  const afterEdit = generations.advance(owner);
  assert.equal(generations.isCurrent(owner, beforeLoad), false);
  assert.equal(generations.isCurrent(owner, afterEdit), true);

  // Closing, then reopening/checking must also reject results from before
  // close even if they finish last.
  const closeFence = generations.advance(owner);
  const reopened = generations.advance(owner);
  assert.equal(generations.isCurrent(owner, afterEdit), false);
  assert.equal(generations.isCurrent(owner, closeFence), false);
  assert.equal(generations.isCurrent(owner, reopened), true);
});
