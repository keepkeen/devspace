import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  delegatedCommandPayloads,
  extractHereStringPayloads,
  extractNestedShellSyntax,
  heredocMarkers,
  isShellProgram,
  isShellAnalysisLimitError,
  MAX_SHELL_ANALYSIS_DEPTH,
  preprocessHeredocs,
  programBasename as sharedProgramBasename,
  shellIsParseOnly,
  splitShellSegments,
  staticInterpreterCommandPayload,
  tokenizeShellSegment,
  unwrapShellWrappers,
  withoutHeredocMarkers,
} from "./shell-command-analysis.js";

export interface ShellWriteTargetViolation {
  target: string;
  reason: string;
}

export interface ShellProtectedPathViolation {
  target: string;
  reason: string;
}

export type DirectCommandPathViolation =
  | ({ kind: "write" } & ShellWriteTargetViolation)
  | ({ kind: "protected" } & ShellProtectedPathViolation)
  | ({ kind: "unresolved" } & ShellWriteTargetViolation);

const ALL_OPERAND_TARGETS = new Set([
  "mkdir", "truncate", "rm", "rmdir", "tee",
]);
const FINAL_OPERAND_TARGET = new Set([
  "cp", "mv", "ln", "install", "rsync",
]);
const MODE_THEN_TARGETS = new Set(["chmod", "chown", "chgrp"]);

/**
 * Reject obvious literal shell write targets outside a workspace.
 *
 * This is an accident-prevention layer, not a sandbox: dynamic expansions and
 * opaque scripts are deliberately allowed and retain the DevSpace OS user's
 * filesystem access.
 */
export function validateShellWriteTargets(
  command: string,
  cwd: string,
  workspaceRoot: string,
): ShellWriteTargetViolation | undefined {
  const canonicalRoot = realpathSync(workspaceRoot);
  try {
    return validateCommand(command, cwd, canonicalRoot, 0);
  } catch (error) {
    if (isShellAnalysisLimitError(error)) return analysisLimitViolation();
    throw error;
  }
}

/**
 * Reject statically visible command paths that enter DevSpace's own state.
 *
 * Like the write-target check, this is defense in depth rather than a sandbox.
 * Dynamic expansions and opaque scripts cannot be confined without OS-level
 * isolation. Callers may explicitly exempt the current confirmed managed
 * worktree subtree.
 */
export function validateShellProtectedPaths(
  command: string,
  cwd: string,
  workspaceRoot: string,
  protectedRoots: string[],
  allowedProtectedSubtrees: string[] = [],
): ShellProtectedPathViolation | undefined {
  const canonicalWorkspaceRoot = realpathSync(workspaceRoot);
  const canonicalProtectedRoots = protectedRoots.map((root) =>
    resolvePotentialTarget(resolve(root))
  );
  const canonicalAllowedProtectedSubtrees = allowedProtectedSubtrees.map((root) =>
    resolvePotentialTarget(resolve(root))
  ).filter((root) => isWithin(canonicalWorkspaceRoot, root));
  try {
    return validateProtectedCommand(
      command,
      cwd,
      canonicalProtectedRoots,
      canonicalAllowedProtectedSubtrees,
      0,
    );
  } catch (error) {
    if (isShellAnalysisLimitError(error)) return protectedAnalysisLimitViolation();
    throw error;
  }
}

/**
 * Apply the same visible-path guardrails to a direct program/argv invocation.
 * Direct argv does not perform shell expansion, so every argument is treated
 * as its literal value rather than rejecting harmless `$`, `*`, or `?` text.
 */
export function validateDirectCommandPaths(
  program: string,
  args: string[],
  cwd: string,
  workspaceRoot: string,
  protectedRoots: string[],
  allowedProtectedSubtrees: string[] = [],
): DirectCommandPathViolation | undefined {
  const canonicalRoot = realpathSync(workspaceRoot);
  const canonicalProtectedRoots = protectedRoots.map((root) =>
    resolvePotentialTarget(resolve(root))
  );
  const canonicalAllowedProtectedSubtrees = allowedProtectedSubtrees.map((root) =>
    resolvePotentialTarget(resolve(root))
  ).filter((root) => isWithin(canonicalRoot, root));
  const interpreter = staticInterpreterCommandPayload([program, ...args]);
  if (interpreter) {
    const mutation = interpreterMutationTargets(interpreter.payload);
    if (mutation.unresolved) {
      return {
        kind: "unresolved",
        target: "<interpreter-payload>",
        reason:
          `Inline ${interpreter.program} code contains a file mutation whose target cannot be statically confined. ` +
          "Use apply_patch or a direct command with explicit workspace-relative path operands.",
      };
    }
    for (const target of mutation.targets) {
      if (pathEntersProtectedRoot(
        target,
        cwd,
        canonicalProtectedRoots,
        canonicalAllowedProtectedSubtrees,
      )) {
        return {
          kind: "protected",
          target,
          reason: `Interpreter payload path enters protected DevSpace internal state: ${target}`,
        };
      }
      if (!targetInsideWorkspace(target, cwd, canonicalRoot)) {
        return {
          kind: "write",
          target,
          reason: `Interpreter payload write target is outside the workspace: ${target}`,
        };
      }
    }
  }
  for (const target of literalPathCandidates([program, ...args])) {
    if (pathEntersProtectedRoot(
      target,
      cwd,
      canonicalProtectedRoots,
      canonicalAllowedProtectedSubtrees,
    )) {
      return {
        kind: "protected",
        target,
        reason: `Command path enters protected DevSpace internal state: ${target}`,
      };
    }
  }

  const executable = programBasename(program);
  if (executable === "rm" && hasDestructiveRmFlag(args)) {
    const operands = nonOptionOperands(args);
    if (operands.length === 0) {
      return {
        kind: "write",
        target: "<missing-rm-target>",
        reason: "Forced or recursive rm requires an explicit workspace target",
      };
    }
    const rootTarget = operands.find((target) =>
      resolvePotentialTarget(resolveLiteralPath(target, cwd)) === canonicalRoot
    );
    if (rootTarget) {
      return {
        kind: "write",
        target: rootTarget,
        reason: "Forced or recursive rm cannot delete the workspace root itself",
      };
    }
  }

  const outside = directMutationTargets(executable, args).find((target) =>
    !isAllowedDeviceTarget(target) &&
    !targetInsideWorkspace(target, cwd, canonicalRoot)
  );
  if (outside) return { kind: "write", ...outsideViolation(outside) };

  if (executable === "ln" && args.some((arg) =>
    /^-[^-]*s/u.test(arg) || arg === "--symbolic"
  )) {
    const operands = nonOptionOperands(args);
    const source = operands.at(-2);
    if (source && !targetInsideWorkspace(source, cwd, canonicalRoot)) {
      return {
        kind: "write",
        target: source,
        reason: `Shell symlink target is outside the workspace: ${source}`,
      };
    }
  }
  return undefined;
}

interface InterpreterMutationAnalysis {
  targets: string[];
  unresolved: boolean;
}

const INTERPRETER_MUTATING_CALLS = new Set([
  "appendFile", "appendFileSync", "chmod", "chmodSync", "chown", "chownSync",
  "copy", "copyFile", "copyFileSync", "copyfile", "createWriteStream",
  "file_put_contents", "makedirs", "mkdir", "mkdirSync", "move", "remove",
  "removedirs", "rename", "renameSync", "replace", "rm", "rmSync", "rmdir",
  "rmdirSync", "rmtree", "truncate", "truncateSync", "unlink", "unlinkSync",
  "writeFile", "writeFileSync", "writeTextFile", "writeTextFileSync",
]);
const INTERPRETER_TWO_TARGET_CALLS = new Set([
  "copy", "copyFile", "copyFileSync", "copyfile", "move", "rename", "renameSync", "replace",
]);
const INTERPRETER_OPEN_CALLS = new Set(["open", "openSync", "fopen"]);
const INTERPRETER_IMPLICIT_TARGET_CALLS = new Set([
  "touch", "write_bytes", "write_text",
]);

function interpreterMutationTargets(payload: string): InterpreterMutationAnalysis {
  const targets: string[] = [];
  let unresolved = false;
  for (const call of interpreterCalls(payload)) {
    const base = call.name.split(".").at(-1) ?? call.name;
    if (INTERPRETER_IMPLICIT_TARGET_CALLS.has(base)) {
      unresolved = true;
      continue;
    }
    if (INTERPRETER_OPEN_CALLS.has(base)) {
      const mode = staticInterpreterString(call.args[1] ?? "");
      if (!mode || !/[wax+>]/iu.test(mode)) continue;
      const target = staticInterpreterPath(call.args[0] ?? "");
      if (target === undefined) unresolved = true;
      else targets.push(target);
      continue;
    }
    if (!INTERPRETER_MUTATING_CALLS.has(base)) continue;
    const indexes = INTERPRETER_TWO_TARGET_CALLS.has(base) ? [0, 1] : [0];
    for (const index of indexes) {
      const target = staticInterpreterPath(call.args[index] ?? "");
      if (target === undefined) unresolved = true;
      else targets.push(target);
    }
  }
  return { targets, unresolved };
}

interface InterpreterCall {
  name: string;
  args: string[];
}

function interpreterCalls(payload: string): InterpreterCall[] {
  const calls: InterpreterCall[] = [];
  const matcher = /\b([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\(/gu;
  for (const match of payload.matchAll(matcher)) {
    const openIndex = (match.index ?? 0) + match[0].lastIndexOf("(");
    const parsed = parseInterpreterArguments(payload, openIndex);
    if (parsed) calls.push({ name: match[1]!, args: parsed.args });
  }
  return calls;
}

function parseInterpreterArguments(
  payload: string,
  openIndex: number,
): { args: string[]; endIndex: number } | undefined {
  const args: string[] = [];
  let current = "";
  let depth = 1;
  let quote: "'" | '"' | "`" | undefined;
  for (let index = openIndex + 1; index < payload.length; index += 1) {
    const character = payload[index]!;
    if (quote) {
      current += character;
      if (character === "\\" && index + 1 < payload.length) {
        current += payload[++index]!;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      current += character;
      continue;
    }
    if ("([{".includes(character)) {
      depth += 1;
      current += character;
      continue;
    }
    if (")]}".includes(character)) {
      depth -= 1;
      if (depth === 0) {
        if (current.trim() || args.length > 0) args.push(current.trim());
        return { args, endIndex: index };
      }
      current += character;
      continue;
    }
    if (character === "," && depth === 1) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  return undefined;
}

function staticInterpreterPath(expression: string): string | undefined {
  const direct = staticInterpreterString(expression);
  if (direct !== undefined) return direct;
  const call = /^\s*(?:path\.)?(?:join|resolve|Path)\s*\((.*)\)\s*$/su.exec(expression);
  if (!call) return undefined;
  const parsed = parseInterpreterArguments(`(${call[1]})`, 0);
  if (!parsed || parsed.args.length === 0) return undefined;
  const segments = parsed.args.map(staticInterpreterString);
  if (segments.some((segment) => segment === undefined)) return undefined;
  return segments.map((segment) => segment!).join(sep);
}

function staticInterpreterString(expression: string): string | undefined {
  const trimmed = expression.trim();
  const match = /^(?:[rRuUbB]*)(["'`])([\s\S]*)\1$/u.exec(trimmed);
  if (!match || /^[fF]/u.test(trimmed) || match[2]!.includes("${")) return undefined;
  return match[2]!
    .replace(/\\([\\'"`])/gu, "$1")
    .replace(/\\n/gu, "\n")
    .replace(/\\r/gu, "\r")
    .replace(/\\t/gu, "\t");
}

function validateProtectedCommand(
  command: string,
  cwd: string,
  canonicalProtectedRoots: string[],
  canonicalAllowedProtectedSubtrees: string[],
  depth: number,
): ShellProtectedPathViolation | undefined {
  const preprocessed = preprocessHeredocs(command);
  if (preprocessed.exceededLimit || depth > MAX_SHELL_ANALYSIS_DEPTH) {
    return protectedAnalysisLimitViolation();
  }
  for (const payload of extractNestedShellSyntax(preprocessed.command)) {
    const nested = validateProtectedNested(
      payload,
      cwd,
      canonicalProtectedRoots,
      canonicalAllowedProtectedSubtrees,
      depth,
    );
    if (nested) return nested;
  }

  let currentCwd = cwd;
  for (const segment of splitShellSegments(preprocessed.command)) {
    for (const payload of extractNestedShellSyntax(segment)) {
      const nested = validateProtectedNested(
        payload,
        currentCwd,
        canonicalProtectedRoots,
        canonicalAllowedProtectedSubtrees,
        depth,
      );
      if (nested) return nested;
    }
    const rawTokens = tokenizeShellSegment(segment);
    const markers = heredocMarkers(rawTokens, preprocessed.documents);
    const tokens = withoutHeredocMarkers(rawTokens, preprocessed.documents);
    const effective = unwrap(withoutRedirections(tokens));

    const visiblePaths = [
      ...extractAnsiQuotedLiteralPaths(segment),
      ...literalPathCandidates(tokens),
    ];
    for (const target of visiblePaths) {
      if (pathEntersProtectedRoot(
        target,
        currentCwd,
        canonicalProtectedRoots,
        canonicalAllowedProtectedSubtrees,
      )) {
        return {
          target,
          reason: `Command path enters protected DevSpace internal state: ${target}`,
        };
      }
    }

    for (const payload of delegatedCommandPayloads(tokens)) {
      const nested = validateProtectedNested(
        payload,
        currentCwd,
        canonicalProtectedRoots,
        canonicalAllowedProtectedSubtrees,
        depth,
      );
      if (nested) return nested;
    }

    const heredocShell = isShellProgram(effective[0]) && !shellIsParseOnly(tokens);
    if (heredocShell) {
      for (const payload of extractHereStringPayloads(segment)) {
        const nested = validateProtectedNested(
          payload,
          currentCwd,
          canonicalProtectedRoots,
          canonicalAllowedProtectedSubtrees,
          depth,
        );
        if (nested) return nested;
      }
    }
    for (const marker of markers) {
      const document = preprocessed.documents.get(marker);
      if (!document) continue;
      if (heredocShell) {
        const nested = validateProtectedNested(
          document.body,
          currentCwd,
          canonicalProtectedRoots,
          canonicalAllowedProtectedSubtrees,
          depth,
        );
        if (nested) return nested;
      } else if (document.expandable) {
        for (const payload of extractNestedShellSyntax(document.body)) {
          const nested = validateProtectedNested(
            payload,
            currentCwd,
            canonicalProtectedRoots,
            canonicalAllowedProtectedSubtrees,
            depth,
          );
          if (nested) return nested;
        }
      }
    }

    const program = programBasename(effective[0]);
    if (program === "cd" || program === "pushd") {
      const directory = nonOptionOperands(effective.slice(1))[0];
      if (directory && isLiteralPathCandidate(directory)) {
        currentCwd = resolveLiteralPath(directory, currentCwd);
      }
    }
  }
  return undefined;
}

function validateProtectedNested(
  payload: string,
  cwd: string,
  canonicalProtectedRoots: string[],
  canonicalAllowedProtectedSubtrees: string[],
  depth: number,
): ShellProtectedPathViolation | undefined {
  if (depth >= MAX_SHELL_ANALYSIS_DEPTH) return protectedAnalysisLimitViolation();
  return validateProtectedCommand(
    payload,
    cwd,
    canonicalProtectedRoots,
    canonicalAllowedProtectedSubtrees,
    depth + 1,
  );
}

function validateCommand(
  command: string,
  cwd: string,
  canonicalRoot: string,
  depth: number,
): ShellWriteTargetViolation | undefined {
  const preprocessed = preprocessHeredocs(command);
  if (preprocessed.exceededLimit || depth > MAX_SHELL_ANALYSIS_DEPTH) {
    return analysisLimitViolation();
  }
  for (const payload of extractNestedShellSyntax(preprocessed.command)) {
    const nested = validateNested(payload, cwd, canonicalRoot, depth);
    if (nested) return nested;
  }
  let currentCwd = cwd;
  for (const segment of splitShellSegments(preprocessed.command)) {
    for (const payload of extractNestedShellSyntax(segment)) {
      const nested = validateNested(payload, currentCwd, canonicalRoot, depth);
      if (nested) return nested;
    }
    const rawTokens = tokenizeShellSegment(segment);
    const markers = heredocMarkers(rawTokens, preprocessed.documents);
    const tokens = withoutHeredocMarkers(rawTokens, preprocessed.documents);
    const redirection = redirectionTargets(segment).find((target) =>
      isCheckableTarget(target) && !isAllowedDeviceTarget(target) &&
      !targetInsideWorkspace(target, currentCwd, canonicalRoot)
    );
    if (redirection) return outsideViolation(redirection);

    const effective = unwrap(withoutRedirections(tokens));
    const program = programBasename(effective[0]);

    for (const payload of delegatedCommandPayloads(tokens)) {
      const nested = validateNested(payload, currentCwd, canonicalRoot, depth);
      if (nested) return nested;
    }
    if (!program) continue;

    if (program === "rm" && hasDestructiveRmFlag(effective.slice(1))) {
      const operands = nonOptionOperands(effective.slice(1));
      if (operands.length === 0) {
        return {
          target: "<missing-rm-target>",
          reason: "Forced or recursive rm requires an explicit workspace target",
        };
      }
      const ambiguous = operands.find((target) =>
        !isCheckableTarget(target) && !isWorkspaceRelativePattern(target)
      );
      if (ambiguous) {
        return {
          target: ambiguous,
          reason: `Forced or recursive rm target is not safely workspace-relative: ${ambiguous}`,
        };
      }
      const workspaceRootTarget = operands.find((target) =>
        isCheckableTarget(target) &&
        resolvePotentialTarget(resolveLiteralPath(target, currentCwd)) === canonicalRoot
      );
      if (workspaceRootTarget) {
        return {
          target: workspaceRootTarget,
          reason: "Forced or recursive rm cannot delete the workspace root itself",
        };
      }
    }

    const heredocShell = isShellProgram(effective[0]) && !shellIsParseOnly(tokens);
    if (heredocShell) {
      for (const payload of extractHereStringPayloads(segment)) {
        const nested = validateNested(payload, currentCwd, canonicalRoot, depth);
        if (nested) return nested;
      }
    }
    for (const marker of markers) {
      const document = preprocessed.documents.get(marker);
      if (!document) continue;
      if (heredocShell) {
        const nested = validateNested(document.body, currentCwd, canonicalRoot, depth);
        if (nested) return nested;
      } else if (document.expandable) {
        for (const payload of extractNestedShellSyntax(document.body)) {
          const nested = validateNested(payload, currentCwd, canonicalRoot, depth);
          if (nested) return nested;
        }
      }
    }

    const explicitTargets = directMutationTargets(program, effective.slice(1));
    const outside = explicitTargets.find((target) =>
      isCheckableTarget(target) && !isAllowedDeviceTarget(target) &&
      !targetInsideWorkspace(target, currentCwd, canonicalRoot)
    );
    if (outside) return outsideViolation(outside);

    if (program === "ln" && effective.slice(1).some((arg) =>
      /^-[^-]*s/u.test(arg) || arg === "--symbolic"
    )) {
      const operands = nonOptionOperands(effective.slice(1));
      const source = operands.at(-2);
      if (source && isCheckableTarget(source) && !targetInsideWorkspace(source, currentCwd, canonicalRoot)) {
        return {
          target: source,
          reason: `Shell symlink target is outside the workspace: ${source}`,
        };
      }
    }

    if (program === "cd" || program === "pushd") {
      const directory = nonOptionOperands(effective.slice(1))[0];
      if (directory && isCheckableTarget(directory)) {
        if (!targetInsideWorkspace(directory, currentCwd, canonicalRoot)) {
          return {
            target: directory,
            reason: `Shell directory target is outside the workspace: ${directory}`,
          };
        }
        currentCwd = resolve(currentCwd, directory);
      }
    }
  }
  return undefined;
}

function validateNested(
  payload: string,
  cwd: string,
  canonicalRoot: string,
  depth: number,
): ShellWriteTargetViolation | undefined {
  if (depth >= MAX_SHELL_ANALYSIS_DEPTH) return analysisLimitViolation();
  return validateCommand(payload, cwd, canonicalRoot, depth + 1);
}

function redirectionTargets(segment: string): string[] {
  const targets: string[] = [];
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index]!;
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
    if (character !== ">") continue;
    let cursor = index + 1;
    if (segment[cursor] === ">" || segment[cursor] === "|") cursor += 1;
    while (/\s/u.test(segment[cursor] ?? "")) cursor += 1;
    if (segment[cursor] === "&" && /\d/u.test(segment[cursor + 1] ?? "")) continue;
    if (segment[cursor] === "&") cursor += 1;
    const target = tokenizeShellSegment(segment.slice(cursor))[0] ?? "";
    if (!target || target === "/dev/null") continue;
    targets.push(target);
  }
  return targets;
}

function withoutRedirections(tokens: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const match = token.match(/^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?(?:>>?|>\||<>)(.*)$/u);
    if (!match) {
      result.push(token);
      continue;
    }
    if (!(match[1] ?? "")) index += 1;
  }
  return result;
}

export function directMutationTargets(program: string, args: string[]): string[] {
  const operands = nonOptionOperands(args);
  if (ALL_OPERAND_TARGETS.has(program)) return operands;
  if (program === "touch") {
    return operandsWithoutReferenceSource(args, new Set(["-r", "--reference"]));
  }
  if (program === "mv") {
    const targetDirectory = optionValue(args, "-t", "--target-directory");
    return [...operands, ...(targetDirectory ? [targetDirectory] : [])];
  }
  if (FINAL_OPERAND_TARGET.has(program)) {
    const targetDirectory = optionValue(args, "-t", "--target-directory");
    return targetDirectory ? [targetDirectory] : operands.slice(-1);
  }
  if (MODE_THEN_TARGETS.has(program)) {
    const usesReference = args.some((arg) => arg === "--reference" || arg.startsWith("--reference="));
    return usesReference
      ? operandsWithoutReferenceSource(args, new Set(["--reference"]))
      : operands.slice(1);
  }
  if (program === "sed" && args.some((arg) => /^-[^-]*i/u.test(arg) || arg.startsWith("--in-place"))) {
    return operands.slice(1);
  }
  if (program === "perl" && args.some((arg) => /^-[^-]*i/u.test(arg))) {
    return operands.slice(1);
  }
  if (program === "dd") {
    const output = args.find((arg) => arg.startsWith("of="));
    return output ? [output.slice(3)] : [];
  }
  return [];
}

function operandsWithoutReferenceSource(args: string[], referenceOptions: Set<string>): string[] {
  const result: string[] = [];
  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && referenceOptions.has(argument)) {
      index += 1;
      continue;
    }
    if (!optionsEnded && [...referenceOptions].some((option) => argument.startsWith(`${option}=`))) continue;
    if (!optionsEnded && argument.startsWith("-") && argument !== "-") continue;
    if (/^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?(?:>>?|>\||<>)/u.test(argument)) continue;
    result.push(argument);
  }
  return result;
}

function nonOptionOperands(args: string[]): string[] {
  const result: string[] = [];
  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (arg === "-t" || arg === "--target-directory")) {
      index += 1;
      continue;
    }
    if (!optionsEnded && arg.startsWith("--target-directory=")) continue;
    if (!optionsEnded && arg.startsWith("-") && arg !== "-") continue;
    if (/^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?(?:>>?|>\||<>)/u.test(arg)) continue;
    result.push(arg);
  }
  return result;
}

function optionValue(args: string[], short: string, long: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === short || args[index] === long) return args[index + 1];
    if (args[index]?.startsWith(short) && args[index]!.length > short.length) {
      return args[index]!.slice(short.length);
    }
    if (args[index]?.startsWith(`${long}=`)) return args[index]!.slice(long.length + 1);
  }
  return undefined;
}

function unwrap(tokens: string[]): string[] {
  return unwrapShellWrappers(tokens);
}

function programBasename(program: string | undefined): string {
  return sharedProgramBasename(program);
}

function isCheckableTarget(target: string): boolean {
  return Boolean(target) && !/[\$`*?\[\]{}]/u.test(target) && !target.startsWith("~");
}

function hasDestructiveRmFlag(args: string[]): boolean {
  return args.some((argument) =>
    argument === "--force" ||
    argument === "--recursive" ||
    (/^-[^-]/u.test(argument) && /[fFrR]/u.test(argument))
  );
}

function isWorkspaceRelativePattern(target: string): boolean {
  if (!target || isAbsolute(target) || target.startsWith("~") || /[\$`]/u.test(target)) return false;
  return !target.split(/[\\/]/u).includes("..");
}

function literalPathCandidates(tokens: string[]): string[] {
  const candidates = new Set<string>();
  for (const token of tokens) {
    const withoutRedirection = token.replace(
      /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?(?:<<<|<<|<>|<|>>?|>\|)&?/u,
      "",
    );
    addLiteralPathCandidate(candidates, withoutRedirection);

    const equalsIndex = withoutRedirection.indexOf("=");
    if (equalsIndex >= 0) {
      addLiteralPathCandidate(candidates, withoutRedirection.slice(equalsIndex + 1));
    }

    if (withoutRedirection.startsWith("-")) {
      const absoluteIndex = withoutRedirection.indexOf("/");
      if (absoluteIndex >= 0) {
        addLiteralPathCandidate(candidates, withoutRedirection.slice(absoluteIndex));
      }
    }
  }
  return [...candidates];
}

function addLiteralPathCandidate(candidates: Set<string>, candidate: string): void {
  if (isLiteralPathCandidate(candidate)) candidates.add(candidate);
}

function isLiteralPathCandidate(candidate: string): boolean {
  return Boolean(candidate) && !/[\$`*?\[\]{}]/u.test(candidate);
}

function extractAnsiQuotedLiteralPaths(segment: string): string[] {
  const paths: string[] = [];
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index]!;
    if (quote) {
      if (character === "\\" && quote === '"') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character !== "$" || segment[index + 1] !== "'") continue;

    let cursor = index;
    let decoded = "";
    for (;;) {
      cursor += 2;
      let body = "";
      for (; cursor < segment.length; cursor += 1) {
        const current = segment[cursor]!;
        if (current === "\\" && cursor + 1 < segment.length) {
          body += current + segment[cursor + 1]!;
          cursor += 1;
          continue;
        }
        if (current === "'") break;
        body += current;
      }
      if (cursor >= segment.length) break;
      decoded += decodeAnsiCString(body);
      if (segment[cursor + 1] !== "$" || segment[cursor + 2] !== "'") break;
      cursor += 1;
    }
    if (isLiteralPathCandidate(decoded)) paths.push(decoded);
    index = cursor;
  }
  return paths;
}

function decodeAnsiCString(value: string): string {
  return value.replace(
    /\\(?:x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[0-7]{1,3}|[abefnrtv\\'"?])/gu,
    (escape) => {
      const body = escape.slice(1);
      if (body.startsWith("x")) return String.fromCodePoint(Number.parseInt(body.slice(1), 16));
      if (body.startsWith("u") || body.startsWith("U")) {
        const codePoint = Number.parseInt(body.slice(1), 16);
        return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : escape;
      }
      if (/^[0-7]/u.test(body)) return String.fromCodePoint(Number.parseInt(body, 8));
      const simpleEscapes: Record<string, string> = {
        a: "\u0007",
        b: "\b",
        e: "\u001b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
        v: "\u000b",
        "\\": "\\",
        "'": "'",
        '"': '"',
        "?": "?",
      };
      return simpleEscapes[body] ?? escape;
    },
  );
}

function resolveLiteralPath(candidate: string, cwd: string): string {
  if (candidate === "~") return homedir();
  if (candidate.startsWith("~/")) return resolve(homedir(), candidate.slice(2));
  return isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate);
}

function pathEntersProtectedRoot(
  target: string,
  cwd: string,
  canonicalProtectedRoots: string[],
  canonicalAllowedProtectedSubtrees: string[],
): boolean {
  const canonicalTarget = resolvePotentialTarget(resolveLiteralPath(target, cwd));
  if (canonicalAllowedProtectedSubtrees.some((root) => isWithin(root, canonicalTarget))) {
    return false;
  }
  return canonicalProtectedRoots.some((root) => isWithin(root, canonicalTarget));
}

function isAllowedDeviceTarget(target: string): boolean {
  return target === "/dev/null" || target === "/dev/stdout" || target === "/dev/stderr" ||
    /^\/dev\/fd\/\d+$/u.test(target);
}

function targetInsideWorkspace(target: string, cwd: string, canonicalRoot: string): boolean {
  const absolute = isAbsolute(target) ? resolve(target) : resolve(cwd, target);
  const canonicalTarget = resolvePotentialTarget(absolute);
  return isWithin(canonicalRoot, canonicalTarget);
}

function resolvePotentialTarget(absolute: string, symlinkDepth = 0): string {
  if (symlinkDepth > 32) return absolute;
  let ancestor = absolute;
  for (;;) {
    try {
      const suffix = relative(ancestor, absolute);
      const metadata = lstatSync(ancestor);
      if (metadata.isSymbolicLink()) {
        const linked = resolve(dirname(ancestor), readlinkSync(ancestor), suffix);
        return resolvePotentialTarget(linked, symlinkDepth + 1);
      }
      return resolve(realpathSync(ancestor), suffix);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) return absolute;
      ancestor = parent;
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relationship = relative(root, candidate);
  return relationship === "" || (
    !relationship.startsWith(`..${sep}`) &&
    relationship !== ".." &&
    !isAbsolute(relationship)
  );
}

function outsideViolation(target: string): ShellWriteTargetViolation {
  return {
    target,
    reason: `Shell write target is outside the workspace: ${target}`,
  };
}

function analysisLimitViolation(): ShellWriteTargetViolation {
  return {
    target: "<analysis-limit>",
    reason: "Shell write target analysis exceeded its bounded nesting or size limit.",
  };
}

function protectedAnalysisLimitViolation(): ShellProtectedPathViolation {
  return {
    target: "<analysis-limit>",
    reason: "Protected DevSpace path analysis exceeded its bounded nesting or size limit.",
  };
}
