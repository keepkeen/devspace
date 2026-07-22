import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  OPEN_WORKSPACE_ANNOTATIONS,
  SHOW_CHANGES_ANNOTATIONS,
  combineBatchResultWithInstructions,
  commandInstructionScopePaths,
  isCompleteReadResult,
  readinessSnapshot,
  workspaceAppAssetPaths,
} from "./server.js";

const shellWorkspaceRoot = mkdtempSync(resolve(tmpdir(), "devspace-shell-scopes-"));
mkdirSync(resolve(shellWorkspaceRoot, "nested"));
mkdirSync(resolve(shellWorkspaceRoot, "foo", "bar"), { recursive: true });
const staticShellScopes = commandInstructionScopePaths(
  shellWorkspaceRoot,
  "cd nested && pwd",
  shellWorkspaceRoot,
  undefined,
);
assert.ok("paths" in staticShellScopes);
assert.deepEqual(staticShellScopes.paths, [".", resolve(shellWorkspaceRoot, "nested")]);
const dynamicShellScopes = commandInstructionScopePaths(
  shellWorkspaceRoot,
  'cd "$TARGET" && pwd',
  shellWorkspaceRoot,
  undefined,
);
assert.ok("error" in dynamicShellScopes);
assert.match(dynamicShellScopes.error.content[0]?.type === "text" ? dynamicShellScopes.error.content[0].text : "", /No command was executed/);
const missingShellScopes = commandInstructionScopePaths(
  shellWorkspaceRoot,
  "mkdir future && cd future && pwd",
  shellWorkspaceRoot,
  undefined,
);
assert.ok("error" in missingShellScopes);
assert.match(missingShellScopes.error.content[0]?.type === "text" ? missingShellScopes.error.content[0].text : "", /does not yet exist/);
const ambiguousChainedShellScopes = commandInstructionScopePaths(
  shellWorkspaceRoot,
  "cd foo && cd bar && pwd",
  shellWorkspaceRoot,
  undefined,
);
assert.ok("error" in ambiguousChainedShellScopes);

assert.equal(isCompleteReadResult({}, undefined), true);
assert.equal(isCompleteReadResult({ offset: 1 }, undefined), false);
assert.equal(isCompleteReadResult({ limit: 100 }, undefined), false);
assert.equal(
  isCompleteReadResult({}, { truncation: { truncated: true } }),
  false,
);
assert.equal(
  isCompleteReadResult({}, { truncation: { truncated: false } }),
  true,
);

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
