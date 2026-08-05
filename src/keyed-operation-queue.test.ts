import assert from "node:assert/strict";
import { KeyedOperationQueue } from "./keyed-operation-queue.js";

const queue = new KeyedOperationQueue();
const order: string[] = [];
let releaseFirst!: () => void;
const firstBlocked = new Promise<void>((resolve) => {
  releaseFirst = resolve;
});

const first = queue.run("session-a\0actor-a", async () => {
  order.push("first:start");
  await firstBlocked;
  order.push("first:end");
  return "first";
});
const second = queue.run("session-a\0actor-a", async () => {
  order.push("second:start");
  order.push("second:end");
  return "second";
});
const independent = queue.run("session-b\0actor-a", async () => {
  order.push("independent");
});

await independent;
assert.deepEqual(order, ["first:start", "independent"]);
releaseFirst();
assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
assert.deepEqual(order, [
  "first:start",
  "independent",
  "first:end",
  "second:start",
  "second:end",
]);

const recovered = await queue.run("failure", async () => {
  throw new Error("expected failure");
}).catch((error: unknown) => (error as Error).message);
assert.equal(recovered, "expected failure");
assert.equal(await queue.run("failure", async () => "recovered"), "recovered");
