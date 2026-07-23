import type { AppliedPatchFile, PatchOperation } from "./apply-patch.js";
import type { FileVersion } from "./file-version.js";
import type { ProcessSnapshot } from "./process-sessions.js";
import type { ReviewSince } from "./review-checkpoints.js";

export interface ToolEffects {
  observedAt: string;
  files?: FileEffect[];
  process?: ProcessEffect;
  network?: NetworkEffect;
  workspace?: WorkspaceEffect;
  reviewCheckpoint?: ReviewCheckpointEffect;
}

export interface FileEffect {
  confidence: "observed";
  path: string;
  previousPath?: string;
  operation: PatchOperation;
  observedBefore: FileVersion | null;
  observedAfter: FileVersion | null;
}

export interface ProcessSubmittedEffect {
  stdinBytes: number;
  closeStdin: boolean;
  interrupt: boolean;
  resize?: {
    columns?: number;
    rows?: number;
  };
}

export interface ProcessObservedEffect {
  sessionId?: number;
  running: boolean;
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  stdinClosed: boolean;
}

export interface ProcessEffect {
  confidence: "unknown";
  action: "start" | "interact";
  submitted: ProcessSubmittedEffect;
  observed: ProcessObservedEffect;
  /** Shell commands can have effects DevSpace did not directly observe. */
  untrackedSideEffects: true;
}

export interface NetworkEffect {
  confidence: "declared";
  allowed: boolean;
  observed: false;
}

export type WorkspaceWorktreeEffect =
  | "not_managed"
  | "created"
  | "reused"
  | "removed"
  | "retained";

export interface WorkspaceEffect {
  confidence: "observed";
  action: "open" | "close" | "revoke";
  result: "opened" | "reused" | "closed" | "revoked" | "retained";
  worktree: WorkspaceWorktreeEffect;
  processesTerminated: number;
}

export interface ReviewCheckpointEffect {
  confidence: "observed";
  since: ReviewSince;
  advanced: boolean;
}

export interface ProcessEffectsInput {
  observedAt: string;
  submitted: ProcessSubmittedEffect;
  snapshot: ProcessSnapshot;
  networkAllowed?: boolean;
}

export interface WorkspaceOpenEffectsInput {
  observedAt: string;
  reused: boolean;
  managedWorktree: boolean;
}

export interface WorkspaceCloseEffectsInput {
  observedAt: string;
  closed: boolean;
  managedWorktree: boolean;
  worktreeRemoved: boolean;
  processesTerminated: number;
}

export interface WorkspaceRevokeEffectsInput {
  observedAt: string;
  revoked: boolean;
  managedWorktree: boolean;
  worktreeRemoved: boolean;
  processesTerminated: number;
}

export interface ReviewEffectsInput {
  observedAt: string;
  since: ReviewSince;
  advanced: boolean;
}

export function createApplyPatchEffects(
  observedAt: string,
  files: readonly AppliedPatchFile[],
): ToolEffects {
  return {
    observedAt,
    files: files.flatMap((file): FileEffect[] => {
      if (file.operation !== "move" || file.previousPath === undefined) {
        return [{
          confidence: "observed",
          path: file.path,
          operation: file.operation,
          observedBefore: cloneFileVersion(file.observedBefore),
          observedAfter: cloneFileVersion(file.observedAfter),
        }];
      }
      return [
        {
          confidence: "observed",
          path: file.previousPath,
          operation: "delete",
          observedBefore: cloneFileVersion(file.observedBefore),
          observedAfter: null,
        },
        {
          confidence: "observed",
          path: file.path,
          previousPath: file.previousPath,
          operation: file.overwrittenBefore ? "update" : "add",
          observedBefore: cloneFileVersion(file.overwrittenBefore ?? null),
          observedAfter: cloneFileVersion(file.observedAfter),
        },
      ];
    }),
  };
}

export function createProcessStartEffects(input: ProcessEffectsInput): ToolEffects {
  return createProcessEffects("start", input);
}

export function createProcessInteractEffects(input: ProcessEffectsInput): ToolEffects {
  return createProcessEffects("interact", input);
}

export function createWorkspaceOpenEffects(input: WorkspaceOpenEffectsInput): ToolEffects {
  return {
    observedAt: input.observedAt,
    workspace: {
      confidence: "observed",
      action: "open",
      result: input.reused ? "reused" : "opened",
      worktree: input.managedWorktree
        ? input.reused ? "reused" : "created"
        : "not_managed",
      processesTerminated: 0,
    },
  };
}

export function createWorkspaceCloseEffects(input: WorkspaceCloseEffectsInput): ToolEffects {
  return {
    observedAt: input.observedAt,
    workspace: {
      confidence: "observed",
      action: "close",
      result: input.closed ? "closed" : "retained",
      worktree: workspaceEndState(
        input.managedWorktree,
        input.worktreeRemoved,
      ),
      processesTerminated: input.processesTerminated,
    },
  };
}

export function createWorkspaceRevokeEffects(input: WorkspaceRevokeEffectsInput): ToolEffects {
  return {
    observedAt: input.observedAt,
    workspace: {
      confidence: "observed",
      action: "revoke",
      result: input.revoked ? "revoked" : "retained",
      worktree: workspaceEndState(
        input.managedWorktree,
        input.worktreeRemoved,
      ),
      processesTerminated: input.processesTerminated,
    },
  };
}

export function createReviewEffects(input: ReviewEffectsInput): ToolEffects {
  return {
    observedAt: input.observedAt,
    reviewCheckpoint: {
      confidence: "observed",
      since: input.since,
      advanced: input.advanced,
    },
  };
}

function createProcessEffects(
  action: ProcessEffect["action"],
  input: ProcessEffectsInput,
): ToolEffects {
  const { observedAt, submitted, snapshot } = input;
  return {
    observedAt,
    process: {
      confidence: "unknown",
      action,
      submitted: {
        stdinBytes: submitted.stdinBytes,
        closeStdin: submitted.closeStdin,
        interrupt: submitted.interrupt,
        ...(submitted.resize === undefined ? {} : {
          resize: {
            ...(submitted.resize.columns === undefined
              ? {}
              : { columns: submitted.resize.columns }),
            ...(submitted.resize.rows === undefined ? {} : { rows: submitted.resize.rows }),
          },
        }),
      },
      observed: {
        ...(snapshot.sessionId === undefined ? {} : { sessionId: snapshot.sessionId }),
        running: snapshot.running,
        ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }),
        ...(snapshot.signal === undefined ? {} : { signal: snapshot.signal }),
        timedOut: snapshot.timedOut,
        stdinClosed: snapshot.stdinClosed,
      },
      untrackedSideEffects: true,
    },
    ...(input.networkAllowed === undefined
      ? {}
      : {
          network: {
            confidence: "declared" as const,
            allowed: input.networkAllowed,
            observed: false as const,
          },
        }),
  };
}

function workspaceEndState(
  managedWorktree: boolean,
  worktreeRemoved: boolean,
): WorkspaceWorktreeEffect {
  if (!managedWorktree) return "not_managed";
  return worktreeRemoved ? "removed" : "retained";
}

function cloneFileVersion<T extends { hash: string; mtimeNs: string } | null>(version: T): T {
  return (version === null ? null : { ...version }) as T;
}
