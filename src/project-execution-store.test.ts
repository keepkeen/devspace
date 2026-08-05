import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db/client.js";
import {
  ProjectExecutionStore,
  type ProjectExecutionAuthorization,
  type ReserveProjectExecutionInput,
} from "./project-execution-store.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const root = mkdtempSync(join(tmpdir(), "devspace-project-execution-store-"));

try {
  testReservationActivationAndExactAuthorization(join(root, "lifecycle"));
  testAuthorizationLifecycle(join(root, "authorization"));
  testStartupAuthorizationReconciliation(join(root, "startup-reconciliation"));
  testQuarantineAndClose(join(root, "terminal"));
  testOperationIdUnicodeValidation(join(root, "operation-id-unicode"));
} finally {
  rmSync(root, { recursive: true, force: true });
}

function testOperationIdUnicodeValidation(stateDir: string): void {
  seedAuthorization(stateDir);
  const store = new ProjectExecutionStore(stateDir, {
    createExecutionId: () => "execution-unicode",
  });
  try {
    for (const createOperationId of ["\uD800", "\uDC00"]) {
      assert.throws(
        () => store.reserve(reservation({ createOperationId })),
        /createOperationId must be/u,
      );
    }
    const replacement = store.reserve(reservation({ createOperationId: "\uFFFD" }));
    assert.equal(replacement.status, "new");
    assert.equal(store.findCreation(authorization(), "\uFFFD")?.createOperationId, "\uFFFD");
    for (const createOperationId of ["\uD800", "\uDC00"]) {
      assert.throws(
        () => store.findCreation(authorization(), createOperationId),
        /createOperationId must be/u,
      );
    }
  } finally {
    store.close();
  }
}

function testReservationActivationAndExactAuthorization(stateDir: string): void {
  seedAuthorization(stateDir);
  let now = 1_000;
  let sequence = 0;
  const store = new ProjectExecutionStore(stateDir, {
    now: () => now,
    createExecutionId: () => `execution-${++sequence}`,
  });
  const input = reservation();
  try {
    const first = store.reserve(input);
    assert.equal(first.status, "new");
    if (first.status !== "new") return;
    assert.equal(first.execution.executionId, "execution-1");
    assert.equal(first.execution.status, "provisioning");
    assert.equal(first.execution.stateGeneration, 1);

    assert.deepEqual(store.reserve(input), {
      status: "replay",
      execution: first.execution,
    });
    assert.deepEqual(store.reserve({ ...input, requestHash: "different" }), {
      status: "conflict",
    });
    assert.equal(
      store.findCreation(authorization(), `${"界".repeat(42)}ab`),
      undefined,
    );
    for (const createOperationId of [
      "a".repeat(129),
      `${"界".repeat(42)}abc`,
      "nul\0id",
    ]) {
      assert.throws(
        () => store.reserve(reservation({ createOperationId })),
        /createOperationId must be/u,
      );
    }

    now = 2_000;
    createWorkspace(
      stateDir,
      "workspace-wrong-project",
      "wrong-project",
      "/tmp/other-project",
    );
    assert.equal(
      store.activate(first.execution.executionId, authorization(), {
        workspaceId: "workspace-wrong-project",
      }),
      undefined,
      "activation must not bind an execution to a different Project root",
    );
    assert.equal(
      store.activate(first.execution.executionId, authorization(), {
        workspaceId: "workspace-wrong-project",
        workspaceRoot: "/tmp/other-project",
      })?.workspaceId,
      "workspace-wrong-project",
      "an internally verified managed checkout root may differ from the authorized source root",
    );
    store.close(first.execution.executionId, "reset managed-root activation test");

    const replacement = store.reserve(reservation({ createOperationId: "create-replacement" }));
    assert.equal(replacement.status, "new");
    if (replacement.status !== "new") return;
    createWorkspace(stateDir, "workspace-execution-2", "execution-2");
    const active = store.activate(replacement.execution.executionId, authorization(), {
      workspaceId: "workspace-execution-2",
    });
    assert.equal(active?.status, "active");
    assert.equal(active?.stateGeneration, 2);
    assert.equal(active?.lastUsedAt, "1970-01-01T00:00:02.000Z");
    assert.equal(
      store.resolveActive(replacement.execution.executionId, {
        ...authorization(),
        authorizationEpoch: 2,
      }),
      undefined,
    );
    assert.equal(
      store.resolveActive(replacement.execution.executionId, authorization())?.workspaceId,
      "workspace-execution-2",
    );

    now = 3_000;
    assert.equal(
      store.touch(replacement.execution.executionId, authorization())?.lastUsedAt,
      "1970-01-01T00:00:03.000Z",
    );
    const database = openDatabase(stateDir);
    try {
      database.sqlite.prepare(
        "update oauth_grants set revoked_at = '2026-01-01T00:00:00.000Z' where grant_id = 'grant-a'",
      ).run();
    } finally {
      database.close();
    }
    assert.equal(
      store.resolveActive(replacement.execution.executionId, authorization()),
      undefined,
    );
    assert.deepEqual(
      store.findRecoveryIdentity(replacement.execution.executionId),
      {
        projectRef: "project-a",
        projectFingerprint: "fingerprint-a",
        canonicalSourceRoot: "/tmp/shared-project",
      },
      "recovery may retain only Project identity after the old grant becomes unusable",
    );
    assert.equal(store.findRecoveryIdentity("missing-execution"), undefined);
    assert.equal(store.touch(replacement.execution.executionId, authorization()), undefined);
  } finally {
    store.close();
  }
}

function testAuthorizationLifecycle(stateDir: string): void {
  seedAuthorization(stateDir);
  let sequence = 0;
  const store = new ProjectExecutionStore(stateDir, {
    createExecutionId: () => `execution-${++sequence}`,
  });
  try {
    const first = store.reserve(reservation({ createOperationId: "create-a" }));
    const second = store.reserve(reservation({ createOperationId: "create-b" }));
    assert.equal(first.status, "new");
    assert.equal(second.status, "new");
    assert.equal(store.listByAuthorization(authorization()).length, 2);
    assert.equal(store.markRevoked(authorization(), "grant revoked"), 2);
    assert.deepEqual(
      store.listByAuthorization(authorization()).map((execution) => execution.status),
      ["revoked", "revoked"],
    );
    if (first.status === "new") {
      assert.equal(
        store.resolveActive(first.execution.executionId, authorization()),
        undefined,
      );
    }
  } finally {
    store.close();
  }
}

function testStartupAuthorizationReconciliation(stateDir: string): void {
  seedAuthorization(stateDir);
  const store = new ProjectExecutionStore(stateDir, {
    now: () => Date.parse("2026-01-02T00:00:00.000Z"),
    createExecutionId: () => "execution-orphaned",
  });
  try {
    const reserved = store.reserve(reservation());
    assert.equal(reserved.status, "new");
    if (reserved.status !== "new") return;
    createWorkspace(stateDir, "workspace-orphaned", "execution-orphaned");
    assert.equal(store.activate(reserved.execution.executionId, authorization(), {
      workspaceId: "workspace-orphaned",
    })?.status, "active");

    const database = openDatabase(stateDir);
    try {
      database.sqlite.prepare("delete from oauth_clients where client_id = 'client-a'").run();
      assert.equal(
        database.sqlite.prepare(
          "select count(*) from project_executions where execution_id = 'execution-orphaned'",
        ).pluck().get(),
        1,
      );
    } finally {
      database.close();
    }

    const reconciled = store.reconcileAuthorizationBoundaries();
    assert.deepEqual(
      reconciled.executions.map(({ executionId, status }) => ({ executionId, status })),
      [{ executionId: "execution-orphaned", status: "revoked" }],
    );
    assert.deepEqual(reconciled.workspaceCleanupJobs, [{
      id: reconciled.workspaceCleanupJobs[0]!.id,
      executionId: "execution-orphaned",
      workspaceId: "workspace-orphaned",
      workspaceRoot: "/tmp/shared-project",
    }]);
  } finally {
    store.close();
  }

  const restartedExecutions = new ProjectExecutionStore(stateDir);
  const restartedWorkspaces = new SqliteWorkspaceStore(stateDir);
  try {
    assert.equal(
      restartedExecutions.listByAuthorization(authorization())[0]?.status,
      "revoked",
    );
    assert.deepEqual(
      restartedExecutions.findRecoveryIdentity("execution-orphaned"),
      {
        projectRef: "project-a",
        projectFingerprint: "fingerprint-a",
        canonicalSourceRoot: "/tmp/shared-project",
      },
      "Project-only recovery identity must survive a service restart",
    );
    assert.deepEqual(
      restartedWorkspaces.listRevocationCleanupJobs().map((job) => ({
        projectExecutionId: job.projectExecutionId,
        workspaceId: job.workspaceId,
        workspaceRoot: job.workspaceRoot,
      })),
      [{
        projectExecutionId: "execution-orphaned",
        workspaceId: "workspace-orphaned",
        workspaceRoot: "/tmp/shared-project",
      }],
    );
  } finally {
    restartedExecutions.close();
    restartedWorkspaces.close();
  }
}

function testQuarantineAndClose(stateDir: string): void {
  seedAuthorization(stateDir);
  const store = new ProjectExecutionStore(stateDir, {
    createExecutionId: () => "execution-terminal",
  });
  try {
    const reserved = store.reserve(reservation());
    assert.equal(reserved.status, "new");
    if (reserved.status !== "new") return;
    const quarantined = store.quarantine(reserved.execution.executionId, "cleanup failed");
    assert.equal(quarantined?.status, "quarantined");
    assert.equal(quarantined?.error, "cleanup failed");
    const closed = store.close(reserved.execution.executionId);
    assert.equal(closed?.status, "closed");
    assert.equal(store.close(reserved.execution.executionId), undefined);
    assert.deepEqual(store.diagnosticSnapshot(), {
      total: 1,
      provisioning: 0,
      active: 0,
      revoked: 0,
      quarantined: 0,
      closed: 1,
    });
  } finally {
    store.close();
  }
}

function seedAuthorization(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  const database = openDatabase(stateDir);
  try {
    database.sqlite.prepare(`
      insert into oauth_clients (client_id, client_json, issued_at)
      values ('client-a', '{}', 1)
    `).run();
    database.sqlite.prepare(`
      insert into oauth_grants (
        grant_id, client_id, principal_id, granted_scopes_json,
        allowed_root_ids_json, authorization_epoch, absolute_expires_at,
        created_at, last_used_at, revoked_at
      ) values (
        'grant-a', 'client-a', 'owner', '["project:read"]',
        '["*"]', 1, null,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', null
      )
    `).run();
  } finally {
    database.close();
  }
}

function createWorkspace(
  stateDir: string,
  workspaceId: string,
  alias: string,
  root = "/tmp/shared-project",
): void {
  const store = new SqliteWorkspaceStore(stateDir);
  try {
    store.createSession({
      id: workspaceId,
      connectionPrincipalId: "owner",
      alias,
      root,
    });
  } finally {
    store.close();
  }
}

function authorization(): ProjectExecutionAuthorization {
  return {
    principalId: "owner",
    clientId: "client-a",
    grantId: "grant-a",
    authorizationEpoch: 1,
  };
}

function reservation(
  overrides: Partial<ReserveProjectExecutionInput> = {},
): ReserveProjectExecutionInput {
  return {
    ...authorization(),
    projectRef: "project-a",
    projectFingerprint: "fingerprint-a",
    sourceRoot: "/tmp/shared-project",
    canonicalSourceRoot: "/tmp/shared-project",
    createOperationId: "create-a",
    requestHash: "request-a",
    ...overrides,
  };
}
