import assert from "node:assert/strict";
import {
  WORKSPACE_CONTEXT_SCHEMA_VERSION,
  WORKSPACE_CONTEXT_TEXT,
  WORKSPACE_METADATA_TEXT,
  createWorkspaceContextReceiptManager,
  serializeWorkspaceContext,
  type WorkspaceContextProtocolInput,
  type WorkspaceContextReceiptBinding,
} from "./workspace-context-protocol.js";

const key = Buffer.alloc(32, 0x5a);
const processGeneration = "process-generation-a";
const issuedAt = 1_000_000;
const receipts = createWorkspaceContextReceiptManager({
  key,
  processGeneration,
  now: () => issuedAt,
});
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

const issued = receipts.issue(binding);
const receipt = issued.receipt;
assert.match(receipt, /^wctx4\.[A-Za-z0-9_-]{43}$/);
assert.equal(issued.expiresAt, issuedAt + 6 * 60 * 60 * 1_000);
assert.equal(receipts.verify(receipt, binding), true);
const resolved = receipts.resolve(receipt);
assert.deepEqual(resolved, { binding, expiresAt: issued.expiresAt });
assert.ok(resolved);
resolved.binding.workspaceId = "mutated-copy";
assert.deepEqual(
  receipts.resolve(receipt),
  { binding, expiresAt: issued.expiresAt },
  "resolve must not expose mutable registry state",
);
const equivalentManager = createWorkspaceContextReceiptManager({ key, processGeneration });
assert.equal(
  equivalentManager.verify(receipt, binding),
  false,
  "a matching signature is not enough when this process did not issue the receipt",
);
assert.equal(equivalentManager.resolve(receipt), undefined, "only locally issued receipts can be resolved");
for (const changed of [
  { ...binding, connectionPrincipalId: "different-principal" },
  { ...binding, workspaceId: "different-workspace" },
  { ...binding, alias: "different-alias" },
  { ...binding, projectFingerprint: "proj_different" },
  { ...binding, contextSessionId: "wctxs_context-session-b" },
  { ...binding, generation: binding.generation + 1 },
  { ...binding, instructionRevision: "instruction-revision-b" },
  { ...binding, skillRevision: "skill-revision-b" },
  { ...binding, phase: "metadata" as const },
]) {
  assert.equal(receipts.verify(receipt, changed), false);
}
assert.equal(
  createWorkspaceContextReceiptManager({ key, processGeneration: "process-generation-b" })
    .verify(receipt, binding),
  false,
  "a process-generation change invalidates previous receipts",
);
assert.equal(
  createWorkspaceContextReceiptManager({ key: Buffer.alloc(32, 0x6b), processGeneration })
    .verify(receipt, binding),
  false,
  "a default-key change on restart invalidates previous receipts",
);
const alteredReceipt = `${receipt.slice(0, -1)}${receipt.endsWith("A") ? "B" : "A"}`;
assert.equal(receipts.verify(alteredReceipt, binding), false);
assert.equal(receipts.verify("wctx4.not-a-receipt", binding), false);
assert.equal(receipts.verify("x".repeat(10_000), binding), false);
assert.equal(receipts.verify(receipt, { ...binding, connectionPrincipalId: "x".repeat(1_025) }), false);
assert.doesNotMatch(receipt, /owner|workspace|instruction|skill|secret/);
assert.throws(
  () => receipts.issue({ ...binding, workspaceId: "x".repeat(1_025) }),
  /exceeds 1024 UTF-8 bytes/,
);
assert.throws(
  () => createWorkspaceContextReceiptManager({ key: Buffer.alloc(31) }),
  /32-64 bytes/,
);
assert.throws(
  () => createWorkspaceContextReceiptManager({ maxReceipts: 0 }),
  /maxReceipts must be an integer from 1 to 65536/,
);
assert.throws(
  () => createWorkspaceContextReceiptManager({ maxReceipts: 2, maxReceiptsPerPrincipal: 3 }),
  /maxReceiptsPerPrincipal must be an integer from 1 to maxReceipts/,
);

const boundedReceipts = createWorkspaceContextReceiptManager({ key, processGeneration, maxReceipts: 2 });
const firstBinding = { ...binding, workspaceId: "workspace-1" };
const secondBinding = { ...binding, workspaceId: "workspace-2" };
const thirdBinding = { ...binding, workspaceId: "workspace-3" };
const firstReceipt = boundedReceipts.issue(firstBinding).receipt;
const secondReceipt = boundedReceipts.issue(secondBinding).receipt;
assert.deepEqual(
  boundedReceipts.resolve(firstReceipt)?.binding,
  firstBinding,
  "resolve refreshes LRU recency",
);
const thirdReceipt = boundedReceipts.issue(thirdBinding).receipt;
assert.equal(boundedReceipts.resolve(secondReceipt), undefined, "the least-recent receipt is evicted");
assert.deepEqual(boundedReceipts.resolve(firstReceipt)?.binding, firstBinding);
assert.deepEqual(boundedReceipts.resolve(thirdReceipt)?.binding, thirdBinding);

const fairReceipts = createWorkspaceContextReceiptManager({
  key,
  processGeneration,
  maxReceipts: 4,
  maxReceiptsPerPrincipal: 2,
});
const principalA1 = fairReceipts.issue({ ...binding, workspaceId: "a-1" }).receipt;
const principalB1 = fairReceipts.issue({
  ...binding,
  connectionPrincipalId: "principal-b",
  workspaceId: "b-1",
}).receipt;
fairReceipts.issue({ ...binding, workspaceId: "a-2" });
fairReceipts.issue({ ...binding, workspaceId: "a-3" });
assert.equal(fairReceipts.resolve(principalA1), undefined, "one principal cannot exceed its share");
assert.ok(fairReceipts.resolve(principalB1), "another principal's receipt must remain available");

let clock = 1_000;
const expiringReceipts = createWorkspaceContextReceiptManager({
  key,
  processGeneration,
  ttlMs: 50,
  now: () => clock,
});
const expiringReceipt = expiringReceipts.issue(binding).receipt;
clock = 1_049;
assert.deepEqual(expiringReceipts.resolve(expiringReceipt)?.binding, binding);
clock = 1_050;
assert.equal(expiringReceipts.resolve(expiringReceipt), undefined, "receipt expires at its fixed deadline");

clock = 0;
const expiryFairReceipts = createWorkspaceContextReceiptManager({
  key,
  processGeneration,
  maxReceipts: 2,
  maxReceiptsPerPrincipal: 2,
  ttlMs: 10,
  now: () => clock,
});
const expiresFirst = expiryFairReceipts.issue({
  ...binding,
  workspaceId: "expires-first",
}).receipt;
clock = 5;
const remainsLive = expiryFairReceipts.issue({
  ...binding,
  workspaceId: "remains-live",
}).receipt;
clock = 9;
assert.ok(
  expiryFairReceipts.resolve(expiresFirst),
  "resolution refreshes LRU recency without renewing the fixed deadline",
);
clock = 11;
expiryFairReceipts.issue({ ...binding, workspaceId: "new-receipt" });
assert.equal(expiryFairReceipts.resolve(expiresFirst), undefined);
assert.ok(
  expiryFairReceipts.resolve(remainsLive),
  "expired recent receipts must be removed before they can evict a live receipt",
);

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
    writeAccess: "read_write",
  },
  instructions: {
    revision: binding.instructionRevision,
    complete: true,
    included: true,
    acknowledged: true,
    items: [{
      source: "repository",
      trust: "repository_untrusted",
      scope: ".",
      path: "AGENTS.md",
      hash: "sha256-v1:instruction-file",
      content: "# Project guidance\n",
    }],
  },
  skills: {
    revision: binding.skillRevision,
    count: 1,
    included: true,
    items: [{
      skillId: "skill-1",
      name: "testing",
      description: "Run focused tests.",
      source: "repository",
      trust: "repository_untrusted",
    }],
  },
};
const serialized = serializeWorkspaceContext(input, receipts);
assert.deepEqual(serialized, {
  content: [{ type: "text", text: WORKSPACE_CONTEXT_TEXT }],
  structuredContent: {
    schemaVersion: WORKSPACE_CONTEXT_SCHEMA_VERSION,
    context: { phase: "context_loaded" },
    workspace: input.workspace,
    instructions: {
      revision: input.instructions.revision,
      complete: true,
      included: true,
      acknowledged: true,
      items: input.instructions.items,
    },
    skills: {
      revision: input.skills.revision,
      count: 1,
      included: true,
      items: input.skills.items,
    },
    continuation: {
      receipt,
      phase: "context_loaded",
      expiresAt: new Date(issued.expiresAt).toISOString(),
      instructionRevision: input.instructions.revision,
      skillRevision: input.skills.revision,
    },
  },
});
assert.equal(
  receipts.verify(serialized.structuredContent.continuation.receipt, binding),
  true,
);
assert.deepEqual(Object.keys(serialized.structuredContent), [
  "schemaVersion",
  "context",
  "workspace",
  "instructions",
  "skills",
  "continuation",
]);

const exceptional = serializeWorkspaceContext({
  ...input,
  instructions: {
    ...input.instructions,
    complete: false,
    incompleteReason: "deadline",
  },
  skills: {
    ...input.skills,
    count: 3,
    warningCount: 2,
  },
}, receipts);
assert.deepEqual(exceptional.structuredContent.diagnostics, {
  instructions: { reason: "deadline" },
  skills: { omitted: 2, warnings: 2 },
});
assert.equal(exceptional.content.length, 1);
assert.equal(exceptional.content[0].text, WORKSPACE_CONTEXT_TEXT);

const metadata = serializeWorkspaceContext({
  ...input,
  phase: "metadata",
  instructions: {
    ...input.instructions,
    included: false,
    acknowledged: false,
    items: [],
  },
  skills: {
    ...input.skills,
    included: false,
    items: [],
  },
}, receipts);
assert.equal(metadata.content[0].text, WORKSPACE_METADATA_TEXT);
assert.deepEqual(metadata.structuredContent.context, { phase: "metadata" });
assert.deepEqual(
  receipts.resolve(metadata.structuredContent.continuation.receipt)?.binding.phase,
  "metadata",
);

assert.throws(
  () => serializeWorkspaceContext({
    ...input,
    workspaceId: "a-different-workspace",
  }, receipts),
  /workspace\.ref must match workspaceId/,
);
assert.throws(
  () => serializeWorkspaceContext({
    ...input,
    skills: { ...input.skills, count: 0 },
  }, receipts),
  /skills\.count cannot be smaller/,
);
assert.throws(
  () => serializeWorkspaceContext({ ...input, phase: "metadata" }, receipts),
  /metadata context cannot include/,
);

console.log("workspace context protocol tests passed");
