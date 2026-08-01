import assert from "node:assert/strict";
import {
  BATCH_ERROR_MAX_CHARACTERS,
  BATCH_ITEM_MIN_CHARACTERS,
  BATCH_ITEM_MAX_CHARACTERS,
  BATCH_MAX_ITEMS,
  BATCH_TOTAL_MAX_CHARACTERS,
  runBoundedBatch,
} from "./batch-tools.js";

const ordered = await runBoundedBatch(
  [
    { operation: "read", path: "slow" },
    { operation: "read", path: "fast" },
  ],
  async (item) => {
    if (item.path === "slow") await new Promise((resolve) => setTimeout(resolve, 10));
    return { ok: true, result: item.path };
  },
);
assert.deepEqual(ordered.items.map((item) => item.path), ["slow", "fast"]);

const referencedDuplicates = await runBoundedBatch(
  [
    { operation: "read", path: "same", ref: "first" },
    { operation: "read", path: "same", ref: "second" },
  ],
  async () => ({ ok: true, result: "content" }),
);
assert.deepEqual(referencedDuplicates.items.map((item) => item.ref), ["first", "second"]);
assert.equal(referencedDuplicates.items[0]?.ok, true);
assert.equal(referencedDuplicates.items[1]?.ok, false);
assert.match(referencedDuplicates.items[1]?.result ?? "", /Duplicate batch item skipped/);

const partialFailure = await runBoundedBatch(
  [
    { operation: "read", path: "ok" },
    { operation: "read", path: "bad" },
    { operation: "read", path: "ok" },
  ],
  async (item) => {
    if (item.path === "bad") throw new Error("unreadable");
    return { ok: true, result: "content" };
  },
);
assert.equal(partialFailure.items[0]?.ok, true);
assert.equal(partialFailure.items[1]?.ok, false);
assert.equal(partialFailure.items[1]?.result, "Batch item failed.");
assert.match(partialFailure.items[2]?.result ?? "", /Duplicate batch item skipped/);

const oversized = await runBoundedBatch(
  Array.from({ length: 4 }, (_, index) => ({ operation: "grep", path: String(index) })),
  async () => ({ ok: true, result: "x".repeat(BATCH_ITEM_MAX_CHARACTERS + 100) }),
);
assert.equal(oversized.truncated, true);
assert.ok(oversized.items.every((item) => item.result.length <= BATCH_ITEM_MAX_CHARACTERS));
assert.ok(oversized.items.reduce((sum, item) => sum + item.result.length, 0) <= BATCH_TOTAL_MAX_CHARACTERS);
assert.ok(oversized.result.length <= BATCH_TOTAL_MAX_CHARACTERS);
assert.ok(oversized.items.every((item) => item.result.length >= BATCH_ITEM_MIN_CHARACTERS));

await assert.rejects(
  runBoundedBatch(
    [{ operation: "read", path: "large.txt" }],
    async () => ({
      ok: true,
      result: `${"visible\n".repeat(BATCH_ITEM_MAX_CHARACTERS)}[Use offset=20001 to continue.]`,
    }),
  ),
  /continuation after its visible content was truncated/u,
);

await assert.rejects(
  runBoundedBatch(
    [
      { operation: "read", path: "first.txt" },
      { operation: "read", path: "second.txt" },
    ],
    async () => ({ ok: true, result: "line\n".repeat(200) }),
    { totalMaxCharacters: 1_000, minItemCharacters: 100 },
  ),
  /continuation after its visible content was truncated/u,
);

const fairlyAllocated = await runBoundedBatch(
  Array.from({ length: 8 }, (_, index) => ({ operation: "grep", path: String(index) })),
  async () => ({ ok: true, result: "x".repeat(1_000) }),
  {
    totalMaxCharacters: 800,
    minItemCharacters: 50,
    allocationChunkCharacters: 25,
  },
);
assert.ok(fairlyAllocated.items.every((item) => item.result.length === 100));
assert.ok(fairlyAllocated.items.every((item) => item.truncated));

const explicitlyOmitted = await runBoundedBatch(
  Array.from({ length: 4 }, (_, index) => ({ operation: "glob", path: String(index) })),
  async () => ({ ok: true, result: "content" }),
  { totalMaxCharacters: 2, minItemCharacters: 10 },
);
assert.equal(explicitlyOmitted.items.filter((item) => item.omitted).length, 2);
assert.ok(explicitlyOmitted.items
  .filter((item) => item.omitted)
  .every((item) => item.omittedReason === "aggregate_budget_exhausted"));

let capturedBatchError: unknown;
const oversizedError = await runBoundedBatch(
  [{ operation: "read", path: "bad" }],
  async () => { throw Object.assign(new Error(`/Users/private/${"x".repeat(BATCH_ITEM_MAX_CHARACTERS + 100)}`), { code: "EIO" }); },
  { onError: (error) => { capturedBatchError = error; } },
);
assert.equal(oversizedError.items[0]?.truncated, false);
assert.ok(BATCH_ERROR_MAX_CHARACTERS < BATCH_ITEM_MAX_CHARACTERS);
assert.ok((oversizedError.items[0]?.result.length ?? Infinity) <= BATCH_ERROR_MAX_CHARACTERS);
assert.equal(oversizedError.items[0]?.result, "EIO: Batch item failed.");
assert.doesNotMatch(oversizedError.items[0]?.result ?? "", /Users|private/);
assert.match(capturedBatchError instanceof Error ? capturedBatchError.message : "", /Users\/private/);

const publicRecoveryError = await runBoundedBatch(
  [{ operation: "read", path: "SKILL.md" }],
  async () => {
    throw Object.assign(new Error("private diagnostic"), {
      code: "skill_not_loaded",
      publicText: "Call skills with action=load for the selected Project, then retry.",
    });
  },
);
assert.equal(
  publicRecoveryError.items[0]?.result,
  "skill_not_loaded: Call skills with action=load for the selected Project, then retry.",
);
assert.doesNotMatch(publicRecoveryError.items[0]?.result ?? "", /private diagnostic/);

const oversizedReturnedError = await runBoundedBatch(
  [{ operation: "read", path: "bad" }],
  async () => ({ ok: false, result: "x".repeat(BATCH_ERROR_MAX_CHARACTERS + 100) }),
);
assert.equal(oversizedReturnedError.items[0]?.truncated, true);
assert.ok((oversizedReturnedError.items[0]?.result.length ?? Infinity) <= BATCH_ERROR_MAX_CHARACTERS);

await assert.rejects(
  runBoundedBatch([], async () => ({ ok: true, result: "" })),
  /between 1/,
);
await assert.rejects(
  runBoundedBatch(
    Array.from({ length: BATCH_MAX_ITEMS + 1 }, (_, index) => ({ operation: "read", path: String(index) })),
    async () => ({ ok: true, result: "" }),
  ),
  new RegExp(String(BATCH_MAX_ITEMS)),
);

console.log("batch-tools tests passed");
