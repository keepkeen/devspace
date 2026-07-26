import assert from "node:assert/strict";
import test from "node:test";
import {
  AsyncConcurrencyGate,
  AsyncConcurrencyGateBusyError,
} from "./async-concurrency-gate.js";

test("async concurrency gate is bounded and FIFO", async () => {
  const gate = new AsyncConcurrencyGate(2, 4);
  let active = 0;
  let maximum = 0;
  const starts: number[] = [];
  const releases: Array<() => void> = [];

  const tasks = Array.from({ length: 6 }, (_, index) => gate.run(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    starts.push(index);
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
  }));

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [0, 1]);
  releases.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [0, 1, 2]);
  while (releases.length > 0) {
    releases.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await Promise.all(tasks);
  assert.equal(maximum, 2);
  assert.deepEqual(starts, [0, 1, 2, 3, 4, 5]);
});

test("async concurrency gate rejects excess queued work", async () => {
  const gate = new AsyncConcurrencyGate(1, 0);
  let release!: () => void;
  const running = gate.run(() => new Promise<void>((resolve) => { release = resolve; }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(gate.run(async () => undefined), AsyncConcurrencyGateBusyError);
  release();
  await running;
});
