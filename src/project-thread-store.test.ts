import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectThreadStore } from "./project-thread-store.js";

const root = mkdtempSync(join(tmpdir(), "devspace-thread-store-"));
let now = Date.parse("2026-07-31T00:00:00.000Z");
let checkpointSequence = 0;
const store = new ProjectThreadStore(root, {
  now: () => now,
  createThreadId: () => "thread-a",
  createCheckpointId: () => `checkpoint-${++checkpointSequence}`,
});

try {
  const created = store.create({
    profileId: "profile-a",
    projectRef: "project-a",
    projectFingerprint: "fingerprint-a",
    title: "Implement protocol",
    checkoutKind: "checkout",
    checkoutRoot: "/tmp/project-a",
  });
  assert.equal(created.revision, 1);
  assert.equal(store.get(created.threadId, "profile-b"), undefined);
  assert.equal(store.list({ profileId: "profile-a" }).length, 1);

  store.bindExecution(created.threadId, "profile-a", "execution-a", "grant-a");
  assert.equal(store.threadIdForExecution("execution-a"), created.threadId);

  now += 1_000;
  const automatic = store.appendCheckpoint({
    threadId: created.threadId,
    profileId: "profile-a",
    cause: "patch_applied",
    sourceOperationId: "patch-a",
    observedState: { files: 2, additions: 5, removals: 1 },
  });
  assert.equal(automatic.checkpointId, "checkpoint-1");
  assert.equal(
    store.appendCheckpoint({
      threadId: created.threadId,
      profileId: "profile-a",
      cause: "patch_applied",
      sourceOperationId: "patch-a",
      observedState: { files: 999 },
    }).checkpointId,
    automatic.checkpointId,
    "automatic checkpoints must replay by source operation id",
  );

  now += 1_000;
  const firstSave = store.saveProgress({
    threadId: created.threadId,
    profileId: "profile-a",
    title: "Implement protocol",
    modelSummary: "Thread summary is model-provided and must be revalidated.",
    observedState: { checkpoint: "manual" },
    sourceOperationId: "save-a",
  });
  assert.equal(firstSave.status, "saved");
  if (firstSave.status !== "saved") throw new Error("save failed");
  assert.equal(firstSave.thread.revision, 2);
  assert.equal(firstSave.checkpoint.modelSummaryTrust, "untrusted");
  assert.equal(store.resume(created.threadId, "profile-a")?.modelSummary, firstSave.checkpoint.modelSummary);

  const migrated = store.reassignProfile(created.threadId, "profile-a", "actor-profile-a");
  assert.equal(migrated?.profileId, "actor-profile-a");
  assert.equal(store.get(created.threadId, "profile-a"), undefined);
  assert.equal(store.setStatus(created.threadId, "actor-profile-a", "archived"), true);
  assert.equal(store.setStatus(created.threadId, "actor-profile-a", "active"), true);

  assert.equal(store.saveProgress({
    threadId: created.threadId,
    profileId: "actor-profile-a",
    title: "Stale",
    modelSummary: "stale",
    observedState: {},
    sourceOperationId: "save-stale",
    ifMatch: 1,
  }).status, "revision_conflict");
  assert.equal(store.saveProgress({
    threadId: created.threadId,
    profileId: "actor-profile-a",
    title: "Missing precondition",
    modelSummary: "missing",
    observedState: {},
    sourceOperationId: "save-missing",
  }).status, "if_match_required");

  assert.equal(store.setStatus(created.threadId, "actor-profile-a", "closed"), true);
  assert.equal(store.resume(created.threadId, "actor-profile-a"), undefined);
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}

console.log("project thread store tests passed");
