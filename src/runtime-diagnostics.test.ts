import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeDiagnostics } from "./runtime-diagnostics.js";

test("runtime diagnostics retain bounded redacted failure metadata", () => {
  const diagnostics = new RuntimeDiagnostics(2, () => new Date("2026-01-02T03:04:05.000Z"));
  diagnostics.recordFailure("first /Users/private", new Error("secret path"));
  diagnostics.recordFailure("second", new TypeError("secret token"));
  diagnostics.recordFailure("third", "raw secret");

  assert.deepEqual(diagnostics.snapshot(), [
    { at: "2026-01-02T03:04:05.000Z", event: "second", category: "TypeError" },
    { at: "2026-01-02T03:04:05.000Z", event: "third", category: "Error" },
  ]);
  assert.equal(JSON.stringify(diagnostics.snapshot()).includes("secret"), false);
  assert.equal(JSON.stringify(diagnostics.snapshot()).includes("/Users"), false);
});
