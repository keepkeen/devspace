import assert from "node:assert/strict";
import { ActiveRequestBarrier } from "./request-barrier.js";

const barrier = new ActiveRequestBarrier();
assert.equal(await barrier.waitForIdle(10), true);

const releaseWithoutTimeout = barrier.enter();
const waitsWithoutTimeout = barrier.waitForIdle();
releaseWithoutTimeout();
assert.equal(await waitsWithoutTimeout, true);
const releaseFirst = barrier.enter();
const releaseSecond = barrier.enter();
let drained = false;
const waiting = barrier.waitForIdle(1_000).then((value) => {
  drained = value;
});
releaseFirst();
await Promise.resolve();
assert.equal(drained, false);
releaseSecond();
await waiting;
assert.equal(drained, true);
releaseSecond();

const timedRelease = barrier.enter();
assert.equal(await barrier.waitForIdle(1), false);
timedRelease();
assert.equal(await barrier.waitForIdle(1), true);

let finishTracked: (() => void) | undefined;
const tracked = barrier.track(() => new Promise<void>((resolve) => {
  finishTracked = resolve;
}));
assert.equal(await barrier.waitForIdle(1), false);
finishTracked?.();
await tracked;
assert.equal(await barrier.waitForIdle(1), true);
