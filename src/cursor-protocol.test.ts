import assert from "node:assert/strict";
import test from "node:test";
import {
  CursorProtocolError,
  cursorPrincipalRef,
  cursorQueryHash,
  decodeCursor,
  encodeCursor,
} from "./cursor-protocol.js";

const key = Buffer.alloc(32, 7);
const now = 1_000_000;

test("signed cursors bind resource, principal, query, revision, offset, and expiry", () => {
  const principalRef = cursorPrincipalRef("principal-a", key);
  const cursor = encodeCursor({
    resourceType: "workspace",
    principalRef,
    queryHash: cursorQueryHash({ status: "active" }),
    revision: "rev-a",
    offset: 20,
  }, key, { now, ttlMs: 10_000 });
  assert.match(cursor, /^dcur1\./u);
  assert.deepEqual(decodeCursor(cursor, key, now + 1), {
    schemaVersion: 1,
    resourceType: "workspace",
    principalRef,
    queryHash: cursorQueryHash({ status: "active" }),
    revision: "rev-a",
    offset: 20,
    expiresAt: now + 10_000,
  });
});

test("cursor signatures and expiry fail closed", () => {
  const cursor = encodeCursor({
    resourceType: "instruction",
    principalRef: cursorPrincipalRef("principal-a", key),
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
  assert.notEqual(cursorPrincipalRef("principal-a", key), cursorPrincipalRef("principal-b", key));
});

test("diff cursors use the same signed principal and revision envelope", () => {
  const cursor = encodeCursor({
    resourceType: "diff",
    principalRef: cursorPrincipalRef("principal-a", key),
    workspaceGeneration: 9,
    queryHash: cursorQueryHash({ since: "last_shown" }),
    revision: "review-revision",
    offset: 12_000,
  }, key, { now, ttlMs: 10_000 });
  assert.equal(decodeCursor(cursor, key, now + 1).resourceType, "diff");
});
