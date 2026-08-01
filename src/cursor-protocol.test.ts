import assert from "node:assert/strict";
import test from "node:test";
import {
  cursorCallerRef,
  CursorProtocolError,
  cursorQueryHash,
  decodeCursor,
  encodeCursor,
} from "./cursor-protocol.js";

const key = Buffer.alloc(32, 7);
const now = 1_000_000;
const callerIdentity = {
  connectionPrincipalId: "principal-a",
  grantId: "grant-a",
  authorizationEpoch: 1,
  executionId: "execution-a",
};

test("signed cursors bind resource, principal, query, revision, offset, and expiry", () => {
  const principalRef = cursorCallerRef(callerIdentity, key);
  const cursor = encodeCursor({
    resourceType: "diff",
    principalRef,
    queryHash: cursorQueryHash({ status: "active" }),
    revision: "rev-a",
    offset: 20,
  }, key, { now, ttlMs: 10_000 });
  assert.match(cursor, /^dcur1\./u);
  assert.deepEqual(decodeCursor(cursor, key, now + 1), {
    schemaVersion: 1,
    resourceType: "diff",
    principalRef,
    queryHash: cursorQueryHash({ status: "active" }),
    revision: "rev-a",
    offset: 20,
    expiresAt: now + 10_000,
  });
});

test("cursor signatures and expiry fail closed", () => {
  const cursor = encodeCursor({
    resourceType: "skill",
    principalRef: cursorCallerRef(callerIdentity, key),
    workspaceGeneration: 3,
    queryHash: cursorQueryHash(["src/file.ts"]),
    revision: "instructions-a",
    offset: 0,
  }, key, { now, ttlMs: 10 });
  const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`;
  assert.throws(() => decodeCursor(tampered, key, now), CursorProtocolError);
  const [prefix, body, signature] = cursor.split(".");
  assert.equal(prefix, "dcur1");
  assert.ok(body && signature);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const finalIndex = alphabet.indexOf(signature.at(-1)!);
  assert.equal(finalIndex % 4, 0, "a 32-byte canonical signature has two zero padding bits");
  const nonCanonicalSignature = `${signature.slice(0, -1)}${alphabet[finalIndex + 1]}`;
  assert.deepEqual(
    Buffer.from(nonCanonicalSignature, "base64url"),
    Buffer.from(signature, "base64url"),
    "the fixture must alter only ignored Base64URL padding bits",
  );
  assert.throws(
    () => decodeCursor(`${prefix}.${body}.${nonCanonicalSignature}`, key, now),
    CursorProtocolError,
  );
  assert.throws(
    () => decodeCursor(cursor, key, now + 11),
    (error: unknown) => error instanceof CursorProtocolError && error.reason === "expired",
  );
  assert.throws(() => decodeCursor(cursor, Buffer.alloc(32, 8), now), CursorProtocolError);
});

test("cursor hashes are stable across object key order", () => {
  assert.equal(cursorQueryHash({ a: 1, b: 2 }), cursorQueryHash({ b: 2, a: 1 }));
});

test("cursor caller references bind the complete request authorization identity", () => {
  const reference = cursorCallerRef(callerIdentity, key);
  for (const identity of [
    { ...callerIdentity, connectionPrincipalId: "principal-b" },
    { ...callerIdentity, grantId: "grant-b" },
    { ...callerIdentity, authorizationEpoch: 2 },
    { ...callerIdentity, executionId: "execution-b" },
  ]) {
    assert.notEqual(cursorCallerRef(identity, key), reference);
  }
  assert.equal(cursorCallerRef({ ...callerIdentity }, key), reference);
  assert.throws(
    () => cursorCallerRef({ ...callerIdentity, executionId: "" }, key),
    TypeError,
  );
});

test("public continuation cursor types carry only the opaque request-bound caller reference", () => {
  const callerRef = cursorCallerRef(callerIdentity, key);
  const otherExecutionRef = cursorCallerRef({
    ...callerIdentity,
    executionId: "execution-b",
  }, key);
  const replacementGrantRef = cursorCallerRef({
    ...callerIdentity,
    grantId: "grant-b",
  }, key);
  for (const resourceType of ["instruction", "process", "skill", "diff"] as const) {
    const cursor = encodeCursor({
      resourceType,
      principalRef: callerRef,
      queryHash: "query-a",
      revision: "revision-a",
      offset: 1,
    }, key, { now, ttlMs: 10_000 });
    const decoded = decodeCursor(cursor, key, now + 1);
    assert.equal(decoded.principalRef, callerRef);
    assert.notEqual(decoded.principalRef, otherExecutionRef);
    assert.notEqual(decoded.principalRef, replacementGrantRef);
    const decodedJson = JSON.stringify(decoded);
    for (const rawIdentityValue of Object.values(callerIdentity)) {
      if (typeof rawIdentityValue === "string") {
        assert.equal(decodedJson.includes(rawIdentityValue), false);
      }
    }
  }
});

test("diff cursors use the same signed principal and revision envelope", () => {
  const cursor = encodeCursor({
    resourceType: "diff",
    principalRef: cursorCallerRef(callerIdentity, key),
    workspaceGeneration: 9,
    queryHash: cursorQueryHash({ since: "last_shown" }),
    revision: "review-revision",
    offset: 12_000,
  }, key, { now, ttlMs: 10_000 });
  assert.equal(decodeCursor(cursor, key, now + 1).resourceType, "diff");
});

test("a cursor can carry bounded signed continuation identity", () => {
  const cursor = encodeCursor({
    resourceType: "process",
    principalRef: cursorCallerRef(callerIdentity, key),
    workspaceGeneration: 2,
    queryHash: cursorQueryHash({ mode: "search", query: "failed" }),
    revision: "process-output-a",
    offset: 42,
    resourceId: "output-a",
    parameters: {
      mode: "search",
      query: "failed",
      ignoreCase: true,
      maxMatches: 20,
    },
  }, key, { now, ttlMs: 10_000 });
  const decoded = decodeCursor(cursor, key, now + 1);
  assert.equal(decoded.resourceId, "output-a");
  assert.deepEqual(decoded.parameters, {
    mode: "search",
    query: "failed",
    ignoreCase: true,
    maxMatches: 20,
  });
  assert.throws(
    () => encodeCursor({
      resourceType: "process",
      principalRef: cursorCallerRef(callerIdentity, key),
      queryHash: "query-a",
      revision: "revision-a",
      offset: 0,
      parameters: { query: "x".repeat(513) },
    }, key, { now, ttlMs: 10_000 }),
    CursorProtocolError,
  );
});

test("root instruction cursors use the same request-bound signed envelope", () => {
  const cursor = encodeCursor({
    resourceType: "instruction",
    principalRef: cursorCallerRef(callerIdentity, key),
    workspaceGeneration: 4,
    queryHash: cursorQueryHash({ kind: "root_instructions" }),
    revision: "root-instructions-a",
    offset: 12_000,
  }, key, { now, ttlMs: 10_000 });
  const decoded = decodeCursor(cursor, key, now + 1);
  assert.equal(decoded.resourceType, "instruction");
  assert.equal(decoded.offset, 12_000);
});
