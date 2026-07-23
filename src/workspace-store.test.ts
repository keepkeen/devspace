import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const root = await mkdtemp(join(tmpdir(), "devspace-workspace-store-test-"));

try {
  const stateDir = join(root, "state");
  const first = new SqliteWorkspaceStore(stateDir);
  const second = new SqliteWorkspaceStore(stateDir);
  try {
    const original = first.createOrReuseCheckoutSession({
      id: "ws-a",
      ownerClientId: "client-a",
      root: "/workspace/a",
      canonicalRoot: "/workspace/a",
      maxActiveSessionsPerClient: 1,
    });
    assert.equal(original.id, "ws-a");
    assert.equal(first.countActiveSessions(), 1);
    assert.equal(first.countActiveSessions("client-a"), 1);

    const reused = second.createOrReuseCheckoutSession({
      id: "ws-a-duplicate",
      ownerClientId: "client-a",
      root: "/workspace/a-alias",
      canonicalRoot: "/workspace/a",
      maxActiveSessionsPerClient: 1,
    });
    assert.equal(reused.id, "ws-a");

    assert.throws(
      () => second.createSession({
        id: "ws-a-over-limit",
        ownerClientId: "client-a",
        root: "/workspace/other",
        maxActiveSessionsPerClient: 1,
      }),
      /limit reached for this OAuth client/,
    );

    second.createSession({
      id: "ws-b",
      ownerClientId: "client-b",
      root: "/workspace/b",
      maxActiveSessionsPerClient: 1,
    });
    assert.equal(second.countActiveSessions(), 2);
    assert.equal(second.countActiveSessions("client-b"), 1);
    assert.deepEqual(
      second.listActiveSessions()
        .map(({ id, ownerClientId }) => ({ id, ownerClientId }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      [
        { id: "ws-a", ownerClientId: "client-a" },
        { id: "ws-b", ownerClientId: "client-b" },
      ],
    );
    assert.equal(second.closeSessions([
      { id: "ws-a", ownerClientId: "wrong-client" },
      { id: "ws-b", ownerClientId: "client-b" },
    ]), 1);
    assert.equal(second.getSession("ws-a", "client-a")?.status, "active");
    assert.equal(second.getSession("ws-b", "client-b"), undefined);
    assert.equal(second.closeSessions([]), 0);

    assert.equal(first.closeSession("ws-a", "client-a"), true);
    first.createSession({
      id: "ws-a-replacement",
      ownerClientId: "client-a",
      root: "/workspace/replacement",
      maxActiveSessionsPerClient: 1,
    });
    assert.equal(first.countActiveSessions("client-a"), 1);

    assert.equal(second.closeSession("ws-b", "client-b"), false);
    const future = new Date(Date.now() + 1_000).toISOString();
    assert.equal(first.deleteClosedSessions(future, 1), 1);
    assert.equal(first.deleteClosedSessions(future, 1), 1);
    assert.equal(first.deleteClosedSessions(future, 1), 0);
    assert.throws(() => first.deleteClosedSessions(future, 0), /positive integer/);
  } finally {
    first.close();
    second.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
