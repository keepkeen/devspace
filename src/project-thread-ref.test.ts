import assert from "node:assert/strict";
import {
  decodeProjectThreadRef,
  encodeProjectThreadRef,
  ProjectThreadRefError,
} from "./project-thread-ref.js";

const key = Buffer.alloc(32, 7);
const otherKey = Buffer.alloc(32, 8);
const threadRef = encodeProjectThreadRef("thread-a", key);

assert.match(threadRef, /^pth1_/u);
assert.equal(decodeProjectThreadRef(threadRef, key), "thread-a");
assert.throws(() => decodeProjectThreadRef(threadRef, otherKey), ProjectThreadRefError);
assert.throws(
  () => decodeProjectThreadRef(`${threadRef.slice(0, -1)}A`, key),
  ProjectThreadRefError,
);
assert.throws(() => encodeProjectThreadRef("", key), RangeError);

console.log("project thread ref tests passed");
