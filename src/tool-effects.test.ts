import assert from "node:assert/strict";
import type { ProcessSnapshot } from "./process-sessions.js";
import {
  createApplyPatchEffects,
  createProcessInteractEffects,
  createProcessStartEffects,
} from "./tool-effects.js";

const observedAt = "2026-07-23T10:00:00.000Z";
const before = { hash: `sha256:${"a".repeat(64)}`, mtimeNs: "100" };
const after = { hash: `sha256:${"b".repeat(64)}`, mtimeNs: "200" };

const patchEffects = createApplyPatchEffects([
  {
    operation: "move",
    path: "new.txt",
    previousPath: "old.txt",
    observedBefore: before,
    observedAfter: after,
    overwrittenBefore: { hash: `sha256:${"c".repeat(64)}`, mtimeNs: "150" },
  },
  {
    operation: "delete",
    path: "deleted.txt",
    observedBefore: before,
    observedAfter: null,
    fuzzyMatch: { fuzzy: true, count: 1, modes: ["trim_end"] },
  },
]);
assert.deepEqual(patchEffects, {
  files: [
    {
      operation: "move",
      path: "new.txt",
      previousPath: "old.txt",
      version: { contentHash: after.hash, mtimeNs: after.mtimeNs },
    },
    {
      operation: "delete",
      path: "deleted.txt",
      version: null,
      fuzzyMatch: { fuzzy: true, count: 1, modes: ["trim_end"] },
    },
  ],
});

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
};
assert.deepEqual(createProcessStartEffects(startInput), {
  observedAt,
  process: {
    confidence: "unknown",
    action: "start",
    submitted: startInput.submitted,
    observed: {
      sessionId: 42,
      running: true,
      timedOut: false,
      stdinClosed: false,
      rootExited: false,
      managedDaemon: false,
      rootLeaseDetached: false,
    },
    untrackedSideEffects: true,
  },
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
  confidence: "unknown",
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
    rootExited: false,
    managedDaemon: false,
    rootLeaseDetached: false,
  },
  untrackedSideEffects: true,
});

const detachedDaemonEffects = createProcessInteractEffects({
  observedAt,
  submitted: {
    stdinBytes: 0,
    closeStdin: false,
    interrupt: false,
    detachRootLease: true,
  },
  snapshot: {
    ...runningSnapshot,
    rootExited: true,
    managedDaemon: true,
    rootLeaseDetached: true,
  },
});
assert.deepEqual(detachedDaemonEffects.process?.submitted, {
  stdinBytes: 0,
  closeStdin: false,
  interrupt: false,
  detachRootLease: true,
});
assert.deepEqual(detachedDaemonEffects.process?.observed, {
  sessionId: 42,
  running: true,
  timedOut: false,
  stdinClosed: false,
  rootExited: true,
  managedDaemon: true,
  rootLeaseDetached: true,
});
const serializedProcessEffects = JSON.stringify(interactEffects);
assert.equal(serializedProcessEffects.includes("secret command output"), false);
assert.equal(serializedProcessEffects.includes("network"), false);

assert.deepEqual(JSON.parse(JSON.stringify({
  patchEffects,
  interactEffects,
})), {
  patchEffects,
  interactEffects,
});
