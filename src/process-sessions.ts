import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
  isProcessTreeAlive,
  resolveProcessCommand,
  terminateProcessTree,
  type ProcessCommand,
  type ShellCommand,
} from "./process-platform.js";
import { ProcessOutputQuotaError, type ProcessOutputStore } from "./process-output-store.js";
import type { WorkspaceRootLease } from "./workspace-root-locks.js";

const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_INTERACTIVE_YIELD_MS = 250;
const DEFAULT_POLL_YIELD_MS = 8_000;
// Allow long foreground waits (Claude Code default timeout is 2 minutes;
// max is 10 minutes). Background/session mode still returns early via yieldTimeMs=0.
const MAX_COMMAND_YIELD_MS = 600_000;
const MAX_POLL_YIELD_MS = 110_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const DEFAULT_BUFFER_BYTES = 1024 * 1024;
const COMPLETED_SESSION_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_DURABLE_OUTPUT_FLUSH_BYTES = 64 * 1_024;
const DEFAULT_DURABLE_OUTPUT_FLUSH_MS = 50;
const INITIAL_TREE_EXIT_POLL_MS = 25;
const MAX_TREE_EXIT_POLL_MS = 2_000;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
export const MAX_PROCESS_INPUT_BYTES = 1024 * 1024;

export interface StartCommandInput {
  connectionPrincipalId: string;
  workspaceId: string;
  command: ProcessCommand;
  cwd: string;
  environment?: Record<string, string>;
  tty?: boolean;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
  runtimeLimitMs?: number;
  instructionScopePaths?: string[];
  instructionInputMode?: "shell" | "opaque";
  /** Initial standard input. When provided, stdin is closed by default after writing. */
  stdin?: string;
  closeStdin?: boolean;
  /** Retain the operation's workspace-root lease immediately after child spawn. */
  retainWorkspaceRootLease?: () => WorkspaceRootLease;
  activity?: {
    threadId: string;
    operationId: string;
    summary: string;
  };
}

export interface ProcessActivityEvent {
  threadId: string;
  operationId: string;
  itemId: string;
  type:
    | "command.started"
    | "command.output_available"
    | "command.completed"
    | "command.failed"
    | "command.interrupted";
  eventKey: string;
  payload: Record<string, unknown>;
}

export interface PreparedProcessInput {
  expectedRevision: number;
  pendingInput: string;
  charsToWrite: string;
  nextCwd: string;
  instructionScopePaths: string[];
}

export interface WriteStdinInput {
  connectionPrincipalId: string;
  workspaceId: string;
  sessionId: number;
  chars?: string;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
  closeStdin?: boolean;
  /** Release root write serialization after the root process exits but descendants remain. */
  detachRootLease?: boolean;
  instructionScopePaths?: string[];
  preparedInput?: PreparedProcessInput;
}

export interface ProcessSnapshot {
  sessionId?: number;
  output: string;
  outputTruncated: boolean;
  running: boolean;
  exitCode?: number;
  signal?: string;
  wallTimeMs: number;
  /** Approximate token count of the full output before truncation (~4 chars/token, Codex-style). */
  originalTokenCount: number;
  /** Bytes dropped from the middle of the output by the head/tail buffer. */
  outputOmittedBytes: number;
  /** Opaque identifier for replaying durable output through read_process_output. */
  outputId?: string;
  /** Exact UTF-8 bytes observed across the full process lifetime. */
  totalOutputBytes: number;
  /** Exact bytes retained in durable storage. */
  storedOutputBytes: number;
  /** Exact bytes irrecoverably dropped after a durable-storage quota was reached. */
  droppedBytes: number;
  outputStorageError?: string;
  timedOut: boolean;
  stdinClosed: boolean;
  /** The originally spawned process exited, while zero or more descendants may remain. */
  rootExited?: boolean;
  /** A descendant process tree remains after the root process exited. */
  managedDaemon?: boolean;
  /** The user explicitly released root serialization while the daemon remains tracked. */
  rootLeaseDetached?: boolean;
}

export class UnknownProcessSessionError extends Error {
  readonly code = "unknown_process_session";

  constructor() {
    super("The process session is no longer available.");
    this.name = "UnknownProcessSessionError";
  }
}

export interface ProcessInstructionContext {
  cwd: string;
  scopePaths: string[];
  inputMode: "shell" | "opaque";
  pendingInput: string;
  inputRevision: number;
  stdinClosed: boolean;
}

interface ManagedProcess {
  pid?: number;
  processGroupId?: number;
  write(data: string): void;
  end?(): void;
  kill(signal?: NodeJS.Signals): void;
  interrupt(): void;
  treeAlive(): boolean;
  resize?(columns: number, rows: number): void;
}

interface ProcessLaunchGate {
  release(): Promise<void>;
  abort(): void;
}

interface ProcessSession {
  id: number;
  connectionPrincipalId: string;
  workspaceId: string;
  cwd: string;
  instructionScopePaths: string[];
  instructionInputMode: "shell" | "opaque";
  pendingInput: string;
  inputRevision: number;
  stdinClosed: boolean;
  process?: ManagedProcess;
  startedAt: number;
  columns: number;
  rows: number;
  buffer: HeadTailBuffer;
  running: boolean;
  exitCode?: number;
  signal?: string;
  exitPromise: Promise<void>;
  resolveExit: () => void;
  cleanupTimer?: NodeJS.Timeout;
  runtimeTimer?: NodeJS.Timeout;
  escalationTimer?: NodeJS.Timeout;
  treeExitTimer?: NodeJS.Timeout;
  timedOut: boolean;
  cancelRequested: boolean;
  rootExited: boolean;
  treeExitPollMs: number;
  rootLeaseDetached: boolean;
  outputId?: string;
  totalOutputBytes: number;
  quotaDroppedBytes: number;
  durableQuotaReached: boolean;
  pendingDurableOutput: string[];
  pendingDurableOutputBytes: number;
  durableFlushTimer?: NodeJS.Timeout;
  outputStorageError?: string;
  releaseWorkspaceRootLease?: () => void;
  activity?: StartCommandInput["activity"];
}

export interface ProcessSessionManagerOptions {
  maxBufferBytes?: number;
  completedSessionTtlMs?: number;
  maxSessions?: number;
  maxSessionsPerWorkspace?: number;
  maxRuntimeMs?: number;
  terminationGraceMs?: number;
  durableOutputFlushBytes?: number;
  durableOutputFlushMs?: number;
  outputStore?: ProcessOutputStore;
  onOutputStorageError?: (
    error: unknown,
    context: { connectionPrincipalId: string; workspaceId: string; outputId?: string },
  ) => void;
  onActivity?: (event: ProcessActivityEvent) => void;
}

export interface ProcessSessionUsageSnapshot {
  sessions: number;
  running: number;
  limit: number;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Duration and output limits must be non-negative.");
  }
  return Math.min(Math.floor(value), maximum);
}

function terminalSize(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Terminal dimensions must be integers between 1 and 1000.");
  }
  return value;
}

function assertProcessInputSize(value: string | undefined): void {
  if (value !== undefined && Buffer.byteLength(value, "utf8") > MAX_PROCESS_INPUT_BYTES) {
    throw new Error(`Process input exceeds the ${MAX_PROCESS_INPUT_BYTES}-byte limit.`);
  }
}

export function nextTreeExitPollMs(current: number): number {
  if (current < 100) return 100;
  if (current < 500) return 500;
  return MAX_TREE_EXIT_POLL_MS;
}

function workspaceKey(connectionPrincipalId: string, workspaceId: string): string {
  return `${connectionPrincipalId}\u0000${workspaceId}`;
}

function processEnvironment(input?: {
  overrides?: Record<string, string>;
  inheritedEnvironment?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const inheritedEnvironment = input?.inheritedEnvironment ?? process.env;
  const inheritedKeys = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "JAVA_HOME",
    "JDK_HOME",
    "GOPATH",
    "GOROOT",
    "GOMODCACHE",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "BUN_INSTALL",
    "PNPM_HOME",
    "VOLTA_HOME",
    "NVM_DIR",
    "NVM_BIN",
    "NVM_INC",
    "SDKROOT",
    "DEVELOPER_DIR",
    "ANDROID_HOME",
    "ANDROID_SDK_ROOT",
    "DOTNET_ROOT",
    "VIRTUAL_ENV",
    "CONDA_PREFIX",
    "PYENV_ROOT",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
  ] as const;
  const environment: Record<string, string> = {
    ...Object.fromEntries(
      inheritedKeys.flatMap((name) => {
        const value = inheritedEnvironment[name];
        return value === undefined ? [] : [[name, value] as const];
      }),
    ),
    NO_COLOR: "1",
    TERM: "dumb",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GH_PAGER: "cat",
    CODEX_CI: "1",
    LANG: inheritedEnvironment.LANG ?? "C.UTF-8",
    LC_ALL: inheritedEnvironment.LC_ALL ?? "C.UTF-8",
    ...(input?.overrides ?? {}),
  };
  // CDPATH changes the destination of an otherwise literal relative `cd`,
  // which would invalidate the instruction-scope check performed before spawn.
  delete environment.CDPATH;
  return environment;
}

export function processLauncherEnvironment(
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment = processEnvironment({ inheritedEnvironment });
  for (const name of Object.keys(environment)) {
    const normalized = name.toUpperCase();
    if (
      normalized.startsWith("LD_") ||
      normalized.startsWith("DYLD_") ||
      [
        "BASH_ENV",
        "ENV",
        "GCONV_PATH",
        "NODE_OPTIONS",
        "NODE_PATH",
        "PERL5LIB",
        "PERL5OPT",
        "PYTHONHOME",
        "PYTHONPATH",
        "RUBYLIB",
        "RUBYOPT",
        "SHELLOPTS",
      ].includes(normalized)
    ) {
      delete environment[name];
    }
  }
  return environment;
}

function splitBudget(maxUnits: number): { head: number; tail: number } {
  return {
    head: Math.ceil(maxUnits / 2),
    tail: Math.floor(maxUnits / 2),
  };
}

function formatHeadTail(head: string, tail: string, omittedBytes: number): string {
  if (omittedBytes <= 0) return head + tail;
  return `${head}\n... output truncated (${omittedBytes} bytes omitted) ...\n${tail}`;
}

function takeUtf8Head(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function takeUtf8Tail(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const characters = Array.from(value);
  let bytes = 0;
  let start = characters.length;
  while (start > 0) {
    const characterBytes = Buffer.byteLength(characters[start - 1]!, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    start -= 1;
  }
  return characters.slice(start).join("");
}

export class HeadTailBuffer {
  private head = "";
  private tail = "";
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new Error("Head/tail buffer limit must be a positive integer.");
    }
  }

  append(output: string): void {
    if (!output) return;

    const previousTotal = this.totalBytes;
    this.totalBytes += Buffer.byteLength(output, "utf8");

    if (this.totalBytes <= this.maxBytes) {
      this.head += output;
      return;
    }

    const budget = splitBudget(this.maxBytes);
    if (previousTotal <= this.maxBytes) {
      const fullOutput = this.head + output;
      this.head = takeUtf8Head(fullOutput, budget.head);
      this.tail = takeUtf8Tail(fullOutput, budget.tail);
      return;
    }

    this.tail = takeUtf8Tail(this.tail + output, budget.tail);
  }

  hasOutput(): boolean {
    return this.totalBytes > 0;
  }

  drain(maxBytes: number): { output: string; truncated: boolean; omittedBytes: number } {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new Error("Output limit must be a positive integer.");
    }

    const omittedByBuffer = Math.max(
      0,
      this.totalBytes - Buffer.byteLength(this.head, "utf8") - Buffer.byteLength(this.tail, "utf8"),
    );
    const retained = formatHeadTail(this.head, this.tail, omittedByBuffer);
    const output = truncateOutput(retained, maxBytes);
    const truncated = omittedByBuffer > 0 || output.truncated;
    const omittedBytes = omittedByBuffer + (output.truncated ? output.omittedBytes : 0);

    this.head = "";
    this.tail = "";
    this.totalBytes = 0;

    return { output: output.output, truncated, omittedBytes };
  }
}

function truncateOutput(output: string, maxBytes: number): {
  output: string;
  truncated: boolean;
  omittedBytes: number;
} {
  const outputBytes = Buffer.byteLength(output, "utf8");
  if (outputBytes <= maxBytes) return { output, truncated: false, omittedBytes: 0 };

  const marker = "\n... output truncated ...\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= maxBytes) {
    return {
      output: takeUtf8Head(marker, maxBytes),
      truncated: true,
      omittedBytes: outputBytes,
    };
  }
  const available = maxBytes - markerBytes;
  const budget = splitBudget(available);
  const head = takeUtf8Head(output, budget.head);
  const tail = takeUtf8Tail(output, budget.tail);
  const omittedBytes = Math.max(
    0,
    outputBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8"),
  );
  return {
    output: head + marker + tail,
    truncated: true,
    omittedBytes,
  };
}

export class ProcessSessionManager {
  private readonly sessions = new Map<number, ProcessSession>();
  private readonly maxBufferBytes: number;
  private readonly completedSessionTtlMs: number;
  private readonly maxSessions: number;
  private readonly maxSessionsPerWorkspace: number;
  private readonly maxRuntimeMs: number;
  private readonly terminationGraceMs: number;
  private readonly durableOutputFlushBytes: number;
  private readonly durableOutputFlushMs: number;
  private readonly outputStore?: ProcessOutputStore;
  private readonly onOutputStorageError?: ProcessSessionManagerOptions["onOutputStorageError"];
  private readonly onActivity?: ProcessSessionManagerOptions["onActivity"];
  private nextSessionId = 1;
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;
  private readonly closingWorkspaces = new Set<string>();

  constructor(options: ProcessSessionManagerOptions = {}) {
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_BUFFER_BYTES;
    this.completedSessionTtlMs = options.completedSessionTtlMs ?? COMPLETED_SESSION_TTL_MS;
    this.maxSessions = options.maxSessions ?? Number.POSITIVE_INFINITY;
    this.maxSessionsPerWorkspace = options.maxSessionsPerWorkspace ?? Number.POSITIVE_INFINITY;
    this.maxRuntimeMs = options.maxRuntimeMs ?? 6 * 60 * 60 * 1_000;
    this.terminationGraceMs = options.terminationGraceMs ?? 5_000;
    this.durableOutputFlushBytes = positiveBoundedInteger(
      options.durableOutputFlushBytes,
      DEFAULT_DURABLE_OUTPUT_FLUSH_BYTES,
      4 * 1_024 * 1_024,
      "durableOutputFlushBytes",
    );
    this.durableOutputFlushMs = positiveBoundedInteger(
      options.durableOutputFlushMs,
      DEFAULT_DURABLE_OUTPUT_FLUSH_MS,
      10_000,
      "durableOutputFlushMs",
    );
    this.outputStore = options.outputStore;
    this.onOutputStorageError = options.onOutputStorageError;
    this.onActivity = options.onActivity;
  }

  async start(input: StartCommandInput): Promise<ProcessSnapshot> {
    if (this.shuttingDown) throw new Error("Process manager is shutting down.");
    if (this.closingWorkspaces.has(workspaceKey(input.connectionPrincipalId, input.workspaceId))) {
      throw new Error("Project execution runtime is closing and cannot start new processes.");
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`Process session limit reached (${this.maxSessions}).`);
    }
    const workspaceSessions = Array.from(this.sessions.values()).filter(
      (session) => session.connectionPrincipalId === input.connectionPrincipalId && session.workspaceId === input.workspaceId,
    ).length;
    if (workspaceSessions >= this.maxSessionsPerWorkspace) {
      throw new Error(`Process session limit reached for this Project (${this.maxSessionsPerWorkspace}).`);
    }
    const runtimeLimitMs = this.resolveRuntimeLimitMs(input.runtimeLimitMs);
    assertProcessInputSize(input.stdin);
    const closeStdin = input.closeStdin ?? input.stdin !== undefined;
    if (input.tty && closeStdin) {
      throw new Error("PTY stdin cannot be closed reliably. Set closeStdin=false or run without tty.");
    }
    const session = this.createSession(input);
    this.sessions.set(session.id, session);

    let launchGate: ProcessLaunchGate | undefined;
    try {
      const command = resolveProcessCommand(input.command);
      if (input.tty && process.platform !== "win32") {
        launchGate = await this.startPty(
          session,
          input,
          command,
          Boolean(input.retainWorkspaceRootLease),
        );
      } else {
        launchGate = await this.startPipe(
          session,
          input,
          command,
          Boolean(input.retainWorkspaceRootLease),
        );
      }
      if (input.retainWorkspaceRootLease) {
        await this.attachWorkspaceRootLease(
          input.connectionPrincipalId,
          input.workspaceId,
          session.id,
          input.retainWorkspaceRootLease(),
          false,
        );
      }
      await launchGate?.release();
      launchGate = undefined;
      this.emitActivity(session, "command.started", `command:${session.id}:started`, {
        summary: input.activity?.summary ?? "Command started.",
        sessionId: session.id,
        cwd: input.cwd,
      });
      this.startRuntimeTimer(session, runtimeLimitMs);
      if (input.stdin) session.process?.write(input.stdin);
      if (closeStdin) this.closeProcessStdin(session);
    } catch (error) {
      launchGate?.abort();
      if (session.process) {
        await this.terminateFailedStartup(session);
      } else {
        this.finalizeDurableOutput(session);
        this.sessions.delete(session.id);
      }
      throw error;
    }

    const yieldTimeMs = boundedInteger(input.yieldTimeMs, DEFAULT_EXEC_YIELD_MS, MAX_COMMAND_YIELD_MS);
    await this.waitForExit(session, yieldTimeMs);

    const snapshot = this.consume(session, input.maxOutputTokens);
    if (!session.running) this.removeSession(session.id);
    return snapshot;
  }

  async write(input: WriteStdinInput): Promise<ProcessSnapshot> {
    const session = this.getOwnedSession(input.connectionPrincipalId, input.workspaceId, input.sessionId);
    if (
      input.preparedInput &&
      input.preparedInput.expectedRevision !== session.inputRevision
    ) {
      throw new Error("Process input changed concurrently; retry write_stdin.");
    }
    const chars = input.preparedInput?.charsToWrite ?? input.chars ?? "";
    assertProcessInputSize(input.chars);
    assertProcessInputSize(chars);
    assertProcessInputSize(input.preparedInput?.pendingInput);
    if (input.closeStdin && chars.includes("\u0003")) {
      throw new Error("Send Ctrl-C and close_stdin in separate write_stdin calls.");
    }
    const ordinaryInteractionRequested =
      (input.chars ?? "").length > 0 || input.closeStdin === true ||
      input.columns !== undefined || input.rows !== undefined;
    if (input.detachRootLease && ordinaryInteractionRequested) {
      throw new Error("Detach the daemon root lease in a separate write_stdin call without input, resize, or close_stdin.");
    }
    if (session.rootExited && ordinaryInteractionRequested) {
      throw new Error(`Process session ${session.id} root process exited; only polling, termination, or confirmed root-lease detach is available.`);
    }
    if (session.stdinClosed && chars.length > 0) {
      throw new Error(`Process session ${session.id} stdin is already closed.`);
    }
    if (input.closeStdin && !session.process?.end) {
      throw new Error(`Process session ${session.id} is a PTY and its stdin cannot be closed reliably.`);
    }
    const interactionRequested = ordinaryInteractionRequested || input.detachRootLease === true;

    if (input.detachRootLease) {
      if (!session.running || !session.rootExited || !session.process?.treeAlive()) {
        throw new Error("The process is not a managed daemon with a live descendant tree.");
      }
      if (session.rootLeaseDetached) {
        throw new Error("The managed daemon root lease is already detached.");
      }
      if (!session.releaseWorkspaceRootLease) {
        throw new Error("The managed daemon does not currently own a Project root lease.");
      }
      this.releaseWorkspaceRootLease(session);
      session.rootLeaseDetached = true;
    }

    if (input.columns !== undefined || input.rows !== undefined) {
      session.columns = terminalSize(input.columns, session.columns);
      session.rows = terminalSize(input.rows, session.rows);
      if (!session.process?.resize) {
        throw new Error(`Process session ${session.id} is not a PTY and cannot be resized.`);
      }
      session.process.resize(session.columns, session.rows);
    }

    const interruptRequested = chars.includes("\u0003") && session.running;
    if (interruptRequested) {
      session.cancelRequested = true;
      session.process?.interrupt();
    }
    const writableChars = chars.replaceAll("\u0003", "");
    if (writableChars && session.running) {
      session.process?.write(writableChars);
      for (const scopePath of input.preparedInput?.instructionScopePaths ?? input.instructionScopePaths ?? []) {
        const normalizedPath = resolve(session.cwd, scopePath);
        if (!session.instructionScopePaths.includes(normalizedPath)) {
          session.instructionScopePaths.push(normalizedPath);
        }
      }
    }
    if (input.closeStdin && !session.stdinClosed) {
      this.closeProcessStdin(session);
    }
    if (input.preparedInput) {
      session.pendingInput = input.preparedInput.pendingInput;
      session.cwd = input.preparedInput.nextCwd;
      session.inputRevision += 1;
    }

    if ((interactionRequested || !session.buffer.hasOutput()) && session.running) {
      const fallback = interactionRequested ? DEFAULT_INTERACTIVE_YIELD_MS : DEFAULT_POLL_YIELD_MS;
      const maximum = interactionRequested ? MAX_COMMAND_YIELD_MS : MAX_POLL_YIELD_MS;
      const yieldTimeMs = boundedInteger(input.yieldTimeMs, fallback, maximum);
      await this.waitForExit(session, yieldTimeMs);
    }

    const snapshot = this.consume(session, input.maxOutputTokens);
    if (!session.running) this.removeSession(session.id);
    return snapshot;
  }

  async attachWorkspaceRootLease(
    connectionPrincipalId: string,
    workspaceId: string,
    sessionId: number,
    lease: WorkspaceRootLease | (() => void),
    releaseOnAttachmentFailure = true,
  ): Promise<boolean> {
    const release = releaseOnce(() => lease());
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      !session.running ||
      session.connectionPrincipalId !== connectionPrincipalId ||
      session.workspaceId !== workspaceId
    ) {
      release();
      return false;
    }
    if (session.releaseWorkspaceRootLease) {
      release();
      throw new Error(`Process session ${sessionId} already owns a Project root lease.`);
    }
    session.releaseWorkspaceRootLease = release;
    const richLease = workspaceRootLease(lease);
    if (richLease && session.process?.pid !== undefined) {
      try {
        await richLease.attachProcess({
          pid: session.process.pid,
          ...(session.process.processGroupId === undefined
            ? {}
            : { processGroupId: session.process.processGroupId }),
        });
      } catch (error) {
        if (releaseOnAttachmentFailure) this.releaseWorkspaceRootLease(session);
        throw error;
      }
      if (!session.running) {
        this.releaseWorkspaceRootLease(session);
        return false;
      }
    }
    // A newly attached lease has not been detached, whatever happened to the
    // previous one. Leaving the flag set would make the next detach request
    // fail as "already detached" and pin the lease until the tree exits.
    session.rootLeaseDetached = false;
    return true;
  }

  instructionContext(
    connectionPrincipalId: string,
    workspaceId: string,
    sessionId: number,
  ): ProcessInstructionContext {
    const session = this.getOwnedSession(connectionPrincipalId, workspaceId, sessionId);
    return {
      cwd: session.cwd,
      scopePaths: [...session.instructionScopePaths],
      inputMode: session.instructionInputMode,
      pendingInput: session.pendingInput,
      inputRevision: session.inputRevision,
      stdinClosed: session.stdinClosed,
    };
  }

  terminate(connectionPrincipalId: string, workspaceId: string, sessionId: number): void {
    const session = this.getOwnedSession(connectionPrincipalId, workspaceId, sessionId);
    if (session.running) {
      session.cancelRequested = true;
      session.process?.kill("SIGTERM");
    }
  }

  interruptWorkspace(connectionPrincipalId: string, workspaceId: string): number[] {
    const sessions = Array.from(this.sessions.values()).filter(
      (session) => session.running &&
        session.connectionPrincipalId === connectionPrincipalId &&
        session.workspaceId === workspaceId,
    );
    for (const session of sessions) {
      session.cancelRequested = true;
      session.process?.interrupt();
    }
    return sessions.map((session) => session.id);
  }

  async terminateWorkspace(connectionPrincipalId: string, workspaceId: string): Promise<number> {
    this.closingWorkspaces.add(workspaceKey(connectionPrincipalId, workspaceId));
    const sessions = Array.from(this.sessions.values()).filter(
      (session) => session.running && session.connectionPrincipalId === connectionPrincipalId && session.workspaceId === workspaceId,
    );
    const errors: unknown[] = [];
    for (const session of sessions) {
      session.cancelRequested = true;
      const error = this.killSession(session, "SIGTERM");
      if (error) errors.push(error);
    }
    await this.waitForSessions(sessions, this.terminationGraceMs);
    const remaining = sessions.filter((session) => session.running);
    for (const session of remaining) {
      const error = this.killSession(session, "SIGKILL");
      if (error) errors.push(error);
    }
    await this.waitForSessions(remaining, this.terminationGraceMs);
    const survivors = sessions.filter((session) => session.running);
    for (const session of sessions) {
      if (!session.running) this.removeSession(session.id);
    }
    if (survivors.length > 0) {
      this.reopenWorkspace(connectionPrincipalId, workspaceId);
      errors.push(new Error(`Failed to terminate ${survivors.length} process session(s).`));
      throw new AggregateError(errors, "Project processes could not be terminated");
    }
    return sessions.length;
  }

  blockWorkspace(connectionPrincipalId: string, workspaceId: string): void {
    this.closingWorkspaces.add(workspaceKey(connectionPrincipalId, workspaceId));
  }

  hasActive(connectionPrincipalId: string, workspaceId: string): boolean {
    return Array.from(this.sessions.values()).some(
      (session) => session.running && session.connectionPrincipalId === connectionPrincipalId && session.workspaceId === workspaceId,
    );
  }

  usageSnapshot(): ProcessSessionUsageSnapshot {
    const sessions = Array.from(this.sessions.values());
    return {
      sessions: sessions.length,
      running: sessions.filter((session) => session.running).length,
      limit: this.maxSessions,
    };
  }

  flushOutput(connectionPrincipalId: string, workspaceId: string, outputId: string): void {
    const session = Array.from(this.sessions.values()).find(
      (candidate) =>
        candidate.outputId === outputId &&
        candidate.connectionPrincipalId === connectionPrincipalId &&
        candidate.workspaceId === workspaceId,
    );
    if (session) this.flushDurableOutput(session);
  }

  reopenWorkspace(connectionPrincipalId: string, workspaceId: string): void {
    this.closingWorkspaces.delete(workspaceKey(connectionPrincipalId, workspaceId));
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.shutdownProcesses();
    return this.shutdownPromise;
  }

  private async waitForExit(session: ProcessSession, yieldTimeMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        session.exitPromise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, yieldTimeMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private createSession(input: StartCommandInput): ProcessSession {
    let resolveExit = (): void => undefined;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    return {
      id: this.nextSessionId++,
      connectionPrincipalId: input.connectionPrincipalId,
      workspaceId: input.workspaceId,
      cwd: input.cwd,
      instructionScopePaths: [...new Set(
        (input.instructionScopePaths ?? [input.cwd]).map((path) => resolve(input.cwd, path)),
      )],
      instructionInputMode: input.instructionInputMode ?? "opaque",
      pendingInput: "",
      inputRevision: 0,
      stdinClosed: false,
      totalOutputBytes: 0,
      quotaDroppedBytes: 0,
      durableQuotaReached: false,
      pendingDurableOutput: [],
      pendingDurableOutputBytes: 0,
      startedAt: Date.now(),
      columns: terminalSize(input.columns, DEFAULT_COLUMNS),
      rows: terminalSize(input.rows, DEFAULT_ROWS),
      buffer: new HeadTailBuffer(this.maxBufferBytes),
      running: true,
      timedOut: false,
      cancelRequested: false,
      rootExited: false,
      treeExitPollMs: INITIAL_TREE_EXIT_POLL_MS,
      rootLeaseDetached: false,
      ...(input.activity ? { activity: input.activity } : {}),
      exitPromise,
      resolveExit,
    };
  }

  private async startPipe(
    session: ProcessSession,
    input: StartCommandInput,
    command: ShellCommand,
    gated: boolean,
  ): Promise<ProcessLaunchGate | undefined> {
    const detached = process.platform !== "win32";
    const targetEnvironment = processEnvironment({
      overrides: input.environment,
    });
    // The supervisor receives neither the target command nor its environment
    // until this private descriptor is released after durable attachment.
    const gateToken = gated ? randomBytes(24).toString("base64url") : undefined;
    const launchCommand = gateToken
      ? gatedSupervisorCommand("pipe", gateToken)
      : command;
    // Spawn the resolved process with its args directly. Using Node's
    // `shell: executable` form drops custom args (e.g. -c) and re-wraps the
    // command inconsistently with the PTY path.
    const child = spawn(launchCommand.executable, launchCommand.args, {
      cwd: input.cwd,
      env: gated ? processLauncherEnvironment() : targetEnvironment,
      stdio: gated ? ["pipe", "pipe", "pipe", "pipe"] : "pipe",
      windowsHide: true,
      detached,
    });

    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      session.stdinClosed = true;
      if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") return;
      this.append(session, `Process stdin failed: ${error.message}\n`);
    });
    child.stdin?.on("close", () => {
      session.stdinClosed = true;
    });

    const managedProcess: ManagedProcess = {
      ...(child.pid === undefined ? {} : { pid: child.pid }),
      ...(detached && child.pid !== undefined ? { processGroupId: child.pid } : {}),
      write: (data) => {
        child.stdin?.write(data);
      },
      end: () => {
        child.stdin?.end();
      },
      kill: (signal = "SIGTERM") => terminateProcessTree(child, signal, detached),
      interrupt: () => terminateProcessTree(child, "SIGINT", detached),
      treeAlive: () => isProcessTreeAlive(child, detached),
      resize: input.tty ? () => undefined : undefined,
    };
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    child.stdout?.on("data", (data: Buffer) => this.append(session, stdoutDecoder.write(data)));
    child.stderr?.on("data", (data: Buffer) => this.append(session, stderrDecoder.write(data)));
    child.stdout?.on("end", () => this.append(session, stdoutDecoder.end()));
    child.stderr?.on("end", () => this.append(session, stderrDecoder.end()));
    child.on("error", (error) => this.append(session, `${error.message}\n`));
    child.on("close", (code, signal) => this.finish(session, code ?? undefined, signal ?? undefined));
    await childSpawned(child);
    session.process = managedProcess;
    if (session.cancelRequested) session.process.kill("SIGTERM");
    if (!gateToken) return undefined;
    const gate = child.stdio[3] as Writable | null;
    if (!gate) throw new Error("Process launch gate was not created.");
    let settled = false;
    let gateError: Error | undefined;
    let rejectRelease: ((error: Error) => void) | undefined;
    gate.on("error", (error) => {
      gateError = error;
      rejectRelease?.(error);
    });
    return {
      release: () => {
        if (settled) return Promise.resolve();
        settled = true;
        if (gateError) return Promise.reject(gateError);
        return new Promise<void>((resolve, reject) => {
          rejectRelease = reject;
          gate.end(launchPayload(gateToken, command, targetEnvironment), () => {
            rejectRelease = undefined;
            if (gateError) reject(gateError);
            else resolve();
          });
        });
      },
      abort: () => {
        if (settled) return;
        settled = true;
        gate.destroy();
      },
    };
  }

  private async startPty(
    session: ProcessSession,
    input: StartCommandInput,
    command: ShellCommand,
    gated: boolean,
  ): Promise<ProcessLaunchGate | undefined> {
    let nodePty: typeof import("node-pty");
    try {
      nodePty = await import("node-pty");
    } catch {
      throw new Error("PTY support requires the optional node-pty dependency.");
    }

    if (session.cancelRequested) {
      this.finish(session, undefined, "SIGTERM");
      return;
    }
    const targetEnvironment = processEnvironment({
      overrides: input.environment,
    });
    const gateToken = gated ? randomBytes(24).toString("base64url") : undefined;
    const readyToken = gateToken ? `devspace-ready-${randomBytes(24).toString("base64url")}` : undefined;
    const launchedToken = gateToken ? `devspace-launched-${randomBytes(24).toString("base64url")}` : undefined;
    const launchCommand = gateToken && readyToken && launchedToken
      ? gatedSupervisorCommand("pty", gateToken, readyToken, launchedToken)
      : command;
    let pty: import("node-pty").IPty;
    try {
      pty = nodePty.spawn(launchCommand.executable, launchCommand.args, {
        cwd: input.cwd,
        env: gated ? processLauncherEnvironment() : targetEnvironment,
        name: "xterm-256color",
        cols: session.columns,
        rows: session.rows,
      });
    } catch (error) {
      throw error;
    }

    session.process = {
      pid: pty.pid,
      ...(process.platform === "win32" ? {} : { processGroupId: pty.pid }),
      write: (data) => pty.write(data),
      kill: (signal = "SIGTERM") => terminateProcessTree(pty, signal, true),
      // Let the terminal driver deliver Ctrl-C to its foreground process group.
      interrupt: () => pty.write("\u0003"),
      treeAlive: () => isProcessTreeAlive(pty, true),
      resize: (columns, rows) => pty.resize(columns, rows),
    };
    let pendingOutput = "";
    let expectedHandshake = readyToken;
    let resolveHandshake = (): void => undefined;
    let rejectHandshake = (_error: Error): void => undefined;
    const handshakePromise = (): Promise<void> => new Promise<void>((resolve, reject) => {
      resolveHandshake = resolve;
      rejectHandshake = reject;
    });
    const ready = readyToken ? handshakePromise() : undefined;
    pty.onData((data) => {
      if (!expectedHandshake) {
        this.append(session, data);
        return;
      }
      pendingOutput += data;
      const markerOffset = pendingOutput.indexOf(expectedHandshake);
      if (markerOffset < 0) {
        const safeLength = Math.max(0, pendingOutput.length - expectedHandshake.length + 1);
        if (safeLength > 0) {
          this.append(session, pendingOutput.slice(0, safeLength));
          pendingOutput = pendingOutput.slice(safeLength);
        }
        return;
      }
      this.append(session, pendingOutput.slice(0, markerOffset));
      const trailing = pendingOutput.slice(markerOffset + expectedHandshake.length);
      pendingOutput = "";
      expectedHandshake = undefined;
      resolveHandshake();
      if (trailing) this.append(session, trailing);
    });
    pty.onExit(({ exitCode, signal }) => {
      if (expectedHandshake) {
        if (pendingOutput) this.append(session, pendingOutput);
        rejectHandshake(new Error("PTY launch gate exited before completing its handshake."));
      }
      this.finish(session, exitCode, signal === 0 ? undefined : String(signal));
    });
    if (session.cancelRequested) session.process.kill("SIGTERM");
    if (!gateToken || !launchedToken || !ready) return undefined;
    await ready;
    let settled = false;
    return {
      release: async () => {
        if (settled) return;
        settled = true;
        expectedHandshake = launchedToken;
        const launched = handshakePromise();
        const payload = Buffer.from(
          launchPayload(gateToken, command, targetEnvironment),
          "utf8",
        ).toString("base64");
        pty.write(`${payload}\n`);
        await launched;
      },
      abort: () => {
        if (settled) return;
        settled = true;
        pty.kill();
      },
    };
  }

  private closeProcessStdin(session: ProcessSession): void {
    if (session.stdinClosed) return;
    if (!session.process?.end) {
      throw new Error(`Process session ${session.id} stdin cannot be closed.`);
    }
    session.process.end();
    session.stdinClosed = true;
  }

  private finish(session: ProcessSession, exitCode?: number, signal?: string): void {
    if (!session.running || session.rootExited) return;
    session.rootExited = true;
    session.stdinClosed = true;
    session.exitCode = exitCode;
    session.signal = signal;
    session.treeExitPollMs = INITIAL_TREE_EXIT_POLL_MS;
    this.finishWhenTreeExits(session);
  }

  private finishWhenTreeExits(session: ProcessSession): void {
    if (!session.running) return;
    if (session.process?.treeAlive()) {
      const delay = session.treeExitPollMs;
      session.treeExitPollMs = nextTreeExitPollMs(delay);
      session.treeExitTimer = setTimeout(() => this.finishWhenTreeExits(session), delay);
      session.treeExitTimer.unref();
      return;
    }
    session.running = false;
    this.releaseWorkspaceRootLease(session);
    this.finalizeDurableOutput(session);
    const terminalType = session.cancelRequested
      ? "command.interrupted"
      : session.exitCode === 0 && !session.signal && !session.timedOut
        ? "command.completed"
        : "command.failed";
    this.emitActivity(session, terminalType, `command:${session.id}:terminal`, {
      summary: terminalType === "command.completed"
        ? "Command completed."
        : terminalType === "command.interrupted"
          ? "Command interrupted."
          : "Command failed.",
      sessionId: session.id,
      exitCode: session.exitCode,
      ...(session.signal ? { signal: session.signal } : {}),
      timedOut: session.timedOut,
      wallTimeMs: Date.now() - session.startedAt,
      outputId: session.outputId,
      ...this.durableMetadata(session),
    });
    session.resolveExit();
    if (session.runtimeTimer) clearTimeout(session.runtimeTimer);
    if (session.escalationTimer) clearTimeout(session.escalationTimer);
    if (session.treeExitTimer) clearTimeout(session.treeExitTimer);
    if (this.shuttingDown) return;
    session.cleanupTimer = setTimeout(
      () => this.sessions.delete(session.id),
      this.completedSessionTtlMs,
    );
    session.cleanupTimer.unref();
  }

  private append(session: ProcessSession, output: string): void {
    if (!output) return;
    const outputBytes = Buffer.byteLength(output, "utf8");
    session.totalOutputBytes += outputBytes;
    session.buffer.append(output);
    if (!this.outputStore || session.outputStorageError) return;
    if (session.durableQuotaReached) {
      session.quotaDroppedBytes += outputBytes;
      return;
    }
    session.pendingDurableOutput.push(output);
    session.pendingDurableOutputBytes += outputBytes;
    if (session.pendingDurableOutputBytes >= this.durableOutputFlushBytes) {
      this.flushDurableOutput(session);
      return;
    }
    if (!session.durableFlushTimer) {
      session.durableFlushTimer = setTimeout(() => {
        session.durableFlushTimer = undefined;
        this.flushDurableOutput(session);
      }, this.durableOutputFlushMs);
      session.durableFlushTimer.unref();
    }
  }

  private consume(session: ProcessSession, maxOutputTokens?: number): ProcessSnapshot {
    this.flushDurableOutput(session);
    const limit = boundedInteger(maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 100_000);
    const maxBytes = Math.max(256, limit * 4);
    const buffered = session.buffer.drain(maxBytes);
    // Codex reports original_token_count + output_omitted_bytes so the model
    // knows how much it lost. Approximate tokens at roughly four UTF-8 bytes.
    const originalTokenCount = Math.ceil(
      (Buffer.byteLength(buffered.output, "utf8") + buffered.omittedBytes) / 4,
    );
    const durable = this.durableMetadata(session);

    return {
      sessionId: session.running ? session.id : undefined,
      output: buffered.output,
      outputTruncated: buffered.truncated,
      running: session.running,
      exitCode: session.exitCode,
      signal: session.signal,
      wallTimeMs: Date.now() - session.startedAt,
      originalTokenCount,
      outputOmittedBytes: buffered.omittedBytes,
      outputId: session.outputId,
      totalOutputBytes: durable.totalBytes,
      storedOutputBytes: durable.storedBytes,
      droppedBytes: durable.droppedBytes,
      outputStorageError: session.outputStorageError,
      timedOut: session.timedOut,
      stdinClosed: session.stdinClosed,
      rootExited: session.rootExited,
      managedDaemon: session.running && session.rootExited,
      rootLeaseDetached: session.rootLeaseDetached,
    };
  }

  private flushDurableOutput(session: ProcessSession): void {
    if (session.durableFlushTimer) {
      clearTimeout(session.durableFlushTimer);
      session.durableFlushTimer = undefined;
    }
    if (session.pendingDurableOutputBytes === 0) return;
    const pending = session.pendingDurableOutput.join("");
    const pendingBytes = session.pendingDurableOutputBytes;
    session.pendingDurableOutput = [];
    session.pendingDurableOutputBytes = 0;
    if (!this.outputStore || session.outputStorageError) return;
    if (session.durableQuotaReached) {
      session.quotaDroppedBytes += pendingBytes;
      return;
    }
    try {
      session.outputId ??= this.outputStore.create({
        connectionPrincipalId: session.connectionPrincipalId,
        workspaceId: session.workspaceId,
      });
      this.outputStore.append(session.outputId, pending);
      const metadata = this.outputStore.metadata(
        session.connectionPrincipalId,
        session.workspaceId,
        session.outputId,
      );
      if (metadata.droppedBytes > 0) session.durableQuotaReached = true;
      this.emitActivity(
        session,
        "command.output_available",
        `command:${session.id}:output:${metadata.totalBytes}`,
        {
          summary: "Command output updated.",
          sessionId: session.id,
          outputId: session.outputId,
          nextOffset: metadata.storedBytes,
          totalBytes: metadata.totalBytes,
          storedBytes: metadata.storedBytes,
          droppedBytes: metadata.droppedBytes + session.quotaDroppedBytes,
          status: metadata.status,
        },
      );
    } catch (error) {
      if (error instanceof ProcessOutputQuotaError) {
        session.durableQuotaReached = true;
        session.quotaDroppedBytes += pendingBytes;
      } else {
        session.outputStorageError = "unavailable";
        this.onOutputStorageError?.(error, {
          connectionPrincipalId: session.connectionPrincipalId,
          workspaceId: session.workspaceId,
          outputId: session.outputId,
        });
      }
    }
  }

  private emitActivity(
    session: ProcessSession,
    type: ProcessActivityEvent["type"],
    eventKeySuffix: string,
    payload: Record<string, unknown>,
  ): void {
    if (!session.activity || !this.onActivity) return;
    try {
      this.onActivity({
        threadId: session.activity.threadId,
        operationId: session.activity.operationId,
        itemId: `command:${session.id}`,
        type,
        eventKey: `${session.activity.operationId}:${eventKeySuffix}`,
        payload,
      });
    } catch {
      // Activity reporting must never change process execution semantics.
    }
  }

  private finalizeDurableOutput(session: ProcessSession): void {
    this.flushDurableOutput(session);
    if (!this.outputStore || !session.outputId) return;
    try {
      this.outputStore.complete(session.outputId);
    } catch (error) {
      session.outputStorageError ??= error instanceof Error ? error.message : String(error);
    }
  }

  private durableMetadata(session: ProcessSession): {
    totalBytes: number;
    storedBytes: number;
    droppedBytes: number;
  } {
    if (!this.outputStore || !session.outputId) {
      return {
        totalBytes: session.totalOutputBytes,
        storedBytes: 0,
        droppedBytes: session.quotaDroppedBytes,
      };
    }
    try {
      const metadata = this.outputStore.metadata(
        session.connectionPrincipalId,
        session.workspaceId,
        session.outputId,
      );
      return {
        totalBytes: session.totalOutputBytes,
        storedBytes: metadata.storedBytes,
        droppedBytes: metadata.droppedBytes + session.quotaDroppedBytes,
      };
    } catch (error) {
      session.outputStorageError ??= error instanceof Error ? error.message : String(error);
      return {
        totalBytes: session.totalOutputBytes,
        storedBytes: 0,
        droppedBytes: session.quotaDroppedBytes,
      };
    }
  }

  private getOwnedSession(connectionPrincipalId: string, workspaceId: string, sessionId: number): ProcessSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw unknownProcessSessionError(sessionId);
    if (session.connectionPrincipalId !== connectionPrincipalId || session.workspaceId !== workspaceId) {
      throw unknownProcessSessionError(sessionId);
    }
    return session;
  }

  private removeSession(sessionId: number): void {
    const session = this.sessions.get(sessionId);
    if (session) this.releaseWorkspaceRootLease(session);
    if (session?.cleanupTimer) clearTimeout(session.cleanupTimer);
    if (session?.runtimeTimer) clearTimeout(session.runtimeTimer);
    if (session?.escalationTimer) clearTimeout(session.escalationTimer);
    if (session?.treeExitTimer) clearTimeout(session.treeExitTimer);
    if (session?.durableFlushTimer) clearTimeout(session.durableFlushTimer);
    this.sessions.delete(sessionId);
  }

  private releaseWorkspaceRootLease(session: ProcessSession): void {
    const release = session.releaseWorkspaceRootLease;
    session.releaseWorkspaceRootLease = undefined;
    release?.();
  }

  private resolveRuntimeLimitMs(requestedRuntimeMs: number | undefined): number {
    if (requestedRuntimeMs === undefined) return this.maxRuntimeMs;
    if (!Number.isInteger(requestedRuntimeMs) || requestedRuntimeMs < 1) {
      throw new Error("Command timeoutMs must be a positive integer.");
    }
    if (requestedRuntimeMs > this.maxRuntimeMs) {
      throw new Error(
        `Command timeoutMs ${requestedRuntimeMs} exceeds the global maximum ${this.maxRuntimeMs}ms.`,
      );
    }
    return requestedRuntimeMs;
  }

  private startRuntimeTimer(session: ProcessSession, runtimeMs: number): void {
    session.runtimeTimer = setTimeout(() => {
      if (!session.running) return;
      session.timedOut = true;
      this.append(session, `\nProcess exceeded the ${runtimeMs}ms runtime limit and was terminated.\n`);
      const error = this.killSession(session, "SIGTERM");
      if (error) this.append(session, `\nFailed to terminate timed-out process: ${String(error)}\n`);
      session.escalationTimer = setTimeout(() => {
        if (session.running) {
          const escalationError = this.killSession(session, "SIGKILL");
          if (escalationError) this.append(session, `\nFailed to force-kill timed-out process: ${String(escalationError)}\n`);
        }
      }, this.terminationGraceMs);
      session.escalationTimer.unref();
    }, runtimeMs);
    session.runtimeTimer.unref();
  }

  private async shutdownProcesses(): Promise<void> {
    this.shuttingDown = true;
    const running = Array.from(this.sessions.values()).filter((session) => session.running);
    for (const session of this.sessions.values()) {
      if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
      if (session.runtimeTimer) clearTimeout(session.runtimeTimer);
      if (session.escalationTimer) clearTimeout(session.escalationTimer);
      if (session.durableFlushTimer) {
        clearTimeout(session.durableFlushTimer);
        // Leaving the handle set would make append() believe a flush is still
        // scheduled, so output produced while we wait for the processes to die
        // would never be written.
        session.durableFlushTimer = undefined;
      }
    }
    const errors: unknown[] = [];
    for (const session of running) {
      const error = this.killSession(session, "SIGTERM");
      if (error) errors.push(error);
    }
    await this.waitForSessions(running, this.terminationGraceMs);
    const remaining = running.filter((session) => session.running);
    for (const session of remaining) {
      const error = this.killSession(session, "SIGKILL");
      if (error) errors.push(error);
    }
    if (remaining.length > 0) {
      await this.waitForSessions(remaining, this.terminationGraceMs);
    }
    // Persist buffered output before reporting survivors. An incomplete
    // shutdown is exactly when the retained log matters most, and throwing
    // first would discard it.
    for (const session of this.sessions.values()) this.flushDurableOutput(session);
    const survivors = running.filter((session) => session.running);
    if (survivors.length > 0) {
      errors.push(new Error(`Failed to terminate ${survivors.length} process session(s) during shutdown.`));
      throw new AggregateError(errors, "Process shutdown incomplete");
    }
    this.sessions.clear();
  }

  private killSession(session: ProcessSession, signal: NodeJS.Signals): unknown | undefined {
    try {
      session.process?.kill(signal);
      return undefined;
    } catch (error) {
      return error;
    }
  }

  private async terminateFailedStartup(session: ProcessSession): Promise<void> {
    session.cancelRequested = true;
    const terminationError = this.killSession(session, "SIGTERM");
    if (terminationError) {
      this.append(session, `\nFailed to terminate process after startup error: ${String(terminationError)}\n`);
    }
    await this.waitForSessions([session], this.terminationGraceMs);
    if (session.running) {
      const escalationError = this.killSession(session, "SIGKILL");
      if (escalationError) {
        this.append(session, `\nFailed to force-kill process after startup error: ${String(escalationError)}\n`);
      }
      await this.waitForSessions([session], this.terminationGraceMs);
    }
    if (session.running) {
      // The launch gate has already been aborted, so this can only be an inert
      // supervisor. Do not retain an undiscoverable session/root lease if the
      // OS refuses both termination attempts.
      this.append(
        session,
        "\nGated process launcher survived startup cleanup; hidden session state was released.\n",
      );
      session.running = false;
      session.stdinClosed = true;
      session.rootExited = true;
      this.finalizeDurableOutput(session);
      session.resolveExit();
    }
    this.removeSession(session.id);
  }

  private async waitForSessions(sessions: ProcessSession[], timeoutMs: number): Promise<void> {
    if (sessions.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all(sessions.map((session) => session.exitPromise)).then(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function positiveBoundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const effective = value ?? fallback;
  if (!Number.isSafeInteger(effective) || effective < 1 || effective > maximum) {
    throw new RangeError(`${label} must be an integer between 1 and ${maximum}.`);
  }
  return effective;
}

function unknownProcessSessionError(_sessionId: number): Error {
  return new UnknownProcessSessionError();
}

function releaseOnce(release: () => void): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

function workspaceRootLease(
  lease: WorkspaceRootLease | (() => void),
): WorkspaceRootLease | undefined {
  const candidate = lease as Partial<WorkspaceRootLease>;
  return typeof candidate.attachProcess === "function" &&
      typeof candidate.heartbeat === "function" &&
      typeof candidate.release === "function"
    ? lease as WorkspaceRootLease
    : undefined;
}

function childSpawned(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    const spawned = (): void => {
      child.off("error", failed);
      resolve();
    };
    const failed = (error: Error): void => {
      child.off("spawn", spawned);
      reject(error);
    };
    child.once("spawn", spawned);
    child.once("error", failed);
  });
}

function gatedSupervisorCommand(
  mode: "pipe" | "pty",
  gateToken: string,
  readyToken?: string,
  launchedToken?: string,
): ShellCommand {
  return {
    executable: process.execPath,
    args: [
      "-e",
      GATED_PROCESS_SUPERVISOR_SOURCE,
      mode,
      gateToken,
      ...(readyToken ? [readyToken] : []),
      ...(launchedToken ? [launchedToken] : []),
    ],
  };
}

function launchPayload(
  token: string,
  command: ShellCommand,
  environment: Record<string, string>,
): string {
  return JSON.stringify({
    token,
    executable: command.executable,
    args: command.args,
    environment,
  });
}

const GATED_PROCESS_SUPERVISOR_SOURCE = [
  "\"use strict\";",
  "const fs=require('node:fs');",
  "const {spawn}=require('node:child_process');",
  "const mode=process.argv[1];",
  "const expectedToken=process.argv[2];",
  "const readyToken=process.argv[3];",
  "const launchedToken=process.argv[4];",
  "function fail(message){if(message)process.stderr.write(message+'\\n');process.exit(125);}",
  "function start(source){",
  " let spec;",
  " try{spec=JSON.parse(source);}catch{fail('Invalid process launch payload.');}",
  " if(!spec||spec.token!==expectedToken||typeof spec.executable!=='string'||",
  "    !Array.isArray(spec.args)||!spec.args.every(value=>typeof value==='string')||",
  "    !spec.environment||typeof spec.environment!=='object'){fail('Invalid process launch payload.');}",
  " if(mode==='pty'&&process.stdin.setRawMode)process.stdin.setRawMode(false);",
  " const child=spawn(spec.executable,spec.args,{stdio:'inherit',env:spec.environment,windowsHide:true});",
  " child.once('spawn',()=>{if(mode==='pty')process.stdout.write(launchedToken);});",
  " child.once('error',error=>{process.stderr.write(error.message+'\\n');process.exit(127);});",
  " child.once('exit',(code,signal)=>{",
  "  if(signal){try{process.kill(process.pid,signal);}catch{process.exit(1);}}",
  "  else process.exit(code??1);",
  " });",
  "}",
  "if(mode==='pipe'){",
  " let source;",
  " try{source=fs.readFileSync(3,'utf8');}catch{process.exit(125);}",
  " if(!source)process.exit(125);",
  " start(source);",
  "}else if(mode==='pty'){",
  " if(process.stdin.setRawMode)process.stdin.setRawMode(true);",
  " process.stdin.setEncoding('utf8');",
  " let source='';",
  " const receive=chunk=>{",
  "  source+=chunk;",
  "  const newline=source.indexOf('\\n');",
  "  if(newline<0)return;",
  "  process.stdin.off('data',receive);process.stdin.pause();",
  "  let decoded;",
  "  try{decoded=Buffer.from(source.slice(0,newline),'base64').toString('utf8');}",
  "  catch{fail('Invalid process launch payload.');}",
  "  start(decoded);",
  " };",
  " process.stdin.on('data',receive);",
  " process.stdout.write(readyToken);",
  "}else fail('Invalid process launch mode.');",
].join("");
