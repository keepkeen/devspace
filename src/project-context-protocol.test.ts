import assert from "node:assert/strict";
import {
  PROJECT_CONTEXT_SCHEMA_VERSION,
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
  source: "repository",
  trust: "repository_untrusted",
  scope: ".",
  path: "AGENTS.md",
  content: instructionText,
  hash: "sha256-v1:private-instruction-file-a",
  bytes: Buffer.byteLength(instructionText, "utf8"),
  revision: "private-instruction-revision-a",
  manifest: { included: true },
  fragment: {
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
  source: "repository",
  trust: "repository_untrusted",
  scope: ".",
  path: "AGENTS.md",
  content: instructionText,
  fragment: {
    offsetBytes: 0,
    lengthBytes: 12,
    totalBytes: Buffer.byteLength(instructionText, "utf8"),
    complete: false,
  },
});

const continuationCursor = "dcur1.public-root-continuation";
const createdDelta = createProjectContextDelta(
  [implementationInstruction],
  false,
  continuationCursor,
);
const copiedDelta = copyProjectContextDelta({
  ...createdDelta,
  privateRevision: execution.revisions.instructionRevision,
} as typeof createdDelta);
assert.deepEqual(copiedDelta, {
  instructions: [copiedInstruction],
  rootInstructionsComplete: false,
  nextCursor: continuationCursor,
});
assert.notEqual(copiedDelta, createdDelta);
assert.notEqual(copiedDelta.instructions, createdDelta.instructions);
assert.notEqual(copiedDelta.instructions[0], createdDelta.instructions[0]);

const input = {
  project: {
    ref: execution.projectRef,
    executionRef: execution.executionRef,
    writeAccess: "read_only",
    projectFingerprint: execution.projectFingerprint,
    workspaceId: execution.workspaceId,
    generation: execution.generation,
    instructionContextId: execution.instructionContextId,
  },
  contextDelta: {
    instructions: [implementationInstruction],
    rootInstructionsComplete: false,
    nextCursor: continuationCursor,
    revision: execution.revisions.instructionRevision,
  },
  thread: {
    ref: execution.threadRef!,
    title: "Continue MCP integration",
    status: "active",
    version: 4,
    checkoutKind: "worktree",
    checkpoint: {
      cause: "patch_applied",
      observedState: { files: 2, additions: 8, removals: 1 },
      modelSummary: "Historical summary; revalidate before acting.",
      modelSummaryTrust: "untrusted",
      createdAt: "2026-07-31T04:00:00.000Z",
      provenance: {
        source: "devspace_checkpoint",
        trust: "server_observed",
        authority: "none",
        privateField: "must-not-copy",
      },
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
  schemaVersion: PROJECT_CONTEXT_SCHEMA_VERSION,
  ok: true,
  project: {
    ref: "project-a",
    executionRef: execution.executionRef,
    writeAccess: "read_only",
  },
  thread: {
    ref: execution.threadRef,
    title: "Continue MCP integration",
    status: "active",
    version: 4,
    checkoutKind: "worktree",
    checkpoint: {
      cause: "patch_applied",
      observedState: { files: 2, additions: 8, removals: 1 },
      modelSummary: "Historical summary; revalidate before acting.",
      modelSummaryTrust: "untrusted",
      createdAt: "2026-07-31T04:00:00.000Z",
      provenance: {
        source: "devspace_checkpoint",
        trust: "server_observed",
        authority: "none",
      },
    },
  },
  contextDelta: {
    instructions: [copiedInstruction],
    rootInstructionsComplete: false,
    nextCursor: continuationCursor,
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
    },
  },
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
  execution.threadId!,
  execution.revisions.instructionRevision,
  execution.revisions.skillRevision,
]) {
  assert.equal(serialized.includes(privateValue), false);
}
assert.doesNotMatch(
  serialized,
  /hash|manifest|skillId|workspaceId|generation|instructionContextId|projectFingerprint|executionId|threadId|privateHandoffId|privateOwner|privateField/u,
);

console.log("project context protocol tests passed");
