import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { resolveShellCommand, terminateProcessTree } from "./process-platform.js";
import { ProcessOutputQuotaError, type ProcessOutputStore } from "./process-output-store.js";
import { tokenizeSegment, unwrapCommandWrappers } from "./command-policy.js";
import {
  delegatedCommandPayloads,
  isShellAnalysisLimitError,
  splitShellSegments,
} from "./shell-command-analysis.js";

const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_INTERACTIVE_YIELD_MS = 250;
const DEFAULT_POLL_YIELD_MS = 5_000;
// Allow long foreground waits (Claude Code default timeout is 2 minutes;
// max is 10 minutes). Background/session mode still returns early via yieldTimeMs=0.
const MAX_COMMAND_YIELD_MS = 600_000;
const MAX_POLL_YIELD_MS = 110_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const DEFAULT_BUFFER_BYTES = 1024 * 1024;
const COMPLETED_SESSION_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
export const MAX_PROCESS_INPUT_BYTES = 1024 * 1024;

export interface StartCommandInput {
  ownerClientId: string;
  workspaceId: string;
  command: string;
  cwd: string;
  workspaceRoot?: string;
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
}

export interface PreparedProcessInput {
  expectedRevision: number;
  pendingInput: string;
  charsToWrite: string;
  nextCwd: string;
  instructionScopePaths: string[];
}

export interface WriteStdinInput {
  ownerClientId: string;
  workspaceId: string;
  sessionId: number;
  chars?: string;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
  closeStdin?: boolean;
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
  write(data: string): void;
  end?(): void;
  kill(signal?: NodeJS.Signals): void;
  resize?(columns: number, rows: number): void;
}

interface ProcessSession {
  id: number;
  ownerClientId: string;
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
  timedOut: boolean;
  cancelRequested: boolean;
  outputId?: string;
  totalOutputBytes: number;
  quotaDroppedBytes: number;
  durableQuotaReached: boolean;
  outputStorageError?: string;
}

export interface ProcessSessionManagerOptions {
  maxBufferBytes?: number;
  /** @deprecated Use maxBufferBytes. Kept for internal callers during migration. */
  maxBufferCharacters?: number;
  completedSessionTtlMs?: number;
  maxSessions?: number;
  maxSessionsPerClient?: number;
  maxSessionsPerWorkspace?: number;
  maxRuntimeMs?: number;
  terminationGraceMs?: number;
  outputStore?: ProcessOutputStore;
  onOutputStorageError?: (
    error: unknown,
    context: { ownerClientId: string; workspaceId: string; outputId?: string },
  ) => void;
}

export interface ProcessSessionUsageSnapshot {
  sessions: number;
  running: number;
  limit: number;
  owner?: {
    sessions: number;
    running: number;
    limit: number;
  };
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

function workspaceKey(ownerClientId: string, workspaceId: string): string {
  return `${ownerClientId}\u0000${workspaceId}`;
}

export function isInteractiveShellCommand(command: string, depth = 0): boolean {
  if (depth > 8) return true;
  try {
    for (const segment of splitShellSegments(command)) {
      const tokens = tokenizeSegment(segment);
      if (directShellReadsStdin(tokens)) return true;
      for (const payload of delegatedCommandPayloads(tokens)) {
        if (isInteractiveShellCommand(payload, depth + 1)) return true;
      }
    }
    return false;
  } catch (error) {
    if (isShellAnalysisLimitError(error)) return true;
    throw error;
  }
}

function directShellReadsStdin(tokens: string[]): boolean {
  const words = unwrapCommandWrappers(tokens);
  const executable = words.shift()?.split("/").at(-1);
  if (!executable || !["sh", "bash", "zsh", "dash", "ksh", "fish"].includes(executable)) {
    return false;
  }

  let readsStdin = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === "--" || (executable === "zsh" && word === "-b")) {
      return readsStdin || index + 1 === words.length;
    }
    if (word === "-") {
      readsStdin = true;
      continue;
    }
    if (!word.startsWith("-") && !word.startsWith("+")) return readsStdin;

    const option = shellInvocationOption(executable, word);
    if (option === "command") {
      // A missing command operand is malformed and therefore ambiguous. Treat
      // it as shell input so any supplied stdin still receives shell checks.
      return words[index + 1] === undefined;
    }
    if (option === "command-inline") return false;
    if (option === "stdin") {
      readsStdin = true;
      continue;
    }
    if (option === "value") {
      if (words[index + 1] === undefined) return true;
      index += 1;
      continue;
    }
    if (option === "flag") continue;

    // Unknown invocation options may consume the following word. Fail closed
    // instead of mistaking that operand for a script file.
    return true;
  }
  return true;
}

type ShellInvocationOption = "command" | "command-inline" | "stdin" | "value" | "flag" | "unknown";

function shellInvocationOption(shell: string, option: string): ShellInvocationOption {
  if (option.startsWith("--command=")) return "command-inline";
  if (option === "-c" || option === "--command") return "command";
  if (option === "-s" || option === "--stdin") return "stdin";

  if (shell === "fish") {
    if (["-C", "--init-command", "-d", "--debug", "-D", "--debug-output", "--features", "--profile", "--profile-startup"].includes(option)) {
      return "value";
    }
    if (/^--(?:init-command|debug|debug-output|features|profile|profile-startup)=/u.test(option)) {
      return "flag";
    }
    if (["-i", "-l", "-N", "-n", "-P", "--interactive", "--login", "--no-config", "--no-execute", "--private", "--version", "--help"].includes(option)) {
      return "flag";
    }
    return "unknown";
  }

  if (option === "-o" || option === "+o" || (shell === "bash" && (option === "-O" || option === "+O"))) {
    return "value";
  }
  if (shell === "bash" && ["--init-file", "--rcfile"].includes(option)) return "value";
  if (shell === "bash" && /^--(?:init-file|rcfile)=/u.test(option)) return "flag";
  if (shell === "ksh" && option === "-R") return "value";

  if (option.startsWith("--")) {
    if (shell === "zsh") return "flag";
    if ([
      "--debug", "--debugger", "--dump-po-strings", "--dump-strings", "--help", "--login",
      "--noediting", "--noprofile", "--norc", "--posix", "--pretty-print", "--protected",
      "--restricted", "--verbose", "--version", "--wordexp",
    ].includes(option)) return "flag";
    return "unknown";
  }

  if (/^-[^-]+/u.test(option)) {
    const flags = option.slice(1);
    if (flags.includes("c")) return "command";
    if (flags.includes("s")) return "stdin";
    const knownFlags = shell === "bash"
      ? /^[abefhiklmnprtuvxBCHPD]+$/u
      : shell === "zsh"
        ? /^[dfilnrsuvx]+$/u
        : shell === "ksh"
          ? /^[abefhiklmnprstuvxBCEG]+$/u
          : /^[abCefhimnuvx]+$/u;
    return knownFlags.test(flags) ? "flag" : "unknown";
  }
  if (/^\+[^+]+/u.test(option)) return "flag";
  return "unknown";
}

function processEnvironment(input?: {
  workspaceId?: string;
  workspaceRoot?: string;
}): Record<string, string> {
  const environment: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    NO_COLOR: "1",
    TERM: "dumb",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GH_PAGER: "cat",
    CODEX_CI: "1",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    ...(input?.workspaceId ? { DEVSPACE_WORKSPACE_ID: input.workspaceId } : {}),
    ...(input?.workspaceRoot ? { DEVSPACE_WORKSPACE_ROOT: input.workspaceRoot } : {}),
  };
  // CDPATH changes the destination of an otherwise literal relative `cd`,
  // which would invalidate the instruction-scope check performed before spawn.
  delete environment.CDPATH;
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
  private readonly maxSessionsPerClient: number;
  private readonly maxSessionsPerWorkspace: number;
  private readonly maxRuntimeMs: number;
  private readonly terminationGraceMs: number;
  private readonly outputStore?: ProcessOutputStore;
  private readonly onOutputStorageError?: ProcessSessionManagerOptions["onOutputStorageError"];
  private nextSessionId = 1;
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;
  private readonly closingWorkspaces = new Set<string>();

  constructor(options: ProcessSessionManagerOptions = {}) {
    this.maxBufferBytes = options.maxBufferBytes ?? options.maxBufferCharacters ?? DEFAULT_BUFFER_BYTES;
    this.completedSessionTtlMs = options.completedSessionTtlMs ?? COMPLETED_SESSION_TTL_MS;
    this.maxSessions = options.maxSessions ?? Number.POSITIVE_INFINITY;
    this.maxSessionsPerClient = options.maxSessionsPerClient ?? Number.POSITIVE_INFINITY;
    this.maxSessionsPerWorkspace = options.maxSessionsPerWorkspace ?? Number.POSITIVE_INFINITY;
    this.maxRuntimeMs = options.maxRuntimeMs ?? 60 * 60 * 1_000;
    this.terminationGraceMs = options.terminationGraceMs ?? 5_000;
    this.outputStore = options.outputStore;
    this.onOutputStorageError = options.onOutputStorageError;
  }

  async start(input: StartCommandInput): Promise<ProcessSnapshot> {
    if (this.shuttingDown) throw new Error("Process manager is shutting down.");
    if (this.closingWorkspaces.has(workspaceKey(input.ownerClientId, input.workspaceId))) {
      throw new Error("Workspace is closing and cannot start new processes.");
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`Process session limit reached (${this.maxSessions}).`);
    }
    const clientSessions = Array.from(this.sessions.values()).filter(
      (session) => session.ownerClientId === input.ownerClientId,
    ).length;
    if (clientSessions >= this.maxSessionsPerClient) {
      throw new Error(`Process session limit reached for this OAuth client (${this.maxSessionsPerClient}).`);
    }
    const workspaceSessions = Array.from(this.sessions.values()).filter(
      (session) => session.ownerClientId === input.ownerClientId && session.workspaceId === input.workspaceId,
    ).length;
    if (workspaceSessions >= this.maxSessionsPerWorkspace) {
      throw new Error(`Process session limit reached for this workspace (${this.maxSessionsPerWorkspace}).`);
    }
    const runtimeLimitMs = this.resolveRuntimeLimitMs(input.runtimeLimitMs);
    assertProcessInputSize(input.stdin);
    const closeStdin = input.closeStdin ?? input.stdin !== undefined;
    if (input.tty && closeStdin) {
      throw new Error("PTY stdin cannot be closed reliably. Set closeStdin=false or run without tty.");
    }
    const session = this.createSession(input);
    this.sessions.set(session.id, session);

    try {
      if (input.tty && process.platform !== "win32") await this.startPty(session, input);
      else this.startPipe(session, input);
      this.startRuntimeTimer(session, runtimeLimitMs);
      if (input.stdin) session.process?.write(input.stdin);
      if (closeStdin) this.closeProcessStdin(session);
    } catch (error) {
      session.process?.kill("SIGTERM");
      this.finalizeDurableOutput(session);
      this.sessions.delete(session.id);
      throw error;
    }

    const yieldTimeMs = boundedInteger(input.yieldTimeMs, DEFAULT_EXEC_YIELD_MS, MAX_COMMAND_YIELD_MS);
    await this.waitForExit(session, yieldTimeMs);

    const snapshot = this.consume(session, input.maxOutputTokens);
    if (!session.running) this.removeSession(session.id);
    return snapshot;
  }

  async write(input: WriteStdinInput): Promise<ProcessSnapshot> {
    const session = this.getOwnedSession(input.ownerClientId, input.workspaceId, input.sessionId);
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
      throw new Error("Send Ctrl-C and closeStdin in separate write_stdin calls.");
    }
    if (session.stdinClosed && chars.length > 0) {
      throw new Error(`Process session ${session.id} stdin is already closed.`);
    }
    if (input.closeStdin && !session.process?.end) {
      throw new Error(`Process session ${session.id} is a PTY and its stdin cannot be closed reliably.`);
    }
    const interactionRequested =
      (input.chars ?? "").length > 0 || input.closeStdin === true ||
      input.columns !== undefined || input.rows !== undefined;

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
      session.process?.kill("SIGINT");
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

  instructionContext(
    ownerClientId: string,
    workspaceId: string,
    sessionId: number,
  ): ProcessInstructionContext {
    const session = this.getOwnedSession(ownerClientId, workspaceId, sessionId);
    return {
      cwd: session.cwd,
      scopePaths: [...session.instructionScopePaths],
      inputMode: session.instructionInputMode,
      pendingInput: session.pendingInput,
      inputRevision: session.inputRevision,
      stdinClosed: session.stdinClosed,
    };
  }

  terminate(ownerClientId: string, workspaceId: string, sessionId: number): void {
    const session = this.getOwnedSession(ownerClientId, workspaceId, sessionId);
    if (session.running) session.process?.kill("SIGTERM");
  }

  async terminateWorkspace(ownerClientId: string, workspaceId: string): Promise<number> {
    this.closingWorkspaces.add(workspaceKey(ownerClientId, workspaceId));
    const sessions = Array.from(this.sessions.values()).filter(
      (session) => session.running && session.ownerClientId === ownerClientId && session.workspaceId === workspaceId,
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
      this.reopenWorkspace(ownerClientId, workspaceId);
      errors.push(new Error(`Failed to terminate ${survivors.length} process session(s).`));
      throw new AggregateError(errors, "Workspace processes could not be terminated");
    }
    return sessions.length;
  }

  blockWorkspace(ownerClientId: string, workspaceId: string): void {
    this.closingWorkspaces.add(workspaceKey(ownerClientId, workspaceId));
  }

  hasActive(ownerClientId: string, workspaceId: string): boolean {
    return Array.from(this.sessions.values()).some(
      (session) => session.running && session.ownerClientId === ownerClientId && session.workspaceId === workspaceId,
    );
  }

  usageSnapshot(ownerClientId?: string): ProcessSessionUsageSnapshot {
    const sessions = Array.from(this.sessions.values());
    return {
      sessions: sessions.length,
      running: sessions.filter((session) => session.running).length,
      limit: this.maxSessions,
      ...(ownerClientId === undefined ? {} : {
        owner: {
          sessions: sessions.filter((session) => session.ownerClientId === ownerClientId).length,
          running: sessions.filter(
            (session) => session.ownerClientId === ownerClientId && session.running,
          ).length,
          limit: this.maxSessionsPerClient,
        },
      }),
    };
  }

  flushOutput(ownerClientId: string, workspaceId: string, outputId: string): void {
    const session = Array.from(this.sessions.values()).find(
      (candidate) =>
        candidate.outputId === outputId &&
        candidate.ownerClientId === ownerClientId &&
        candidate.workspaceId === workspaceId,
    );
    if (session) this.flushDurableOutput(session);
  }

  reopenWorkspace(ownerClientId: string, workspaceId: string): void {
    this.closingWorkspaces.delete(workspaceKey(ownerClientId, workspaceId));
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
      ownerClientId: input.ownerClientId,
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
      startedAt: Date.now(),
      columns: terminalSize(input.columns, DEFAULT_COLUMNS),
      rows: terminalSize(input.rows, DEFAULT_ROWS),
      buffer: new HeadTailBuffer(this.maxBufferBytes),
      running: true,
      timedOut: false,
      cancelRequested: false,
      exitPromise,
      resolveExit,
    };
  }

  private startPipe(session: ProcessSession, input: StartCommandInput): void {
    const shell = resolveShellCommand(input.command);
    const detached = process.platform !== "win32";
    // Spawn the resolved shell with its args directly. Using Node's
    // `shell: executable` form drops custom args (e.g. -c) and re-wraps the
    // command inconsistently with the PTY path.
    const child = spawn(shell.executable, shell.args, {
      cwd: input.cwd,
      env: processEnvironment({
        workspaceId: input.workspaceId,
        workspaceRoot: input.workspaceRoot,
      }),
      stdio: "pipe",
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

    session.process = {
      write: (data) => {
        child.stdin?.write(data);
      },
      end: () => {
        child.stdin?.end();
      },
      kill: (signal = "SIGTERM") => terminateProcessTree(child, signal, detached),
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
    if (session.cancelRequested) session.process.kill("SIGTERM");
  }

  private async startPty(session: ProcessSession, input: StartCommandInput): Promise<void> {
    let nodePty: typeof import("node-pty");
    try {
      nodePty = await import("node-pty");
    } catch {
      throw new Error("PTY support requires the optional node-pty dependency.");
    }

    const shell = resolveShellCommand(input.command);
    if (session.cancelRequested) {
      this.finish(session, undefined, "SIGTERM");
      return;
    }
    let pty: import("node-pty").IPty;
    try {
      pty = nodePty.spawn(shell.executable, shell.args, {
        cwd: input.cwd,
        env: processEnvironment({
          workspaceId: input.workspaceId,
          workspaceRoot: input.workspaceRoot,
        }),
        name: "xterm-256color",
        cols: session.columns,
        rows: session.rows,
      });
    } catch (error) {
      throw error;
    }

    session.process = {
      write: (data) => pty.write(data),
      kill: (signal) => pty.kill(signal),
      resize: (columns, rows) => pty.resize(columns, rows),
    };
    pty.onData((data) => this.append(session, data));
    pty.onExit(({ exitCode, signal }) => {
      this.finish(session, exitCode, signal === 0 ? undefined : String(signal));
    });
    if (session.cancelRequested) session.process.kill("SIGTERM");
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
    if (!session.running) return;
    session.running = false;
    session.stdinClosed = true;
    session.exitCode = exitCode;
    session.signal = signal;
    this.finalizeDurableOutput(session);
    session.resolveExit();
    if (session.runtimeTimer) clearTimeout(session.runtimeTimer);
    if (session.escalationTimer) clearTimeout(session.escalationTimer);
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
    try {
      session.outputId ??= this.outputStore.create({
        ownerClientId: session.ownerClientId,
        workspaceId: session.workspaceId,
      });
      this.outputStore.append(session.outputId, output);
    } catch (error) {
      if (error instanceof ProcessOutputQuotaError) {
        session.durableQuotaReached = true;
        session.quotaDroppedBytes += outputBytes;
      } else {
        session.outputStorageError = "unavailable";
        this.onOutputStorageError?.(error, {
          ownerClientId: session.ownerClientId,
          workspaceId: session.workspaceId,
          outputId: session.outputId,
        });
      }
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
    };
  }

  private flushDurableOutput(session: ProcessSession): void {
    // Output chunks are persisted as they arrive. This method remains as the
    // synchronization point used before snapshots and read_process_output.
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
        session.ownerClientId,
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

  private getOwnedSession(ownerClientId: string, workspaceId: string, sessionId: number): ProcessSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw unknownProcessSessionError(sessionId);
    if (session.ownerClientId !== ownerClientId || session.workspaceId !== workspaceId) {
      throw unknownProcessSessionError(sessionId);
    }
    return session;
  }

  private removeSession(sessionId: number): void {
    const session = this.sessions.get(sessionId);
    if (session?.cleanupTimer) clearTimeout(session.cleanupTimer);
    if (session?.runtimeTimer) clearTimeout(session.runtimeTimer);
    if (session?.escalationTimer) clearTimeout(session.escalationTimer);
    this.sessions.delete(sessionId);
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

function unknownProcessSessionError(_sessionId: number): Error {
  return new UnknownProcessSessionError();
}
