import assert from "node:assert/strict";
import {
  decodeProjectHandoffRef,
  encodeProjectHandoffRef,
  ProjectHandoffRefError,
} from "./project-handoff-ref.js";

const key = "handoff-reference-key";
const handoffRef = encodeProjectHandoffRef("handoff-α", key);

assert.match(handoffRef, /^phf1_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
assert.equal(decodeProjectHandoffRef(handoffRef, key), "handoff-α");

for (const invalid of [
  "",
  "phf1_missing-mac",
  handoffRef.replace(/.$/u, handoffRef.endsWith("A") ? "B" : "A"),
  handoffRef.replace("phf1_", "pex1_"),
]) {
  assert.throws(
    () => decodeProjectHandoffRef(invalid, key),
    ProjectHandoffRefError,
  );
}

assert.throws(
  () => decodeProjectHandoffRef(handoffRef, "different-key"),
  ProjectHandoffRefError,
);
assert.throws(
  () => encodeProjectHandoffRef("", key),
  /handoffId must be/u,
);
