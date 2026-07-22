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
 *   trusted OAuth-authenticated connection (`rm -f`, `sudo`, pipe-to-shell)
 * - wrapper recursion through `sudo` / `env` / `trap` / `nohup`
 * - an optional workspace prefix-allow list for auto-approved command prefixes
 *
 * The model is a browser agent with no per-command approval surface, so the
 * classifier is a workflow guardrail (refuses a few obviously-bad shapes and
 * nudges toward edit/write), not a security boundary. The filesystem roots
 * allowlist + OAuth remain the real security boundary.
 */

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

/**
 * Commands that are always denied. Matched against the first non-wrapper token
 * of a segment. See DANGEROUS_PATTERNS for the fine-grained rules.
 */
const DENY_ADVICE =
  "Use the edit/write tools for file changes, or ask the user before running destructive commands.";

/**
 * Describes a dangerous command shape. `test` receives the effective tokens of
 * a single segment (already unwrapped through sudo/env/trap/nohup).
 */
interface DangerousPattern {
  id: string;
  reason: string;
  test: (tokens: string[]) => boolean;
}

const rmForce: DangerousPattern = {
  id: "rm-force",
  reason: "rm -f style commands are not permitted (unpredictable destructive deletion).",
  test: (tokens) => {
    if (tokens[0] !== "rm") return false;
    return tokens.slice(1).some((t) => /^-.*[fF].*$/.test(t));
  },
};

const pipeToShell: DangerousPattern = {
  id: "pipe-to-shell",
  reason: "Piping remote or untrusted content into a shell is not permitted.",
  test: (tokens) =>
    tokens.length >= 2 &&
    isShellProgram(tokens[0]) &&
    (tokens[1] === "-c" ||
      tokens[1] === "-lc" ||
      tokens.slice(1).includes("eval")),
};

const SHELL_PROGRAMS = new Set(["bash", "sh", "zsh", "dash"]);

function isShellProgram(program: string | undefined): boolean {
  if (!program) return false;
  return SHELL_PROGRAMS.has(program.split("/").at(-1) ?? program);
}

const sudoRoot: DangerousPattern = {
  id: "sudo",
  reason: "sudo is not permitted in this workspace.",
  test: (tokens) => tokens[0] === "sudo",
};

const dangerousPatterns: DangerousPattern[] = [rmForce, pipeToShell, sudoRoot];

/**
 * Wrappers that modify or delegate execution. Codex's heuristic recurses
 * through these to inspect the underlying command. We strip them so
 * `sudo rm -f` and `env rm -f` are caught the same as `rm -f`.
 */
const WRAPPER_COMMANDS = new Set(["sudo", "env", "trap", "nohup", "exec", "command"]);

function unwrapWrappers(tokens: string[]): string[] {
  let i = 0;
  // Skip leading wrapper commands and their flag-like arguments until we reach
  // the real command. `env VAR=1 rm -f` -> `rm -f`; `sudo -E rm` -> `rm`.
  while (i < tokens.length && WRAPPER_COMMANDS.has(tokens[i])) {
    i += 1;
    // Consume env-style VAR=value assignments and -flags that belong to the wrapper.
    while (i < tokens.length && (tokens[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) {
      i += 1;
    }
  }
  return tokens.slice(i);
}

/**
 * Split a command string into independent segments at shell control operators.
 * This is a pragmatic tokenizer, not a full bash AST (Codex uses tree-sitter;
 * DevSpace keeps it light). It handles the common cases: `&&`, `||`, `|`, `;`,
 * and `( ... )` subshells. Quoted strings and escaped operators are preserved
 * within a segment.
 */
export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let i = 0;
  let depth = 0;
  let quote: string | null = null;

  while (i < command.length) {
    const ch = command[i];
    const next = command[i + 1];

    if (quote) {
      current += ch;
      if (ch === "\\" && i + 1 < command.length) {
        current += command[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }

    if (ch === "\\") {
      current += ch;
      if (i + 1 < command.length) current += command[i + 1];
      i += 2;
      continue;
    }

    if (ch === "(") {
      depth += 1;
      // Drop the paren — its contents are treated as a nested segment list.
      i += 1;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }

    // Control operators split segments at any depth so a destructive tail inside
    // a subshell is still classified independently.
    if (ch === "&" && next === "&") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      i += 2;
      continue;
    }
    if (ch === "|" && next === "|") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      i += 2;
      continue;
    }
    if (ch === "|") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      i += 1;
      continue;
    }
    if (ch === ";") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  if (current.trim()) segments.push(current.trim());
  return segments.filter(Boolean);
}

/**
 * Tokenize a single segment into words, respecting quotes and backslash
 * escapes. Redirection targets (`>`, `>>`, `<`) and their following word are
 * kept as tokens so callers can inspect them, but the classifier treats the
 * command's first real word as the program.
 */
export function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let i = 0;
  let quote: string | null = null;

  while (i < segment.length) {
    const ch = segment[i];

    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < segment.length) {
        current += segment[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      i += 1;
      continue;
    }

    if (ch === "\\") {
      if (i + 1 < segment.length) current += segment[i + 1];
      i += 2;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) tokens.push(current);
      current = "";
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  if (current) tokens.push(current);
  return tokens;
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

  // Explicit prefix allow wins (Codex: bypass only when every segment is
  // rule-allowed). Match against the raw segment tokens so allow rules can
  // cover wrapper forms the model might use.
  for (const prefix of allowPrefixes) {
    if (matchesPrefix(tokens, prefix)) {
      return { decision: "allow", reason: "" };
    }
  }

  // Deny sudo before unwrapping — sudo itself is never allowed, even when the
  // inner command would otherwise be fine.
  if (tokens[0] === "sudo") {
    return {
      decision: "deny",
      reason: sudoRoot.reason,
      advice: DENY_ADVICE,
      matchedSegment: segment,
    };
  }

  // Also deny if a later wrapper in a chain reintroduces sudo (e.g. env sudo …).
  if (tokens.includes("sudo")) {
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
): CommandPolicyResult {
  const pipedShell = findPipedShellSegment(command);
  if (pipedShell) {
    return {
      decision: "deny",
      reason: pipeToShell.reason,
      advice: DENY_ADVICE,
      matchedSegment: pipedShell,
    };
  }
  const segments = splitCommandSegments(command);
  for (const segment of segments) {
    const result = evaluateSegment(segment, allowPrefixes);
    if (result.decision === "deny") return result;
  }
  return { decision: "allow", reason: "" };
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
    const effective = unwrapWrappers(tokenizeSegment(segment));
    if (isShellProgram(effective[0])) return segment;
  }
  return undefined;
}
