import assert from "node:assert/strict";
import {
  isValidOperationId,
  operationId,
  operationIdSchema,
} from "./operation-id.js";

const asciiMaximum = "a".repeat(128);
const multibyteMaximum = `${"界".repeat(42)}ab`;

for (const value of [asciiMaximum, multibyteMaximum, " ", "\uFFFD"]) {
  assert.equal(isValidOperationId(value), true);
  assert.equal(operationId(value), value);
  assert.equal(operationIdSchema.safeParse(value).success, true);
}

for (const value of [
  "",
  "a".repeat(129),
  `${multibyteMaximum}c`,
  "nul\0operation",
  "\uD800",
  "\uDC00",
]) {
  assert.equal(isValidOperationId(value), false);
  assert.throws(() => operationId(value), /operationId must be/u);
  assert.equal(operationIdSchema.safeParse(value).success, false);
}

console.log("operation id tests passed");
