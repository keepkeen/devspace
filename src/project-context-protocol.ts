export const PROJECT_CONTEXT_SCHEMA_VERSION = 6 as const;
export const PROJECT_CONTEXT_TEXT = "Project context ready.";

export type ProjectInstructionSource = "repository" | "user" | "admin" | "bundled";
export type ProjectInstructionTrust =
  | "repository_untrusted"
  | "user_trusted"
  | "admin_trusted"
  | "bundled_trusted";

interface ProjectInstructionItemBase {
  scope: string;
  path: string;
  content: string;
  fragment?: {
    offsetBytes: number;
    lengthBytes: number;
    totalBytes: number;
    complete: boolean;
  };
}

/**
 * The complete model-visible representation of one applicable instruction.
 * Server-only discovery and paging fields must not be added to this type.
 */
export type ProjectInstructionItem = ProjectInstructionItemBase & (
  | { source: "repository"; trust: "repository_untrusted" }
  | { source: "user"; trust: "user_trusted" }
  | { source: "admin"; trust: "admin_trusted" }
  | { source: "bundled"; trust: "bundled_trusted" }
);

export interface ProjectDescriptor {
  ref: string;
  executionRef: string;
  writeAccess: "read_only" | "read_write";
}

export interface ProjectThreadContext {
  ref: string;
  title: string;
  status: "active" | "paused" | "archived" | "completed" | "closed";
  version: number;
  checkoutKind: "checkout" | "worktree";
  checkpoint?: {
    cause:
      | "patch_applied"
      | "command_completed"
      | "execution_idle"
      | "service_shutdown"
      | "thread_left"
      | "manual";
    observedState: Record<string, unknown>;
    modelSummary?: string;
    modelSummaryTrust?: "untrusted";
    createdAt: string;
    provenance: {
      source: "devspace_checkpoint";
      trust: "server_observed";
      authority: "none";
    };
  };
}

export interface ProjectContextDelta {
  instructions: readonly ProjectInstructionItem[];
  rootInstructionsComplete: boolean;
  nextCursor?: string;
}

export interface ProjectContextDiagnostics {
  instructions?: {
    reason: string;
  };
  source?: {
    reason: string;
  };
}

export interface ProjectHandoffContext {
  ref: string;
  title: string;
  progress: string;
  status: "resumable";
  version: number;
  updatedAt: string;
  mustRevalidate: true;
  provenance: {
    source: "devspace_saved_progress";
    trust: "untrusted";
    authority: "none";
  };
}

/**
 * Server-held progressive-loading state. This state is bound to one Project
 * execution and must never be copied into model-visible structured content.
 */
export interface ProjectContextRevisionState {
  instructionRevision: string;
  skillRevision: string;
  acknowledgedRootInstructionRevision?: string;
  acknowledgedSkillRevision?: string;
  acknowledgedInstructionScopes?: readonly string[];
}

/**
 * Request-local Project execution. Only the opaque `executionRef` is public;
 * the durable execution id and backing checkout identity remain private.
 */
export interface ProjectExecutionRecord {
  executionId: string;
  executionRef: string;
  projectRef: string;
  projectFingerprint: string;
  workspaceId: string;
  generation: number;
  instructionContextId: string;
  rootInstructionsAcknowledged: boolean;
  threadId?: string;
  threadRef?: string;
  revisions: ProjectContextRevisionState;
}

export interface ProjectContextProtocolInput {
  project: ProjectDescriptor;
  thread?: ProjectThreadContext;
  contextDelta: ProjectContextDelta;
  handoff?: ProjectHandoffContext;
  diagnostics?: ProjectContextDiagnostics;
}

export interface ProjectContextProtocolResult {
  [key: string]: unknown;
  content: [{
    type: "text";
    text: typeof PROJECT_CONTEXT_TEXT;
  }];
  structuredContent: {
    schemaVersion: typeof PROJECT_CONTEXT_SCHEMA_VERSION;
    ok: true;
    project: ProjectDescriptor;
    thread?: ProjectThreadContext;
    contextDelta: ProjectContextDelta;
    handoff?: ProjectHandoffContext;
    diagnostics?: ProjectContextDiagnostics;
  };
}

/**
 * Copies only the public instruction fields. This is intentionally safe to call
 * with a structurally compatible server record that also has private metadata.
 */
export function copyProjectInstruction(
  instruction: ProjectInstructionItem,
): ProjectInstructionItem {
  return {
    source: instruction.source,
    trust: instruction.trust,
    scope: instruction.scope,
    path: instruction.path,
    content: instruction.content,
    ...(instruction.fragment
      ? {
          fragment: {
            offsetBytes: instruction.fragment.offsetBytes,
            lengthBytes: instruction.fragment.lengthBytes,
            totalBytes: instruction.fragment.totalBytes,
            complete: instruction.fragment.complete,
          },
        }
      : {}),
  } as ProjectInstructionItem;
}

/**
 * Creates a detached, model-safe instruction delta from server-held records.
 */
export function createProjectContextDelta(
  instructions: readonly ProjectInstructionItem[],
  rootInstructionsComplete: boolean,
  nextCursor?: string,
): ProjectContextDelta {
  return {
    instructions: instructions.map(copyProjectInstruction),
    rootInstructionsComplete,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

/**
 * Copies an existing delta while reapplying the model-visible field boundary.
 */
export function copyProjectContextDelta(
  delta: ProjectContextDelta,
): ProjectContextDelta {
  return createProjectContextDelta(
    delta.instructions,
    delta.rootInstructionsComplete,
    delta.nextCursor,
  );
}

export function serializeProjectContext(
  input: ProjectContextProtocolInput,
): ProjectContextProtocolResult {
  return {
    content: [{
      type: "text",
      text: PROJECT_CONTEXT_TEXT,
    }],
    structuredContent: {
      schemaVersion: PROJECT_CONTEXT_SCHEMA_VERSION,
      ok: true,
      project: {
        ref: input.project.ref,
        executionRef: input.project.executionRef,
        writeAccess: input.project.writeAccess,
      },
      ...(input.thread ? { thread: copyProjectThread(input.thread) } : {}),
      contextDelta: copyProjectContextDelta(input.contextDelta),
      ...(input.handoff ? { handoff: copyProjectHandoff(input.handoff) } : {}),
      ...(input.diagnostics
        ? { diagnostics: copyProjectContextDiagnostics(input.diagnostics) }
        : {}),
    },
  };
}

function copyProjectThread(thread: ProjectThreadContext): ProjectThreadContext {
  return {
    ref: thread.ref,
    title: thread.title,
    status: thread.status,
    version: thread.version,
    checkoutKind: thread.checkoutKind,
    ...(thread.checkpoint
      ? {
          checkpoint: {
            cause: thread.checkpoint.cause,
            observedState: structuredClone(thread.checkpoint.observedState),
            ...(thread.checkpoint.modelSummary
              ? {
                  modelSummary: thread.checkpoint.modelSummary,
                  modelSummaryTrust: "untrusted" as const,
                }
              : {}),
            createdAt: thread.checkpoint.createdAt,
            provenance: {
              source: "devspace_checkpoint",
              trust: "server_observed",
              authority: "none",
            },
          },
        }
      : {}),
  };
}

function copyProjectHandoff(
  handoff: ProjectHandoffContext,
): ProjectHandoffContext {
  return {
    ref: handoff.ref,
    title: handoff.title,
    progress: handoff.progress,
    status: "resumable",
    version: handoff.version,
    updatedAt: handoff.updatedAt,
    mustRevalidate: true,
    provenance: {
      source: "devspace_saved_progress",
      trust: "untrusted",
      authority: "none",
    },
  };
}

function copyProjectContextDiagnostics(
  diagnostics: ProjectContextDiagnostics,
): ProjectContextDiagnostics {
  return {
    ...(diagnostics.instructions
      ? { instructions: { reason: diagnostics.instructions.reason } }
      : {}),
    ...(diagnostics.source
      ? { source: { reason: diagnostics.source.reason } }
      : {}),
  };
}
