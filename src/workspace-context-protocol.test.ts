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
const receipts = createWorkspaceContextReceiptManager({ key, processGeneration });
const binding: WorkspaceContextReceiptBinding = {
  connectionPrincipalId: "principal-secret-17",
  workspaceId: "workspace-opaque-ref",
  contextSessionId: "wctxs_context-session-a",
  generation: 7,
  instructionRevision: "instruction-revision-a",
  skillRevision: "skill-revision-a",
  phase: "context_loaded",
};

const receipt = receipts.issue(binding);
assert.match(receipt, /^wctx3\.[A-Za-z0-9_-]{43}$/);
assert.equal(receipts.verify(receipt, binding), true);
const resolved = receipts.resolve(receipt);
assert.deepEqual(resolved, binding);
assert.ok(resolved);
resolved.workspaceId = "mutated-copy";
assert.deepEqual(receipts.resolve(receipt), binding, "resolve must not expose mutable registry state");
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
assert.equal(receipts.verify("wctx3.not-a-receipt", binding), false);
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

const boundedReceipts = createWorkspaceContextReceiptManager({ key, processGeneration, maxReceipts: 2 });
const firstBinding = { ...binding, workspaceId: "workspace-1" };
const secondBinding = { ...binding, workspaceId: "workspace-2" };
const thirdBinding = { ...binding, workspaceId: "workspace-3" };
const firstReceipt = boundedReceipts.issue(firstBinding);
const secondReceipt = boundedReceipts.issue(secondBinding);
assert.deepEqual(boundedReceipts.resolve(firstReceipt), firstBinding, "resolve refreshes LRU recency");
const thirdReceipt = boundedReceipts.issue(thirdBinding);
assert.equal(boundedReceipts.resolve(secondReceipt), undefined, "the least-recent receipt is evicted");
assert.deepEqual(boundedReceipts.resolve(firstReceipt), firstBinding);
assert.deepEqual(boundedReceipts.resolve(thirdReceipt), thirdBinding);

let clock = 1_000;
const expiringReceipts = createWorkspaceContextReceiptManager({
  key,
  processGeneration,
  ttlMs: 50,
  now: () => clock,
});
const expiringReceipt = expiringReceipts.issue(binding);
clock = 1_049;
assert.deepEqual(expiringReceipts.resolve(expiringReceipt), binding);
clock = 1_050;
assert.equal(expiringReceipts.resolve(expiringReceipt), undefined, "receipt expires at its fixed deadline");

const input: WorkspaceContextProtocolInput = {
  connectionPrincipalId: binding.connectionPrincipalId,
  workspaceId: binding.workspaceId,
  contextSessionId: binding.contextSessionId,
  phase: "context_loaded",
  workspace: {
    ref: binding.workspaceId,
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
    receipt,
  },
});
assert.equal(
  receipts.verify(serialized.structuredContent.receipt, binding),
  true,
);
assert.deepEqual(Object.keys(serialized.structuredContent), [
  "schemaVersion",
  "context",
  "workspace",
  "instructions",
  "skills",
  "receipt",
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
assert.deepEqual(receipts.resolve(metadata.structuredContent.receipt)?.phase, "metadata");

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
