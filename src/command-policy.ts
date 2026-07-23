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
 *   trusted OAuth-authenticated connection (forced/recursive `rm`, `sudo`, pipe-to-shell)
 * - wrapper recursion through `sudo` / `env` / `trap` / `nohup`
 * - an optional workspace prefix-allow list for auto-approved command prefixes
 *
 * The model is a browser agent with no per-command approval surface, so the
 * classifier is a workflow guardrail, not a filesystem sandbox. Normal shell
 * writes are allowed; direct literal targets are checked separately against
 * the workspace. Opaque scripts still run with the DevSpace OS user's access.
 */

import { stripHeredocBodies } from "./shell-command-scopes.js";

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

const rmDangerous: DangerousPattern = {
  id: "rm-dangerous",
  reason: "Forced or recursive rm commands are not permitted (unpredictable destructive deletion).",
  test: (tokens) => {
    if (commandBasename(tokens[0]) !== "rm") return false;
    return tokens.slice(1).some((token) =>
      token === "--force" ||
      token === "--recursive" ||
      (/^-[^-]/u.test(token) && /[fFrR]/u.test(token))
    );
  },
};

const pipeToShell: DangerousPattern = {
  id: "pipe-to-shell",
  reason: "Piping remote or untrusted content into a shell is not permitted.",
  test: () => false,
};

const SHELL_PROGRAMS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);

function isShellProgram(program: string | undefined): boolean {
  if (!program) return false;
  return SHELL_PROGRAMS.has(commandBasename(program));
}

const sudoRoot: DangerousPattern = {
  id: "sudo",
  reason: "sudo is not permitted in this workspace.",
  test: (tokens) => commandBasename(tokens[0]) === "sudo",
};

const dangerousPatterns: DangerousPattern[] = [rmDangerous, sudoRoot];

/**
 * Wrappers that modify or delegate execution. Codex's heuristic recurses
 * through these to inspect the underlying command. We strip them so
 * `sudo rm -f` and `env rm -f` are caught the same as `rm -f`.
 */
const WRAPPER_COMMANDS = new Set(["sudo", "env", "nohup", "exec", "command", "builtin", "nice"]);

export function unwrapCommandWrappers(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[i]!)) i += 1;
  // Skip leading wrapper commands and their flag-like arguments until we reach
  // the real command. `env VAR=1 rm -f` -> `rm -f`; `sudo -E rm` -> `rm`.
  while (i < tokens.length && WRAPPER_COMMANDS.has(commandBasename(tokens[i]))) {
    const wrapper = commandBasename(tokens[i]);
    i += 1;
    while (i < tokens.length) {
      const token = tokens[i]!;
      if (token === "--") {
        i += 1;
        break;
      }
      if (wrapper === "env" && (token === "-u" || token === "--unset" || token === "-C" || token === "--chdir")) {
        i += 2;
        continue;
      }
      if (wrapper === "nice" && (token === "-n" || token === "--adjustment")) {
        i += 2;
        continue;
      }
      if (token.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) {
        i += 1;
        continue;
      }
      break;
    }
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[i]!)) {
      i += 1;
    }
  }
  return tokens.slice(i);
}

const unwrapWrappers = unwrapCommandWrappers;

function commandBasename(program: string | undefined): string {
  if (!program) return "";
  return (program.split(/[\\/]/u).at(-1) ?? program).replace(/\.exe$/iu, "").toLowerCase();
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

    if (ch === "\n" || ch === "\r") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      if (ch === "\r" && next === "\n") i += 2;
      else i += 1;
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
    if (ch === "&" && command[i - 1] !== ">" && next !== ">") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      i += 1;
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

  // Deny sudo before unwrapping — sudo itself is never allowed, even when the
  // inner command would otherwise be fine.
  if (commandBasename(unwrapWrappers(tokens)[0]) === "sudo" || commandBasename(tokens[0]) === "sudo") {
    return {
      decision: "deny",
      reason: sudoRoot.reason,
      advice: DENY_ADVICE,
      matchedSegment: segment,
    };
  }

  // Also deny if a later wrapper in a chain reintroduces sudo (e.g. env sudo …).
  if (tokens.some((token) => commandBasename(token) === "sudo")) {
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
  // hard sudo/deletion rules above.
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
  if (depth < 4) {
    for (const nestedCommand of extractShellCommandSubstitutions(stripQuotedHeredocBodies(command))) {
      const nested = classifyCommand(nestedCommand, allowPrefixes, depth + 1);
      if (nested.decision === "deny") return nested;
    }
  }
  const policyCommand = stripHeredocBodies(command);
  const pipedShell = findPipedShellSegment(policyCommand);
  if (pipedShell) {
    return {
      decision: "deny",
      reason: pipeToShell.reason,
      advice: DENY_ADVICE,
      matchedSegment: pipedShell,
    };
  }
  const segments = splitCommandSegments(policyCommand);
  for (const segment of segments) {
    const result = evaluateSegment(segment, allowPrefixes);
    if (result.decision === "deny") return result;
    if (depth < 4) {
      const payload = staticShellPayload(tokenizeSegment(segment));
      if (payload) {
        const nested = classifyCommand(payload, allowPrefixes, depth + 1);
        if (nested.decision === "deny") return nested;
      }
      const effective = unwrapWrappers(tokenizeSegment(segment));
      if (commandBasename(effective[0]) === "eval" && effective.length > 1) {
        const payload = effective.slice(effective[1] === "--" ? 2 : 1).join(" ");
        const nested = classifyCommand(payload, allowPrefixes, depth + 1);
        if (nested.decision === "deny") return nested;
      }
      if (commandBasename(effective[0]) === "trap" && effective[1]) {
        const nested = classifyCommand(effective[1], allowPrefixes, depth + 1);
        if (nested.decision === "deny") return nested;
      }
      const envPayload = staticEnvSplitPayload(tokenizeSegment(segment));
      if (envPayload) {
        const nested = classifyCommand(envPayload, allowPrefixes, depth + 1);
        if (nested.decision === "deny") return nested;
      }
    }
  }
  return { decision: "allow", reason: "" };
}

function staticEnvSplitPayload(tokens: string[]): string | undefined {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? "")) index += 1;
  if (commandBasename(tokens[index]) !== "env") return undefined;
  for (index += 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "-S" || token === "--split-string") return tokens[index + 1];
    if (token.startsWith("--split-string=")) return token.slice("--split-string=".length);
  }
  return undefined;
}

function staticShellPayload(tokens: string[]): string | undefined {
  const effective = unwrapWrappers(tokens);
  if (!isShellProgram(effective[0])) return undefined;
  const optionIndex = effective.findIndex((token, index) =>
    index > 0 && /^-[^-]*c/u.test(token)
  );
  return optionIndex >= 0 ? effective[optionIndex + 1] : undefined;
}

export function extractShellCommandSubstitutions(command: string): string[] {
  const substitutions: string[] = [];
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === "'" && quote === null) {
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "`") {
      const end = command.indexOf("`", index + 1);
      if (end > index) {
        substitutions.push(command.slice(index + 1, end));
        index = end;
      }
      continue;
    }
    if (character !== "$" || command[index + 1] !== "(") continue;
    let depth = 1;
    let cursor = index + 2;
    let nestedQuote: "'" | '"' | null = null;
    for (; cursor < command.length && depth > 0; cursor += 1) {
      const nestedCharacter = command[cursor]!;
      if (nestedQuote === "'") {
        if (nestedCharacter === "'") nestedQuote = null;
        continue;
      }
      if (nestedQuote === '"') {
        if (nestedCharacter === "\\") cursor += 1;
        else if (nestedCharacter === '"') nestedQuote = null;
        continue;
      }
      if (nestedCharacter === "'" && nestedQuote === null) {
        nestedQuote = "'";
        continue;
      }
      if (nestedCharacter === '"') {
        nestedQuote = '"';
        continue;
      }
      if (command[cursor] === "\\") {
        cursor += 1;
        continue;
      }
      if (nestedCharacter === "(" && command[cursor - 1] === "$") depth += 1;
      if (nestedCharacter === ")") depth -= 1;
    }
    if (depth === 0) {
      substitutions.push(command.slice(index + 2, cursor - 1));
      index = cursor - 1;
    }
  }
  return substitutions;
}

function stripQuotedHeredocBodies(command: string): string {
  const lines = command.split("\n");
  const output: string[] = [];
  const pending: Array<{ delimiter: string; stripTabs: boolean }> = [];
  for (const line of lines) {
    if (pending.length > 0) {
      const spec = pending[0]!;
      const candidate = spec.stripTabs ? line.replace(/^\t+/u, "") : line;
      if (candidate === spec.delimiter) {
        pending.shift();
        output.push("");
      }
      continue;
    }
    output.push(line);
    const pattern = /<<(-)?\s*(['"])([^'"\s]+)\2/gu;
    for (const match of line.matchAll(pattern)) {
      pending.push({ delimiter: match[3]!, stripTabs: Boolean(match[1]) });
    }
  }
  return output.join("\n");
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
