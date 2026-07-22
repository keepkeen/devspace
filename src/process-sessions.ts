import { spawn } from "node:child_process";
import { resolveShellCommand, terminateProcessTree } from "./process-platform.js";

const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_INTERACTIVE_YIELD_MS = 250;
const DEFAULT_POLL_YIELD_MS = 5_000;
// Allow long foreground waits (Claude Code default timeout is 2 minutes;
// max is 10 minutes). Background/session mode still returns early via yieldTimeMs=0.
const MAX_COMMAND_YIELD_MS = 600_000;
const MAX_POLL_YIELD_MS = 110_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const DEFAULT_BUFFER_CHARACTERS = 1_000_000;
const COMPLETED_SESSION_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

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
  timedOut: boolean;
}

interface ManagedProcess {
  write(data: string): void;
  kill(signal?: NodeJS.Signals): void;
  resize?(columns: number, rows: number): void;
}

interface ProcessSession {
  id: number;
  ownerClientId: string;
  workspaceId: string;
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
}

export interface ProcessSessionManagerOptions {
  maxBufferCharacters?: number;
  completedSessionTtlMs?: number;
  maxSessions?: number;
  maxSessionsPerClient?: number;
  maxSessionsPerWorkspace?: number;
  maxRuntimeMs?: number;
  terminationGraceMs?: number;
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

function workspaceKey(ownerClientId: string, workspaceId: string): string {
  return `${ownerClientId}\u0000${workspaceId}`;
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

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function sliceCodePoints(value: string, start: number, end?: number): string {
  return Array.from(value).slice(start, end).join("");
}

function takeHead(value: string, count: number): string {
  if (count <= 0) return "";
  return sliceCodePoints(value, 0, count);
}

function takeTail(value: string, count: number): string {
  if (count <= 0) return "";
  const characters = Array.from(value);
  return characters.slice(Math.max(0, characters.length - count)).join("");
}

function splitBudget(maxCharacters: number): { head: number; tail: number } {
  return {
    head: Math.ceil(maxCharacters / 2),
    tail: Math.floor(maxCharacters / 2),
  };
}

function formatHeadTail(head: string, tail: string, omittedCharacters: number): string {
  if (omittedCharacters <= 0) return head + tail;
  return `${head}\n... output truncated (${omittedCharacters} characters omitted) ...\n${tail}`;
}

export class HeadTailBuffer {
  private head = "";
  private tail = "";
  private totalCharacters = 0;

  constructor(private readonly maxCharacters: number) {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Head/tail buffer limit must be a positive integer.");
    }
  }

  append(output: string): void {
    if (!output) return;

    const previousTotal = this.totalCharacters;
    this.totalCharacters += codePointLength(output);

    if (this.totalCharacters <= this.maxCharacters) {
      this.head += output;
      return;
    }

    const budget = splitBudget(this.maxCharacters);
    if (previousTotal <= this.maxCharacters) {
      const fullOutput = this.head + output;
      this.head = takeHead(fullOutput, budget.head);
      this.tail = takeTail(fullOutput, budget.tail);
      return;
    }

    this.tail = takeTail(this.tail + output, budget.tail);
  }

  hasOutput(): boolean {
    return this.totalCharacters > 0;
  }

  drain(maxCharacters: number): { output: string; truncated: boolean; omittedCharacters: number } {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Output limit must be a positive integer.");
    }

    const omittedByBuffer = Math.max(
      0,
      this.totalCharacters - codePointLength(this.head) - codePointLength(this.tail),
    );
    const retained = formatHeadTail(this.head, this.tail, omittedByBuffer);
    const output = truncateOutput(retained, maxCharacters);
    const truncated = omittedByBuffer > 0 || output.truncated;
    const omittedCharacters = omittedByBuffer + (output.truncated ? output.omittedCharacters : 0);

    this.head = "";
    this.tail = "";
    this.totalCharacters = 0;

    return { output: output.output, truncated, omittedCharacters };
  }
}

function truncateOutput(output: string, maxCharacters: number): {
  output: string;
  truncated: boolean;
  omittedCharacters: number;
} {
  const outputCharacters = codePointLength(output);
  if (outputCharacters <= maxCharacters) return { output, truncated: false, omittedCharacters: 0 };

  const marker = "\n... output truncated ...\n";
  const markerCharacters = codePointLength(marker);
  const available = Math.max(0, maxCharacters - markerCharacters);
  const budget = splitBudget(available);
  const omittedCharacters = Math.max(0, outputCharacters - maxCharacters);
  return {
    output: takeHead(output, budget.head) + marker + takeTail(output, budget.tail),
    truncated: true,
    omittedCharacters,
  };
}

export class ProcessSessionManager {
  private readonly sessions = new Map<number, ProcessSession>();
  private readonly maxBufferCharacters: number;
  private readonly completedSessionTtlMs: number;
  private readonly maxSessions: number;
  private readonly maxSessionsPerClient: number;
  private readonly maxSessionsPerWorkspace: number;
  private readonly maxRuntimeMs: number;
  private readonly terminationGraceMs: number;
  private nextSessionId = 1;
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;
  private readonly closingWorkspaces = new Set<string>();

  constructor(options: ProcessSessionManagerOptions = {}) {
    this.maxBufferCharacters = options.maxBufferCharacters ?? DEFAULT_BUFFER_CHARACTERS;
    this.completedSessionTtlMs = options.completedSessionTtlMs ?? COMPLETED_SESSION_TTL_MS;
    this.maxSessions = options.maxSessions ?? Number.POSITIVE_INFINITY;
    this.maxSessionsPerClient = options.maxSessionsPerClient ?? Number.POSITIVE_INFINITY;
    this.maxSessionsPerWorkspace = options.maxSessionsPerWorkspace ?? Number.POSITIVE_INFINITY;
    this.maxRuntimeMs = options.maxRuntimeMs ?? 60 * 60 * 1_000;
    this.terminationGraceMs = options.terminationGraceMs ?? 5_000;
  }

  async start(input: StartCommandInput): Promise<ProcessSnapshot> {
    if (this.shuttingDown) throw new Error("Process manager is shutting down.");
    if (this.closingWorkspaces.has(workspaceKey(input.ownerClientId, input.workspaceId))) {
      throw new Error("Workspace is closing and cannot start new processes.");
    }
    this.reapCompletedSessions();
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
    const session = this.createSession(input);
    this.sessions.set(session.id, session);

    try {
      if (input.tty && process.platform !== "win32") await this.startPty(session, input);
      else this.startPipe(session, input);
      this.startRuntimeTimer(session, input.runtimeLimitMs);
    } catch (error) {
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
    const chars = input.chars ?? "";
    const interactionRequested =
      chars.length > 0 || input.columns !== undefined || input.rows !== undefined;

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
    if (writableChars && session.running) session.process?.write(writableChars);

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
      startedAt: Date.now(),
      columns: terminalSize(input.columns, DEFAULT_COLUMNS),
      rows: terminalSize(input.rows, DEFAULT_ROWS),
      buffer: new HeadTailBuffer(this.maxBufferCharacters),
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

    session.process = {
      write: (data) => {
        child.stdin?.write(data);
      },
      kill: (signal = "SIGTERM") => terminateProcessTree(child, signal, detached),
      resize: input.tty ? () => undefined : undefined,
    };
    child.stdout?.on("data", (data: Buffer) => this.append(session, data.toString("utf8")));
    child.stderr?.on("data", (data: Buffer) => this.append(session, data.toString("utf8")));
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

  private finish(session: ProcessSession, exitCode?: number, signal?: string): void {
    if (!session.running) return;
    session.running = false;
    session.exitCode = exitCode;
    session.signal = signal;
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
    session.buffer.append(output);
  }

  private consume(session: ProcessSession, maxOutputTokens?: number): ProcessSnapshot {
    const limit = boundedInteger(maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 100_000);
    const maxCharacters = Math.max(256, limit * 4);
    const buffered = session.buffer.drain(maxCharacters);
    // Codex reports original_token_count + output_omitted_bytes so the model
    // knows how much it lost. Approximate tokens at ~4 chars each; omitted bytes
    // are character-count based (close enough for codepoints vs bytes).
    const totalCharacters = codePointLength(buffered.output) + buffered.omittedCharacters;
    const originalTokenCount = Math.ceil(totalCharacters / 4);

    return {
      sessionId: session.running ? session.id : undefined,
      output: buffered.output,
      outputTruncated: buffered.truncated,
      running: session.running,
      exitCode: session.exitCode,
      signal: session.signal,
      wallTimeMs: Date.now() - session.startedAt,
      originalTokenCount,
      outputOmittedBytes: buffered.omittedCharacters,
      timedOut: session.timedOut,
    };
  }

  private getOwnedSession(ownerClientId: string, workspaceId: string, sessionId: number): ProcessSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown process session: ${sessionId}`);
    if (session.ownerClientId !== ownerClientId || session.workspaceId !== workspaceId) {
      throw new Error(`Unknown process session: ${sessionId}`);
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

  private reapCompletedSessions(): void {
    for (const [sessionId, session] of this.sessions) {
      if (!session.running) this.removeSession(sessionId);
    }
  }

  private startRuntimeTimer(session: ProcessSession, requestedRuntimeMs: number | undefined): void {
    const runtimeMs = requestedRuntimeMs === undefined
      ? this.maxRuntimeMs
      : Math.min(boundedInteger(requestedRuntimeMs, this.maxRuntimeMs, this.maxRuntimeMs), this.maxRuntimeMs);
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
