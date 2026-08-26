import assert from "node:assert/strict";
import test from "node:test";
import { RetryableLoader } from "../server/src/retryableLoader";

test("RetryableLoader retries an empty load and caches the later success", async () => {
  let calls = 0;
  const loader = new RetryableLoader(async () => (++calls === 1 ? undefined : "ready"));

  assert.equal(await loader.get(), undefined);
  assert.equal(await loader.get(), "ready");
  assert.equal(await loader.get(), "ready");
  assert.equal(calls, 2);
});

test("RetryableLoader coalesces concurrent loads and caches a later force refresh", async () => {
  let calls = 0;
  let release!: (value: string) => void;
  const loader = new RetryableLoader<string>(
    () => new Promise((resolve) => {
      calls++;
      release = resolve;
    }),
  );

  const first = loader.get();
  const joined = loader.get();
  assert.equal(calls, 1);
  release("first");
  assert.equal(await first, "first");
  assert.equal(await joined, "first");

  const refreshed = loader.get(true);
  assert.equal(calls, 2);
  release("second");
  assert.equal(await refreshed, "second");
  assert.equal(await loader.get(), "second");
});

test("RetryableLoader queues one forced refresh behind an ordinary in-flight load", async () => {
  const calls: boolean[] = [];
  const releases: Array<(value: string) => void> = [];
  const loader = new RetryableLoader<string>(
    (force) => new Promise((resolve) => {
      calls.push(force);
      releases.push(resolve);
    }),
  );

  const startup = loader.get();
  const refresh = loader.get(true);
  const joinedRefresh = loader.get(true);
  assert.deepEqual(calls, [false]);

  releases[0]("cached");
  assert.equal(await startup, "cached");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [false, true]);

  releases[1]("fresh");
  assert.equal(await refresh, "fresh");
  assert.equal(await joinedRefresh, "fresh");
  assert.equal(await loader.get(), "fresh");
});
