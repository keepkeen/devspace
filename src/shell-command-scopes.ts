import path from "node:path";

export type UnresolvedShellCwdReason =
  | "dynamic-path"
  | "missing-directory"
  | "previous-directory"
  | "directory-stack"
  | "relative-to-dynamic-cwd"
  | "cdpath"
  | "unsupported-syntax"
  | "analysis-limit";

export interface UnresolvedShellCwd {
  /** The shell word (or command name, when omitted) that cannot be resolved. */
  fragment: string;
  reason: UnresolvedShellCwdReason;
}

export interface ShellCommandScopeAnalysis {
  /** Normalized cwd candidates reached by cd/pushd that remain in the workspace. */
  staticCwds: string[];
  /** Candidate destinations grouped by one cwd-changing command. */
  staticCwdAlternatives: string[][];
  /** cwd changes that require runtime shell state or expansion. */
  unresolvedCwds: UnresolvedShellCwd[];
}

interface ShellWord {
  raw: string;
  value: string;
  dynamic: boolean;
}

interface ScopeCommand {
  name: "cd" | "pushd";
  target?: ShellWord;
  unsupported?: ShellWord;
}

const MAX_POSSIBLE_CWDS = 64;

/**
 * Find directory scopes that a Bash command may enter.
 *
 * This is deliberately a conservative lexical analysis rather than a shell
 * evaluator. Each successful static cwd is retained as a possible base for
 * later commands, while the prior cwd is retained for failure/branch paths.
 * That can over-report candidates, but avoids missing scopes across control
 * operators and subshell-like syntax.
 */
export function analyzeShellCommandScopes(
  command: string,
  initialCwd: string,
  workspaceRoot: string,
): ShellCommandScopeAnalysis {
  const normalizedRoot = path.resolve(workspaceRoot);
  const possibleCwds = new Set([path.resolve(initialCwd)]);
  let hasDynamicCwd = false;
  const staticCwds: string[] = [];
  const staticCwdAlternatives: string[][] = [];
  const staticCwdSet = new Set<string>();
  const unresolvedCwds: UnresolvedShellCwd[] = [];
  const unresolvedSet = new Set<string>();

  const addUnresolved = (fragment: string, reason: UnresolvedShellCwdReason) => {
    const key = `${reason}\0${fragment}`;
    if (unresolvedSet.has(key)) return;
    unresolvedSet.add(key);
    unresolvedCwds.push({ fragment, reason });
  };

  for (const words of splitIntoSimpleCommands(command)) {
    if (mutatesCdPath(words)) {
      addUnresolved("CDPATH", "cdpath");
      hasDynamicCwd = true;
    }

    const scopeCommand = findScopeCommand(words);
    if (!scopeCommand) continue;

    const { name, target, unsupported } = scopeCommand;
    if (unsupported) {
      addUnresolved(unsupported.raw, "unsupported-syntax");
      hasDynamicCwd = true;
      continue;
    }
    if (!target) {
      addUnresolved(name, name === "cd" ? "missing-directory" : "directory-stack");
      hasDynamicCwd = true;
      continue;
    }

    if (target.dynamic) {
      addUnresolved(target.raw, "dynamic-path");
      hasDynamicCwd = true;
      continue;
    }

    if (name === "cd" && target.value === "-") {
      addUnresolved(target.raw, "previous-directory");
      hasDynamicCwd = true;
      continue;
    }

    if (name === "pushd" && /^[+-]\d+$/.test(target.value)) {
      addUnresolved(target.raw, "directory-stack");
      hasDynamicCwd = true;
      continue;
    }

    const isAbsolute = path.isAbsolute(target.value);
    const destinations = new Set<string>();
    for (const cwd of possibleCwds) {
      destinations.add(path.resolve(cwd, target.value));
    }

    if (hasDynamicCwd && !isAbsolute) {
      addUnresolved(target.raw, "relative-to-dynamic-cwd");
    }

    // An absolute cd has the same statically-known destination even when its
    // input cwd came from a dynamic expansion.
    if (isAbsolute && hasDynamicCwd) {
      destinations.add(path.resolve(target.value));
    }

    const alternatives: string[] = [];
    for (const destination of destinations) {
      // Keep outside paths for later static traversal/re-entry, but expose only
      // paths covered by the workspace root.
      if (!possibleCwds.has(destination) && possibleCwds.size >= MAX_POSSIBLE_CWDS) {
        addUnresolved(String(MAX_POSSIBLE_CWDS), "analysis-limit");
        hasDynamicCwd = true;
        break;
      }
      possibleCwds.add(destination);
      if (!isWithin(normalizedRoot, destination)) continue;
      alternatives.push(destination);
      if (staticCwdSet.has(destination)) continue;
      staticCwdSet.add(destination);
      staticCwds.push(destination);
    }
    if (alternatives.length > 0) staticCwdAlternatives.push(alternatives);
  }

  return { staticCwds, staticCwdAlternatives, unresolvedCwds };
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function findScopeCommand(words: ShellWord[]): ScopeCommand | undefined {
  const executable = executableCommandWord(words);
  if (!executable || executable.dynamic) return undefined;
  let { index } = executable;
  const command = executable.word;

  if (command.value !== "cd" && command.value !== "pushd") return undefined;
  const name = command.value;
  index += 1;

  while (words[index] && !words[index].dynamic && words[index].value.startsWith("-")) {
    const option = words[index];
    if (option.value === "--") {
      index += 1;
      break;
    }
    if (name === "cd" && /^-[LPe@]+$/.test(option.value)) {
      index += 1;
      continue;
    }
    if (name === "pushd" && option.value === "-n") {
      index += 1;
      continue;
    }
    break;
  }

  return { name, target: words[index], unsupported: words[index + 1] };
}

function isAssignment(word: ShellWord): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.value);
}

function mutatesCdPath(words: ShellWord[]): boolean {
  let assignmentEnd = 0;
  while (assignmentEnd < words.length && isAssignment(words[assignmentEnd])) {
    if (/^(?:CDPATH|cdpath)=/.test(words[assignmentEnd].value)) return true;
    assignmentEnd += 1;
  }
  const executable = executableCommandWord(words);
  if (!executable || executable.dynamic) return false;
  const command = executable.word;
  const args = words.slice(executable.index + 1);
  if (command.value === "printf" && args.some((word, index) =>
    word.value === "-v" && /^(?:CDPATH|cdpath)$/.test(args[index + 1]?.value ?? "")
  )) return true;
  return (
    ["export", "readonly", "declare", "typeset", "local", "read"].includes(command.value) &&
    args.some((word) =>
      /^(?:CDPATH|cdpath)(?:=|$)/.test(word.value) || /=(?:CDPATH|cdpath)$/.test(word.value)
    )
  );
}

function executableCommandWord(
  words: ShellWord[],
): { word: ShellWord; index: number; dynamic: boolean } | undefined {
  let index = 0;
  while (index < words.length && isAssignment(words[index])) index += 1;

  for (;;) {
    const word = words[index];
    if (!word) return undefined;
    if (word.dynamic) return { word, index, dynamic: true };
    if (
      word.value === "command" &&
      (words[index + 1]?.value === "-v" || words[index + 1]?.value === "-V")
    ) {
      return { word, index, dynamic: false };
    }
    if (word.value === "command" || word.value === "builtin" || word.value === "exec") {
      index += 1;
      while (words[index]?.value.startsWith("-") && !words[index].dynamic) {
        const option = words[index++];
        if (option.value === "--") break;
      }
      continue;
    }
    if (word.value === "env") {
      index += 1;
      while (words[index]) {
        const candidate = words[index];
        if (!candidate.dynamic && (candidate.value.startsWith("-") || isAssignment(candidate))) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    return { word, index, dynamic: false };
  }
}

function splitIntoSimpleCommands(command: string): ShellWord[][] {
  command = stripHeredocBodies(command);
  const commands: ShellWord[][] = [];
  let words: ShellWord[] = [];
  let raw = "";
  let value = "";
  let dynamic = false;
  let index = 0;

  const flushWord = () => {
    if (!raw) return;
    words.push({ raw, value, dynamic });
    raw = "";
    value = "";
    dynamic = false;
  };

  const flushCommand = () => {
    flushWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };

  while (index < command.length) {
    const ch = command[index];

    if (/\s/.test(ch)) {
      flushWord();
      if (ch === "\n" || ch === "\r") flushCommand();
      index += 1;
      continue;
    }

    if (ch === "#" && raw === "") {
      while (index < command.length && command[index] !== "\n") index += 1;
      continue;
    }

    const operatorLength = controlOperatorLength(command, index);
    if (operatorLength > 0) {
      flushCommand();
      index += operatorLength;
      continue;
    }

    if (ch === "\\") {
      raw += ch;
      if (index + 1 < command.length) {
        raw += command[index + 1];
        value += command[index + 1];
        index += 2;
      } else {
        dynamic = true;
        index += 1;
      }
      continue;
    }

    if (ch === "'") {
      const quoted = consumeSingleQuoted(command, index);
      raw += quoted.raw;
      value += quoted.value;
      dynamic ||= !quoted.closed;
      index = quoted.nextIndex;
      continue;
    }

    if (ch === '"') {
      const quoted = consumeDoubleQuoted(command, index);
      raw += quoted.raw;
      value += quoted.value;
      dynamic ||= quoted.dynamic || !quoted.closed;
      index = quoted.nextIndex;
      continue;
    }

    if (ch === "`") {
      const substitution = consumeBackticks(command, index);
      raw += substitution.raw;
      value += substitution.raw;
      dynamic = true;
      index = substitution.nextIndex;
      continue;
    }

    if (ch === "$" && (command[index + 1] === "(" || command[index + 1] === "{")) {
      const expansion = consumeDollarGroup(command, index);
      raw += expansion;
      value += expansion;
      dynamic = true;
      index += expansion.length;
      continue;
    }

    if (ch === "$" || ch === "*" || ch === "?" || ch === "[") dynamic = true;
    if (ch === "{" && hasBraceExpansion(command, index)) dynamic = true;
    if (ch === "~" && raw === "") dynamic = true;
    raw += ch;
    value += ch;
    index += 1;
  }

  flushCommand();
  return commands;
}

interface HeredocSpec {
  delimiter: string;
  stripTabs: boolean;
}

/**
 * Heredoc bodies are shell input, not commands in the surrounding script.
 * Recognize the common static-delimiter forms and remove their body lines
 * before looking for cwd-changing commands.
 */
export function stripHeredocBodies(command: string): string {
  const pending: HeredocSpec[] = [];
  let output = "";
  let index = 0;
  let quote: "'" | '"' | null = null;
  let wordStarted = false;

  while (index < command.length) {
    const ch = command[index];

    if (quote) {
      output += ch;
      if (ch === "\\" && quote === '"' && index + 1 < command.length) {
        output += command[index + 1];
        index += 2;
        continue;
      }
      if (ch === quote) quote = null;
      index += 1;
      continue;
    }

    if (ch === "\\" && index + 1 < command.length) {
      output += command.slice(index, index + 2);
      if (command[index + 1] !== "\n") wordStarted = true;
      index += 2;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      wordStarted = true;
      output += ch;
      index += 1;
      continue;
    }

    if (ch === "#" && !wordStarted) {
      const newline = command.indexOf("\n", index);
      if (newline < 0) return output + command.slice(index);
      output += command.slice(index, newline);
      index = newline;
      continue;
    }

    if (
      ch === "<" &&
      command[index - 1] !== "<" &&
      command[index + 1] === "<" &&
      command[index + 2] !== "<"
    ) {
      const parsed = parseHeredocSpec(command, index);
      if (parsed) {
        pending.push(parsed.spec);
        output += command.slice(index, parsed.nextIndex);
        index = parsed.nextIndex;
        wordStarted = true;
        continue;
      }
    }

    if (ch === "\n") {
      output += ch;
      index += 1;
      wordStarted = false;

      if (pending.length > 0) {
        for (const spec of pending) {
          const bodyEnd = skipHeredocBody(command, index, spec);
          index = bodyEnd.nextIndex;
          if (bodyEnd.terminatedWithNewline) output += "\n";
        }
        pending.length = 0;
      }
      continue;
    }

    if (/\s/.test(ch) || "|;&()<>".includes(ch)) wordStarted = false;
    else wordStarted = true;
    output += ch;
    index += 1;
  }

  return output;
}

function parseHeredocSpec(
  command: string,
  operatorIndex: number,
): { spec: HeredocSpec; nextIndex: number } | undefined {
  let index = operatorIndex + 2;
  const stripTabs = command[index] === "-";
  if (stripTabs) index += 1;
  while (command[index] === " " || command[index] === "\t") index += 1;

  let delimiter = "";
  let sawWord = false;
  while (index < command.length && !/[\s|;&()<>]/.test(command[index])) {
    const ch = command[index];
    sawWord = true;
    if (ch === "'") {
      const end = command.indexOf("'", index + 1);
      if (end < 0) return undefined;
      delimiter += command.slice(index + 1, end);
      index = end + 1;
      continue;
    }
    if (ch === '"') {
      const quoted = consumeDoubleQuoted(command, index);
      if (!quoted.closed) return undefined;
      delimiter += quoted.value;
      index = quoted.nextIndex;
      continue;
    }
    if (ch === "\\") {
      if (index + 1 >= command.length) return undefined;
      delimiter += command[index + 1];
      index += 2;
      continue;
    }
    delimiter += ch;
    index += 1;
  }

  if (!sawWord) return undefined;
  return { spec: { delimiter, stripTabs }, nextIndex: index };
}

function skipHeredocBody(
  command: string,
  start: number,
  spec: HeredocSpec,
): { nextIndex: number; terminatedWithNewline: boolean } {
  let index = start;
  while (index <= command.length) {
    const newline = command.indexOf("\n", index);
    const lineEnd = newline < 0 ? command.length : newline;
    let line = command.slice(index, lineEnd);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (spec.stripTabs) line = line.replace(/^\t+/, "");

    if (line === spec.delimiter) {
      return {
        nextIndex: newline < 0 ? command.length : newline + 1,
        terminatedWithNewline: newline >= 0,
      };
    }
    if (newline < 0) break;
    index = newline + 1;
  }

  return { nextIndex: command.length, terminatedWithNewline: false };
}

function controlOperatorLength(command: string, index: number): number {
  const pair = command.slice(index, index + 2);
  if (pair === "&&" || pair === "||" || pair === "|&" || pair === ";;" || pair === ";&") return 2;
  return "|;&()".includes(command[index]) ? 1 : 0;
}

function consumeSingleQuoted(
  command: string,
  start: number,
): { raw: string; value: string; nextIndex: number; closed: boolean } {
  const end = command.indexOf("'", start + 1);
  if (end < 0) {
    return { raw: command.slice(start), value: command.slice(start + 1), nextIndex: command.length, closed: false };
  }
  return {
    raw: command.slice(start, end + 1),
    value: command.slice(start + 1, end),
    nextIndex: end + 1,
    closed: true,
  };
}

function consumeDoubleQuoted(
  command: string,
  start: number,
): { raw: string; value: string; nextIndex: number; dynamic: boolean; closed: boolean } {
  let raw = '"';
  let value = "";
  let dynamic = false;
  let index = start + 1;

  while (index < command.length) {
    const ch = command[index];
    raw += ch;
    if (ch === '"') {
      return { raw, value, nextIndex: index + 1, dynamic, closed: true };
    }
    if (ch === "\\" && index + 1 < command.length) {
      const next = command[index + 1];
      raw += next;
      if ('$`"\\\n'.includes(next)) value += next;
      else value += `\\${next}`;
      index += 2;
      continue;
    }
    if (ch === "$" || ch === "`") dynamic = true;
    value += ch;
    index += 1;
  }

  return { raw, value, nextIndex: command.length, dynamic, closed: false };
}

function consumeBackticks(command: string, start: number): { raw: string; nextIndex: number } {
  let index = start + 1;
  while (index < command.length) {
    if (command[index] === "\\") {
      index += 2;
      continue;
    }
    if (command[index] === "`") {
      index += 1;
      break;
    }
    index += 1;
  }
  return { raw: command.slice(start, index), nextIndex: index };
}

function consumeDollarGroup(command: string, start: number): string {
  const opener = command[start + 1];
  const closer = opener === "(" ? ")" : "}";
  let depth = 1;
  let index = start + 2;
  let quote: "'" | '"' | null = null;

  while (index < command.length && depth > 0) {
    const ch = command[index];
    if (quote) {
      if (ch === "\\" && quote === '"') index += 2;
      else {
        if (ch === quote) quote = null;
        index += 1;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      index += 1;
      continue;
    }
    if (ch === "\\") {
      index += 2;
      continue;
    }
    if (ch === opener) depth += 1;
    if (ch === closer) depth -= 1;
    index += 1;
  }

  return command.slice(start, index);
}

function hasBraceExpansion(command: string, start: number): boolean {
  const end = command.indexOf("}", start + 1);
  if (end < 0) return false;
  const contents = command.slice(start + 1, end);
  return contents.includes(",") || contents.includes("..");
}
