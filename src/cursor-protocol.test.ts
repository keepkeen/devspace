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
