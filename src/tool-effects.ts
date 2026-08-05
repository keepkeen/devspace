import type { AppliedPatchFile, PatchOperation } from "./apply-patch.js";
import type { ProcessSnapshot } from "./process-sessions.js";

export interface ToolEffects {
  observedAt: string;
  process?: ProcessEffect;
}

export interface ApplyPatchEffects {
  files: ApplyPatchEffect[];
}

export interface ApplyPatchEffect {
  path: string;
  previousPath?: string;
  operation: PatchOperation;
  version: { contentHash: string; mtimeNs: string } | null;
  fuzzyMatch?: AppliedPatchFile["fuzzyMatch"];
}

export interface ProcessSubmittedEffect {
  stdinBytes: number;
  closeStdin: boolean;
  interrupt: boolean;
  detachRootLease?: boolean;
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
  rootExited: boolean;
  managedDaemon: boolean;
  rootLeaseDetached: boolean;
}

export interface ProcessEffect {
  confidence: "unknown";
  action: "start" | "interact";
  submitted: ProcessSubmittedEffect;
  observed: ProcessObservedEffect;
  /** Shell commands can have effects DevSpace did not directly observe. */
  untrackedSideEffects: true;
}

export interface ProcessEffectsInput {
  observedAt: string;
  submitted: ProcessSubmittedEffect;
  snapshot: ProcessSnapshot;
}

export function createApplyPatchEffects(
  files: readonly AppliedPatchFile[],
): ApplyPatchEffects {
  return {
    files: files.map((file): ApplyPatchEffect => ({
      path: file.path,
      ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      operation: file.operation,
      version: file.observedAfter
        ? {
            contentHash: file.observedAfter.hash,
            mtimeNs: file.observedAfter.mtimeNs,
          }
        : null,
      ...(file.fuzzyMatch ? { fuzzyMatch: file.fuzzyMatch } : {}),
    })),
  };
}

export function createProcessStartEffects(input: ProcessEffectsInput): ToolEffects {
  return createProcessEffects("start", input);
}

export function createProcessInteractEffects(input: ProcessEffectsInput): ToolEffects {
  return createProcessEffects("interact", input);
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
        ...(submitted.detachRootLease ? { detachRootLease: true } : {}),
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
        rootExited: snapshot.rootExited === true,
        managedDaemon: snapshot.managedDaemon === true,
        rootLeaseDetached: snapshot.rootLeaseDetached === true,
      },
      untrackedSideEffects: true,
    },
  };
}
