import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db/client.js";
import {
  MAX_COMPLETED_PROJECT_HANDOFFS,
  MAX_PROJECT_HANDOFF_MODEL_TEXT_JSON_BYTES,
  MAX_PROJECT_HANDOFF_PROGRESS_UTF8_BYTES,
  MAX_PROJECT_HANDOFF_TITLE_UTF8_BYTES,
  MAX_RESUMABLE_PROJECT_HANDOFFS,
  ProjectHandoffStore,
  projectHandoffModelTextJsonBytes,
} from "./project-handoff-store.js";
import {
  ProjectExecutionStore,
  type ProjectExecutionAuthorization,
} from "./project-execution-store.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const root = mkdtempSync(join(tmpdir(), "devspace-project-handoff-store-"));

try {
  testSaveCasCompletionAndCrossGrantResume(join(root, "lifecycle"));
  testBoundedListingAndCapacity(join(root, "capacity"));
  testCompletedRetention(join(root, "completed-retention"));
  testUtf8Bounds(join(root, "bounds"));
} finally {
  rmSync(root, { recursive: true, force: true });
}

function testSaveCasCompletionAndCrossGrantResume(stateDir: string): void {
  seedAuthorization(stateDir, "a");
  seedAuthorization(stateDir, "b");
  let now = Date.parse("2026-07-31T01:00:00.000Z");
  let handoffSequence = 0;
  const handoffs = new ProjectHandoffStore(stateDir, {
    now: () => now,
    createHandoffId: () => `handoff-${++handoffSequence}`,
  });
  const executions = new ProjectExecutionStore(stateDir, {
    now: () => now,
    createExecutionId: (() => {
      let sequence = 0;
      return () => `execution-${++sequence}`;
    })(),
  });
  try {
    const first = createActiveExecution(stateDir, executions, authorization("a"), "create-a");
    assert.deepEqual(handoffs.saveForExecution({
      executionId: first.executionId,
      projectRef: "project-a",
      projectFingerprint: "fingerprint-a",
      title: "Implement Project handoffs",
      progress: "Schema is complete; integrate the MCP tool next.",
      ifMatch: 1,
    }), {
      status: "if_match_unexpected",
    });

    const created = handoffs.saveForExecution({
      executionId: first.executionId,
      projectRef: "project-a",
      projectFingerprint: "fingerprint-a",
      title: "Implement Project handoffs",
      progress: "Schema is complete; integrate the MCP tool next.",
    });
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    assert.equal(created.handoff.revision, 1);
    assert.equal(created.handoff.status, "resumable");
    assert.equal(handoffs.getForExecution(first.executionId)?.handoffId, "handoff-1");
    assert.equal(executions.findCreation(authorization("a"), "create-a")?.handoffId, "handoff-1");

    const missingIfMatch = handoffs.saveForExecution({
      executionId: first.executionId,
      projectRef: "project-a",
      projectFingerprint: "fingerprint-a",
      title: "Updated title",
      progress: "Updated progress.",
    });
    assert.equal(missingIfMatch.status, "if_match_required");
    if (missingIfMatch.status === "if_match_required") {
      assert.equal(missingIfMatch.current.revision, 1);
    }

    const secondStore = new ProjectHandoffStore(stateDir, {
      now: () => now,
      createHandoffId: () => "unused",
    });
    try {
      now += 1_000;
      const updated = handoffs.saveForExecution({
        executionId: first.executionId,
        projectRef: "project-a",
        projectFingerprint: "fingerprint-a",
        title: "Implement Project handoffs",
        progress: "MCP integration is in progress.",
        ifMatch: 1,
      });
      assert.equal(updated.status, "updated");
      if (updated.status !== "updated") return;
      assert.equal(updated.handoff.revision, 2);

      const conflict = secondStore.saveForExecution({
        executionId: first.executionId,
        projectRef: "project-a",
        projectFingerprint: "fingerprint-a",
        title: "Stale writer",
        progress: "Must not overwrite the newer snapshot.",
        ifMatch: 1,
      });
      assert.equal(conflict.status, "revision_conflict");
      if (conflict.status === "revision_conflict") {
        assert.equal(conflict.current.revision, 2);
        assert.equal(conflict.current.progress, "MCP integration is in progress.");
      }
    } finally {
      secondStore.close();
    }

    const resumed = createActiveExecution(
      stateDir,
      executions,
      authorization("b"),
      "create-b",
      "handoff-1",
    );
    assert.equal(resumed.handoffId, "handoff-1");
    now += 1_000;
    const completed = handoffs.saveForExecution({
      executionId: resumed.executionId,
      projectRef: "project-a",
      projectFingerprint: "fingerprint-a",
      title: "Implement Project handoffs",
      progress: "Implementation and verification are complete.",
      status: "completed",
      ifMatch: 2,
    });
    assert.equal(completed.status, "updated");
    if (completed.status !== "updated") return;
    assert.equal(completed.handoff.status, "completed");
    assert.equal(completed.handoff.revision, 3);
    assert.equal(completed.handoff.completedAt, "2026-07-31T01:00:02.000Z");
    assert.deepEqual(handoffs.listSelection("fingerprint-a"), []);

    const completedAgain = handoffs.saveForExecution({
      executionId: resumed.executionId,
      projectRef: "project-a",
      projectFingerprint: "fingerprint-a",
      title: "Must remain complete",
      progress: "No update.",
      ifMatch: 3,
    });
    assert.equal(completedAgain.status, "handoff_completed");
  } finally {
    executions.close();
    handoffs.close();
  }
}

function testBoundedListingAndCapacity(stateDir: string): void {
  seedAuthorization(stateDir, "a");
  let now = Date.parse("2026-07-31T02:00:00.000Z");
  let sequence = 0;
  const handoffs = new ProjectHandoffStore(stateDir, {
    now: () => now,
    createHandoffId: () => `handoff-${++sequence}`,
  });
  const executions = new ProjectExecutionStore(stateDir, {
    now: () => now,
    createExecutionId: () => `execution-${sequence + 1}`,
  });
  try {
    for (let index = 0; index < MAX_RESUMABLE_PROJECT_HANDOFFS; index += 1) {
      now += 1_000;
      const execution = createActiveExecution(
        stateDir,
        executions,
        authorization("a"),
        `create-${index}`,
      );
      const saved = handoffs.saveForExecution({
        executionId: execution.executionId,
        projectRef: "project-a",
        projectFingerprint: "fingerprint-a",
        title: `Task ${index}`,
        progress: `Progress ${index}`,
      });
      assert.equal(saved.status, "created");
    }
    assert.equal(handoffs.listSelection("fingerprint-a").length, 2);
    const listing = handoffs.listResumable({
      projectFingerprints: ["fingerprint-a"],
      perProjectLimit: 3,
      totalLimit: 2,
    });
    assert.equal(listing.handoffs.length, 2);
    assert.equal(listing.truncated, true);
    assert.ok(listing.handoffs[0]!.updatedAt > listing.handoffs[1]!.updatedAt);
    assert.deepEqual(handoffs.countResumable([
      "fingerprint-a",
      "fingerprint-missing",
      "fingerprint-a",
    ]), [
      {
        projectFingerprint: "fingerprint-a",
        count: MAX_RESUMABLE_PROJECT_HANDOFFS,
      },
      {
        projectFingerprint: "fingerprint-missing",
        count: 0,
      },
    ]);

    const overflowExecution = createActiveExecution(
      stateDir,
      executions,
      authorization("a"),
      "create-overflow",
    );
    assert.deepEqual(handoffs.saveForExecution({
      executionId: overflowExecution.executionId,
      projectRef: "project-a",
      projectFingerprint: "fingerprint-a",
      title: "Overflow",
      progress: "Must be rejected before persistence.",
    }), {
      status: "capacity",
      limit: MAX_RESUMABLE_PROJECT_HANDOFFS,
    });
    assert.equal(handoffs.getForExecution(overflowExecution.executionId), undefined);
  } finally {
    executions.close();
    handoffs.close();
  }
}

function testUtf8Bounds(stateDir: string): void {
  seedAuthorization(stateDir, "a");
  const handoffs = new ProjectHandoffStore(stateDir);
  const executions = new ProjectExecutionStore(stateDir, {
    createExecutionId: () => "execution-bounds",
  });
  try {
    const execution = createActiveExecution(
      stateDir,
      executions,
      authorization("a"),
      "create-bounds",
    );
    assert.throws(
      () => handoffs.saveForExecution({
        executionId: execution.executionId,
        projectRef: "project-a",
        projectFingerprint: "fingerprint-a",
        title: "界".repeat(Math.floor(MAX_PROJECT_HANDOFF_TITLE_UTF8_BYTES / 3) + 1),
        progress: "valid",
      }),
      /title must be/u,
    );
    assert.throws(
      () => handoffs.saveForExecution({
        executionId: execution.executionId,
        projectRef: "project-a",
        projectFingerprint: "fingerprint-a",
        title: "valid",
        progress: "界".repeat(Math.floor(MAX_PROJECT_HANDOFF_PROGRESS_UTF8_BYTES / 3) + 1),
      }),
      /progress must be/u,
    );
    const escapeHeavyProgress = "\\".repeat(
      Math.min(MAX_PROJECT_HANDOFF_PROGRESS_UTF8_BYTES, MAX_PROJECT_HANDOFF_MODEL_TEXT_JSON_BYTES),
    );
    assert.ok(
      projectHandoffModelTextJsonBytes("valid", escapeHeavyProgress) >
        MAX_PROJECT_HANDOFF_MODEL_TEXT_JSON_BYTES,
    );
    assert.throws(
      () => handoffs.saveForExecution({
        executionId: execution.executionId,
        projectRef: "project-a",
        projectFingerprint: "fingerprint-a",
        title: "valid",
        progress: escapeHeavyProgress,
      }),
      /serialized context limit/u,
    );
  } finally {
    executions.close();
    handoffs.close();
  }
}

function testCompletedRetention(stateDir: string): void {
  seedAuthorization(stateDir, "a");
  let now = Date.parse("2026-07-31T03:00:00.000Z");
  let handoffSequence = 0;
  let executionSequence = 0;
  const handoffs = new ProjectHandoffStore(stateDir, {
    now: () => now,
    createHandoffId: () => `completed-handoff-${++handoffSequence}`,
  });
  const executions = new ProjectExecutionStore(stateDir, {
    now: () => now,
    createExecutionId: () => `completed-execution-${++executionSequence}`,
  });
  try {
    const firstExecution = createActiveExecution(
      stateDir,
      executions,
      authorization("a"),
      "create-first-completed",
    );
    const firstSaved = handoffs.saveForExecution({
      executionId: firstExecution.executionId,
      projectRef: "project-a",
      projectFingerprint: "fingerprint-a",
      title: "First completed task",
      progress: "Will become the oldest retained task.",
    });
    assert.equal(firstSaved.status, "created");
    if (firstSaved.status !== "created") return;
    const pendingInput = {
      ...authorization("a"),
      projectRef: "project-a",
      projectFingerprint: "fingerprint-a",
      sourceRoot: "/tmp/shared-project",
      canonicalSourceRoot: "/tmp/shared-project",
      handoffId: firstSaved.handoff.handoffId,
      createOperationId: "create-pending-resume",
      requestHash: "pending-resume-request",
    };
    const pending = executions.reserve(pendingInput);
    assert.equal(pending.status, "new");
    assert.equal(handoffs.saveForExecution({
      executionId: firstExecution.executionId,
      projectRef: "project-a",
      projectFingerprint: "fingerprint-a",
      title: "First completed task",
      progress: "Completed.",
      status: "completed",
      ifMatch: 1,
    }).status, "updated");

    let lastExecutionId = "";
    for (let index = 0; index < MAX_COMPLETED_PROJECT_HANDOFFS; index += 1) {
      now += 1_000;
      const execution = createActiveExecution(
        stateDir,
        executions,
        authorization("a"),
        `create-additional-completed-${index}`,
      );
      lastExecutionId = execution.executionId;
      const saved = handoffs.saveForExecution({
        executionId: execution.executionId,
        projectRef: "project-a",
        projectFingerprint: "fingerprint-a",
        title: `Completed task ${index}`,
        progress: `Completed progress ${index}`,
        status: "completed",
      });
      assert.equal(saved.status, "created");
    }

    const database = openDatabase(stateDir);
    try {
      const retained = database.sqlite.prepare(`
        select count(*) as count
        from project_handoffs
        where project_fingerprint = ? and status = 'completed'
      `).get("fingerprint-a") as { count: number };
      assert.equal(retained.count, MAX_COMPLETED_PROJECT_HANDOFFS);
    } finally {
      database.close();
    }
    assert.equal(
      handoffs.getForExecution(firstExecution.executionId),
      undefined,
      "the oldest completed record and its execution link must be pruned",
    );
    assert.equal(
      executions.findCreation(
        authorization("a"),
        "create-first-completed",
      )?.handoffRetired,
      true,
    );
    assert.deepEqual(handoffs.saveForExecution({
      executionId: firstExecution.executionId,
      projectRef: "project-a",
      projectFingerprint: "fingerprint-a",
      title: "Must not reopen",
      progress: "A pruned completed task remains terminal.",
    }), {
      status: "handoff_retired",
    });
    const replayedPending = executions.reserve(pendingInput);
    assert.equal(replayedPending.status, "replay");
    if (replayedPending.status === "replay") {
      assert.equal(replayedPending.execution.handoffId, undefined);
      assert.equal(replayedPending.execution.handoffRetired, true);
    }
    assert.equal(handoffs.getForExecution(lastExecutionId)?.status, "completed");
  } finally {
    executions.close();
    handoffs.close();
  }
}

function seedAuthorization(stateDir: string, suffix: string): void {
  mkdirSync(stateDir, { recursive: true });
  const database = openDatabase(stateDir);
  try {
    database.sqlite.prepare(`
      insert into oauth_clients (client_id, client_json, issued_at)
      values (?, '{}', 1)
    `).run(`client-${suffix}`);
    database.sqlite.prepare(`
      insert into oauth_grants (
        grant_id, client_id, principal_id, granted_scopes_json,
        allowed_root_ids_json, authorization_epoch, absolute_expires_at,
        created_at, last_used_at, revoked_at
      ) values (
        ?, ?, 'owner', '["project:read"]', '["*"]', 1, null,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', null
      )
    `).run(`grant-${suffix}`, `client-${suffix}`);
  } finally {
    database.close();
  }
}

function createActiveExecution(
  stateDir: string,
  store: ProjectExecutionStore,
  auth: ProjectExecutionAuthorization,
  operationId: string,
  handoffId?: string,
) {
  const reserved = store.reserve({
    ...auth,
    projectRef: "project-a",
    projectFingerprint: "fingerprint-a",
    sourceRoot: "/tmp/shared-project",
    canonicalSourceRoot: "/tmp/shared-project",
    ...(handoffId ? { handoffId } : {}),
    createOperationId: operationId,
    requestHash: operationId,
  });
  assert.equal(reserved.status, "new");
  if (reserved.status !== "new") throw new Error("Expected a new execution");
  const workspaceId = `workspace-${reserved.execution.executionId}`;
  const workspaces = new SqliteWorkspaceStore(stateDir);
  try {
    workspaces.createSession({
      id: workspaceId,
      connectionPrincipalId: "owner",
      alias: reserved.execution.executionId,
      root: "/tmp/shared-project",
    });
  } finally {
    workspaces.close();
  }
  const active = store.activate(reserved.execution.executionId, auth, { workspaceId });
  if (!active) throw new Error("Expected execution activation");
  return active;
}

function authorization(suffix: string): ProjectExecutionAuthorization {
  return {
    principalId: "owner",
    clientId: `client-${suffix}`,
    grantId: `grant-${suffix}`,
    authorizationEpoch: 1,
  };
}
