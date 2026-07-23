import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { databasePath } from "./db/client.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const root = await mkdtemp(join(tmpdir(), "devspace-workspace-store-test-"));

try {
  const legacyStateDir = join(root, "legacy-state");
  await mkdir(legacyStateDir);
  const legacyDatabase = new Database(databasePath(legacyStateDir));
  legacyDatabase.exec(`
    create table devspace_schema_migrations (
      version integer primary key,
      name text not null,
      applied_at text not null
    );
    insert into devspace_schema_migrations (version, name, applied_at) values
      (1, 'workspace-state', '2026-01-01T00:00:00.000Z'),
      (2, 'oauth-state', '2026-01-01T00:00:00.000Z'),
      (3, 'local-agent-sessions', '2026-01-01T00:00:00.000Z'),
      (4, 'workspace-oauth-ownership', '2026-01-01T00:00:00.000Z'),
      (5, 'workspace-checkout-reuse', '2026-01-01T00:00:00.000Z'),
      (6, 'oauth-owner-credential', '2026-01-01T00:00:00.000Z');
    create table workspace_sessions (
      id text primary key,
      owner_client_id text not null default '__legacy_unowned__',
      root text not null,
      canonical_root text,
      status text not null default 'active',
      mode text not null default 'checkout',
      source_root text,
      base_ref text,
      base_sha text,
      managed text not null default 'false',
      created_at text not null,
      last_used_at text not null
    );
    insert into workspace_sessions (
      id, owner_client_id, root, canonical_root, status, mode, managed, created_at, last_used_at
    ) values (
      'legacy-ws', 'legacy-client', '/workspace/legacy', '/workspace/legacy',
      'active', 'checkout', 'false', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
  `);
  legacyDatabase.close();

  const migratedStore = new SqliteWorkspaceStore(legacyStateDir);
  try {
    const migrated = migratedStore.getSession("legacy-ws", "legacy-client");
    assert.equal(migrated?.alias, undefined);
    assert.equal(migrated?.writeAccess, "read_write");
    assert.equal(migrated?.stateGeneration, 1);

    const summaries = migratedStore.listActiveSessionSummaries("legacy-client");
    assert.equal(summaries.length, 1);
    assert.match(summaries[0]!.alias, /^ws-[0-9a-f-]{36}$/);
    assert.equal("root" in summaries[0]!, false);
    assert.equal("id" in summaries[0]!, false);
    assert.equal(
      migratedStore.getActiveSessionByAlias("legacy-client", summaries[0]!.alias)?.id,
      "legacy-ws",
    );
  } finally {
    migratedStore.close();
  }

  const migratedDatabase = new Database(databasePath(legacyStateDir));
  try {
    assert.equal(
      (migratedDatabase.prepare(
        "select count(*) as count from devspace_schema_migrations where version = 9",
      ).get() as { count: number }).count,
      1,
    );
    const workspaceColumns = migratedDatabase.prepare("pragma table_info(workspace_sessions)")
      .all() as Array<{ name: string }>;
    assert.equal(workspaceColumns.some((column) => column.name === "dirty_source"), true);
    assert.equal(
      migratedDatabase.prepare(
        "select dirty_source from workspace_sessions where id = 'legacy-ws'",
      ).pluck().get(),
      "false",
    );
    const operationColumns = migratedDatabase.prepare("pragma table_info(mutation_operations)")
      .all() as Array<{ name: string; pk: number }>;
    assert.deepEqual(operationColumns.map((column) => column.name), [
      "owner_client_id",
      "workspace_id",
      "tool",
      "operation_id",
      "workspace_generation",
      "request_hash",
      "state",
      "result_json",
      "created_at",
      "updated_at",
      "expires_at",
    ]);
    assert.deepEqual(
      operationColumns.filter((column) => column.pk > 0).map((column) => column.name),
      ["owner_client_id", "operation_id"],
    );
    assert.throws(
      () => migratedDatabase.prepare(
        "update workspace_sessions set alias = 'replacement' where id = 'legacy-ws'",
      ).run(),
      /workspace session alias is immutable/,
    );
    assert.throws(
      () => migratedDatabase.prepare(
        "update workspace_sessions set status = 'unknown' where id = 'legacy-ws'",
      ).run(),
      /invalid workspace session status/,
    );
    migratedDatabase.prepare(
      "update workspace_sessions set status = 'revoked' where id = 'legacy-ws'",
    ).run();
    assert.throws(
      () => migratedDatabase.prepare(
        "update workspace_sessions set status = 'active' where id = 'legacy-ws'",
      ).run(),
      /revoked workspace session is terminal/,
    );
  } finally {
    migratedDatabase.close();
  }

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
    assert.match(original.alias ?? "", /^ws-[0-9a-f-]{36}$/);
    assert.equal(original.writeAccess, "read_write");
    assert.equal(original.stateGeneration, 1);
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
    assert.equal(reused.alias, original.alias);
    assert.equal(reused.writeAccess, "read_write");

    const downgraded = second.createOrReuseCheckoutSession({
      id: "ws-a-downgrade",
      ownerClientId: "client-a",
      root: "/workspace/a",
      canonicalRoot: "/workspace/a",
      writeAccess: "read_only",
      replaceWriteAccess: true,
      maxActiveSessionsPerClient: 1,
    });
    assert.equal(downgraded.id, "ws-a");
    assert.equal(downgraded.writeAccess, "read_only");
    assert.equal(downgraded.stateGeneration, 2);

    const preservedDowngrade = first.createOrReuseCheckoutSession({
      id: "ws-a-preserved",
      ownerClientId: "client-a",
      root: "/workspace/a",
      canonicalRoot: "/workspace/a",
      writeAccess: "read_write",
      maxActiveSessionsPerClient: 1,
    });
    assert.equal(preservedDowngrade.writeAccess, "read_only");
    assert.equal(preservedDowngrade.stateGeneration, 2);

    const upgraded = first.createOrReuseCheckoutSession({
      id: "ws-a-upgrade",
      ownerClientId: "client-a",
      root: "/workspace/a",
      canonicalRoot: "/workspace/a",
      writeAccess: "read_write",
      replaceWriteAccess: true,
      maxActiveSessionsPerClient: 1,
    });
    assert.equal(upgraded.writeAccess, "read_write");
    assert.equal(upgraded.stateGeneration, 3);

    const aliasGuarded = first.createOrReuseCheckoutSession({
      id: "ws-alias-guarded",
      ownerClientId: "client-alias-guarded",
      alias: "stable-alias",
      root: "/workspace/alias-guarded",
      canonicalRoot: "/workspace/alias-guarded",
      writeAccess: "read_only",
    });
    assert.equal(first.closeSession(aliasGuarded.id, aliasGuarded.ownerClientId), true);
    const rejectedAliasReuse = second.createOrReuseCheckoutSession({
      id: "ws-alias-guarded-reuse",
      ownerClientId: aliasGuarded.ownerClientId,
      alias: "conflicting-alias",
      root: aliasGuarded.root,
      canonicalRoot: aliasGuarded.root,
      writeAccess: "read_write",
      replaceWriteAccess: true,
    });
    assert.equal(rejectedAliasReuse.status, "closed");
    assert.equal(rejectedAliasReuse.alias, "stable-alias");
    assert.equal(rejectedAliasReuse.writeAccess, "read_only");
    assert.equal(rejectedAliasReuse.stateGeneration, 2);
    assert.equal(first.countActiveSessions(aliasGuarded.ownerClientId), 0);

    first.createSession({
      id: "ws-quota-active",
      ownerClientId: aliasGuarded.ownerClientId,
      alias: "quota-active",
      root: "/workspace/quota-active",
    });
    assert.throws(
      () => second.createOrReuseCheckoutSession({
        id: "ws-alias-guarded-reactivate",
        ownerClientId: aliasGuarded.ownerClientId,
        alias: "stable-alias",
        root: aliasGuarded.root,
        canonicalRoot: aliasGuarded.root,
        maxActiveSessionsPerClient: 1,
      }),
      /limit reached for this OAuth client/,
    );
    assert.equal(first.countActiveSessions(aliasGuarded.ownerClientId), 1);
    assert.throws(
      () => first.reactivateClosedSession(aliasGuarded.id, aliasGuarded.ownerClientId, 1),
      /limit reached for this OAuth client/,
    );
    assert.equal(first.deleteSession("ws-quota-active", aliasGuarded.ownerClientId), true);
    assert.equal(first.deleteSession(aliasGuarded.id, aliasGuarded.ownerClientId), true);

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

    const aliased = first.createSession({
      id: "ws-fields",
      ownerClientId: "client-fields",
      alias: "devspace",
      root: "/workspace/fields",
      writeAccess: "read_only",
      stateGeneration: 7,
    });
    assert.equal(aliased.alias, "devspace");
    assert.equal(aliased.writeAccess, "read_only");
    assert.equal(aliased.stateGeneration, 7);
    const restoredFields = first.getSession("ws-fields", "client-fields");
    assert.equal(restoredFields?.alias, aliased.alias);
    assert.equal(restoredFields?.writeAccess, aliased.writeAccess);
    assert.equal(restoredFields?.stateGeneration, aliased.stateGeneration);
    assert.equal(
      second.getActiveSessionByAlias("client-fields", "devspace")?.root,
      "/workspace/fields",
    );
    assert.equal(second.getActiveSessionByAlias("wrong-client", "devspace"), undefined);

    assert.throws(
      () => second.createSession({
        id: "ws-fields-duplicate",
        ownerClientId: "client-fields",
        alias: "devspace",
        root: "/workspace/fields-duplicate",
      }),
      /UNIQUE constraint failed/,
    );
    const otherOwner = second.createSession({
      id: "ws-fields-other-owner",
      ownerClientId: "client-fields-other",
      alias: "devspace",
      root: "/workspace/fields-other-owner",
    });
    assert.equal(otherOwner.alias, "devspace");

    const managed = first.createOrReuseManagedSession({
      id: "ws-managed",
      ownerClientId: "client-managed",
      root: "/managed/worktree-a",
      sourceRoot: "/workspace/source",
      baseRef: "HEAD",
      baseSha: "abc123",
      dirtySource: true,
    });
    assert.equal(managed.dirtySource, true);
    assert.equal(
      second.findActiveManagedSession("client-managed", "/workspace/source", "abc123")?.id,
      managed.id,
    );
    const reusedManaged = second.createOrReuseManagedSession({
      id: "ws-managed-duplicate",
      ownerClientId: "client-managed",
      root: "/managed/worktree-duplicate",
      sourceRoot: "/workspace/source",
      baseRef: "main",
      baseSha: "abc123",
      dirtySource: false,
    });
    assert.equal(reusedManaged.id, managed.id);
    assert.equal(reusedManaged.dirtySource, true);
    const isolatedManaged = second.createOrReuseManagedSession({
      id: "ws-managed-isolated",
      ownerClientId: "client-managed",
      root: "/managed/worktree-b",
      sourceRoot: "/workspace/source",
      baseRef: "HEAD",
      baseSha: "abc123",
      dirtySource: false,
      forceNew: true,
    });
    assert.notEqual(isolatedManaged.id, managed.id);
    assert.equal(first.countManagedWorktrees(), 2);

    assert.equal(first.allocateSessionAlias("ws-fields", "client-fields", "changed"), "devspace");
    assert.equal(first.updateStateGeneration("ws-fields", "wrong-client", 8), false);
    assert.equal(first.updateStateGeneration("ws-fields", "client-fields", 8), true);
    assert.equal(first.getSession("ws-fields", "client-fields")?.stateGeneration, 8);
    assert.throws(
      () => first.updateStateGeneration("ws-fields", "client-fields", 0),
      /positive integer/,
    );

    const fieldSummaries = second.listActiveSessionSummaries("client-fields");
    assert.deepEqual(fieldSummaries, [{
      alias: "devspace",
      mode: "checkout",
      managed: false,
      writeAccess: "read_only",
      stateGeneration: 8,
      createdAt: aliased.createdAt,
      lastUsedAt: aliased.lastUsedAt,
    }]);

    const generationActive = first.createSession({
      id: "ws-generation-active",
      ownerClientId: "client-generation",
      root: "/workspace/generation-active",
      stateGeneration: 2,
    });
    first.createSession({
      id: "ws-generation-closed",
      ownerClientId: "client-generation",
      root: "/workspace/generation-closed",
      stateGeneration: 9,
    });
    first.createSession({
      id: "ws-generation-revoked",
      ownerClientId: "client-generation",
      root: "/workspace/generation-revoked",
      stateGeneration: 20,
    });
    assert.equal(first.closeSession("ws-generation-closed", "client-generation"), true);
    assert.equal(first.revokeSession("ws-generation-revoked", "client-generation"), 21);

    assert.equal(first.bumpStateGeneration(generationActive.id, "client-generation"), 3);
    assert.equal(first.bumpStateGeneration("ws-generation-closed", "client-generation"), 11);
    assert.equal(first.bumpStateGeneration("ws-generation-revoked", "client-generation"), undefined);
    assert.equal(first.bumpStateGeneration(generationActive.id, "wrong-client"), undefined);
    assert.deepEqual(first.bumpActiveStateGenerations("client-generation"), [{
      id: generationActive.id,
      ownerClientId: "client-generation",
      stateGeneration: 4,
    }]);

    const allGenerationUpdates = first.bumpActiveStateGenerations();
    assert.deepEqual(
      allGenerationUpdates.filter((entry) => entry.ownerClientId === "client-generation"),
      [{
        id: generationActive.id,
        ownerClientId: "client-generation",
        stateGeneration: 5,
      }],
    );
    assert.equal(second.bumpStateGeneration(generationActive.id, "client-generation"), 6);
    assert.equal(first.bumpStateGeneration(generationActive.id, "client-generation"), 7);
    assert.equal(first.reactivateClosedSession("ws-generation-closed", "client-generation"), 12);
    assert.equal(first.reactivateClosedSession("ws-generation-closed", "client-generation"), undefined);
    assert.equal(
      first.getSession("ws-generation-closed", "client-generation")?.stateGeneration,
      12,
    );

    assert.equal(first.closeSession("ws-generation-closed", "client-generation"), true);
    assert.equal(first.revokeSession("ws-generation-closed", "client-generation"), 14);
    assert.equal(first.revokeSession("ws-generation-closed", "client-generation"), undefined);
    assert.equal(
      first.reactivateClosedSession("ws-generation-closed", "client-generation"),
      undefined,
    );
    assert.equal(first.bumpStateGeneration("ws-generation-closed", "client-generation"), undefined);
  } finally {
    first.close();
    second.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
