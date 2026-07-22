import assert from "node:assert/strict";
import test from "node:test";
import {
  internalDiagnosticsToken,
  internalRevocationToken,
  validInternalDiagnosticsToken,
  validInternalRevocationToken,
} from "./internal-auth.js";

test("internal diagnostics tokens are deterministic and domain separated", () => {
  const token = internalDiagnosticsToken("owner-secret");
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(validInternalDiagnosticsToken("owner-secret", token), true);
  assert.equal(validInternalDiagnosticsToken("different-secret", token), false);
  assert.equal(validInternalDiagnosticsToken("owner-secret", undefined), false);
  assert.equal(token.includes("owner-secret"), false);
  const revocationToken = internalRevocationToken("owner-secret");
  assert.notEqual(revocationToken, token);
  assert.equal(validInternalRevocationToken("owner-secret", revocationToken), true);
  assert.equal(validInternalRevocationToken("owner-secret", token), false);
  assert.equal(validInternalDiagnosticsToken("owner-secret", revocationToken), false);
});
