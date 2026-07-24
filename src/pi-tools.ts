import { constants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import { minimatch } from "minimatch";
import { resolveAllowedPath } from "./roots.js";

type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface ReadToolInput {
  path: string;
  offset?: number;
  limit?: number;
}

interface WriteToolInput {
  path: string;
  content: string;
}

interface EditToolInput {
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
}

interface GrepToolInput {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

interface FindToolInput {
  pattern: string;
  path?: string;
  limit?: number;
}

interface LsToolInput {
  path?: string;
  limit?: number;
}

interface TruncationResult {
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  firstLineExceedsLimit: boolean;
  maxLines: number;
  maxBytes: number;
}

interface ReadToolDetails {
  truncation?: TruncationResult;
}

interface EditToolDetails {
  patch: string;
  diff: string;
  firstChangedLine?: number;
}

export const PI_TOOL_ERROR_MAX_CHARACTERS = 500;
const DEFAULT_MAX_LINES = 2_000;
const DEFAULT_MAX_BYTES = 50 * 1_024;
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 1_000;
const DEFAULT_LS_LIMIT = 500;
const GREP_MAX_LINE_LENGTH = 500;
const MAX_WALK_ENTRIES = 100_000;
const MAX_IMAGE_BYTES = 10 * 1_024 * 1_024;
const IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);

export type ToolResponse<TDetails = unknown> = {
  content: McpContent[];
  details?: TDetails;
  isError?: boolean;
};

interface ToolContext {
  cwd: string;
  root: string;
  readRoots?: string[];
  onError?: (error: unknown) => void;
}

export function sanitizePiToolError(error: unknown, context: ToolContext): string {
  const rawMessage = extractErrorMessage(error);
  const firstLine = rawMessage.split(/[\r\n]/, 1)[0]?.replace(/\s+/g, " ").trim() ?? "";
  const message = redactContextPaths(firstLine, context) || fallbackErrorMessage(error);

  if (message.length <= PI_TOOL_ERROR_MAX_CHARACTERS) return message;
  return `${message.slice(0, PI_TOOL_ERROR_MAX_CHARACTERS - 1)}…`;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  if (typeof error === "string") return error;
  if (typeof error === "number" || typeof error === "bigint" || typeof error === "boolean") {
    return String(error);
  }
  return "";
}

function redactContextPaths(message: string, context: ToolContext): string {
  const replacements = new Map<string, string>();
  replacements.set(context.root, "__DEVSPACE_WORKSPACE__");
  replacements.set(context.cwd, "__DEVSPACE_WORKSPACE__");
  for (const root of context.readRoots ?? []) {
    if (!replacements.has(root)) replacements.set(root, "__DEVSPACE_READ_ROOT__");
  }

  let redacted = message;
  const ordered = [...replacements.entries()]
    .filter(([path]) => path.length > 1)
    .sort(([left], [right]) => right.length - left.length);
  for (const [path, replacement] of ordered) {
    redacted = redacted.split(path).join(replacement);
  }
  return redacted
    .replace(/(?<![A-Za-z0-9_])\/(?:[^\s'"]+)/gu, "[path]")
    .replace(/\b[A-Za-z]:[\\/][^\s'"]+/gu, "[path]")
    .replaceAll("__DEVSPACE_WORKSPACE__", "[workspace]")
    .replaceAll("__DEVSPACE_READ_ROOT__", "[read root]");
}

function fallbackErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    if (code) return `${code}: Tool operation failed.`;

    const name = "name" in error && typeof error.name === "string" ? error.name : undefined;
    if (name && name !== "Error") return `${name}: Tool operation failed.`;
  }
  return "Tool operation failed.";
}

async function runLocalTool<TDetails>(
  context: ToolContext,
  operation: () => Promise<ToolResponse<TDetails>>,
): Promise<ToolResponse<TDetails>> {
  try {
    return await operation();
  } catch (error) {
    context.onError?.(error);
    return {
      content: [{ type: "text", text: sanitizePiToolError(error, context) }],
      isError: true,
    };
  }
}

export async function readFileTool(
  input: ReadToolInput,
  context: ToolContext,
): Promise<ToolResponse<ReadToolDetails | undefined>> {
  return runLocalTool(context, async () => {
    const path = resolveAllowedPath(input.path, context.cwd, context.readRoots ?? [context.root]);
    await access(path, constants.R_OK);
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error(`Not a file: ${path}`);
    const buffer = await readFile(path);
    const imageMimeType = supportedImageMimeType(path, buffer);
    if (imageMimeType) {
      if (buffer.length > MAX_IMAGE_BYTES) {
        throw new Error(`Image exceeds ${formatSize(MAX_IMAGE_BYTES)} limit: ${path}`);
      }
      return {
        content: [
          { type: "text", text: `Read image file [${imageMimeType}]` },
          { type: "image", data: buffer.toString("base64"), mimeType: imageMimeType },
        ],
      };
    }

    const text = buffer.toString("utf8");
    const allLines = text.split("\n");
    const startIndex = Math.max(0, (input.offset ?? 1) - 1);
    if (startIndex >= allLines.length) {
      throw new Error(`Offset ${input.offset} is beyond end of file (${allLines.length} lines total)`);
    }
    const requestedEnd = input.limit === undefined
      ? allLines.length
      : Math.min(allLines.length, startIndex + input.limit);
    const selected = allLines.slice(startIndex, requestedEnd);
    const truncated = truncateLines(selected, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES);
    const startLine = startIndex + 1;
    let output = truncated.content;
    let details: ReadToolDetails | undefined;
    if (truncated.firstLineExceedsLimit) {
      output = `[Line ${startLine} is ${formatSize(Buffer.byteLength(selected[0] ?? "", "utf8"))}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit.]`;
      details = { truncation: truncated.details };
    } else if (truncated.details.truncated) {
      const endLine = startLine + truncated.details.outputLines - 1;
      const nextOffset = endLine + 1;
      const sizeNote = truncated.details.truncatedBy === "bytes"
        ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`
        : "";
      output += `\n\n[Showing lines ${startLine}-${endLine} of ${allLines.length}${sizeNote}. Use offset=${nextOffset} to continue.]`;
      details = { truncation: truncated.details };
    } else if (requestedEnd < allLines.length) {
      output += `\n\n[${allLines.length - requestedEnd} more lines in file. Use offset=${requestedEnd + 1} to continue.]`;
    }
    return { content: [{ type: "text", text: output }], details };
  });
}

export async function writeFileTool(
  input: WriteToolInput,
  context: ToolContext,
): Promise<ToolResponse> {
  return runLocalTool(context, async () => {
    const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.content);
    return { content: [{ type: "text", text: `Wrote ${Buffer.byteLength(input.content, "utf8")} bytes.` }] };
  });
}

export async function editFileTool(
  input: EditToolInput,
  context: ToolContext,
): Promise<ToolResponse<EditToolDetails>> {
  return runLocalTool(context, async () => {
    const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
    const before = await readFile(path, "utf8");
    let after = before;
    let firstChangedLine: number | undefined;
    for (const edit of input.edits) {
      const index = after.indexOf(edit.oldText);
      if (index === -1) throw new Error("Edit target text was not found.");
      if (after.indexOf(edit.oldText, index + edit.oldText.length) !== -1) {
        throw new Error("Edit target text is ambiguous; include more surrounding text.");
      }
      firstChangedLine ??= after.slice(0, index).split("\n").length;
      after = `${after.slice(0, index)}${edit.newText}${after.slice(index + edit.oldText.length)}`;
    }
    await writeFile(path, after);
    const patch = simplePatch(before, after);
    return {
      content: [{ type: "text", text: "Applied edits." }],
      details: { patch, diff: patch, ...(firstChangedLine ? { firstChangedLine } : {}) },
    };
  });
}

export async function grepFilesTool(
  input: GrepToolInput,
  context: ToolContext,
): Promise<ToolResponse> {
  return runLocalTool(context, async () => {
    const searchPath = resolveAllowedPath(input.path ?? ".", context.cwd, [context.root]);
    const effectiveLimit = Math.max(1, input.limit ?? DEFAULT_GREP_LIMIT);
    const contextLines = Math.max(0, input.context ?? 0);
    const expression = input.literal
      ? new RegExp(escapeRegExp(input.pattern), input.ignoreCase ? "iu" : "u")
      : new RegExp(input.pattern, input.ignoreCase ? "iu" : "u");
    const files = await collectFiles(searchPath);
    const output: string[] = [];
    let matches = 0;
    let linesTruncated = false;
    for (const file of files) {
      if (matches >= effectiveLimit) break;
      const relativePath = displayRelative(searchPath, file.path, file.singleFile);
      if (input.glob && !globMatches(relativePath, input.glob)) continue;
      const buffer = await readFile(file.path);
      if (buffer.subarray(0, 8_192).includes(0)) continue;
      const lines = buffer.toString("utf8").split("\n");
      for (let index = 0; index < lines.length && matches < effectiveLimit; index += 1) {
        expression.lastIndex = 0;
        if (!expression.test(lines[index] ?? "")) continue;
        matches += 1;
        const from = Math.max(0, index - contextLines);
        const to = Math.min(lines.length - 1, index + contextLines);
        for (let current = from; current <= to; current += 1) {
          const compact = truncateGrepLine((lines[current] ?? "").replace(/\r/gu, ""));
          linesTruncated ||= compact.truncated;
          output.push(current === index
            ? `${relativePath}:${current + 1}: ${compact.text}`
            : `${relativePath}-${current + 1}- ${compact.text}`);
        }
      }
    }
    if (matches === 0) return { content: [{ type: "text", text: "No matches found" }] };
    const truncated = truncateLines(output, Number.MAX_SAFE_INTEGER, DEFAULT_MAX_BYTES);
    const notices: string[] = [];
    if (matches >= effectiveLimit) notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
    if (truncated.details.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    if (linesTruncated) notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
    return {
      content: [{
        type: "text",
        text: `${truncated.content}${notices.length ? `\n\n[${notices.join(". ")}]` : ""}`,
      }],
      details: truncated.details.truncated ? { truncation: truncated.details } : undefined,
    };
  });
}

export async function findFilesTool(
  input: FindToolInput,
  context: ToolContext,
): Promise<ToolResponse> {
  return runLocalTool(context, async () => {
    const searchPath = resolveAllowedPath(input.path ?? ".", context.cwd, [context.root]);
    const effectiveLimit = Math.max(1, input.limit ?? DEFAULT_FIND_LIMIT);
    const entries = await collectEntries(searchPath);
    const patternHasPath = input.pattern.includes("/") || input.pattern.includes("\\");
    const matches = entries
      .filter((entry) => globMatches(patternHasPath ? entry.relativePath : entry.name, input.pattern))
      .map((entry) => entry.relativePath)
      .sort((left, right) => left.localeCompare(right))
      .slice(0, effectiveLimit);
    if (matches.length === 0) {
      return { content: [{ type: "text", text: "No files found matching pattern" }] };
    }
    const truncated = truncateLines(matches, Number.MAX_SAFE_INTEGER, DEFAULT_MAX_BYTES);
    const notices: string[] = [];
    if (matches.length >= effectiveLimit) notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
    if (truncated.details.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    return {
      content: [{
        type: "text",
        text: `${truncated.content}${notices.length ? `\n\n[${notices.join(". ")}]` : ""}`,
      }],
      details: truncated.details.truncated ? { truncation: truncated.details } : undefined,
    };
  });
}

export async function listDirectoryTool(
  input: LsToolInput,
  context: ToolContext,
): Promise<ToolResponse> {
  return runLocalTool(context, async () => {
    const path = resolveAllowedPath(input.path ?? ".", context.cwd, [context.root]);
    const metadata = await stat(path);
    if (!metadata.isDirectory()) throw new Error(`Not a directory: ${path}`);
    const effectiveLimit = Math.max(1, input.limit ?? DEFAULT_LS_LIMIT);
    const entries = await readdir(path, { withFileTypes: true });
    const formatted = entries
      .filter((entry) => !entry.isSymbolicLink())
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .sort((left, right) => left.toLocaleLowerCase("en-US").localeCompare(right.toLocaleLowerCase("en-US")));
    if (formatted.length === 0) return { content: [{ type: "text", text: "(empty directory)" }] };
    const limited = formatted.slice(0, effectiveLimit);
    const truncated = truncateLines(limited, Number.MAX_SAFE_INTEGER, DEFAULT_MAX_BYTES);
    const notices: string[] = [];
    if (formatted.length > limited.length) notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
    if (truncated.details.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    return {
      content: [{
        type: "text",
        text: `${truncated.content}${notices.length ? `\n\n[${notices.join(". ")}]` : ""}`,
      }],
      details: truncated.details.truncated ? { truncation: truncated.details } : undefined,
    };
  });
}

interface WalkEntry {
  path: string;
  relativePath: string;
  name: string;
  directory: boolean;
}

async function collectEntries(root: string): Promise<WalkEntry[]> {
  const metadata = await stat(root);
  if (!metadata.isDirectory()) throw new Error(`Not a directory: ${root}`);
  const results: WalkEntry[] = [];
  const pending = [root];
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_WALK_ENTRIES) throw new Error(`Directory traversal exceeded ${MAX_WALK_ENTRIES} entries.`);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const path = `${directory}${sep}${entry.name}`;
      const relativePath = toPosix(relative(root, path)) + (entry.isDirectory() ? "/" : "");
      results.push({ path, relativePath, name: entry.name, directory: entry.isDirectory() });
      if (entry.isDirectory()) pending.push(path);
    }
  }
  return results;
}

async function collectFiles(path: string): Promise<Array<{ path: string; singleFile: boolean }>> {
  const metadata = await stat(path);
  if (metadata.isFile()) return [{ path, singleFile: true }];
  if (!metadata.isDirectory()) throw new Error(`Not a file or directory: ${path}`);
  return (await collectEntries(path))
    .filter((entry) => !entry.directory)
    .map((entry) => ({ path: entry.path, singleFile: false }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function displayRelative(root: string, path: string, singleFile: boolean): string {
  return singleFile ? path.split(sep).at(-1) ?? "[file]" : toPosix(relative(root, path));
}

function globMatches(path: string, pattern: string): boolean {
  return minimatch(toPosix(path), toPosix(pattern), {
    dot: true,
    matchBase: !pattern.includes("/") && !pattern.includes("\\"),
    nocase: process.platform === "win32",
  });
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function truncateGrepLine(value: string): { text: string; truncated: boolean } {
  if (value.length <= GREP_MAX_LINE_LENGTH) return { text: value, truncated: false };
  return { text: `${value.slice(0, GREP_MAX_LINE_LENGTH)}... [truncated]`, truncated: true };
}

function truncateLines(
  lines: string[],
  maxLines: number,
  maxBytes: number,
): { content: string; details: TruncationResult; firstLineExceedsLimit: boolean } {
  const totalContent = lines.join("\n");
  const totalBytes = Buffer.byteLength(totalContent, "utf8");
  if (lines.length > 0 && Buffer.byteLength(lines[0]!, "utf8") > maxBytes) {
    return {
      content: "",
      firstLineExceedsLimit: true,
      details: {
        truncated: true,
        truncatedBy: "bytes",
        totalLines: lines.length,
        totalBytes,
        outputLines: 0,
        outputBytes: 0,
        firstLineExceedsLimit: true,
        maxLines,
        maxBytes,
      },
    };
  }
  const output: string[] = [];
  let outputBytes = 0;
  let truncatedBy: "lines" | "bytes" | null = null;
  for (const line of lines) {
    if (output.length >= maxLines) {
      truncatedBy = "lines";
      break;
    }
    const bytes = Buffer.byteLength(line, "utf8") + (output.length > 0 ? 1 : 0);
    if (outputBytes + bytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    output.push(line);
    outputBytes += bytes;
  }
  const content = output.join("\n");
  const truncated = output.length < lines.length;
  return {
    content,
    firstLineExceedsLimit: false,
    details: {
      truncated,
      truncatedBy: truncated ? truncatedBy ?? "lines" : null,
      totalLines: lines.length,
      totalBytes,
      outputLines: output.length,
      outputBytes: Buffer.byteLength(content, "utf8"),
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    },
  };
}

function supportedImageMimeType(path: string, buffer: Buffer): string | undefined {
  const lower = path.toLocaleLowerCase("en-US");
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buffer.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
  if (lower.endsWith(".svg")) return undefined;
  return undefined;
}

function formatSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes}B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)}KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)}MB`;
}

function simplePatch(before: string, after: string): string {
  return ["--- before", "+++ after", "@@", ...before.split("\n").map((line) => `-${line}`), ...after.split("\n").map((line) => `+${line}`)].join("\n");
}
