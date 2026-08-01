import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  CURRENT_DATABASE_SCHEMA_NAME,
  CURRENT_DATABASE_SCHEMA_VERSION,
} from "./db/canonical-schema.js";
import { databasePath } from "./db/client.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const root = await mkdtemp(join(tmpdir(), "devspace-project-runtime-store-test-"));
const stateDir = join(root, "state");
const first = new SqliteWorkspaceStore(stateDir);
const second = new SqliteWorkspaceStore(stateDir);

try {
  const created = first.createOrReuseCheckoutSession({
    id: "runtime-a",
    connectionPrincipalId: "owner",
    root: "/project/a",
    canonicalRoot: "/project/a",
    writeAccess: "read_write",
  });
  assert.equal(created.id, "runtime-a");
  assert.equal(created.alias, "a");
  assert.equal(created.stateGeneration, 1);

  const reused = second.createOrReuseCheckoutSession({
    id: "runtime-a-duplicate",
    connectionPrincipalId: "owner",
    alias: created.alias,
    root: "/project/a-via-symlink",
    canonicalRoot: "/project/a",
  });
  assert.equal(reused.id, created.id);
  assert.equal(reused.alias, created.alias);

  const parallel = second.createOrReuseCheckoutSession({
    id: "runtime-a-parallel",
    connectionPrincipalId: "owner",
    alias: "execution-parallel",
    root: "/project/a",
    canonicalRoot: "/project/a",
  });
  assert.equal(parallel.id, "runtime-a-parallel");
  assert.equal(parallel.canonicalRoot, created.canonicalRoot);

  const downgraded = second.createOrReuseCheckoutSession({
    id: "runtime-a-downgrade",
    connectionPrincipalId: "owner",
    alias: created.alias,
    root: "/project/a",
    canonicalRoot: "/project/a",
    writeAccess: "read_only",
    replaceWriteAccess: true,
  });
  assert.equal(downgraded.writeAccess, "read_only");
  assert.equal(downgraded.stateGeneration, 2);

  const generatedFirst = first.createSession({
    id: "runtime-generated-first",
    connectionPrincipalId: "owner",
    root: "/projects/latent_flow",
  });
  const generatedSecond = first.createSession({
    id: "runtime-generated-second",
    connectionPrincipalId: "owner",
    root: "/archive/latent_flow",
  });
  assert.equal(generatedFirst.alias, "latent-flow");
  assert.equal(generatedSecond.alias, "latent-flow-2");
  assert.equal(first.countActiveSessions(), 4);
  assert.equal(first.countActiveSessions("owner"), 4);
  assert.equal(first.countActiveSessions("not-owner"), 0);
  assert.equal(first.getSession(created.id, "not-owner"), undefined);

  assert.equal(first.updateStateGeneration(created.id, "owner", 8), true);
  assert.equal(second.getSession(created.id, "owner")?.stateGeneration, 8);
  assert.throws(
    () => first.updateStateGeneration(created.id, "owner", 0),
    /positive integer/u,
  );

  assert.equal(first.closeSession(created.id, "owner"), true);
  assert.equal(first.reactivateClosedSession(created.id, "owner"), 10);
  assert.equal(first.reactivateClosedSession(created.id, "owner"), undefined);
  assert.equal(first.revokeSession(created.id, "owner"), 11);
  assert.equal(first.revokeSession(created.id, "owner"), undefined);
  assert.equal(first.reactivateClosedSession(created.id, "owner"), undefined);
  assert.equal(first.bumpStateGeneration(created.id, "owner"), undefined);
  const queuedCleanup = first.listRevocationCleanupJobs();
  assert.equal(queuedCleanup.length, 1);
  assert.deepEqual(
    {
      connectionPrincipalId: queuedCleanup[0]!.connectionPrincipalId,
      workspaceId: queuedCleanup[0]!.workspaceId,
      workspaceRoot: queuedCleanup[0]!.workspaceRoot,
      status: queuedCleanup[0]!.status,
      attempts: queuedCleanup[0]!.attempts,
    },
    {
      connectionPrincipalId: "owner",
      workspaceId: created.id,
      workspaceRoot: "/project/a",
      status: "pending",
      attempts: 0,
    },
  );

  const database = new Database(databasePath(stateDir));
  try {
    assert.deepEqual(
      database.prepare(
        "select version, name from devspace_schema_migrations order by version",
      ).all(),
      [{
        version: CURRENT_DATABASE_SCHEMA_VERSION,
        name: CURRENT_DATABASE_SCHEMA_NAME,
      }],
    );
    const workspaceColumns = database.prepare(
      "select name from pragma_table_info('workspace_sessions') order by cid",
    ).pluck().all() as string[];
    for (const removed of [
      "mode",
      "source_root",
      "base_ref",
      "base_sha",
      "dirty_source",
      "managed",
    ]) {
      assert.equal(workspaceColumns.includes(removed), false);
    }
    assert.deepEqual(
      database.prepare(
        "select principal_id as principalId from connection_principals order by principal_id",
      ).all(),
      [{ principalId: "owner" }],
    );
    assert.throws(
      () => database.prepare(`
        insert into connection_principals (
          principal_id, created_at, last_used_at, revoked_at
        ) values (?, ?, ?, null)
      `).run("second-owner", new Date(0).toISOString(), new Date(0).toISOString()),
      /CHECK constraint failed/u,
    );
    const cleanup = first.listRevocationCleanupJobs()[0]!;
    assert.equal(cleanup.workspaceRoot, "/project/a");
    const claimed = first.claimRevocationCleanupJob(cleanup.id, { now: 1_000 })!;
    assert.equal(first.finalizeRevocationCleanupJob({
      id: cleanup.id,
      claimToken: claimed.claimToken!,
      now: 1_001,
    }), true);
  } finally {
    database.close();
  }
} finally {
  first.close();
  second.close();
  await rm(root, { recursive: true, force: true });
}
