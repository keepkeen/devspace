import {
  BASH_DEFAULT_TIMEOUT_SECONDS,
  BASH_MAX_TIMEOUT_SECONDS,
} from "./bash-prompt.js";
import {
  isInteractiveShellCommand,
  type ProcessSessionManager,
  type ProcessSnapshot,
} from "./process-sessions.js";
import { classifyCommand, type CommandPolicyResult } from "./command-policy.js";
import { validateShellWriteTargets } from "./shell-write-targets.js";
import type { Workspace, WorkspaceRegistry } from "./workspaces.js";

export interface BashToolInput {
  command: string;
  description?: string;
  workingDirectory?: string;
  /** Timeout in seconds. Defaults to 120, max 600. */
  timeout?: number;
  /** When true, return a sessionId quickly so the model can poll with write_stdin. */
  runInBackground?: boolean;
  maxOutputTokens?: number;
  /** Initial standard input. When provided, stdin is closed by default after writing. */
  stdin?: string;
  closeStdin?: boolean;
}

export interface BashToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  snapshot: ProcessSnapshot;
  cwd: string;
  description?: string;
  command: string;
  /** When a command-policy denied the command, the denial details. */
  policy?: CommandPolicyResult;
}

export function resolveBashTimeoutSeconds(timeout: number | undefined): number {
  if (timeout === undefined) return BASH_DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(
      `timeout must be a positive number of seconds (max ${BASH_MAX_TIMEOUT_SECONDS}).`,
    );
  }
  return Math.min(Math.floor(timeout), BASH_MAX_TIMEOUT_SECONDS);
}

function formatBashResultText(snapshot: ProcessSnapshot, options: {
  runInBackground: boolean;
  writeStdinTool: string;
  readProcessOutputTool: string;
}): string {
  const parts: string[] = [];
  if (snapshot.output) {
    parts.push(snapshot.output.replace(/\n$/, ""));
  }

  if (snapshot.running) {
    const session = snapshot.sessionId ?? "unknown";
    parts.push(
      options.runInBackground
        ? `Command is running in the background with session ID ${session}. Use ${options.writeStdinTool} with this sessionId to poll output, send input, or send Ctrl-C (\\u0003). You will not be auto-notified; poll when you need the result.`
        : `Command is still running with session ID ${session} after the wait window. Use ${options.writeStdinTool} to poll, send input, or send Ctrl-C (\\u0003).`,
    );
    if (snapshot.outputId) {
      parts.push(`Durable output ID: ${snapshot.outputId}.`);
    }
  } else if (snapshot.signal) {
    parts.push(`Process exited after signal ${snapshot.signal}.`);
  } else if (snapshot.exitCode !== undefined && snapshot.exitCode !== 0) {
    parts.push(`Command exited with code ${snapshot.exitCode}.`);
  } else if (!snapshot.output) {
    parts.push("(no output)");
  }

  if (snapshot.outputTruncated) {
    const omitted = snapshot.outputOmittedBytes ?? 0;
    const originalTokens = snapshot.originalTokenCount;
    const sizeNote = omitted > 0
      ? ` (~${omitted} bytes omitted, original ~${originalTokens ?? "?"} tokens)`
      : "";
    parts.push(
      snapshot.outputId
        ? `Inline output was truncated (head + tail retained${sizeNote}). Use ${options.readProcessOutputTool} with outputId=${snapshot.outputId} and offset=0 to page the retained output.`
        : `Output was truncated (head + tail retained${sizeNote}). Re-run with a narrower command if you need more context.`,
    );
  }
  if (snapshot.droppedBytes > 0) {
    parts.push(`${snapshot.droppedBytes} byte(s) exceeded the durable output quota and cannot be recovered.`);
  } else if (snapshot.outputStorageError) {
    parts.push(`Durable output is unavailable: ${snapshot.outputStorageError}`);
  }

  return parts.join("\n");
}

function policyDenialError(policy: CommandPolicyResult): BashToolResult {
  const text = `Command blocked by command policy: ${policy.reason}\n${policy.advice ?? ""}`.trim();
  return {
    content: [{ type: "text", text }],
    isError: true,
    snapshot: {
      output: text,
      outputTruncated: false,
      running: false,
      exitCode: undefined,
      signal: undefined,
      wallTimeMs: 0,
      originalTokenCount: 0,
      outputOmittedBytes: 0,
      totalOutputBytes: 0,
      storedOutputBytes: 0,
      droppedBytes: 0,
      timedOut: false,
      stdinClosed: false,
    },
    cwd: "",
    command: "",
    policy,
  };
}

export async function runWorkspaceBash(options: {
  workspaces: WorkspaceRegistry;
  processSessions: ProcessSessionManager;
  workspace: Workspace;
  input: BashToolInput;
  writeStdinTool?: string;
  readProcessOutputTool?: string;
  /** Optional per-workspace prefix-allow list for the command classifier. */
  allowPrefixes?: string[][];
  /** Canonical paths whose project instructions governed this process start. */
  instructionScopePaths?: string[];
}): Promise<BashToolResult> {
  const { workspaces, processSessions, workspace, input } = options;
  const writeStdinTool = options.writeStdinTool ?? "write_stdin";
  const readProcessOutputTool = options.readProcessOutputTool ?? "read_process_output";
  const timeoutSeconds = resolveBashTimeoutSeconds(input.timeout);
  const runInBackground = input.runInBackground === true;

  const cwd = workspaces.resolveWorkingDirectory(workspace, input.workingDirectory);

  const policy = classifyCommand(input.command, options.allowPrefixes ?? []);
  if (policy.decision === "deny") {
    return policyDenialError(policy);
  }
  const writeTargetViolation = validateShellWriteTargets(input.command, cwd, workspace.root);
  if (writeTargetViolation) {
    return policyDenialError({
      decision: "deny",
      reason: writeTargetViolation.reason,
    });
  }
  if (isInteractiveShellCommand(input.command) && input.stdin !== undefined) {
    const closeStdin = input.closeStdin ?? true;
    if (!closeStdin) {
      return policyDenialError({
        decision: "deny",
        reason: "Initial stdin for a direct interactive shell must close after the script.",
        advice: "Set closeStdin=true, or start the shell first and use write_stdin.",
      });
    }
    const stdinPolicy = classifyCommand(input.stdin, options.allowPrefixes ?? []);
    if (stdinPolicy.decision === "deny") return policyDenialError(stdinPolicy);
    const stdinWriteTargetViolation = validateShellWriteTargets(input.stdin, cwd, workspace.root);
    if (stdinWriteTargetViolation) {
      return policyDenialError({
        decision: "deny",
        reason: stdinWriteTargetViolation.reason,
      });
    }
  }

  try {
    // Foreground: wait up to the full timeout (ms). Background: return immediately with sessionId.
    const yieldTimeMs = runInBackground
      ? 0
      : Math.min(timeoutSeconds * 1_000, 600_000);

    const snapshot = await processSessions.start({
      ownerClientId: workspace.ownerClientId,
      workspaceId: workspace.id,
      command: input.command,
      cwd,
      workspaceRoot: workspace.root,
      yieldTimeMs,
      maxOutputTokens: input.maxOutputTokens,
      runtimeLimitMs: timeoutSeconds * 1_000,
      instructionScopePaths: options.instructionScopePaths,
      instructionInputMode: isInteractiveShellCommand(input.command) ? "shell" : "opaque",
      stdin: input.stdin,
      closeStdin: input.closeStdin,
    });

    const text = formatBashResultText(snapshot, {
      runInBackground: runInBackground || Boolean(snapshot.running),
      writeStdinTool,
      readProcessOutputTool,
    });
    const failed =
      !snapshot.running &&
      ((snapshot.exitCode !== undefined && snapshot.exitCode !== 0) ||
        Boolean(snapshot.signal));

    return {
      content: [{ type: "text", text }],
      isError: failed || undefined,
      snapshot,
      cwd,
      description: input.description,
      command: input.command,
      policy,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: message }],
      isError: true,
      snapshot: {
        output: message,
        outputTruncated: false,
        running: false,
        exitCode: undefined,
        signal: undefined,
        wallTimeMs: 0,
        originalTokenCount: 0,
        outputOmittedBytes: 0,
        totalOutputBytes: 0,
        storedOutputBytes: 0,
        droppedBytes: 0,
        timedOut: false,
        stdinClosed: false,
      },
      cwd,
      command: input.command,
    };
  }
}

export async function pollWorkspaceProcess(options: {
  workspaces: WorkspaceRegistry;
  processSessions: ProcessSessionManager;
  workspace: Workspace;
  sessionId: number;
  chars?: string;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
  closeStdin?: boolean;
}): Promise<BashToolResult> {
  const { processSessions, workspaces, workspace } = options;
  const snapshot = await processSessions.write({
    ownerClientId: workspace.ownerClientId,
    workspaceId: workspace.id,
    sessionId: options.sessionId,
    chars: options.chars,
    columns: options.columns,
    rows: options.rows,
    yieldTimeMs: options.yieldTimeMs,
    maxOutputTokens: options.maxOutputTokens,
    closeStdin: options.closeStdin,
  });

  const text = formatBashResultText(snapshot, {
    runInBackground: true,
    writeStdinTool: "write_stdin",
    readProcessOutputTool: "read_process_output",
  });
  const failed =
    !snapshot.running &&
    ((snapshot.exitCode !== undefined && snapshot.exitCode !== 0) || Boolean(snapshot.signal));

  return {
    content: [{ type: "text", text }],
    isError: failed || undefined,
    snapshot,
    cwd: workspaces.getShellCwd(workspace),
    command: "",
  };
}
