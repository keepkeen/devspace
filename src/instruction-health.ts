import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  MAX_PROJECT_INSTRUCTION_BYTES,
  hasProjectInstructionContent,
  projectInstructionFilenames,
} from "./project-instructions.js";

export const INSTRUCTION_PAGE_WARNING_BYTES = 8 * 1024;
export const INSTRUCTION_CHAIN_WARNING_BYTES = 28 * 1024;

export type InstructionHealthIssueCode =
  | "instruction_file_large"
  | "instruction_line_large"
  | "instruction_chain_near_limit"
  | "instruction_repeated_template"
  | "root_instruction_scope_candidate";

export interface InstructionHealthIssue {
  code: InstructionHealthIssueCode;
  severity: "warning" | "info";
  root: string;
  path: string;
  bytes?: number;
  message: string;
}

export interface InstructionHealthReport {
  roots: number;
  scannedDirectories: number;
  instructionFiles: number;
  issues: InstructionHealthIssue[];
  truncated: boolean;
}

export interface InstructionHealthOptions {
  maxDirectories?: number;
  maxDepth?: number;
}

interface SelectedInstructionFile {
  root: string;
  directory: string;
  path: string;
  relativePath: string;
  content: string;
  bytes: number;
}

const DEFAULT_MAX_DIRECTORIES = 2_000;
const DEFAULT_MAX_DEPTH = 16;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".devspace",
  ".idea",
  ".vscode",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  "target",
]);

export async function inspectInstructionHealth(
  roots: readonly string[],
  fallbackFilenames: readonly string[] = [],
  options: InstructionHealthOptions = {},
): Promise<InstructionHealthReport> {
  const maxDirectories = positiveInteger(
    options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES,
    "maxDirectories",
  );
  const maxDepth = nonNegativeInteger(options.maxDepth ?? DEFAULT_MAX_DEPTH, "maxDepth");
  const filenames = projectInstructionFilenames(fallbackFilenames);
  const selected = new Map<string, SelectedInstructionFile>();
  let scannedDirectories = 0;
  let truncated = false;

  for (const configuredRoot of roots) {
    const root = resolve(configuredRoot);
    const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
    while (queue.length > 0) {
      if (scannedDirectories >= maxDirectories) {
        truncated = true;
        break;
      }
      const current = queue.shift()!;
      scannedDirectories += 1;
      let entries;
      try {
        entries = await readdir(current.directory, { withFileTypes: true });
      } catch {
        continue;
      }
      const byName = new Map(entries.map((entry) => [entry.name, entry]));
      for (const filename of filenames) {
        const entry = byName.get(filename);
        if (!entry?.isFile() || entry.isSymbolicLink()) continue;
        const path = join(current.directory, filename);
        const file = await readSelectedInstruction(root, current.directory, path);
        if (!file) continue;
        selected.set(current.directory, file);
        break;
      }
      if (current.depth >= maxDepth) {
        if (entries.some((entry) => entry.isDirectory())) truncated = true;
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || SKIPPED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        queue.push({ directory: join(current.directory, entry.name), depth: current.depth + 1 });
      }
    }
    if (truncated && scannedDirectories >= maxDirectories) break;
  }

  const issues: InstructionHealthIssue[] = [];
  for (const file of selected.values()) {
    if (file.bytes > INSTRUCTION_PAGE_WARNING_BYTES) {
      issues.push({
        code: "instruction_file_large",
        severity: "warning",
        root: file.root,
        path: file.relativePath,
        bytes: file.bytes,
        message:
          `Instruction file is ${file.bytes} UTF-8 bytes and will require internal paging. ` +
          "Keep global policy concise and move target-specific rules to nested instruction files.",
      });
    }
    const longestLine = longestUtf8Line(file.content);
    if (longestLine > INSTRUCTION_PAGE_WARNING_BYTES) {
      issues.push({
        code: "instruction_line_large",
        severity: "warning",
        root: file.root,
        path: file.relativePath,
        bytes: longestLine,
        message:
          `One line is ${longestLine} UTF-8 bytes, so line-boundary paging is impossible for that line. ` +
          "Split generated blobs, minified text, or long examples into references.",
      });
    }
    const repeated = repeatedTemplateBytes(file.content);
    if (repeated >= 1_024) {
      issues.push({
        code: "instruction_repeated_template",
        severity: "info",
        root: file.root,
        path: file.relativePath,
        bytes: repeated,
        message:
          `At least ${repeated} UTF-8 bytes come from repeated non-empty lines. ` +
          "Replace repeated templates with one rule and a scoped reference.",
      });
    }
    if (file.directory === file.root) {
      const scope = dominantPathScope(file.content);
      if (scope) {
        issues.push({
          code: "root_instruction_scope_candidate",
          severity: "info",
          root: file.root,
          path: file.relativePath,
          message:
            `Many path-qualified rules refer to ${scope}/. ` +
            `Consider moving them to ${scope}/AGENTS.md so unrelated tasks do not receive them.`,
        });
      }
    }
    const chain = instructionChainFor(file, selected);
    const chainBytes = chain.reduce((total, entry) => total + entry.bytes, 0);
    if (chainBytes >= INSTRUCTION_CHAIN_WARNING_BYTES) {
      issues.push({
        code: "instruction_chain_near_limit",
        severity: "warning",
        root: file.root,
        path: file.relativePath,
        bytes: chainBytes,
        message:
          `The effective instruction chain reaches ${chainBytes} UTF-8 bytes ` +
          `(hard limit ${MAX_PROJECT_INSTRUCTION_BYTES}).`,
      });
    }
  }

  return {
    roots: roots.length,
    scannedDirectories,
    instructionFiles: selected.size,
    issues: deduplicateIssues(issues).sort((left, right) =>
      left.root.localeCompare(right.root) ||
      left.path.localeCompare(right.path) ||
      left.code.localeCompare(right.code)
    ),
    truncated,
  };
}

function instructionChainFor(
  file: SelectedInstructionFile,
  selected: ReadonlyMap<string, SelectedInstructionFile>,
): SelectedInstructionFile[] {
  const chain: SelectedInstructionFile[] = [];
  let directory = file.directory;
  for (;;) {
    const current = selected.get(directory);
    if (current?.root === file.root) chain.push(current);
    if (directory === file.root) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return chain.reverse();
}

async function readSelectedInstruction(
  root: string,
  directory: string,
  path: string,
): Promise<SelectedInstructionFile | undefined> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) return undefined;
    if (metadata.size > MAX_PROJECT_INSTRUCTION_BYTES) {
      return {
        root,
        directory,
        path,
        relativePath: modelPath(root, path),
        content: "",
        bytes: metadata.size,
      };
    }
    const content = await readFile(path, "utf8");
    if (!hasProjectInstructionContent(content)) return undefined;
    return {
      root,
      directory,
      path,
      relativePath: modelPath(root, path),
      content,
      bytes: Buffer.byteLength(content, "utf8"),
    };
  } catch {
    return undefined;
  }
}

function longestUtf8Line(content: string): number {
  return content.split(/\r?\n/u).reduce(
    (maximum, line) => Math.max(maximum, Buffer.byteLength(line, "utf8")),
    0,
  );
}

function repeatedTemplateBytes(content: string): number {
  const counts = new Map<string, { count: number; bytes: number }>();
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim().replace(/\s+/gu, " ");
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes < 24 || line.startsWith("#")) continue;
    const current = counts.get(line) ?? { count: 0, bytes };
    current.count += 1;
    counts.set(line, current);
  }
  let repeated = 0;
  for (const value of counts.values()) {
    if (value.count >= 3) repeated += (value.count - 1) * value.bytes;
  }
  return repeated;
}

function dominantPathScope(content: string): string | undefined {
  const counts = new Map<string, number>();
  let qualifiedLines = 0;
  for (const line of content.split(/\r?\n/u)) {
    const matches = [...line.matchAll(/(?:^|[\s`'"(])([A-Za-z0-9._-]{1,64})\/[A-Za-z0-9._/-]+/gu)];
    const scopes = new Set(matches.map((match) => match[1]!).filter((scope) =>
      !["http:", "https:", "file:", "Users", "home", "tmp"].includes(scope)
    ));
    if (scopes.size === 0) continue;
    qualifiedLines += 1;
    for (const scope of scopes) counts.set(scope, (counts.get(scope) ?? 0) + 1);
  }
  const dominant = [...counts].sort((left, right) => right[1] - left[1])[0];
  if (!dominant || dominant[1] < 4 || dominant[1] < Math.ceil(qualifiedLines * 0.6)) return undefined;
  return dominant[0];
}

function deduplicateIssues(issues: InstructionHealthIssue[]): InstructionHealthIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}\0${issue.root}\0${issue.path}\0${issue.bytes ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function modelPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/") || ".";
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be positive.`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be non-negative.`);
  return value;
}
