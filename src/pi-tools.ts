import {
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type EditToolInput,
  type EditToolDetails,
  type FindToolInput,
  type GrepToolInput,
  type LsToolInput,
  type ReadToolInput,
  type ReadToolDetails,
  type WriteToolInput,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { resolveAllowedPath } from "./roots.js";

type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export const PI_TOOL_ERROR_MAX_CHARACTERS = 500;
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

function toMcpContent(result: AgentToolResult<unknown>): McpContent[] {
  return result.content.map((content) => {
    if (content.type === "text") {
      return { type: "text", text: content.text };
    }

    return {
      type: "image",
      data: content.data,
      mimeType: content.mimeType,
    };
  });
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

function formatToolError(error: unknown, context: ToolContext): McpContent[] {
  return [{ type: "text", text: sanitizePiToolError(error, context) }];
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

async function runTool<TInput, TDetails = unknown>(
  execute: (input: TInput) => Promise<AgentToolResult<TDetails>>,
  input: TInput,
  context: ToolContext,
): Promise<ToolResponse<TDetails>> {
  try {
    const result = await execute(input);
    return {
      content: toMcpContent(result),
      details: result.details,
    };
  } catch (error) {
    context.onError?.(error);
    return { content: formatToolError(error, context), isError: true };
  }
}

export async function readFileTool(
  input: ReadToolInput,
  context: ToolContext,
): Promise<ToolResponse<ReadToolDetails | undefined>> {
  const path = resolveAllowedPath(input.path, context.cwd, context.readRoots ?? [context.root]);
  const tool = createReadTool(context.cwd);

  return runTool((params) => tool.execute("read_file", params), {
    path,
    offset: input.offset,
    limit: input.limit,
  }, context);
}

export async function writeFileTool(input: WriteToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createWriteTool(context.cwd);

  return runTool((params) => tool.execute("write_file", params), {
    path,
    content: input.content,
  }, context);
}

export async function editFileTool(input: EditToolInput, context: ToolContext): Promise<ToolResponse<EditToolDetails>> {
  const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createEditTool(context.cwd);

  return runTool((params) => tool.execute("edit_file", params), {
    path,
    edits: input.edits,
  }, context);
}

export async function grepFilesTool(input: GrepToolInput, context: ToolContext): Promise<ToolResponse> {
  if (input.path) resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createGrepTool(context.cwd);

  return runTool((params) => tool.execute("grep_files", params), input, context);
}

export async function findFilesTool(input: FindToolInput, context: ToolContext): Promise<ToolResponse> {
  if (input.path) resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createFindTool(context.cwd);

  return runTool((params) => tool.execute("find_files", params), input, context);
}

export async function listDirectoryTool(input: LsToolInput, context: ToolContext): Promise<ToolResponse> {
  if (input.path) resolveAllowedPath(input.path, context.cwd, [context.root]);
  const tool = createLsTool(context.cwd);

  return runTool((params) => tool.execute("list_directory", params), input, context);
}
