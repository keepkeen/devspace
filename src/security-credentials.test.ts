import assert from "node:assert/strict";
import test from "node:test";
import { authorizationRootId } from "./authorization-roots.js";
import { internalDiagnosticsToken } from "./internal-auth.js";
import {
  createSecurityKeyring,
  generateMasterKey,
  hashOwnerPassword,
  legacyMasterKeyFromOwnerPassword,
  verifyOwnerPassword,
  verifyOwnerPasswordAsync,
} from "./security-credentials.js";

test("Owner passwords are stored as Argon2id verifiers", () => {
  const password = "owner-password-for-argon2id-test";
  const passwordHash = hashOwnerPassword(password);
  assert.match(passwordHash, /^\$argon2id\$/u);
  assert.equal(passwordHash.includes(password), false);
  assert.equal(verifyOwnerPassword(passwordHash, password), true);
  assert.equal(verifyOwnerPassword(passwordHash, `${password}-wrong`), false);
});

test("request-path Argon2 verification is asynchronous", async () => {
  const password = "owner-password-for-async-argon2-test";
  const passwordHash = hashOwnerPassword(password);
  let immediateObserved = false;
  const verification = verifyOwnerPasswordAsync(passwordHash, password);
  await new Promise<void>((resolve) => setImmediate(() => {
    immediateObserved = true;
    resolve();
  }));
  assert.equal(immediateObserved, true);
  assert.equal(await verification, true);
  assert.equal(await verifyOwnerPasswordAsync(passwordHash, `${password}-wrong`), false);
});

test("password rotation is independent from the persistent HMAC master key", () => {
  const masterKey = generateMasterKey();
  const firstPasswordHash = hashOwnerPassword("first-owner-password-long-enough");
  const secondPasswordHash = hashOwnerPassword("second-owner-password-long-enough");
  assert.notEqual(firstPasswordHash, secondPasswordHash);

  const before = createSecurityKeyring({
    masterKey,
    derivation: "hkdf-v1",
    source: "auth_file",
  });
  const after = createSecurityKeyring({
    masterKey,
    derivation: "hkdf-v1",
    source: "auth_file",
  });
  assert.equal(before.masterKeyFingerprint, after.masterKeyFingerprint);
  assert.deepEqual(before.legacyOwnerVerifier, after.legacyOwnerVerifier);
  assert.deepEqual(before.authorizationRoot, after.authorizationRoot);
  assert.deepEqual(before.cursor, after.cursor);
  assert.deepEqual(before.auditReference, after.auditReference);
});

test("HKDF purpose keys are domain separated and master-key rotation changes all identities", () => {
  const first = createSecurityKeyring({
    masterKey: generateMasterKey(),
    derivation: "hkdf-v1",
    source: "auth_file",
  });
  const second = createSecurityKeyring({
    masterKey: generateMasterKey(),
    derivation: "hkdf-v1",
    source: "auth_file",
  });
  const firstKeys = [
    first.legacyOwnerVerifier,
    first.authorizationRoot,
    first.projectFingerprint,
    first.cursor,
    first.auditReference,
    first.internalDiagnostics,
    first.internalConfigReload,
    first.internalRevocation,
  ];
  assert.equal(new Set(firstKeys.map((key) => key.toString("hex"))).size, firstKeys.length);
  const secondKeys = [
    second.legacyOwnerVerifier,
    second.authorizationRoot,
    second.projectFingerprint,
    second.cursor,
    second.auditReference,
    second.internalDiagnostics,
    second.internalConfigReload,
    second.internalRevocation,
  ];
  for (let index = 0; index < firstKeys.length; index += 1) {
    assert.notDeepEqual(firstKeys[index], secondKeys[index]);
  }
});

test("legacy-direct migration preserves pre-v2 HMAC identifiers", () => {
  const ownerPassword = "legacy-owner-token-that-was-also-a-key";
  const ownerPasswordHash = hashOwnerPassword(ownerPassword);
  const keyring = createSecurityKeyring({
    masterKey: legacyMasterKeyFromOwnerPassword(ownerPassword),
    derivation: "legacy-direct",
    source: "auth_file",
  });
  assert.equal(keyring.legacyCompatibility, true);
  assert.equal(
    verifyOwnerPassword(ownerPasswordHash, keyring.legacyOwnerVerifier),
    true,
    "legacy key bytes must prove they describe the same password as the v2 verifier",
  );
  assert.equal(
    authorizationRootId(process.cwd(), keyring.authorizationRoot),
    authorizationRootId(process.cwd(), ownerPassword),
  );
  assert.equal(
    internalDiagnosticsToken(keyring.internalDiagnostics),
    internalDiagnosticsToken(ownerPassword),
  );
});
