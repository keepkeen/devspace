/**
 * Shared, bounded lexical helpers for the command accident-prevention checks.
 *
 * This deliberately is not a shell evaluator. It only follows statically
 * visible command delegation and nested command syntax so the policy, write
 * target, and instruction-scope checks agree about what may execute.
 */

export const MAX_SHELL_ANALYSIS_DEPTH = 8;
// Matches exec_command's input schema so every schema-valid command can be analyzed.
export const MAX_SHELL_COMMAND_LENGTH = 100_000;
export const MAX_NESTED_COMMANDS = 128;

export const SHELL_PROGRAMS = new Set([
  "ash", "bash", "dash", "fish", "ksh", "sh", "zsh",
]);

const WRAPPER_PROGRAMS = new Set([
  "builtin", "command", "env", "exec", "nice", "nohup", "sudo", "time",
]);

const COMMAND_PREFIX_KEYWORDS = new Set([
  "!", "{", "elif", "else", "if", "then", "until", "while", "do",
]);

const WRAPPER_OPTIONS_WITH_VALUES: Record<string, Set<string>> = {
  env: new Set(["-a", "--argv0", "-C", "--chdir", "-u", "--unset"]),
  exec: new Set(["-a"]),
  nice: new Set(["-n", "--adjustment"]),
  sudo: new Set([
    "-C", "--close-from", "-D", "--chdir", "-g", "--group", "-h",
    "--host", "-p", "--prompt", "-R", "--chroot", "-r", "--role",
    "-T", "--command-timeout", "-t", "--type", "-u", "--user",
  ]),
  time: new Set(["-f", "--format", "-o", "--output"]),
};

export interface HeredocDocument {
  marker: string;
  body: string;
  expandable: boolean;
}

export interface PreprocessedShellCommand {
  command: string;
  documents: Map<string, HeredocDocument>;
  exceededLimit: boolean;
}

/** Signals that static command discovery exceeded a deliberately bounded limit. */
export class ShellAnalysisLimitError extends Error {
  constructor(message = "Shell command analysis exceeded its bounded payload limit.") {
    super(message);
    this.name = "ShellAnalysisLimitError";
  }
}

export function isShellAnalysisLimitError(error: unknown): error is ShellAnalysisLimitError {
  return error instanceof ShellAnalysisLimitError;
}

function pushNestedPayload(payloads: string[], payload: string): void {
  if (payloads.length >= MAX_NESTED_COMMANDS) throw new ShellAnalysisLimitError();
  payloads.push(payload);
}

export function programBasename(program: string | undefined): string {
  if (!program) return "";
  return (program.split(/[\\/]/u).at(-1) ?? program)
    .replace(/\.exe$/iu, "")
    .toLowerCase();
}

export function isShellProgram(program: string | undefined): boolean {
  return SHELL_PROGRAMS.has(programBasename(program));
}

export function tokenizeShellSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let index = 0;
  let quote: "'" | '"' | null = null;

  while (index < segment.length) {
    const character = segment[index]!;
    if (quote) {
      if (character === "\\" && quote === '"' && index + 1 < segment.length) {
        const escaped = segment[index + 1]!;
        if (escaped === "\n") {
          index += 2;
          continue;
        }
        current += '$`"\\'.includes(escaped) ? escaped : `\\${escaped}`;
        index += 2;
        continue;
      }
      if (character === quote) {
        quote = null;
        index += 1;
        continue;
      }
      current += character;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      index += 1;
      continue;
    }
    if (character === "\\") {
      if (index + 1 < segment.length) current += segment[index + 1];
      index += 2;
      continue;
    }
    if (/\s/u.test(character)) {
      if (current) tokens.push(current);
      current = "";
      index += 1;
      continue;
    }
    current += character;
    index += 1;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Split at top-level shell control operators, preserving quoted/nested text. */
export function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let index = 0;
  let quote: "'" | '"' | null = null;
  let substitutionDepth = 0;

  const flush = () => {
    const segment = current.trim();
    if (segment) segments.push(segment);
    current = "";
  };

  while (index < command.length) {
    const character = command[index]!;
    const next = command[index + 1];
    if (quote) {
      current += character;
      if (character === "\\" && quote === '"' && index + 1 < command.length) {
        current += command[index + 1];
        index += 2;
        continue;
      }
      if (character === quote) quote = null;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      index += 1;
      continue;
    }
    if (character === "\\") {
      current += character;
      if (index + 1 < command.length) current += command[index + 1];
      index += 2;
      continue;
    }
    if ((character === "$" || character === "<" || character === ">") && next === "(") {
      substitutionDepth += 1;
      current += `${character}(`;
      index += 2;
      continue;
    }
    if (substitutionDepth > 0) {
      current += character;
      if (character === "(") substitutionDepth += 1;
      else if (character === ")") substitutionDepth -= 1;
      index += 1;
      continue;
    }
    if (character === "#" && isShellCommentStart(command, index)) {
      while (index < command.length && command[index] !== "\n" && command[index] !== "\r") {
        index += 1;
      }
      continue;
    }
    if (character === "\n" || character === "\r") {
      flush();
      index += character === "\r" && next === "\n" ? 2 : 1;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (pair === "&&" || pair === "||") {
      flush();
      index += 2;
      continue;
    }
    if (")(;|&".includes(character) && !(
      character === "&" && (command[index - 1] === ">" || next === ">")
    )) {
      flush();
      index += 1;
      continue;
    }
    current += character;
    index += 1;
  }
  flush();
  return segments;
}

function optionConsumesValue(wrapper: string, token: string): boolean {
  return WRAPPER_OPTIONS_WITH_VALUES[wrapper]?.has(token) ?? false;
}

/** Return executable positions in a static wrapper chain, never data arguments. */
export function executableChain(tokens: string[]): string[] {
  const chain: string[] = [];
  let index = skipCommandPreamble(tokens, 0, true, true);

  while (index < tokens.length) {
    const wrapper = programBasename(tokens[index]);
    chain.push(wrapper);
    if (!WRAPPER_PROGRAMS.has(wrapper)) break;
    index += 1;
    while (index < tokens.length) {
      const token = tokens[index]!;
      if (token === "--") {
        index += 1;
        break;
      }
      if (wrapper === "env" && (token === "-S" || token === "--split-string" || token.startsWith("--split-string="))) {
        return chain;
      }
      if (optionConsumesValue(wrapper, token)) {
        index += 2;
        continue;
      }
      if (token.startsWith("-") || (wrapper === "env" && isAssignment(token))) {
        index += 1;
        continue;
      }
      break;
    }
    index = skipCommandPreamble(tokens, index, false, false);
  }
  return chain.filter(Boolean);
}

export function unwrapShellWrappers(tokens: string[]): string[] {
  let index = skipCommandPreamble(tokens, 0, true, true);
  while (index < tokens.length && WRAPPER_PROGRAMS.has(programBasename(tokens[index]))) {
    const wrapper = programBasename(tokens[index]);
    index += 1;
    while (index < tokens.length) {
      const token = tokens[index]!;
      if (token === "--") {
        index += 1;
        break;
      }
      if (wrapper === "env" && (token === "-S" || token === "--split-string" || token.startsWith("--split-string="))) {
        return [];
      }
      if (optionConsumesValue(wrapper, token)) {
        index += 2;
        continue;
      }
      if (token.startsWith("-") || (wrapper === "env" && isAssignment(token))) {
        index += 1;
        continue;
      }
      break;
    }
    index = skipCommandPreamble(tokens, index, false, false);
  }
  return tokens.slice(index);
}

export function staticShellCommandPayload(tokens: string[]): string | undefined {
  const effective = unwrapShellWrappers(tokens);
  if (!isShellProgram(effective[0])) return undefined;
  for (let index = 1; index < effective.length; index += 1) {
    const token = effective[index]!;
    if (token === "-c" || token === "--command") return effective[index + 1];
    if (token.startsWith("--command=")) return token.slice("--command=".length);
    if (/^-[^-]*c/u.test(token)) return effective[index + 1];
  }
  return undefined;
}

export function staticEnvSplitPayload(tokens: string[]): string | undefined {
  let index = skipCommandPreamble(tokens, 0, true, true);
  while (index < tokens.length && programBasename(tokens[index]) !== "env") {
    const wrapper = programBasename(tokens[index]);
    if (!WRAPPER_PROGRAMS.has(wrapper)) return undefined;
    index += 1;
    while (index < tokens.length) {
      const token = tokens[index]!;
      if (token === "--") {
        index += 1;
        break;
      }
      if (optionConsumesValue(wrapper, token)) {
        index += 2;
        continue;
      }
      if (token.startsWith("-") || (wrapper === "env" && isAssignment(token))) {
        index += 1;
        continue;
      }
      break;
    }
  }
  if (programBasename(tokens[index]) !== "env") return undefined;
  for (index += 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "-S" || token === "--split-string") return tokens[index + 1];
    if (token.startsWith("--split-string=")) return token.slice("--split-string=".length);
  }
  return undefined;
}

/** Static commands delegated by shell/wrapper utilities in one simple command. */
export function delegatedCommandPayloads(tokens: string[]): string[] {
  const payloads: string[] = [];
  const envPayload = staticEnvSplitPayload(tokens);
  if (envPayload) pushNestedPayload(payloads, envPayload);

  const effective = unwrapShellWrappers(tokens);
  const program = programBasename(effective[0]);
  const shellPayload = staticShellCommandPayload(tokens);
  if (shellPayload) pushNestedPayload(payloads, shellPayload);

  if (program === "eval" && effective.length > 1) {
    pushNestedPayload(payloads, effective.slice(effective[1] === "--" ? 2 : 1).join(" "));
  }
  if (program === "trap") {
    let index = 1;
    while (effective[index]?.startsWith("-") && effective[index] !== "--") index += 1;
    if (effective[index] === "--") index += 1;
    if (effective[index]) pushNestedPayload(payloads, effective[index]!);
  }
  if (program === "find") {
    for (const payload of findExecPayloads(effective.slice(1))) {
      pushNestedPayload(payloads, payload);
    }
  }
  if (program === "xargs") {
    const payload = xargsPayload(effective.slice(1));
    if (payload) pushNestedPayload(payloads, payload);
  }
  return payloads;
}

function findExecPayloads(args: string[]): string[] {
  const payloads: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[index]!)) continue;
    const command: string[] = [];
    for (index += 1; index < args.length; index += 1) {
      const token = args[index]!;
      if (token === ";" || token === "+") break;
      command.push(token);
    }
    if (command.length > 0) pushNestedPayload(payloads, tokensToShellCommand(command));
  }
  return payloads;
}

const XARGS_OPTIONS_WITH_REQUIRED_VALUES = new Set([
  "-a", "--arg-file", "-d", "--delimiter", "-E", "-I", "-L",
  "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars",
  "--process-slot-var",
]);

// GNU optional arguments are only accepted when attached. A following word is
// the utility, so `xargs --replace sudo` delegates to sudo rather than using it
// as the replacement string.
const XARGS_OPTIONS_WITH_OPTIONAL_ATTACHED_VALUES = new Set([
  "-e", "--eof", "-i", "--replace", "-l", "--max-lines",
]);

const XARGS_OPTIONS_WITHOUT_VALUES = new Set([
  "-0", "--null", "-o", "--open-tty", "-p", "--interactive", "-r",
  "--no-run-if-empty", "--show-limits", "-t", "--verbose", "-x", "--exit",
]);

function xargsPayload(args: string[]): string | undefined {
  let index = 0;
  while (index < args.length) {
    const token = args[index]!;
    if (token === "--") {
      index += 1;
      break;
    }
    if (!token.startsWith("-") || token === "-") break;
    if (XARGS_OPTIONS_WITH_REQUIRED_VALUES.has(token)) {
      if (index + 1 >= args.length) throw new ShellAnalysisLimitError("Ambiguous xargs delegation.");
      index += 2;
      continue;
    }
    if (XARGS_OPTIONS_WITH_OPTIONAL_ATTACHED_VALUES.has(token) || XARGS_OPTIONS_WITHOUT_VALUES.has(token)) {
      index += 1;
      continue;
    }
    if (isKnownAttachedXargsOption(token)) {
      index += 1;
      continue;
    }
    throw new ShellAnalysisLimitError("Ambiguous xargs delegation.");
  }
  return index < args.length ? tokensToShellCommand(args.slice(index)) : undefined;
}

function isKnownAttachedXargsOption(token: string): boolean {
  if ([...XARGS_OPTIONS_WITH_REQUIRED_VALUES, ...XARGS_OPTIONS_WITH_OPTIONAL_ATTACHED_VALUES]
    .some((option) => option.startsWith("--") && token.startsWith(`${option}=`))) {
    return true;
  }
  if (/^-(?:[adEILnPs])[\s\S]+$/u.test(token)) return true;
  if (/^-(?:e|i|l)[\s\S]*$/u.test(token)) return true;
  return /^-[0oprtx]+$/u.test(token);
}

function tokensToShellCommand(tokens: string[]): string {
  return tokens.map((token) => `'${token.replaceAll("'", `'\\''`)}'`).join(" ");
}

function isAssignment(token: string | undefined): boolean {
  return Boolean(token && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token));
}

function skipCommandPreamble(
  tokens: string[],
  start: number,
  allowKeyword: boolean,
  allowAssignments: boolean,
): number {
  let index = start;
  for (;;) {
    if (allowAssignments && isAssignment(tokens[index])) {
      index += 1;
      continue;
    }
    const redirection = tokens[index]?.match(/^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?(?:<<<?|<>|>>?|>\||&>)(.*)$/u);
    if (redirection) {
      index += redirection[1] ? 1 : 2;
      continue;
    }
    if (allowKeyword && COMMAND_PREFIX_KEYWORDS.has(tokens[index] ?? "")) {
      index += 1;
      continue;
    }
    return index;
  }
}

/** Extract command substitutions, process substitutions, and backticks. */
export function extractNestedShellSyntax(command: string): string[] {
  const payloads: string[] = [];
  let index = 0;
  let quote: "'" | '"' | null = null;
  while (index < command.length) {
    const character = command[index]!;
    if (quote === "'") {
      if (character === "'") quote = null;
      index += 1;
      continue;
    }
    if (character === "'" && quote === null) {
      quote = "'";
      index += 1;
      continue;
    }
    if (character === '"') {
      quote = quote === '"' ? null : '"';
      index += 1;
      continue;
    }
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "`") {
      const end = findBacktickEnd(command, index + 1);
      if (end >= 0) {
        pushNestedPayload(payloads, command.slice(index + 1, end));
        index = end + 1;
        continue;
      }
    }
    const opener = (
      character === "$" && command[index + 1] === "(" && command[index + 2] !== "("
    ) || (
      quote === null && (character === "<" || character === ">") && command[index + 1] === "("
    );
    if (opener) {
      const start = index + 2;
      const end = findClosingParenthesis(command, start);
      if (end >= 0) {
        pushNestedPayload(payloads, command.slice(start, end));
        index = end + 1;
        continue;
      }
    }
    index += 1;
  }
  return payloads;
}

/** Extract statically visible `<<< word` payloads without evaluating expansion. */
export function extractHereStringPayloads(command: string): string[] {
  const payloads: string[] = [];
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote) {
      if (character === "\\" && quote === '"') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "#" && isShellCommentStart(command, index)) break;
    if (command.slice(index, index + 3) !== "<<<" || command[index + 3] === "<") continue;
    const payload = tokenizeShellSegment(command.slice(index + 3))[0];
    if (payload) pushNestedPayload(payloads, payload);
    index += 2;
  }
  return payloads;
}

function findBacktickEnd(command: string, start: number): number {
  for (let index = start; index < command.length; index += 1) {
    if (command[index] === "\\") index += 1;
    else if (command[index] === "`") return index;
  }
  return -1;
}

function findClosingParenthesis(command: string, start: number): number {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  for (let index = start; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote) {
      if (character === "\\" && quote === '"') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")" && --depth === 0) return index;
  }
  return -1;
}

/** Replace heredoc bodies with markers so each body stays attached to its command. */
export function preprocessHeredocs(command: string): PreprocessedShellCommand {
  if (command.length > MAX_SHELL_COMMAND_LENGTH) {
    return { command: command.slice(0, MAX_SHELL_COMMAND_LENGTH), documents: new Map(), exceededLimit: true };
  }
  const lines = command.split("\n");
  const output: string[] = [];
  const documents = new Map<string, HeredocDocument>();
  let documentIndex = 0;
  let lexicalState: HeredocLexicalState = { quotes: [null] };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    let line = lines[lineIndex]!;
    const pending: PendingHeredoc[] = [];
    ({ line, documentIndex, state: lexicalState } = replaceHeredocOperators(
      line,
      documentIndex,
      pending,
      lexicalState,
    ));
    output.push(line);

    for (const spec of pending) {
      const body: string[] = [];
      let terminated = false;
      while (lineIndex + 1 < lines.length) {
        lineIndex += 1;
        const bodyLine = lines[lineIndex]!;
        const candidate = spec.stripTabs ? bodyLine.replace(/^\t+/u, "") : bodyLine;
        if (candidate.replace(/\r$/u, "") === spec.delimiter) {
          terminated = true;
          break;
        }
        body.push(spec.stripTabs ? bodyLine.replace(/^\t+/u, "") : bodyLine);
      }
      documents.set(spec.marker, {
        marker: spec.marker,
        body: body.join("\n"),
        expandable: spec.expandable,
      });
      if (!terminated) break;
    }
  }
  return { command: output.join("\n"), documents, exceededLimit: false };
}

interface PendingHeredoc {
  marker: string;
  delimiter: string;
  stripTabs: boolean;
  expandable: boolean;
}

interface HeredocLexicalState {
  /** Independent quote state for the root command and each nested substitution. */
  quotes: Array<"'" | '"' | null>;
}

function replaceHeredocOperators(
  line: string,
  documentIndex: number,
  pending: PendingHeredoc[],
  initialState: HeredocLexicalState,
): { line: string; documentIndex: number; state: HeredocLexicalState } {
  let output = "";
  let index = 0;
  const quotes = [...initialState.quotes];

  while (index < line.length) {
    const character = line[index]!;
    const quote = quotes.at(-1) ?? null;
    if (quote) {
      output += character;
      if (
        quote === '"' && character === "$" && line[index + 1] === "(" && line[index + 2] !== "("
      ) {
        output += "(";
        quotes.push(null);
        index += 2;
        continue;
      }
      if (character === "\\" && quote === '"' && index + 1 < line.length) {
        output += line[index + 1];
        index += 2;
        continue;
      }
      if (character === quote) quotes[quotes.length - 1] = null;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quotes[quotes.length - 1] = character;
      output += character;
      index += 1;
      continue;
    }
    if (character === "\\") {
      output += character;
      if (index + 1 < line.length) output += line[index + 1];
      index += 2;
      continue;
    }
    if (character === "#" && isShellCommentStart(line, index)) {
      output += line.slice(index);
      break;
    }
    const substitutionOpener = (
      character === "$" && line[index + 1] === "(" && line[index + 2] !== "("
    ) || (
      (character === "<" || character === ">") && line[index + 1] === "("
    );
    if (substitutionOpener) {
      output += `${character}(`;
      quotes.push(null);
      index += 2;
      continue;
    }
    if (quotes.length > 1 && character === ")") {
      output += character;
      quotes.pop();
      index += 1;
      continue;
    }
    if (quotes.length > 1) {
      output += character;
      index += 1;
      continue;
    }
    if (character !== "<" || line[index + 1] !== "<" || line[index - 1] === "<" || line[index + 2] === "<") {
      output += character;
      index += 1;
      continue;
    }

    const parsed = parseHeredocDelimiter(line, index + 2);
    if (!parsed) {
      output += character;
      index += 1;
      continue;
    }
    const marker = `__DEVSPACE_HEREDOC_${documentIndex++}__`;
    pending.push({ marker, ...parsed.spec });
    output += ` ${marker} `;
    index = parsed.end;
  }
  return { line: output, documentIndex, state: { quotes } };
}

function isShellCommentStart(line: string, index: number): boolean {
  return index === 0 || /[\s;|&()]/u.test(line[index - 1]!);
}

function parseHeredocDelimiter(
  line: string,
  start: number,
): { spec: Omit<PendingHeredoc, "marker">; end: number } | undefined {
  let index = start;
  let stripTabs = false;
  if (line[index] === "-") {
    stripTabs = true;
    index += 1;
  }
  while (line[index] === " " || line[index] === "\t") index += 1;

  let delimiter = "";
  let consumed = false;
  let expandable = true;
  let quote: "'" | '"' | null = null;
  for (; index < line.length; index += 1) {
    const character = line[index]!;
    if (quote) {
      consumed = true;
      if (character === quote) {
        quote = null;
      } else if (character === "\\" && quote === '"' && index + 1 < line.length) {
        delimiter += line[++index]!;
      } else {
        delimiter += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      consumed = true;
      expandable = false;
      quote = character;
      continue;
    }
    if (character === "\\") {
      if (index + 1 >= line.length) break;
      consumed = true;
      expandable = false;
      delimiter += line[++index]!;
      continue;
    }
    if (/\s/u.test(character) || "|;&()<>>".includes(character)) break;
    consumed = true;
    delimiter += character;
  }
  if (!consumed || quote) return undefined;
  return { spec: { delimiter, stripTabs, expandable }, end: index };
}

export function heredocMarkers(
  tokens: string[],
  documents?: Map<string, HeredocDocument>,
): string[] {
  return tokens.filter((token) => documents
    ? documents.has(token)
    : /^__DEVSPACE_HEREDOC_\d+__$/u.test(token));
}

export function withoutHeredocMarkers(
  tokens: string[],
  documents?: Map<string, HeredocDocument>,
): string[] {
  return tokens.filter((token) => documents
    ? !documents.has(token)
    : !/^__DEVSPACE_HEREDOC_\d+__$/u.test(token));
}
