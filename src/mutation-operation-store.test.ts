import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { databasePath, openDatabase } from "./db/client.js";
import {
  MutationOperationStore,
  type MutationOperationKey,
} from "./mutation-operation-store.js";

const root = mkdtempSync(join(tmpdir(), "devspace-mutation-operation-test-"));

try {
  testNewSettledReplayAndConflict(join(root, "replay"));
  testRestartRecovery(join(root, "restart"));
  testTtlCleanup(join(root, "ttl"));
  testKeyIsolation(join(root, "isolation"));
  testPendingCancellation(join(root, "cancellation"));
  testStatusLookupAndGenerationSnapshot(join(root, "status"));
  testOversizedResultTombstone(join(root, "oversized"));
  testOwnerMatchedWorkspaceForeignKey(join(root, "owner-fk"));
  testDuplicateMigration(join(root, "duplicate-migration"));
} finally {
  rmSync(root, { recursive: true, force: true });
}

function testPendingCancellation(stateDir: string): void {
  prepareStateDir(stateDir);
  const store = new MutationOperationStore(stateDir);
  const key = operationKey();
  try {
    assert.deepEqual(store.reserve(key, "hash-a"), { status: "new" });
    assert.equal(store.cancelPending(key, "wrong-hash"), false);
    assert.equal(store.cancelPending(key, "hash-a"), true);
    assert.equal(store.getOperationStatus(key.ownerClientId, key.operationId), undefined);
    assert.deepEqual(store.reserve(key, "hash-b"), { status: "new" });
    assert.deepEqual(store.settle(key, "hash-b", { ok: true }), { status: "settled" });
    assert.equal(store.cancelPending(key, "hash-b"), false);
  } finally {
    store.close();
  }
}

function testNewSettledReplayAndConflict(stateDir: string): void {
  prepareStateDir(stateDir);
  const store = new MutationOperationStore(stateDir);
  const key = operationKey();
  try {
    assert.deepEqual(store.reserve(key, "hash-a"), { status: "new" });
    assert.deepEqual(store.reserve(key, "hash-a"), { status: "outcome_unknown" });
    assert.deepEqual(store.reserve(key, "hash-b"), { status: "conflict" });
    assert.deepEqual(store.markOutcomeUnknown(key, "hash-b"), { status: "conflict" });
    assert.deepEqual(store.settle(key, "hash-b", { ignored: true }), { status: "conflict" });
    assert.deepEqual(store.settle(key, "hash-a", { ok: true, value: 42 }), { status: "settled" });
    assert.deepEqual(store.reserve(key, "hash-a"), {
      status: "replay",
      result: { ok: true, value: 42 },
    });
    assert.deepEqual(store.reserve(key, "hash-b"), { status: "conflict" });

    const failedKey = operationKey({ operationId: "failed-operation" });
    assert.deepEqual(store.reserve(failedKey, "failed-hash"), { status: "new" });
    assert.deepEqual(store.markOutcomeUnknown(failedKey, "failed-hash"), {
      status: "outcome_unknown",
    });
    assert.deepEqual(store.reserve(failedKey, "failed-hash"), { status: "outcome_unknown" });
    assert.deepEqual(store.markOutcomeUnknown(failedKey, "failed-hash"), { status: "not_pending" });
  } finally {
    store.close();
  }
}

function testRestartRecovery(stateDir: string): void {
  prepareStateDir(stateDir);
  const key = operationKey();
  const first = new MutationOperationStore(stateDir);
  assert.deepEqual(first.reserve(key, "hash"), { status: "new" });
  first.close();

  const restored = new MutationOperationStore(stateDir);
  try {
    assert.deepEqual(restored.reserve(key, "hash"), { status: "outcome_unknown" });
    assert.deepEqual(restored.reserve(key, "different-hash"), { status: "conflict" });
    assert.deepEqual(restored.settle(key, "hash", { tooLate: true }), { status: "not_pending" });
  } finally {
    restored.close();
  }
}

function testTtlCleanup(stateDir: string): void {
  prepareStateDir(stateDir);
  let now = 10;
  const store = new MutationOperationStore(stateDir, { ttlMs: 100, now: () => now });
  const first = operationKey({ operationId: "first" });
  const second = operationKey({ operationId: "second" });
  try {
    assert.deepEqual(store.reserve(first, "first-hash"), { status: "new" });
    assert.deepEqual(store.settle(first, "first-hash", "first-result"), { status: "settled" });
    now = 20;
    assert.deepEqual(store.reserve(second, "second-hash"), { status: "new" });
    assert.deepEqual(store.settle(second, "second-hash", "second-result"), { status: "settled" });

    now = 111;
    assert.equal(store.cleanupExpired(1), 1);
    assert.deepEqual(store.reserve(first, "replacement-hash"), { status: "new" });
    assert.deepEqual(store.reserve(second, "second-hash"), {
      status: "replay",
      result: "second-result",
    });

    now = 121;
    assert.equal(store.cleanupExpired(1), 1);
    assert.equal(store.cleanupExpired(1), 0);
  } finally {
    store.close();
  }
}

function testKeyIsolation(stateDir: string): void {
  prepareStateDir(stateDir);
  const store = new MutationOperationStore(stateDir);
  const keys = [
    operationKey(),
    operationKey({ ownerClientId: "owner-b", workspaceId: "workspace-owner-b" }),
    operationKey({ workspaceId: "workspace-b", operationId: "operation-b" }),
    operationKey({ tool: "delete_file", operationId: "operation-c" }),
  ];
  try {
    for (const [index, key] of keys.entries()) {
      assert.deepEqual(store.reserve(key, `hash-${index}`), { status: "new" });
      assert.deepEqual(store.settle(key, `hash-${index}`, { index }), { status: "settled" });
    }
    for (const [index, key] of keys.entries()) {
      assert.deepEqual(store.reserve(key, `hash-${index}`), {
        status: "replay",
        result: { index },
      });
    }
    assert.deepEqual(
      store.reserve(operationKey({ workspaceId: "workspace-b" }), "different-workspace"),
      { status: "conflict" },
    );
    assert.deepEqual(
      store.reserve(operationKey({ tool: "delete_file" }), "different-tool"),
      { status: "conflict" },
    );
  } finally {
    store.close();
  }
}

function testStatusLookupAndGenerationSnapshot(stateDir: string): void {
  prepareStateDir(stateDir);
  const database = openDatabase(stateDir);
  try {
    database.sqlite.prepare(
      "update workspace_sessions set state_generation = 7 where id = 'workspace-a'",
    ).run();
  } finally {
    database.close();
  }

  let now = 1_000;
  const store = new MutationOperationStore(stateDir, { ttlMs: 5_000, now: () => now });
  const key = operationKey();
  try {
    assert.equal(store.getOperationStatus("owner-a", key.operationId), undefined);
    const staleKey = operationKey({ operationId: "stale-operation" });
    assert.deepEqual(store.reserve(staleKey, "stale-hash", 6), {
      status: "stale_generation",
      currentGeneration: 7,
    });
    assert.equal(store.getOperationStatus("owner-a", staleKey.operationId), undefined);
    assert.deepEqual(store.reserve(key, "hash", 7), { status: "new" });
    assert.deepEqual(store.getOperationStatus("owner-a", key.operationId), {
      operationId: key.operationId,
      state: "pending",
      tool: key.tool,
      workspaceId: key.workspaceId,
      workspaceGeneration: 7,
      createdAt: "1970-01-01T00:00:01.000Z",
      updatedAt: "1970-01-01T00:00:01.000Z",
      expiresAt: "1970-01-01T00:00:06.000Z",
      resultAvailable: false,
    });

    const workspaceDatabase = openDatabase(stateDir);
    try {
      workspaceDatabase.sqlite.prepare(
        "update workspace_sessions set state_generation = 8 where id = 'workspace-a'",
      ).run();
    } finally {
      workspaceDatabase.close();
    }
    now = 2_000;
    assert.deepEqual(store.settle(key, "hash", { secret: "result-body" }), { status: "settled" });
    assert.deepEqual(store.reserve(key, "hash", 7), {
      status: "stale_generation",
      currentGeneration: 8,
    });
    const status = store.getOperationStatus("owner-a", key.operationId);
    assert.deepEqual(status, {
      operationId: key.operationId,
      state: "settled",
      tool: key.tool,
      workspaceId: key.workspaceId,
      workspaceGeneration: 7,
      createdAt: "1970-01-01T00:00:01.000Z",
      updatedAt: "1970-01-01T00:00:02.000Z",
      expiresAt: "1970-01-01T00:00:07.000Z",
      resultAvailable: true,
    });
    assert.equal(status && "result" in status, false);
    assert.equal(store.getOperationStatus("owner-b", key.operationId), undefined);

    now = 8_000;
    assert.equal(store.getOperationStatus("owner-a", key.operationId), undefined);
  } finally {
    store.close();
  }
}

function testOversizedResultTombstone(stateDir: string): void {
  prepareStateDir(stateDir);
  const store = new MutationOperationStore(stateDir, { maxResultBytes: 16 });
  const key = operationKey();
  try {
    assert.deepEqual(store.reserve(key, "hash"), { status: "new" });
    assert.deepEqual(store.settle(key, "hash", { output: "x".repeat(100) }), {
      status: "result_unavailable",
    });
    assert.deepEqual(store.reserve(key, "hash"), { status: "result_unavailable" });
    assert.deepEqual(store.reserve(key, "different-hash"), { status: "conflict" });
    assert.equal(store.getOperationStatus(key.ownerClientId, key.operationId)?.resultAvailable, false);

    const database = openDatabase(stateDir);
    try {
      const row = database.sqlite
        .prepare(
          `select request_hash, state, result_json from mutation_operations
           where owner_client_id = ? and workspace_id = ? and tool = ? and operation_id = ?`,
        )
        .get(key.ownerClientId, key.workspaceId, key.tool, key.operationId);
      assert.deepEqual(row, { request_hash: "hash", state: "settled", result_json: null });
    } finally {
      database.close();
    }
  } finally {
    store.close();
  }
}

function testOwnerMatchedWorkspaceForeignKey(stateDir: string): void {
  prepareStateDir(stateDir);
  const store = new MutationOperationStore(stateDir);
  const mismatched = operationKey({ ownerClientId: "owner-b", workspaceId: "workspace-a" });
  try {
    assert.throws(
      () => store.reserve(mismatched, "hash"),
      /workspace does not belong to the OAuth client/,
    );
    assert.equal(store.getOperationStatus("owner-b", mismatched.operationId), undefined);
  } finally {
    store.close();
  }
}

function testDuplicateMigration(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  const legacy = new Database(databasePath(stateDir));
  legacy.exec(`
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
      (6, 'oauth-owner-credential', '2026-01-01T00:00:00.000Z'),
      (7, 'workspace-resume-idempotency', '2026-01-01T00:00:00.000Z');

    create table workspace_sessions (
      id text primary key,
      owner_client_id text not null,
      alias text,
      root text not null,
      canonical_root text,
      status text not null default 'active',
      mode text not null default 'checkout',
      source_root text,
      base_ref text,
      base_sha text,
      managed text not null default 'false',
      write_access text not null default 'read_write',
      state_generation integer not null default 1,
      created_at text not null,
      last_used_at text not null
    );
    insert into workspace_sessions (
      id, owner_client_id, root, state_generation, created_at, last_used_at
    ) values
      ('workspace-old', 'owner-a', '/old', 7, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('workspace-new', 'owner-a', '/new', 11, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('workspace-owner-b', 'owner-b', '/owner-b', 3, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    create table mutation_operations (
      owner_client_id text not null,
      workspace_id text not null,
      tool text not null,
      operation_id text not null,
      request_hash text not null,
      state text not null,
      result_json text,
      created_at text not null,
      updated_at text not null,
      expires_at text not null,
      primary key (owner_client_id, workspace_id, tool, operation_id),
      foreign key (workspace_id) references workspace_sessions(id) on delete cascade
    );
    insert into mutation_operations values
      ('owner-a', 'workspace-old', 'write_file', 'shared', 'useful-hash', 'settled', '{"kept":true}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z', '2099-01-01T00:00:00.000Z'),
      ('owner-a', 'workspace-new', 'delete_file', 'shared', 'newer-hash', 'outcome_unknown', null, '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:03.000Z', '2099-01-01T00:00:00.000Z'),
      ('owner-b', 'workspace-owner-b', 'write_file', 'shared', 'owner-b-hash', 'settled', '{"owner":"b"}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z', '2099-01-01T00:00:00.000Z'),
      ('owner-a', 'workspace-old', 'write_file', 'latest', 'old-hash', 'settled', '{"version":1}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z', '2099-01-01T00:00:00.000Z'),
      ('owner-a', 'workspace-new', 'write_file', 'latest', 'new-hash', 'settled', '{"version":2}', '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:04.000Z', '2099-01-01T00:00:00.000Z'),
      ('owner-c', 'workspace-old', 'write_file', 'owner-mismatch', 'bad-hash', 'pending', null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z', '2099-01-01T00:00:00.000Z');
  `);
  legacy.close();

  const store = new MutationOperationStore(stateDir);
  try {
    assert.deepEqual(store.getOperationStatus("owner-a", "shared"), {
      operationId: "shared",
      state: "settled",
      tool: "write_file",
      workspaceId: "workspace-old",
      workspaceGeneration: 7,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      resultAvailable: true,
    });
    assert.deepEqual(
      store.reserve({
        ownerClientId: "owner-a",
        workspaceId: "workspace-old",
        tool: "write_file",
        operationId: "shared",
      }, "useful-hash"),
      { status: "replay", result: { kept: true } },
    );
    assert.equal(store.getOperationStatus("owner-a", "latest")?.workspaceGeneration, 11);
    assert.equal(store.getOperationStatus("owner-b", "shared")?.workspaceGeneration, 3);
    assert.equal(store.getOperationStatus("owner-c", "owner-mismatch"), undefined);
  } finally {
    store.close();
  }

  const migrated = openDatabase(stateDir);
  try {
    assert.equal(
      (migrated.sqlite.prepare("select count(*) as count from mutation_operations").get() as {
        count: number;
      }).count,
      3,
    );
    const primaryKey = migrated.sqlite.prepare("pragma table_info(mutation_operations)").all() as
      Array<{ name: string; pk: number }>;
    assert.deepEqual(
      primaryKey.filter((column) => column.pk > 0).map((column) => column.name),
      ["owner_client_id", "operation_id"],
    );
    migrated.sqlite.prepare("delete from workspace_sessions where id = 'workspace-old'").run();
    assert.equal(
      (migrated.sqlite.prepare(
        "select count(*) as count from mutation_operations where owner_client_id = 'owner-a' and operation_id = 'shared'",
      ).get() as { count: number }).count,
      0,
    );
  } finally {
    migrated.close();
  }
}

function operationKey(overrides: Partial<MutationOperationKey> = {}): MutationOperationKey {
  return {
    ownerClientId: "owner-a",
    workspaceId: "workspace-a",
    tool: "write_file",
    operationId: "operation-a",
    ...overrides,
  };
}

function prepareStateDir(stateDir: string): void {
  const database = openDatabase(stateDir);
  try {
    const insert = database.sqlite.prepare(
      `insert into workspace_sessions (
        id, owner_client_id, root, status, mode, managed, created_at, last_used_at
      ) values (?, ?, ?, 'active', 'existing', 'false', ?, ?)`,
    );
    const timestamp = new Date(0).toISOString();
    insert.run("workspace-a", "owner-a", join(stateDir, "workspace-a"), timestamp, timestamp);
    insert.run("workspace-b", "owner-a", join(stateDir, "workspace-b"), timestamp, timestamp);
    insert.run(
      "workspace-owner-b",
      "owner-b",
      join(stateDir, "workspace-owner-b"),
      timestamp,
      timestamp,
    );
  } finally {
    database.close();
  }
}
