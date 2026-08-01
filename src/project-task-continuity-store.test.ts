import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTaskContinuityStore } from "./project-task-continuity-store.js";

const root = mkdtempSync(join(tmpdir(), "devspace-task-continuity-"));
let eventSequence = 0;
let snapshotSequence = 0;
const store = new ProjectTaskContinuityStore(root, {
  now: () => Date.parse("2026-07-31T12:00:00.000Z"),
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
  });
  assert.equal(store.resolveSession("session-a", "actor-a"), "thread-a");

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
  assert.equal(store.unbindSession("session-a", "actor-a"), true);
  assert.equal(store.resolveSession("session-a", "actor-a"), undefined);
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}

console.log("project task continuity store tests passed");
