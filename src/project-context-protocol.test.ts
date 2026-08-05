import assert from "node:assert/strict";
import {
  PROJECT_CONTEXT_TEXT,
  copyProjectContextDelta,
  copyProjectInstruction,
  createProjectContextDelta,
  serializeProjectContext,
  type ProjectContextProtocolInput,
  type ProjectExecutionRecord,
  type ProjectInstructionItem,
} from "./project-context-protocol.js";

const instructionText = "Use the repository's npm scripts.";
const implementationInstruction = {
  trustClass: "repository_untrusted",
  path: "AGENTS.md",
  content: instructionText,
  hash: "sha256-v1:private-instruction-file-a",
  bytes: Buffer.byteLength(instructionText, "utf8"),
  revision: "private-instruction-revision-a",
  manifest: { included: true },
  fragment: {
    partial: true,
    offsetBytes: 0,
    lengthBytes: 12,
    totalBytes: Buffer.byteLength(instructionText, "utf8"),
    complete: false,
  },
} as ProjectInstructionItem;

const execution: ProjectExecutionRecord = {
  executionId: "execution-private-a",
  executionRef: "pex1_public-execution-ref-a.signature-a",
  projectRef: "project-a",
  projectFingerprint: "project-fingerprint-private-a",
  workspaceId: "workspace-private-a",
  generation: 987_654_321,
  instructionContextId: "context-private-a",
  rootInstructionsAcknowledged: false,
  threadId: "thread-private-a",
  threadRef: "pth1_public-thread.signature",
  revisions: {
    instructionRevision: "instruction-revision-private-a",
    skillRevision: "skill-revision-private-a",
    acknowledgedRootInstructionRevision: "acknowledged-instruction-private-a",
    acknowledgedSkillRevision: "acknowledged-skill-private-a",
    acknowledgedInstructionScopes: ["."],
  },
};

const copiedInstruction = copyProjectInstruction(implementationInstruction);
assert.deepEqual(copiedInstruction, {
  trustClass: "repository_untrusted",
  path: "AGENTS.md",
  content: instructionText,
  fragment: {
    partial: true,
  },
});

const continuationCursor = "dcur1.public-root-continuation";
const createdDelta = createProjectContextDelta(
  [implementationInstruction],
  continuationCursor,
);
const copiedDelta = copyProjectContextDelta({
  ...createdDelta,
  privateRevision: execution.revisions.instructionRevision,
} as typeof createdDelta);
assert.deepEqual(copiedDelta, {
  instructions: [copiedInstruction],
  nextCursor: continuationCursor,
});
assert.notEqual(copiedDelta, createdDelta);
assert.notEqual(copiedDelta.instructions, createdDelta.instructions);
assert.notEqual(copiedDelta.instructions[0], createdDelta.instructions[0]);

const input = {
  page: "bootstrap",
  project: {
    ref: execution.projectRef,
    writeAccess: "read_only",
    checkoutKind: "worktree",
    projectFingerprint: execution.projectFingerprint,
    workspaceId: execution.workspaceId,
    generation: execution.generation,
    instructionContextId: execution.instructionContextId,
  },
  contextDelta: {
    instructions: [implementationInstruction],
    nextCursor: continuationCursor,
    revision: execution.revisions.instructionRevision,
  },
  checkpoint: {
    cause: "patch_applied",
    serverObserved: { files: 2, additions: 8, removals: 1 },
    untrustedSummary: "Historical summary; revalidate before acting.",
    createdAt: "2026-07-31T04:00:00.000Z",
    provenance: {
      source: "devspace_checkpoint",
      trust: "server_observed",
      authority: "none",
      privateField: "must-not-copy",
    },
  },
  handoff: {
    ref: "phf1_public-handoff.signature",
    title: "Continue MCP integration",
    progress: "Historical snapshot: re-read server.ts before editing.",
    status: "resumable",
    version: 3,
    updatedAt: "2026-07-31T03:00:00.000Z",
    mustRevalidate: true,
    provenance: {
      source: "devspace_saved_progress",
      trust: "untrusted",
      authority: "none",
      privateOwner: "must-not-copy",
    },
    privateHandoffId: "handoff-private-a",
  },
  diagnostics: {
    instructions: {
      reason: "Instruction scan reached its time limit.",
      revision: execution.revisions.instructionRevision,
    },
    source: {
      reason: "The source checkout is dirty; this execution starts from HEAD.",
      privatePath: "/private/source",
    },
    skills: {
      revision: execution.revisions.skillRevision,
    },
  },
} as ProjectContextProtocolInput;

const context = serializeProjectContext(input);
assert.deepEqual(context.content, [{
  type: "text",
  text: PROJECT_CONTEXT_TEXT,
}]);
assert.deepEqual(context.structuredContent, {
  project: {
    ref: "project-a",
    writeAccess: "read_only",
    checkoutKind: "worktree",
  },
  checkpoint: {
    cause: "patch_applied",
    serverObserved: { files: 2, additions: 8, removals: 1 },
    untrustedSummary: "Historical summary; revalidate before acting.",
  },
  instructions: [copiedInstruction],
  nextCursor: continuationCursor,
  diagnostics: {
    instructions: {
      reason: "Instruction scan reached its time limit.",
    },
    source: {
      reason: "The source checkout is dirty; this execution starts from HEAD.",
    },
  },
});

const serialized = JSON.stringify(context);
for (const privateValue of [
  execution.projectFingerprint,
  execution.executionId,
  execution.workspaceId,
  String(execution.generation),
  execution.instructionContextId,
  execution.executionRef,
  execution.threadId!,
  execution.revisions.instructionRevision,
  execution.revisions.skillRevision,
]) {
  assert.equal(serialized.includes(privateValue), false);
}
assert.doesNotMatch(
  serialized,
  /hash|manifest|skillId|workspaceId|generation|instructionContextId|projectFingerprint|executionId|executionRef|threadId|privateHandoffId|privateOwner|privateField|handoff|mustRevalidate|provenance|offsetBytes|lengthBytes|totalBytes|complete/u,
);
assert.equal("thread" in context.structuredContent, false);

const continuation = serializeProjectContext({
  page: "continuation",
  contextDelta: {
    instructions: [implementationInstruction],
    nextCursor: continuationCursor,
  },
});
assert.deepEqual(continuation.structuredContent, {
  instructions: [copiedInstruction],
  nextCursor: continuationCursor,
});
assert.doesNotMatch(
  JSON.stringify(continuation.structuredContent),
  /schemaVersion|ok|project|thread|checkpoint|diagnostics|rootInstructionsComplete/u,
);

console.log("project context protocol tests passed");
