/**
 * Lightweight command classifier inspired by Codex's execpolicy.
 *
 * Codex splits a shell command at control operators (`&&`, `||`, `|`, `;`,
 * subshells) and classifies each segment independently with a prefix-token
 * rule engine plus a dangerous-command heuristic that recurses through
 * `sudo`/`env`/`trap` wrappers. DevSpace does not need the full Starlark DSL
 * or AST parser, but it does need:
 *
 * - segment evaluation so a broad allow rule never authorizes a destructive tail
 * - a small built-in denylist for commands that are dangerous even for a
 *   trusted OAuth-authenticated connection (`sudo` and pipe-to-shell)
 * - wrapper recursion through `sudo` / `env` / `trap` / `nohup`
 * - an optional workspace prefix-allow list for auto-approved command prefixes
 *
 * The model is a browser agent with no per-command approval surface, so the
 * classifier is a workflow guardrail, not a filesystem sandbox. Normal shell
 * writes are allowed; direct literal targets are checked separately against
 * the workspace. Opaque scripts still run with the DevSpace OS user's access.
 */

import {
  delegatedCommandPayloads,
  extractHereStringPayloads,
  executableChain,
  extractNestedShellSyntax,
  heredocMarkers,
  isShellProgram as sharedIsShellProgram,
  isShellAnalysisLimitError,
  MAX_SHELL_ANALYSIS_DEPTH,
  preprocessHeredocs,
  programBasename,
  splitShellSegments,
  staticEnvSplitPayload,
  tokenizeShellSegment,
  unwrapShellWrappers,
  withoutHeredocMarkers,
} from "./shell-command-analysis.js";

export type CommandDecision = "allow" | "deny";

export interface CommandPolicyResult {
  decision: CommandDecision;
  /** Human-readable reason shown to the model when denied. */
  reason: string;
  /** Optional follow-up advice appended to the denial text. */
  advice?: string;
  /** The segment that triggered a deny decision, for telemetry. */
  matchedSegment?: string;
}

export interface DevSpaceSelfManagementContext {
  pid: number;
  launchdServiceLabel?: string;
}

/**
 * Commands that are always denied. Matched against the first non-wrapper token
 * of a segment. See DANGEROUS_PATTERNS for the fine-grained rules.
 */
const DENY_ADVICE =
  "Use a non-destructive project-scoped command, or ask the user before running destructive commands.";

/**
 * Describes a dangerous command shape. `test` receives the effective tokens of
 * a single segment (already unwrapped through sudo/env/trap/nohup).
 */
interface DangerousPattern {
  id: string;
  reason: string;
  test: (tokens: string[]) => boolean;
}

const pipeToShell: DangerousPattern = {
  id: "pipe-to-shell",
  reason: "Piping remote or untrusted content into a shell is not permitted.",
  test: () => false,
};

function isShellProgram(program: string | undefined): boolean {
  return sharedIsShellProgram(program);
}

const sudoRoot: DangerousPattern = {
  id: "sudo",
  reason: "sudo is not permitted in this workspace.",
  test: (tokens) => commandBasename(tokens[0]) === "sudo",
};

const dangerousPatterns: DangerousPattern[] = [sudoRoot];

export function unwrapCommandWrappers(tokens: string[]): string[] {
  return unwrapShellWrappers(tokens);
}

const unwrapWrappers = unwrapCommandWrappers;

function commandBasename(program: string | undefined): string {
  return programBasename(program);
}

/**
 * Split a command string into independent segments at shell control operators.
 * This is a pragmatic tokenizer, not a full bash AST (Codex uses tree-sitter;
 * DevSpace keeps it light). It handles the common cases: `&&`, `||`, `|`, `;`,
 * and `( ... )` subshells. Quoted strings and escaped operators are preserved
 * within a segment.
 */
export function splitCommandSegments(command: string): string[] {
  return splitShellSegments(command);
}

/**
 * Tokenize a single segment into words, respecting quotes and backslash
 * escapes. Redirection targets (`>`, `>>`, `<`) and their following word are
 * kept as tokens so callers can inspect them, but the classifier treats the
 * command's first real word as the program.
 */
export function tokenizeSegment(segment: string): string[] {
  return tokenizeShellSegment(segment);
}

/**
 * Reject commands that can terminate or restart the currently serving
 * DevSpace backend. Lifecycle changes must go through the local Admin control
 * plane, which verifies the old/new PID and readiness generation.
 */
export function devSpaceSelfManagementViolation(
  command: string,
  context: DevSpaceSelfManagementContext,
): string | undefined {
  const currentPid = String(context.pid);
  const serviceLabel = context.launchdServiceLabel?.trim().toLowerCase();
  for (const segment of splitCommandSegments(command)) {
    const tokens = unwrapCommandWrappers(tokenizeSegment(segment));
    if (tokens.length === 0) continue;
    const program = commandBasename(tokens[0]);
    const args = tokens.slice(1);
    const normalizedArgs = args.map((value) => value.toLowerCase());
    const joined = normalizedArgs.join(" ");

    if (program === "kill" && args.some((value) => value === currentPid)) {
      return "Terminating the current DevSpace backend is not permitted through exec_command.";
    }
    if (
      (program === "pkill" || program === "killall") &&
      /(?:^|[\s/._-])(?:devspace|node|cli\.js)(?:$|[\s/._-])/u.test(joined)
    ) {
      return "Process-wide DevSpace termination is not permitted through exec_command.";
    }
    if (
      program === "launchctl" &&
      normalizedArgs.some((value) =>
        ["kickstart", "kill", "bootout", "unload", "remove", "stop"].includes(value)
      ) &&
      serviceLabel &&
      normalizedArgs.some((value) => value === serviceLabel || value.endsWith(`/${serviceLabel}`))
    ) {
      return "The enrolled DevSpace launchd service can be restarted only from the local Admin control plane.";
    }
    if (
      (program === "systemctl" || program === "service") &&
      /(?:^|[\s/._-])devspace(?:$|[\s/._-])/u.test(joined) &&
      /(?:^|\s)(?:restart|stop|kill|reload-or-restart)(?:\s|$)/u.test(joined)
    ) {
      return "The DevSpace service lifecycle can be changed only from the local Admin control plane.";
    }
  }
  return undefined;
}

function matchesPrefix(tokens: string[], prefix: string[]): boolean {
  if (prefix.length === 0) return false;
  if (tokens.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (tokens[i] !== prefix[i]) return false;
  }
  return true;
}

function evaluateSegment(
  segment: string,
  allowPrefixes: string[][],
): CommandPolicyResult {
  const tokens = tokenizeSegment(segment);
  if (tokens.length === 0) return { decision: "allow", reason: "" };

  // Only executable positions in the wrapper chain count. Arguments such as
  // `git grep sudo` and `printf sudo` are data, while `env command sudo id`
  // still exposes sudo as an executable.
  if (executableChain(tokens).includes("sudo")) {
    return {
      decision: "deny",
      reason: sudoRoot.reason,
      advice: DENY_ADVICE,
      matchedSegment: segment,
    };
  }

  const effective = unwrapWrappers(tokens);
  if (effective.length === 0) return { decision: "allow", reason: "" };

  for (const pattern of dangerousPatterns) {
    if (pattern.test(effective) || pattern.test(tokens)) {
      return {
        decision: "deny",
        reason: pattern.reason,
        advice: DENY_ADVICE,
        matchedSegment: segment,
      };
    }
  }

  // Explicit allow rules may bypass ordinary workflow checks, but never the
  // hard sudo rule above.
  for (const prefix of allowPrefixes) {
    if (matchesPrefix(tokens, prefix)) {
      return { decision: "allow", reason: "" };
    }
  }

  return { decision: "allow", reason: "" };
}

/**
 * Classify a full command. Each segment is evaluated independently; a deny on
 * any segment denies the whole command (Codex behavior — a broad allow never
 * authorizes a destructive tail).
 */
export function classifyCommand(
  command: string,
  allowPrefixes: string[][] = [],
  depth = 0,
): CommandPolicyResult {
  try {
    return classifyCommandWithinLimits(command, allowPrefixes, depth);
  } catch (error) {
    if (isShellAnalysisLimitError(error)) return analysisLimitDenial(command);
    throw error;
  }
}

function classifyCommandWithinLimits(
  command: string,
  allowPrefixes: string[][],
  depth: number,
): CommandPolicyResult {
  const preprocessed = preprocessHeredocs(command);
  if (preprocessed.exceededLimit || depth > MAX_SHELL_ANALYSIS_DEPTH) {
    return analysisLimitDenial(command);
  }
  for (const payload of extractNestedShellSyntax(preprocessed.command)) {
    const nested = classifyNested(payload, allowPrefixes, depth);
    if (nested) return nested;
  }
  const pipedShell = findPipedShellSegment(preprocessed.command);
  if (pipedShell) {
    return {
      decision: "deny",
      reason: pipeToShell.reason,
      advice: DENY_ADVICE,
      matchedSegment: pipedShell,
    };
  }
  const segments = splitCommandSegments(preprocessed.command);
  for (const segment of segments) {
    const rawTokens = tokenizeSegment(segment);
    const markers = heredocMarkers(rawTokens, preprocessed.documents);
    const tokens = withoutHeredocMarkers(rawTokens, preprocessed.documents);
    const normalizedSegment = tokens.join(" ");

    for (const payload of extractNestedShellSyntax(segment)) {
      const nested = classifyNested(payload, allowPrefixes, depth);
      if (nested) return nested;
    }

    const result = evaluateSegment(normalizedSegment, allowPrefixes);
    if (result.decision === "deny") return result;

    for (const payload of delegatedCommandPayloads(tokens)) {
      const nested = classifyNested(payload, allowPrefixes, depth);
      if (nested) return nested;
    }

    const effective = unwrapWrappers(tokens);
    const heredocShell = isShellProgram(effective[0]);
    if (heredocShell) {
      for (const payload of extractHereStringPayloads(segment)) {
        const nested = classifyNested(payload, allowPrefixes, depth);
        if (nested) return nested;
      }
    }
    for (const marker of markers) {
      const document = preprocessed.documents.get(marker);
      if (!document) continue;
      if (heredocShell) {
        const nested = classifyNested(document.body, allowPrefixes, depth);
        if (nested) return nested;
      } else if (document.expandable) {
        for (const payload of extractNestedShellSyntax(document.body)) {
          const nested = classifyNested(payload, allowPrefixes, depth);
          if (nested) return nested;
        }
      }
    }
  }
  return { decision: "allow", reason: "" };
}

function classifyNested(
  payload: string,
  allowPrefixes: string[][],
  depth: number,
): CommandPolicyResult | undefined {
  if (depth >= MAX_SHELL_ANALYSIS_DEPTH) return analysisLimitDenial(payload);
  const nested = classifyCommand(payload, allowPrefixes, depth + 1);
  return nested.decision === "deny" ? nested : undefined;
}

function analysisLimitDenial(command: string): CommandPolicyResult {
  return {
    decision: "deny",
    reason: "Command nesting or size exceeds the bounded safety analysis limit.",
    advice: DENY_ADVICE,
    matchedSegment: command.slice(0, 256),
  };
}

export function extractShellCommandSubstitutions(command: string): string[] {
  return extractNestedShellSyntax(command);
}

function findPipedShellSegment(command: string): string | undefined {
  let quote: string | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch !== "|" || command[i - 1] === "|" || command[i + 1] === "|") continue;

    const segment = splitCommandSegments(command.slice(i + 1))[0];
    if (!segment) continue;
    const tokens = tokenizeSegment(segment);
    const effective = unwrapWrappers(tokens);
    if (isShellProgram(effective[0])) return segment;
    const envPayload = staticEnvSplitPayload(tokens);
    if (envPayload) {
      const splitTokens = tokenizeSegment(envPayload);
      if (isShellProgram(splitTokens[0])) return segment;
    }
  }
  return undefined;
}
