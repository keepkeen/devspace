import type { AppliedPatchFile, PatchOperation } from "./apply-patch.js";
import type { FileVersion } from "./file-version.js";
import type { ProcessSnapshot } from "./process-sessions.js";

export interface ToolEffects {
  observedAt: string;
  files?: FileEffect[];
  process?: ProcessEffect;
}

export interface FileEffect {
  confidence: "observed";
  path: string;
  previousPath?: string;
  operation: PatchOperation;
  observedBefore: FileVersion | null;
  observedAfter: FileVersion | null;
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
          ...(file.fuzzyMatch ? { fuzzyMatch: file.fuzzyMatch } : {}),
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
          ...(file.fuzzyMatch ? { fuzzyMatch: file.fuzzyMatch } : {}),
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

function cloneFileVersion<T extends { hash: string; mtimeNs: string } | null>(version: T): T {
  return (version === null ? null : { ...version }) as T;
}
