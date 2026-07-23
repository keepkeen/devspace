import { lstatSync, readlinkSync, realpathSync } from "node:fs";
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
  tokenizeShellSegment,
  unwrapShellWrappers,
  withoutHeredocMarkers,
} from "./shell-command-analysis.js";

export interface ShellWriteTargetViolation {
  target: string;
  reason: string;
}

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

function directMutationTargets(program: string, args: string[]): string[] {
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
