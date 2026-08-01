import assert from "node:assert/strict";
import {
  decodeProjectExecutionRef,
  encodeProjectExecutionRef,
  ProjectExecutionRefError,
} from "./project-execution-ref.js";

const key = Buffer.alloc(32, 7);
const executionId = "pex_6c754c7e-58f8-4c87-bd99-d104f861be2d";
const executionRef = encodeProjectExecutionRef(executionId, key);

assert.equal(decodeProjectExecutionRef(executionRef, key), executionId);
assert.match(executionRef, /^pex1_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);

const tampered = `${executionRef.slice(0, -1)}${executionRef.endsWith("A") ? "B" : "A"}`;
assert.throws(
  () => decodeProjectExecutionRef(tampered, key),
  ProjectExecutionRefError,
);
assert.throws(
  () => decodeProjectExecutionRef(executionRef, Buffer.alloc(32, 8)),
  ProjectExecutionRefError,
);
assert.throws(
  () => decodeProjectExecutionRef("pex1_not-base64.unsigned", key),
  ProjectExecutionRefError,
);
assert.throws(
  () => encodeProjectExecutionRef("x".repeat(129), key),
  /1-128 UTF-8 bytes/u,
);
