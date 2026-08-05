export const PROJECT_CONTEXT_TEXT = "Project context ready.";

export type ProjectInstructionTrustClass =
  | "repository_untrusted"
  | "user_trusted"
  | "admin_trusted"
  | "bundled_trusted";

interface ProjectInstructionItemBase {
  trustClass: ProjectInstructionTrustClass;
  scope?: string;
  path: string;
  content: string;
  fragment?: {
    partial: true;
  };
}

/**
 * The complete model-visible representation of one applicable instruction.
 * Server-only discovery and paging fields must not be added to this type.
 */
export type ProjectInstructionItem = ProjectInstructionItemBase;

export interface ProjectDescriptor {
  ref: string;
  writeAccess: "read_only" | "read_write";
  checkoutKind: "checkout" | "worktree";
}

export interface ProjectCheckpointContext {
  cause:
    | "patch_applied"
    | "command_completed"
    | "execution_idle"
    | "service_shutdown"
    | "thread_left"
    | "manual";
  serverObserved: Record<string, unknown>;
  untrustedSummary?: string;
}

export interface ProjectContextDelta {
  [key: string]: unknown;
  instructions: readonly ProjectInstructionItem[];
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
 * Request-local Project execution. Its opaque capability and durable backing
 * identities remain server-held and must not enter model-visible context.
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

export type ProjectContextProtocolInput =
  | {
      page: "bootstrap";
      project: ProjectDescriptor;
      checkpoint?: ProjectCheckpointContext;
      contextDelta: ProjectContextDelta;
      diagnostics?: ProjectContextDiagnostics;
    }
  | {
      page: "continuation";
      contextDelta: ProjectContextDelta;
    };

export interface ProjectContextBootstrap extends ProjectContextDelta {
  project: ProjectDescriptor;
  checkpoint?: ProjectCheckpointContext;
  diagnostics?: ProjectContextDiagnostics;
}

export interface ProjectContextProtocolResult {
  [key: string]: unknown;
  content: [{
    type: "text";
    text: typeof PROJECT_CONTEXT_TEXT;
  }];
  structuredContent: ProjectContextBootstrap | ProjectContextDelta;
}

/**
 * Copies only the public instruction fields. This is intentionally safe to call
 * with a structurally compatible server record that also has private metadata.
 */
export function copyProjectInstruction(
  instruction: ProjectInstructionItem,
): ProjectInstructionItem {
  return {
    trustClass: instruction.trustClass,
    ...(instruction.scope ? { scope: instruction.scope } : {}),
    path: instruction.path,
    content: instruction.content,
    ...(instruction.fragment
      ? {
          fragment: {
            partial: true,
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
  nextCursor?: string,
): ProjectContextDelta {
  return {
    instructions: instructions.map(copyProjectInstruction),
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
    delta.nextCursor,
  );
}

export function serializeProjectContext(
  input: ProjectContextProtocolInput,
): ProjectContextProtocolResult {
  const contextDelta = copyProjectContextDelta(input.contextDelta);
  return {
    content: [{
      type: "text",
      text: PROJECT_CONTEXT_TEXT,
    }],
    structuredContent: input.page === "continuation"
      ? contextDelta
      : {
          project: {
            ref: input.project.ref,
            writeAccess: input.project.writeAccess,
            checkoutKind: input.project.checkoutKind,
          },
          ...(input.checkpoint
            ? { checkpoint: copyProjectCheckpoint(input.checkpoint) }
            : {}),
          ...contextDelta,
          ...(input.diagnostics
            ? { diagnostics: copyProjectContextDiagnostics(input.diagnostics) }
            : {}),
        },
  };
}

function copyProjectCheckpoint(
  checkpoint: ProjectCheckpointContext,
): ProjectCheckpointContext {
  return {
    cause: checkpoint.cause,
    serverObserved: structuredClone(checkpoint.serverObserved),
    ...(checkpoint.untrustedSummary
      ? { untrustedSummary: checkpoint.untrustedSummary }
      : {}),
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
