import assert from "node:assert/strict";
import {
  WORKSPACE_CONTEXT_SCHEMA_VERSION,
  WORKSPACE_CONTEXT_TEXT,
  WORKSPACE_SELECTED_TEXT,
  WORKSPACE_TARGET_SCOPED_TEXT,
  createWorkspaceContextReceiptManager,
  serializeWorkspaceContext,
  type WorkspaceContextProtocolInput,
  type WorkspaceContextReceiptBinding,
} from "./workspace-context-protocol.js";

const key = Buffer.alloc(32, 0x5a);
const processGeneration = "process-generation-a";
const issuedAt = 1_000_000;
const binding: WorkspaceContextReceiptBinding = {
  connectionPrincipalId: "principal-secret-17",
  workspaceId: "workspace-opaque-ref",
  alias: "project-a",
  projectFingerprint: "proj_stable-project-a",
  contextSessionId: "wctxs_context-session-a",
  generation: 7,
  instructionRevision: "instruction-revision-a",
  skillRevision: "skill-revision-a",
  phase: "context_loaded",
};

const receipts = createWorkspaceContextReceiptManager({
  key,
  processGeneration,
  now: () => issuedAt,
});
const issued = receipts.issue(binding);
assert.match(issued.receipt, /^wctx5\.[A-Za-z0-9_-]{43}$/u);
assert.equal(issued.expiresAt, issuedAt + 6 * 60 * 60 * 1_000);
assert.equal(receipts.verify(issued.receipt, binding), true);
assert.deepEqual(receipts.resolve(issued.receipt), {
  binding,
  expiresAt: issued.expiresAt,
});
assert.equal(
  receipts.verify(issued.receipt, { ...binding, alias: "another-alias" }),
  false,
);
assert.equal(
  createWorkspaceContextReceiptManager({ key, processGeneration: "process-generation-b" })
    .resolve(issued.receipt),
  undefined,
);

let currentTime = 5_000;
const expiring = createWorkspaceContextReceiptManager({
  key,
  processGeneration,
  ttlMs: 10,
  now: () => currentTime,
});
const expiringReceipt = expiring.issue(binding);
currentTime = 5_011;
assert.equal(expiring.resolve(expiringReceipt.receipt), undefined);

const bounded = createWorkspaceContextReceiptManager({
  key,
  processGeneration,
  maxReceipts: 2,
  maxReceiptsPerPrincipal: 1,
});
const first = bounded.issue(binding);
const second = bounded.issue({
  ...binding,
  workspaceId: "workspace-second",
  alias: "second",
});
assert.equal(bounded.resolve(first.receipt), undefined);
assert.ok(bounded.resolve(second.receipt));

const instructionText = "Never expose this lifecycle-only test instruction body.";
const input: WorkspaceContextProtocolInput = {
  connectionPrincipalId: binding.connectionPrincipalId,
  workspaceId: binding.workspaceId,
  contextSessionId: binding.contextSessionId,
  phase: "context_loaded",
  workspace: {
    ref: binding.workspaceId,
    alias: binding.alias,
    projectFingerprint: binding.projectFingerprint,
    generation: binding.generation,
    mode: "checkout",
    writeAccess: "read_only",
  },
  instructionManifest: {
    revision: binding.instructionRevision,
    complete: true,
    included: true,
    loadedForScope: false,
    files: [{
      source: "repository",
      trust: "repository_untrusted",
      scope: ".",
      path: "AGENTS.md",
      hash: "sha256-v1:instruction-file-a",
      bytes: Buffer.byteLength(instructionText, "utf8"),
    }],
  },
  skills: {
    revision: binding.skillRevision,
    count: 1,
    included: true,
    items: [{
      skillId: "skill-a",
      name: "review",
      description: "Review the current change.",
      source: "repository",
      trust: "repository_untrusted",
      explicitOnly: true,
    }],
  },
};

const context = serializeWorkspaceContext(input, receipts);
assert.equal(context.content[0].text, WORKSPACE_CONTEXT_TEXT);
assert.equal(context.structuredContent.schemaVersion, WORKSPACE_CONTEXT_SCHEMA_VERSION);
assert.deepEqual(context.structuredContent.state, { phase: "context_loaded" });
assert.deepEqual(context.structuredContent.instructionManifest, input.instructionManifest);
assert.equal(context.structuredContent.instructionManifest.loadedForScope, false);
assert.equal(JSON.stringify(context).includes(instructionText), false);
assert.match(context.structuredContent.continuation.receipt, /^wctx5\./u);
assert.equal(context.structuredContent.continuation.phase, "context_loaded");

const selected = serializeWorkspaceContext({
  ...input,
  phase: "selected",
  instructionManifest: {
    ...input.instructionManifest,
    included: false,
    files: [],
  },
  skills: {
    ...input.skills,
    included: false,
    items: [],
  },
}, receipts);
assert.equal(selected.content[0].text, WORKSPACE_SELECTED_TEXT);
assert.deepEqual(selected.structuredContent.state, { phase: "selected" });

const targetScoped = serializeWorkspaceContext({
  ...input,
  phase: "target_scoped",
  instructionManifest: {
    ...input.instructionManifest,
    loadedForScope: true,
    reviewedRevision: input.instructionManifest.revision,
  },
}, receipts);
assert.equal(targetScoped.content[0].text, WORKSPACE_TARGET_SCOPED_TEXT);
assert.deepEqual(targetScoped.structuredContent.state, { phase: "target_scoped" });
assert.equal(
  targetScoped.structuredContent.instructionManifest.reviewedRevision,
  input.instructionManifest.revision,
);

assert.throws(
  () => serializeWorkspaceContext({
    ...input,
    phase: "selected",
  }, receipts),
  /selected context cannot include/u,
);
assert.throws(
  () => serializeWorkspaceContext({
    ...input,
    phase: "selected",
    instructionManifest: {
      ...input.instructionManifest,
      included: false,
      files: [],
      loadedForScope: true,
    },
    skills: { ...input.skills, included: false, items: [] },
  }, receipts),
  /cannot mark scoped instructions as loaded/u,
);

console.log("workspace context protocol v5 tests passed");
