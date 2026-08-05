import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ProjectTaskContinuityStore } from "./project-task-continuity-store.js";

const root = mkdtempSync(join(tmpdir(), "devspace-task-continuity-"));
let eventSequence = 0;
let snapshotSequence = 0;
let now = Date.parse("2026-07-31T12:00:00.000Z");
const store = new ProjectTaskContinuityStore(root, {
  now: () => now,
  createEventId: () => `event-${++eventSequence}`,
  createSnapshotId: () => `snapshot-${++snapshotSequence}`,
});

try {
  const identity = store.observeHostIdentity({
    actorId: "actor-a",
    subjectRef: "subject-a",
    organizationRef: "organization-a",
    sessionRef: "session-a",
  });
  assert.equal(identity.actorId, "actor-a");
  store.bindSession({
    sessionRef: "session-a",
    actorId: "actor-a",
    organizationRef: "organization-a",
    threadId: "thread-a",
    executionId: "execution-a",
  });
  assert.deepEqual(store.resolveSession("session-a", "actor-a"), {
    sessionRef: "session-a",
    actorId: "actor-a",
    organizationRef: "organization-a",
    threadId: "thread-a",
    executionId: "execution-a",
    boundAt: "2026-07-31T12:00:00.000Z",
    lastSeenAt: "2026-07-31T12:00:00.000Z",
  });
  now = Date.parse("2026-07-31T12:01:00.000Z");
  assert.equal(store.touchSession({
    sessionRef: "session-a",
    actorId: "actor-a",
    threadId: "thread-a",
    executionId: "wrong-execution",
  }), false);
  assert.equal(store.resolveSession("session-a", "actor-a")?.lastSeenAt, "2026-07-31T12:00:00.000Z");
  assert.equal(store.touchSession({
    sessionRef: "session-a",
    actorId: "actor-a",
    threadId: "thread-a",
    executionId: "execution-a",
  }), true);
  assert.deepEqual(store.resolveSession("session-a", "actor-a"), {
    sessionRef: "session-a",
    actorId: "actor-a",
    organizationRef: "organization-a",
    threadId: "thread-a",
    executionId: "execution-a",
    boundAt: "2026-07-31T12:00:00.000Z",
    lastSeenAt: "2026-07-31T12:01:00.000Z",
  });
  store.bindSession({
    sessionRef: "session-a",
    actorId: "actor-a",
    threadId: "thread-replacement",
    executionId: "execution-replacement",
  });
  assert.equal(store.resolveSession("session-a", "actor-a")?.threadId, "thread-replacement");
  assert.equal(store.resolveSession("session-a", "actor-a")?.executionId, "execution-replacement");
  assert.equal(store.releaseSession({
    sessionRef: "session-a",
    actorId: "actor-a",
    threadId: "thread-a",
    executionId: "execution-a",
  }), false);

  store.observeHostIdentity({ actorId: "actor-b" });
  store.bindSession({
    sessionRef: "session-b",
    actorId: "actor-a",
    threadId: "thread-session-b",
    executionId: "execution-session-b",
  });
  store.bindSession({
    sessionRef: "session-a",
    actorId: "actor-b",
    threadId: "thread-actor-b",
    executionId: "execution-actor-b",
  });
  assert.equal(store.resolveSession("session-b", "actor-a")?.threadId, "thread-session-b");
  assert.equal(store.resolveSession("session-a", "actor-b")?.threadId, "thread-actor-b");
  assert.equal(store.resolveSession("session-b", "actor-b"), undefined);

  const first = store.appendEvent({
    threadId: "thread-a",
    eventKey: "patch-a:applied",
    type: "patch_applied",
    source: "server",
    trust: "server_observed",
    operationId: "patch-a",
    payload: { files: 2 },
  });
  assert.equal(first.sequence, 1);
  assert.equal(store.appendEvent({
    threadId: "thread-a",
    eventKey: "patch-a:applied",
    type: "patch_applied",
    source: "server",
    trust: "server_observed",
    operationId: "patch-a",
    payload: { files: 999 },
  }).eventId, first.eventId);
  store.appendEvent({
    threadId: "thread-a",
    eventKey: "command-a:started",
    type: "command.started",
    source: "server",
    trust: "server_observed",
    visibility: "widget",
    operationId: "command-a",
    itemId: "command:1",
    payload: { summary: "Running tests.", sessionId: 1 },
  });
  store.appendEvent({
    threadId: "thread-a",
    eventKey: "command-a:output:12",
    type: "command.output_available",
    source: "server",
    trust: "server_observed",
    visibility: "widget",
    operationId: "command-a",
    itemId: "command:1",
    payload: {
      summary: "Command output updated.",
      outputId: "output-a",
      nextOffset: 12,
      totalBytes: 12,
      storedBytes: 12,
      droppedBytes: 0,
      status: "active",
    },
  });
  assert.equal(store.activityProjection("thread-a").status, "running");
  assert.equal(store.activityProjection("thread-a").latestOutput?.nextOffset, 12);
  store.appendEvent({
    threadId: "thread-a",
    eventKey: "command-a:completed",
    type: "command.completed",
    source: "server",
    trust: "server_observed",
    visibility: "widget",
    operationId: "command-a",
    itemId: "command:1",
    payload: { summary: "Command completed.", exitCode: 0 },
  });
  assert.equal(store.activityProjection("thread-a").status, "completed");
  assert.deepEqual(store.activityProjection("thread-a").activeItems, []);
  store.appendEvent({
    threadId: "thread-a",
    type: "progress_saved",
    source: "model",
    trust: "untrusted",
    operationId: "save-a",
    payload: { title: "Continue implementation" },
  });
  assert.deepEqual(store.listEvents({ threadId: "thread-a" }).map((event) => event.sequence), [1, 2, 3, 4, 5]);

  const snapshot = store.saveSnapshot({
    threadId: "thread-a",
    objective: "Finish continuity",
    observedState: { worktreeDirty: true },
    modelSummary: "Re-run validation.",
  });
  assert.equal(snapshot.throughSequence, 5);
  assert.equal(snapshot.modelSummaryTrust, "untrusted");
  assert.deepEqual(store.latestSnapshot("thread-a")?.observedState, { worktreeDirty: true });
  assert.equal(store.releaseSession({
    sessionRef: "session-a",
    actorId: "actor-a",
    threadId: "thread-replacement",
    executionId: "execution-replacement",
  }), true);
  assert.equal(store.touchSession({
    sessionRef: "session-a",
    actorId: "actor-a",
    threadId: "thread-replacement",
    executionId: "execution-replacement",
  }), false);
  assert.equal(store.resolveSession("session-a", "actor-a"), undefined);
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}

const legacyRoot = mkdtempSync(join(tmpdir(), "devspace-task-continuity-legacy-"));
try {
  const legacyPath = join(legacyRoot, "project-task-continuity.sqlite");
  const legacyDatabase = new Database(legacyPath);
  legacyDatabase.exec(`
    create table project_task_actors (
      actor_id text primary key,
      subject_ref text,
      organization_ref text,
      created_at text not null,
      last_seen_at text not null
    );
    create table project_task_session_bindings (
      session_ref text not null,
      actor_id text not null references project_task_actors(actor_id) on delete cascade,
      organization_ref text,
      thread_id text not null,
      binding_status text not null check (binding_status in ('active', 'released')),
      bound_at text not null,
      last_seen_at text not null,
      primary key (session_ref, actor_id)
    );
    insert into project_task_actors values (
      'legacy-actor', null, null, '2026-07-30T12:00:00.000Z', '2026-07-30T12:00:00.000Z'
    );
    insert into project_task_session_bindings values (
      'legacy-session', 'legacy-actor', null, 'legacy-thread', 'active',
      '2026-07-30T12:00:00.000Z', '2026-07-30T12:00:00.000Z'
    );
  `);
  legacyDatabase.close();

  const migratedStore = new ProjectTaskContinuityStore(legacyRoot);
  assert.deepEqual(migratedStore.resolveSession("legacy-session", "legacy-actor"), {
    sessionRef: "legacy-session",
    actorId: "legacy-actor",
    threadId: "legacy-thread",
    boundAt: "2026-07-30T12:00:00.000Z",
    lastSeenAt: "2026-07-30T12:00:00.000Z",
  });
  assert.equal(migratedStore.touchSession({
    sessionRef: "legacy-session",
    actorId: "legacy-actor",
    threadId: "legacy-thread",
    executionId: "legacy-execution",
  }), false);
  assert.equal(
    migratedStore.resolveSession("legacy-session", "legacy-actor")?.lastSeenAt,
    "2026-07-30T12:00:00.000Z",
  );
  migratedStore.bindSession({
    sessionRef: "persisted-session",
    actorId: "legacy-actor",
    threadId: "persisted-thread",
    executionId: "persisted-execution",
  });
  migratedStore.close();

  const reopenedStore = new ProjectTaskContinuityStore(legacyRoot);
  assert.equal(reopenedStore.resolveSession("legacy-session", "legacy-actor")?.executionId, undefined);
  assert.equal(
    reopenedStore.resolveSession("persisted-session", "legacy-actor")?.executionId,
    "persisted-execution",
  );
  assert.equal(reopenedStore.releaseSession({
    sessionRef: "legacy-session",
    actorId: "legacy-actor",
    threadId: "legacy-thread",
  }), true);
  assert.equal(reopenedStore.resolveSession("legacy-session", "legacy-actor"), undefined);
  reopenedStore.close();

  const migratedDatabase = new Database(legacyPath, { readonly: true });
  const bindingColumns = migratedDatabase
    .prepare("pragma table_info(project_task_session_bindings)")
    .all() as Array<{ name: string }>;
  assert.equal(bindingColumns.some((column) => column.name === "execution_id"), true);
  migratedDatabase.close();
} finally {
  rmSync(legacyRoot, { recursive: true, force: true });
}

console.log("project task continuity store tests passed");
