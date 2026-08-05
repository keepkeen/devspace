import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { databasePath, openDatabase } from "./db/client.js";
import {
  ApplyPatchHistoryLimitError,
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
  testOutcomeResolution(join(root, "resolution"));
  testOversizedResultTombstone(join(root, "oversized"));
  testOwnerMatchedWorkspaceForeignKey(join(root, "owner-fk"));
  testApplyPatchJournalPersistenceAndOrdering(join(root, "patch-journal"));
  testApplyPatchJournalStateAndToolFiltering(join(root, "patch-journal-filtering"));
  testApplyPatchJournalAtomicSettlement(join(root, "patch-journal-atomic"));
  testApplyPatchJournalCapacity(join(root, "patch-journal-capacity"));
  testDuplicateMigration(join(root, "duplicate-migration"));
  testOperationIdValidation(join(root, "operation-id-validation"));
} finally {
  rmSync(root, { recursive: true, force: true });
}

function testOperationIdValidation(stateDir: string): void {
  prepareStateDir(stateDir);
  const store = new MutationOperationStore(stateDir);
  try {
    assert.deepEqual(
      store.reserve(operationKey({ operationId: `${"界".repeat(42)}ab` }), "hash"),
      { status: "new" },
    );
    for (const operationId of [
      "a".repeat(129),
      `${"界".repeat(42)}abc`,
      "nul\0id",
      "\uD800",
      "\uDC00",
    ]) {
      assert.throws(
        () => store.reserve(operationKey({ operationId }), "hash"),
        /operationId must be/u,
      );
    }
    assert.deepEqual(
      store.reserve(operationKey({ operationId: "\uFFFD" }), "replacement-hash"),
      { status: "new" },
      "malformed Unicode must not reserve or alias the valid replacement character",
    );
  } finally {
    store.close();
  }
}

function testOutcomeResolution(stateDir: string): void {
  prepareStateDir(stateDir);
  let now = 1_000;
  const store = new MutationOperationStore(stateDir, { now: () => now });
  const key = operationKey({ operationId: "resolved-operation" });
  try {
    assert.deepEqual(store.reserve(key, "hash"), { status: "new" });
    assert.deepEqual(store.markOutcomeUnknown(key, "hash"), { status: "outcome_unknown" });
    now = 2_000;
    const resolved = store.resolveOutcome({
      connectionPrincipalId: key.connectionPrincipalId,
      workspaceId: key.workspaceId,
      operationId: key.operationId,
      resolution: "verified_not_started",
      method: "manual_verification",
      evidenceType: "status_snapshot",
      evidence: { process: "absent" },
      operatorRef: "conn_operator",
    });
    assert.equal(resolved?.state, "verified_not_started");
    assert.deepEqual(resolved?.resolution, {
      state: "verified_not_started",
      method: "manual_verification",
      evidenceType: "status_snapshot",
      evidence: { process: "absent" },
      resolvedAt: "1970-01-01T00:00:02.000Z",
      operatorRef: "conn_operator",
    });
    assert.deepEqual(store.reserve(key, "hash"), { status: "verified_not_started" });
    assert.equal(store.resolveOutcome({
      connectionPrincipalId: key.connectionPrincipalId,
      workspaceId: key.workspaceId,
      operationId: key.operationId,
      resolution: "verified_committed",
      method: "manual_verification",
      evidenceType: "none",
      operatorRef: "conn_operator",
    }), undefined);
  } finally {
    store.close();
  }
}

function testPendingCancellation(stateDir: string): void {
  prepareStateDir(stateDir);
  const store = new MutationOperationStore(stateDir);
  const key = operationKey();
  try {
    assert.deepEqual(store.reserve(key, "hash-a"), { status: "new" });
    assert.equal(store.cancelPending(key, "wrong-hash"), false);
    assert.equal(store.cancelPending(key, "hash-a"), true);
    assert.equal(
      store.getOperationStatus(key.connectionPrincipalId, key.workspaceId, key.operationId),
      undefined,
    );
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
    assert.deepEqual(store.reserve(first, "first-hash"), { status: "result_unavailable" });
    assert.deepEqual(store.reserve(first, "replacement-hash"), { status: "conflict" });
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
    const sameOperationInAnotherWorkspace = operationKey({ workspaceId: "workspace-b" });
    assert.deepEqual(
      store.reserve(sameOperationInAnotherWorkspace, "different-workspace"),
      { status: "new" },
    );
    assert.deepEqual(
      store.settle(
        sameOperationInAnotherWorkspace,
        "different-workspace",
        { workspace: "b" },
      ),
      { status: "settled" },
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
    assert.equal(store.getOperationStatus("owner", key.workspaceId, key.operationId), undefined);
    const staleKey = operationKey({ operationId: "stale-operation" });
    assert.deepEqual(store.reserve(staleKey, "stale-hash", 6), {
      status: "stale_generation",
      currentGeneration: 7,
    });
    assert.equal(
      store.getOperationStatus("owner", staleKey.workspaceId, staleKey.operationId),
      undefined,
    );
    assert.deepEqual(store.reserve(key, "hash", 7), { status: "new" });
    assert.deepEqual(store.getOperationStatus("owner", key.workspaceId, key.operationId), {
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
      status: "replay",
      result: { secret: "result-body" },
    });
    const status = store.getOperationStatus("owner", key.workspaceId, key.operationId);
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
    assert.equal(
      store.getOperationStatus("not-owner", key.workspaceId, key.operationId),
      undefined,
    );

    now = 8_000;
    assert.deepEqual(store.getOperationStatus("owner", key.workspaceId, key.operationId), {
      operationId: key.operationId,
      state: "settled",
      tool: key.tool,
      workspaceId: key.workspaceId,
      workspaceGeneration: 7,
      createdAt: "1970-01-01T00:00:01.000Z",
      updatedAt: "1970-01-01T00:00:02.000Z",
      expiresAt: "1970-01-01T00:00:07.000Z",
      resultAvailable: false,
    });
    assert.deepEqual(store.reserve(key, "hash", 8), { status: "conflict" });
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
    assert.equal(
      store.getOperationStatus(
        key.connectionPrincipalId,
        key.workspaceId,
        key.operationId,
      )?.resultAvailable,
      false,
    );

    const database = openDatabase(stateDir);
    try {
      const row = database.sqlite
        .prepare(
          `select request_hash, state, result_json from mutation_operations
           where connection_principal_id = ? and workspace_id = ? and tool = ? and operation_id = ?`,
        )
        .get(key.connectionPrincipalId, key.workspaceId, key.tool, key.operationId);
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
  const mismatched = operationKey({ connectionPrincipalId: "not-owner", workspaceId: "workspace-a" });
  try {
    assert.throws(
      () => store.reserve(mismatched, "hash"),
      /Project runtime does not belong to the active authorization/,
    );
    assert.equal(
      store.getOperationStatus(
        "not-owner",
        mismatched.workspaceId,
        mismatched.operationId,
      ),
      undefined,
    );
  } finally {
    store.close();
  }
}

function testApplyPatchJournalPersistenceAndOrdering(stateDir: string): void {
  prepareStateDir(stateDir);
  ensureApplyPatchChangesTable(stateDir);
  let now = 1_000;
  const store = new MutationOperationStore(stateDir, {
    maxResultBytes: 1,
    ttlMs: 100,
    now: () => now,
  });
  const laterIdentity = operationKey({
    tool: "apply_patch",
    operationId: "operation-z",
  });
  const earlierIdentity = operationKey({
    tool: "apply_patch",
    operationId: "operation-a",
  });
  const laterChange = applyPatchChange("later.txt", "later");
  const earlierChange = applyPatchChange("earlier.txt", "earlier");
  try {
    assert.deepEqual(store.reserve(laterIdentity, "later-hash", 1), { status: "new" });
    assert.deepEqual(
      store.settle(laterIdentity, "later-hash", { output: "oversized" }, {
        applyPatchChange: laterChange,
      }),
      { status: "result_unavailable" },
    );

    const database = openDatabase(stateDir);
    try {
      database.sqlite.prepare(
        "update workspace_sessions set state_generation = 2 where id = 'workspace-a'",
      ).run();
    } finally {
      database.close();
    }

    assert.deepEqual(store.reserve(earlierIdentity, "earlier-hash", 2), { status: "new" });
    assert.deepEqual(
      store.settle(earlierIdentity, "earlier-hash", { output: "also oversized" }, {
        applyPatchChange: earlierChange,
      }),
      { status: "result_unavailable" },
    );
    assert.deepEqual(store.listApplyPatchChanges({
      connectionPrincipalId: "owner",
      workspaceId: "workspace-a",
    }), [
      {
        operationId: "operation-z",
        workspaceGeneration: 1,
        appliedAt: "1970-01-01T00:00:01.000Z",
        ...journalChange(laterChange),
      },
      {
        operationId: "operation-a",
        workspaceGeneration: 2,
        appliedAt: "1970-01-01T00:00:01.000Z",
        ...journalChange(earlierChange),
      },
    ]);

    assert.deepEqual(
      store.settle(laterIdentity, "later-hash", { duplicate: true }, {
        applyPatchChange: laterChange,
      }),
      { status: "not_pending" },
    );
    now = 1_101;
    assert.equal(store.cleanupExpired(10), 0);
  } finally {
    store.close();
  }

  const restored = new MutationOperationStore(stateDir);
  try {
    assert.deepEqual(restored.listApplyPatchChanges({
      connectionPrincipalId: "owner",
      workspaceId: "workspace-a",
    }).map(({ operationId, workspaceGeneration }) => ({ operationId, workspaceGeneration })), [
      { operationId: "operation-z", workspaceGeneration: 1 },
      { operationId: "operation-a", workspaceGeneration: 2 },
    ]);
    assert.deepEqual(restored.listApplyPatchChanges({
      connectionPrincipalId: "owner",
      workspaceId: "workspace-b",
    }), []);
  } finally {
    restored.close();
  }
}

function testApplyPatchJournalStateAndToolFiltering(stateDir: string): void {
  prepareStateDir(stateDir);
  ensureApplyPatchChangesTable(stateDir);
  const store = new MutationOperationStore(stateDir);
  const change = applyPatchChange("file.txt", "content");
  try {
    const commandKey = operationKey({ tool: "write_file", operationId: "command" });
    assert.deepEqual(store.reserve(commandKey, "command-hash"), { status: "new" });
    assert.throws(
      () => store.settle(commandKey, "command-hash", { ok: true }, {
        applyPatchChange: change,
      }),
      /only be recorded for the apply_patch tool/,
    );
    assert.equal(
      store.getOperationStatus("owner", "workspace-a", "command")?.state,
      "pending",
    );
    assert.deepEqual(store.settle(commandKey, "command-hash", { ok: true }), {
      status: "settled",
    });

    const unknownKey = operationKey({ tool: "apply_patch", operationId: "unknown" });
    assert.deepEqual(store.reserve(unknownKey, "unknown-hash"), { status: "new" });
    assert.deepEqual(store.markOutcomeUnknown(unknownKey, "unknown-hash"), {
      status: "outcome_unknown",
    });
    assert.equal(store.resolveOutcome({
      connectionPrincipalId: "owner",
      workspaceId: "workspace-a",
      operationId: "unknown",
      resolution: "verified_committed",
      method: "manual_verification",
      evidenceType: "status_snapshot",
      operatorRef: "operator",
    })?.state, "verified_committed");
    assert.deepEqual(
      store.settle(unknownKey, "unknown-hash", { late: true }, {
        applyPatchChange: change,
      }),
      { status: "not_pending" },
    );

    assert.deepEqual(store.listApplyPatchChanges({
      connectionPrincipalId: "owner",
      workspaceId: "workspace-a",
    }), []);
  } finally {
    store.close();
  }
}

function testApplyPatchJournalAtomicSettlement(stateDir: string): void {
  prepareStateDir(stateDir);
  ensureApplyPatchChangesTable(stateDir);
  const database = openDatabase(stateDir);
  try {
    database.sqlite.exec(`
      create trigger reject_apply_patch_change
      before insert on apply_patch_changes
      begin
        select raise(abort, 'journal rejected');
      end;
    `);
  } finally {
    database.close();
  }

  const store = new MutationOperationStore(stateDir);
  const key = operationKey({ tool: "apply_patch", operationId: "atomic" });
  try {
    assert.deepEqual(store.reserve(key, "hash"), { status: "new" });
    assert.throws(
      () => store.settle(key, "hash", { ok: true }, {
        applyPatchChange: applyPatchChange("atomic.txt", "atomic"),
      }),
      /journal rejected/,
    );
    assert.equal(
      store.getOperationStatus("owner", "workspace-a", "atomic")?.state,
      "pending",
    );
    assert.deepEqual(store.listApplyPatchChanges({
      connectionPrincipalId: "owner",
      workspaceId: "workspace-a",
    }), []);
  } finally {
    store.close();
  }
}

function testApplyPatchJournalCapacity(stateDir: string): void {
  prepareStateDir(stateDir);
  ensureApplyPatchChangesTable(stateDir);
  const store = new MutationOperationStore(stateDir, {
    maxApplyPatchHistoryBytes: 16 * 1024,
    maxApplyPatchHistoryOperations: 1,
  });
  const first = operationKey({ tool: "apply_patch", operationId: "first" });
  const second = operationKey({ tool: "apply_patch", operationId: "second" });
  try {
    assert.equal(store.checkApplyPatchHistoryCapacity({
      connectionPrincipalId: "owner",
      workspaceId: "workspace-a",
      additionalBytes: 1,
    }).allowed, true);
    assert.deepEqual(store.reserve(first, "first-hash"), { status: "new" });
    assert.deepEqual(store.settle(first, "first-hash", { ok: true }, {
      applyPatchChange: applyPatchChange("first.txt", "first"),
    }), { status: "settled" });

    const capacity = store.checkApplyPatchHistoryCapacity({
      connectionPrincipalId: "owner",
      workspaceId: "workspace-a",
      additionalBytes: 1,
    });
    assert.equal(capacity.allowed, false);
    assert.equal(capacity.limitingFactor, "operations");

    assert.deepEqual(store.reserve(second, "second-hash"), { status: "new" });
    assert.throws(
      () => store.settle(second, "second-hash", { ok: true }, {
        applyPatchChange: applyPatchChange("second.txt", "second"),
      }),
      (error: unknown) =>
        error instanceof ApplyPatchHistoryLimitError &&
        error.limitingFactor === "operations",
    );
    assert.equal(
      store.getOperationStatus("owner", "workspace-a", "second")?.state,
      "pending",
      "journal capacity rejection rolls back mutation settlement atomically",
    );
  } finally {
    store.close();
  }

  const byteLimitedStateDir = `${stateDir}-bytes`;
  prepareStateDir(byteLimitedStateDir);
  ensureApplyPatchChangesTable(byteLimitedStateDir);
  const byteLimited = new MutationOperationStore(byteLimitedStateDir, {
    maxApplyPatchHistoryBytes: 1,
  });
  try {
    const capacity = byteLimited.checkApplyPatchHistoryCapacity({
      connectionPrincipalId: "owner",
      workspaceId: "workspace-a",
      additionalBytes: 2,
    });
    assert.equal(capacity.allowed, false);
    assert.equal(capacity.limitingFactor, "bytes");
  } finally {
    byteLimited.close();
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
      (3, 'legacy-v3', '2026-01-01T00:00:00.000Z'),
      (4, 'workspace-oauth-ownership', '2026-01-01T00:00:00.000Z'),
      (5, 'workspace-checkout-reuse', '2026-01-01T00:00:00.000Z'),
      (6, 'oauth-owner-credential', '2026-01-01T00:00:00.000Z'),
      (7, 'workspace-resume-idempotency', '2026-01-01T00:00:00.000Z');

    create table oauth_clients (
      client_id text primary key,
      client_json text not null,
      issued_at integer not null
    );

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
      ('workspace-new', 'owner-a', '/new', 11, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

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
      ('owner-a', 'workspace-old', 'write_file', 'latest', 'old-hash', 'settled', '{"version":1}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z', '2099-01-01T00:00:00.000Z'),
      ('owner-a', 'workspace-new', 'write_file', 'latest', 'new-hash', 'settled', '{"version":2}', '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:04.000Z', '2099-01-01T00:00:00.000Z');
  `);
  legacy.close();

  const store = new MutationOperationStore(stateDir);
  try {
    assert.deepEqual(store.getOperationStatus("owner", "workspace-old", "shared"), {
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
        connectionPrincipalId: "owner",
        workspaceId: "workspace-old",
        tool: "write_file",
        operationId: "shared",
      }, "useful-hash"),
      { status: "replay", result: { kept: true } },
    );
    assert.equal(
      store.getOperationStatus("owner", "workspace-new", "latest")?.workspaceGeneration,
      11,
    );
  } finally {
    store.close();
  }

  const migrated = openDatabase(stateDir);
  try {
    assert.equal(
      (migrated.sqlite.prepare("select count(*) as count from mutation_operations").get() as {
        count: number;
      }).count,
      4,
    );
    const primaryKey = migrated.sqlite.prepare("pragma table_info(mutation_operations)").all() as
      Array<{ name: string; pk: number }>;
    assert.deepEqual(
      primaryKey.filter((column) => column.pk > 0).map((column) => column.name),
      ["connection_principal_id", "workspace_id", "operation_id"],
    );
    migrated.sqlite.prepare("delete from workspace_sessions where id = 'workspace-old'").run();
    assert.equal(
      (migrated.sqlite.prepare(
        "select count(*) as count from mutation_operations where connection_principal_id = 'owner' and workspace_id = 'workspace-old' and operation_id = 'shared'",
      ).get() as { count: number }).count,
      0,
    );
  } finally {
    migrated.close();
  }
}

function operationKey(overrides: Partial<MutationOperationKey> = {}): MutationOperationKey {
  return {
    connectionPrincipalId: "owner",
    workspaceId: "workspace-a",
    tool: "write_file",
    operationId: "operation-a",
    ...overrides,
  };
}

function applyPatchChange(path: string, content: string) {
  return {
    patch: `*** Begin Patch\n*** Add File: ${path}\n+${content}\n*** End Patch\n`,
    files: [{
      path,
      operation: "add" as const,
      observedBefore: null,
      observedAfter: null,
    }],
    summary: {
      files: 1,
      additions: 1,
      removals: 0,
    },
  };
}

function journalChange(change: ReturnType<typeof applyPatchChange>) {
  return {
    patch: change.patch,
    files: change.files.map(({ path, operation }) => ({ path, operation })),
    summary: change.summary,
  };
}

function ensureApplyPatchChangesTable(stateDir: string): void {
  const database = openDatabase(stateDir);
  try {
    database.sqlite.exec(`
      create table if not exists apply_patch_changes (
        sequence integer primary key autoincrement,
        connection_principal_id text not null,
        workspace_id text not null,
        operation_id text not null,
        workspace_generation integer not null check (workspace_generation >= 1),
        tool text not null default 'apply_patch' check (tool = 'apply_patch'),
        applied_at text not null,
        patch text not null,
        files_json text not null,
        summary_json text not null,
        unique (connection_principal_id, workspace_id, operation_id),
        foreign key (connection_principal_id, workspace_id, operation_id)
          references mutation_operations(
            connection_principal_id, workspace_id, operation_id
          )
          on delete cascade
      );
    `);
  } finally {
    database.close();
  }
}

function prepareStateDir(stateDir: string): void {
  const database = openDatabase(stateDir);
  try {
    const timestamp = new Date(0).toISOString();
    const insert = database.sqlite.prepare(
      `insert into workspace_sessions (
        id, connection_principal_id, alias, root, canonical_root, status,
        write_access, state_generation, created_at, last_used_at
      ) values (?, ?, ?, ?, ?, 'active', 'read_write', 1, ?, ?)`,
    );
    const workspaceA = join(stateDir, "workspace-a");
    const workspaceB = join(stateDir, "workspace-b");
    insert.run("workspace-a", "owner", "workspace-a", workspaceA, workspaceA, timestamp, timestamp);
    insert.run("workspace-b", "owner", "workspace-b", workspaceB, workspaceB, timestamp, timestamp);
  } finally {
    database.close();
  }
}
