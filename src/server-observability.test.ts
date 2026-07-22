import assert from "node:assert/strict";
import {
  OPEN_WORKSPACE_ANNOTATIONS,
  SHOW_CHANGES_ANNOTATIONS,
  combineBatchResultWithInstructions,
  readinessSnapshot,
  workspaceAppAssetPaths,
} from "./server.js";

assert.deepEqual(OPEN_WORKSPACE_ANNOTATIONS, {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
});

assert.deepEqual(SHOW_CHANGES_ANNOTATIONS, {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
});

assert.deepEqual(
  readinessSnapshot({
    closing: false,
    workspaceDatabaseReady: true,
    oauthDatabaseReady: true,
  }),
  {
    statusCode: 200,
    body: {
      ok: true,
      name: "devspace",
      status: "ready",
      checks: {
        lifecycle: true,
        workspaceDatabase: true,
        oauthDatabase: true,
      },
    },
  },
);

const notReady = readinessSnapshot({
  closing: true,
  workspaceDatabaseReady: false,
  oauthDatabaseReady: true,
});
assert.equal(notReady.statusCode, 503);
assert.equal(notReady.body.ok, false);
assert.equal(notReady.body.status, "not_ready");
assert.deepEqual(notReady.body.checks, {
  lifecycle: false,
  workspaceDatabase: false,
  oauthDatabase: true,
});

const publicAssets = workspaceAppAssetPaths();
assert.equal(publicAssets.has("admin.html"), false);
assert.equal([...publicAssets].some((path) => /(^|\/)admin-[^/]+\.(?:js|css)$/.test(path)), false);
assert.equal([...publicAssets].every((path) => path.startsWith("assets/")), true);

const combinedBatch = combineBatchResultWithInstructions("result", false, "instructions");
assert.equal(combinedBatch.instructionsDelivered, true);
assert.match(combinedBatch.result, /result\n\ninstructions/);

const oversizedInstructions = combineBatchResultWithInstructions(
  "result",
  false,
  "x".repeat(60_000),
);
assert.equal(oversizedInstructions.instructionsDelivered, false);
assert.equal(oversizedInstructions.truncated, true);
assert.ok(oversizedInstructions.result.length <= 48_000);
assert.match(oversizedInstructions.result, /Use read on one target path/);
