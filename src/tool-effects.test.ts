import assert from "node:assert/strict";
import type { ProcessSnapshot } from "./process-sessions.js";
import {
  createApplyPatchEffects,
  createProcessInteractEffects,
  createProcessStartEffects,
  createReviewEffects,
  createWorkspaceCloseEffects,
  createWorkspaceOpenEffects,
  createWorkspaceRevokeEffects,
} from "./tool-effects.js";

const observedAt = "2026-07-23T10:00:00.000Z";
const before = { hash: `sha256:${"a".repeat(64)}`, mtimeNs: "100" };
const after = { hash: `sha256:${"b".repeat(64)}`, mtimeNs: "200" };
const overwritten = { hash: `sha256:${"c".repeat(64)}`, mtimeNs: "150" };

const patchEffects = createApplyPatchEffects(observedAt, [
  {
    operation: "move",
    path: "new.txt",
    previousPath: "old.txt",
    observedBefore: before,
    observedAfter: after,
    overwrittenBefore: overwritten,
  },
  {
    operation: "delete",
    path: "deleted.txt",
    observedBefore: before,
    observedAfter: null,
  },
]);
assert.deepEqual(patchEffects, {
  observedAt,
  files: [
    {
      operation: "delete",
      path: "old.txt",
      observedBefore: before,
      observedAfter: null,
    },
    {
      operation: "update",
      path: "new.txt",
      previousPath: "old.txt",
      observedBefore: overwritten,
      observedAfter: after,
    },
    {
      operation: "delete",
      path: "deleted.txt",
      observedBefore: before,
      observedAfter: null,
    },
  ],
});
assert.notEqual(patchEffects.files?.[0]?.observedBefore, before);

const runningSnapshot: ProcessSnapshot = {
  sessionId: 42,
  output: "secret command output",
  outputTruncated: false,
  running: true,
  wallTimeMs: 25,
  originalTokenCount: 5,
  outputOmittedBytes: 0,
  totalOutputBytes: 21,
  storedOutputBytes: 21,
  droppedBytes: 0,
  timedOut: false,
  stdinClosed: false,
};
const startInput = {
  observedAt,
  submitted: {
    stdinBytes: 12,
    closeStdin: false,
    interrupt: false,
  },
  snapshot: runningSnapshot,
  networkAllowed: true,
};
assert.deepEqual(createProcessStartEffects(startInput), {
  observedAt,
  process: {
    action: "start",
    submitted: startInput.submitted,
    observed: {
      sessionId: 42,
      running: true,
      timedOut: false,
      stdinClosed: false,
    },
    untrackedSideEffects: true,
  },
  network: { allowed: true, observed: false },
});

const interactEffects = createProcessInteractEffects({
  observedAt,
  submitted: {
    stdinBytes: 0,
    closeStdin: true,
    interrupt: true,
    resize: { columns: 120, rows: 40 },
  },
  snapshot: {
    ...runningSnapshot,
    sessionId: undefined,
    running: false,
    exitCode: 130,
    signal: "SIGINT",
    timedOut: true,
    stdinClosed: true,
  },
});
assert.deepEqual(interactEffects.process, {
  action: "interact",
  submitted: {
    stdinBytes: 0,
    closeStdin: true,
    interrupt: true,
    resize: { columns: 120, rows: 40 },
  },
  observed: {
    running: false,
    exitCode: 130,
    signal: "SIGINT",
    timedOut: true,
    stdinClosed: true,
  },
  untrackedSideEffects: true,
});
const serializedProcessEffects = JSON.stringify(interactEffects);
assert.equal(serializedProcessEffects.includes("secret command output"), false);
assert.equal(serializedProcessEffects.includes("network"), false);

assert.deepEqual(createWorkspaceOpenEffects({
  observedAt,
  reused: false,
  managedWorktree: true,
}), {
  observedAt,
  workspace: {
    action: "open",
    result: "opened",
    worktree: "created",
    processesTerminated: 0,
  },
});
assert.deepEqual(createWorkspaceCloseEffects({
  observedAt,
  closed: false,
  managedWorktree: true,
  worktreeRemoved: false,
  processesTerminated: 2,
}), {
  observedAt,
  workspace: {
    action: "close",
    result: "retained",
    worktree: "retained",
    processesTerminated: 2,
  },
});
assert.deepEqual(createWorkspaceRevokeEffects({
  observedAt,
  revoked: true,
  managedWorktree: true,
  worktreeRemoved: true,
  processesTerminated: 1,
}), {
  observedAt,
  workspace: {
    action: "revoke",
    result: "revoked",
    worktree: "removed",
    processesTerminated: 1,
  },
});

const reviewInput = { observedAt, since: "last_shown" as const, advanced: true };
const reviewEffects = createReviewEffects(reviewInput);
assert.deepEqual(reviewEffects, {
  observedAt,
  reviewCheckpoint: { since: "last_shown", advanced: true },
});

assert.equal(
  JSON.stringify(createReviewEffects(reviewInput)),
  JSON.stringify(createReviewEffects(reviewInput)),
);
assert.deepEqual(JSON.parse(JSON.stringify({
  patchEffects,
  interactEffects,
  reviewEffects,
})), {
  patchEffects,
  interactEffects,
  reviewEffects,
});
