import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  registerAppResource,
  registerAppTool as registerSdkAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import { applyPatch, parsePatch } from "./apply-patch.js";
import { loadConfig, type ServerConfig, type WidgetMode } from "./config.js";
import {
  logEvent,
  requestIp,
  requestPath,
  commandPreview,
  errorFields,
  identifierHash,
  sessionIdPrefix,
} from "./logger.js";
import {
  BASH_DEFAULT_TIMEOUT_SECONDS,
  BASH_DESCRIPTION_PARAM,
  BASH_MAX_TIMEOUT_SECONDS,
  BASH_WORKING_DIRECTORY_PARAM,
  buildBashServerInstructions,
  buildBashToolDescription,
  buildCodexServerInstructions,
  buildWorkspaceLifecycleInstruction,
} from "./bash-prompt.js";
import { runWorkspaceBash } from "./bash-tool.js";
import { classifyCommand } from "./command-policy.js";
import { validateShellWriteTargets } from "./shell-write-targets.js";
import { analyzeShellCommandScopes } from "./shell-command-scopes.js";
import {
  BATCH_MAX_ITEMS,
  BATCH_READ_DEFAULT_LINES,
  BATCH_READ_MAX_LINES,
  BATCH_TOTAL_MAX_CHARACTERS,
  limitBatchText,
  runBoundedBatch,
  type BatchItemResult,
} from "./batch-tools.js";
import {
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  writeFileTool,
} from "./pi-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import {
  McpSessionRegistry,
  type McpSessionCloseResult,
  type McpSessionReservation,
} from "./mcp-sessions.js";
import {
  isInteractiveShellCommand,
  MAX_PROCESS_INPUT_BYTES,
  ProcessSessionManager,
  type PreparedProcessInput,
  type ProcessSnapshot,
} from "./process-sessions.js";
import { ProcessOutputStore } from "./process-output-store.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { formatPathForPrompt, type Skill } from "./skills.js";
import { createWorkspaceStore } from "./workspace-store.js";
import {
  formatAgentsPath,
  UnknownWorkspaceError,
  WorkspaceRegistry,
  type Workspace,
} from "./workspaces.js";
import { removeManagedWorktree } from "./git-worktrees.js";
import { RuntimeDiagnostics } from "./runtime-diagnostics.js";
import { ActiveRequestBarrier } from "./request-barrier.js";
import { createRuntimeControlPlane } from "./runtime-control-plane.js";
import { allowedRootsRevision } from "./roots.js";
import { DEVSPACE_SERVER_INFO } from "./version.js";
import { summarizeLocalAgentProfile } from "./local-agent-profiles.js";
import { createLocalAgentStore } from "./local-agent-store.js";
import { cleanupDetachedAgentPromptArtifacts } from "./detached-agent-cleanup.js";
import { devspaceConfigPath } from "./user-config.js";
import {
  formatLocalAgentProviderAvailabilitySummary,
  getLocalAgentProviderAvailabilitySnapshot,
  type LocalAgentProviderAvailability,
} from "./local-agent-availability.js";

const SHELL_COMMAND_MAX_CHARACTERS = 100_000;

type Transport = StreamableHTTPServerTransport;
const requestContext = new AsyncLocalStorage<{ clientId: string; requestId?: string }>();
const toolHandlerBarriers = new WeakMap<McpServer, ActiveRequestBarrier>();
const registerAppTool: typeof registerSdkAppTool = ((...args: unknown[]) => {
  const server = args[0] as McpServer;
  const toolName = typeof args[1] === "string" ? args[1] : "unknown";
  const handlerIndex = args.length - 1;
  const handler = args[handlerIndex];
  const barrier = toolHandlerBarriers.get(server);
  if (typeof handler === "function") {
    const invoke = async (handlerArgs: unknown[]) => {
      const result: unknown = await handler(...handlerArgs);
      if (!result || typeof result !== "object" || Array.isArray(result)) return result;
      const record = result as Record<string, unknown>;
      const meta = record._meta && typeof record._meta === "object" && !Array.isArray(record._meta)
        ? record._meta as Record<string, unknown>
        : {};
      return { ...record, _meta: { ...meta, tool: toolName } };
    };
    args[handlerIndex] = (...handlerArgs: unknown[]) => barrier
      ? barrier.track(() => invoke(handlerArgs))
      : invoke(handlerArgs);
  }
  return (registerSdkAppTool as (...parameters: unknown[]) => unknown)(...args);
}) as typeof registerSdkAppTool;
// MCP clients can reconnect without closing the previous transport. Bound stale
// session retention so abandoned MCP servers do not accumulate for the life of the process.
const WORKSPACE_APP_URI = "ui://devspace/workspace-app.html";
const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
export const OPEN_WORKSPACE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
const EDIT_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const SHELL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};
export const SHOW_CHANGES_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
  localAgentProviders: LocalAgentProviderAvailability[];
  beginClose(): Promise<void>;
  close(): Promise<void>;
}

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  assets?: string[];
  imports?: string[];
  dynamicImports?: string[];
  isEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

interface DiffStats {
  additions: number;
  removals: number;
}

type ToolWidgetKind =
  | "workspace"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "directory"
  | "shell"
  | "show_changes";

interface ToolDefinitionMeta extends Record<string, unknown> {
  ui: {
    resourceUri: string;
    visibility: ["model"];
  };
  "openai/toolInvocation/invoking"?: string;
  "openai/toolInvocation/invoked"?: string;
}

type EmptyToolDefinitionMeta = Record<string, unknown> & {
  "ui/resourceUri"?: string;
};

interface ToolWidgetDescriptorMeta {
  _meta: ToolDefinitionMeta | EmptyToolDefinitionMeta;
}

function shouldAttachWidget(mode: WidgetMode, kind: ToolWidgetKind): boolean {
  switch (mode) {
    case "off":
      return false;
    case "changes":
      return kind === "workspace" || kind === "show_changes";
    case "full":
      return true;
  }
}

function toolWidgetDescriptorMeta(
  config: ServerConfig,
  kind: ToolWidgetKind,
  invocation?: { invoking: string; invoked: string },
): ToolWidgetDescriptorMeta {
  if (!shouldAttachWidget(config.widgets, kind)) return { _meta: {} };

  return {
    _meta: {
      ui: {
        resourceUri: WORKSPACE_APP_URI,
        visibility: ["model"],
      },
      ...(invocation
        ? {
            "openai/toolInvocation/invoking": invocation.invoking,
            "openai/toolInvocation/invoked": invocation.invoked,
          }
        : {}),
    },
  };
}

const toolNames = {
  openWorkspace: "open_workspace",
  loadSkill: "load_skill",
  readProcessOutput: "read_process_output",
  closeWorkspace: "close_workspace",
  read: "read",
  batchRead: "batch_read",
  batchInspect: "batch_inspect",
  write: "write",
  edit: "edit",
  grep: "grep",
  glob: "glob",
  ls: "ls",
  shell: "bash",
  writeStdin: "write_stdin",
  applyPatch: "apply_patch",
  execCommand: "exec_command",
} as const;

export function toolSurface(config: Pick<ServerConfig, "toolMode" | "widgets" | "skillsEnabled">): string[] {
  const tools: string[] = [
    toolNames.openWorkspace,
    toolNames.closeWorkspace,
    toolNames.read,
    toolNames.batchRead,
    toolNames.batchInspect,
    toolNames.writeStdin,
    toolNames.readProcessOutput,
  ];
  if (config.skillsEnabled) tools.push(toolNames.loadSkill);
  if (config.toolMode === "codex") {
    tools.push(toolNames.applyPatch, toolNames.execCommand);
  } else {
    tools.push(toolNames.write, toolNames.edit, toolNames.shell);
    if (config.toolMode === "full") tools.push(toolNames.grep, toolNames.glob, toolNames.ls);
  }
  if (config.widgets === "changes") tools.push("show_changes");
  return tools.sort();
}

interface ToolLogFields {
  tool: string;
  workspaceId?: string;
  path?: string;
  workingDirectory?: string;
  command?: string;
  commandLength?: number;
  stdinBytes?: number;
  success: boolean;
  durationMs: number;
  error?: string;
}

function serverInstructions(config: ServerConfig): string {
  const lifecycleInstruction = buildWorkspaceLifecycleInstruction({
    openWorkspace: toolNames.openWorkspace,
    closeWorkspace: toolNames.closeWorkspace,
  });
  const showChangesInstruction =
    config.widgets === "changes"
      ? " After the turn's final file change, call show_changes once for that workspace before replying; do not call it after each edit."
      : "";

  if (config.toolMode === "codex") {
    return (
      lifecycleInstruction + " " + buildCodexServerInstructions({
        read: toolNames.read,
        batchRead: toolNames.batchRead,
        batchInspect: toolNames.batchInspect,
        loadSkill: config.skillsEnabled ? toolNames.loadSkill : undefined,
        readProcessOutput: toolNames.readProcessOutput,
        writeStdin: toolNames.writeStdin,
      }) + showChangesInstruction
    );
  }

  const skills = config.skillsEnabled
    ? `If ${toolNames.openWorkspace} advertises a matching skill, call ${toolNames.loadSkill} with skillId first. Reload it after backend restart or workspace recovery. Explicit-only skills require the user's request. `
    : "";

  const agentsMd = `Follow instructions returned by tools; nested files load on first scoped access. If blocked with instructionToken, review them and retry with that token. Batch 2–8 known independent targets; keep dependent discovery iterative. `;

  const bashInstructions = buildBashServerInstructions({
    toolNames: {
      openWorkspace: toolNames.openWorkspace,
      read: toolNames.read,
      write: toolNames.write,
      edit: toolNames.edit,
      grep: toolNames.grep,
      glob: toolNames.glob,
      ls: toolNames.ls,
      shell: toolNames.shell,
      writeStdin: toolNames.writeStdin,
      readProcessOutput: toolNames.readProcessOutput,
    },
    hasInspectionTools: config.toolMode === "full",
  });

  return `${lifecycleInstruction} ${agentsMd}${skills}${bashInstructions}${showChangesInstruction}`;
}

function formatVisibleAgent(agent: {
  name: string;
  provider: string;
  model?: string;
  thinking?: string;
  providerAvailable?: boolean;
  providerUnavailableReason?: string;
}): string {
  const model = agent.model ? `, model ${agent.model}` : "";
  const thinking = agent.thinking ? `, thinking ${agent.thinking}` : "";
  const availability = agent.providerAvailable === false
    ? `, unavailable: ${agent.providerUnavailableReason ?? "provider unavailable"}`
    : "";
  return `${agent.name} (${agent.provider}${model}${thinking}${availability})`;
}

function formatUnavailableAgentProvider(provider: LocalAgentProviderAvailability): string {
  return `${provider.name} (${provider.reason ?? "unavailable"})`;
}

const workspaceSkillOutputSchema = z.object({
  skillId: z.string(),
  name: z.string(),
  description: z.string(),
  path: z.string(),
  source: z.string(),
  scope: z.string(),
  allowImplicitInvocation: z.boolean(),
});

export const MAX_SKILL_CATALOG_CHARACTERS = 8_000;

export interface WorkspaceSkillCatalogEntry {
  skillId: string;
  name: string;
  description: string;
  path: string;
  source: string;
  scope: string;
  allowImplicitInvocation: boolean;
}

export interface WorkspaceSkillCatalog {
  skills: WorkspaceSkillCatalogEntry[];
  totalSkills: number;
  omittedSkills: number;
  truncated: boolean;
  characters: number;
}

function truncateCatalogDescription(description: string, maximum: number): string {
  if (description.length <= maximum) return description;
  if (maximum <= 1) return "…".slice(0, maximum);
  return `${description.slice(0, maximum - 1)}…`;
}

/** Builds the model-visible catalog under one exact serialized-character budget. */
export function buildWorkspaceSkillCatalog(
  skills: readonly Skill[],
  maximumCharacters = MAX_SKILL_CATALOG_CHARACTERS,
): WorkspaceSkillCatalog {
  const entries: WorkspaceSkillCatalogEntry[] = [];
  let truncated = false;

  for (const skill of skills) {
    const base: WorkspaceSkillCatalogEntry = {
      skillId: skill.skillId,
      name: skill.name,
      description: truncateCatalogDescription(skill.description, 1_024),
      path: formatPathForPrompt(skill.filePath),
      source: skill.source,
      scope: skill.scope,
      allowImplicitInvocation: skill.allowImplicitInvocation,
    };
    if (base.description !== skill.description) truncated = true;

    let candidate = base;
    let serializedLength = JSON.stringify([...entries, candidate]).length;
    if (serializedLength > maximumCharacters && candidate.description.length > 80) {
      const excess = serializedLength - maximumCharacters;
      candidate = {
        ...candidate,
        description: truncateCatalogDescription(
          candidate.description,
          Math.max(80, candidate.description.length - excess),
        ),
      };
      serializedLength = JSON.stringify([...entries, candidate]).length;
      truncated = true;
    }

    if (serializedLength > maximumCharacters) {
      truncated = true;
      continue;
    }
    entries.push(candidate);
  }

  return {
    skills: entries,
    totalSkills: skills.length,
    omittedSkills: skills.length - entries.length,
    truncated,
    characters: JSON.stringify(entries).length,
  };
}

const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const workspaceLocalAgentOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  thinking: z.string().optional(),
  providerAvailable: z.boolean().optional(),
  providerUnavailableReason: z.string().optional(),
});

const DEFAULT_PROCESS_OUTPUT_READ_BYTES = 40_000;
const MAX_PROCESS_OUTPUT_READ_BYTES = 40_000;

const batchItemOutputSchema = z.object({
  index: z.number().int().nonnegative(),
  operation: z.string(),
  path: z.string(),
  ok: z.boolean(),
  result: z.string(),
  truncated: z.boolean(),
});

const reviewFileOutputSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  type: z.enum(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  additions: z.number(),
  removals: z.number(),
});

const reviewSummaryOutputSchema = z.object({
  files: z.number(),
  additions: z.number(),
  removals: z.number(),
});

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
  id: string | number | null = null,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id,
  });
}

function sendCallToolErrorResult(
  res: Response,
  message: string,
  id: string | number | null,
): void {
  res.status(200).json({
    jsonrpc: "2.0",
    result: {
      content: [{ type: "text", text: message }],
      isError: true,
    },
    id,
  });
}

export function jsonRpcRequestId(body: unknown): string | number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

export function recoverableWorkspaceError(error: unknown): string | undefined {
  return error instanceof UnknownWorkspaceError ? error.message : undefined;
}

export function workspaceOperationId(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const request = body as { method?: unknown; params?: unknown };
  if (request.method !== "tools/call" || !request.params || typeof request.params !== "object") {
    return undefined;
  }
  const params = request.params as { name?: unknown; arguments?: unknown };
  if (params.name === "open_workspace" || params.name === "close_workspace") return undefined;
  if (!params.arguments || typeof params.arguments !== "object") return undefined;
  const workspaceId = (params.arguments as { workspaceId?: unknown }).workspaceId;
  return typeof workspaceId === "string" && workspaceId.length > 0 ? workspaceId : undefined;
}

export function containsBatchedToolCall(body: unknown): boolean {
  return Array.isArray(body) && body.some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    return (entry as { method?: unknown }).method === "tools/call";
  });
}

function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
}

function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
  if (!config.logging.toolCalls) return;

  const { command, ...safeFields } = fields;
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    requestId: requestContext.getStore()?.requestId,
    clientIdHash: identifierHash(requestContext.getStore()?.clientId),
    ...safeFields,
    commandPreview: config.logging.shellCommands && command ? commandPreview(command) : undefined,
  });
}

function contentText(content: ToolContent[]): string {
  return content
    .filter(
      (item): item is { type: "text"; text: string } => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

function toolErrorPreview(content: ToolContent[]): string | undefined {
  const text = contentText(content).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function logFailedToolResponse(
  config: ServerConfig,
  fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
  content: ToolContent[],
  startedAt: number,
): void {
  logToolCall(config, {
    ...fields,
    success: false,
    durationMs: Math.round(performance.now() - startedAt),
    error: toolErrorPreview(content),
  });
}

function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

export function staleOAuthClientHtml(uiLocales: string | undefined): string {
  const chinese = uiLocales?.toLowerCase().startsWith("zh") ?? false;
  const title = chinese ? "连接注册已失效" : "Connector registration expired";
  const detail = chinese
    ? "ChatGPT 仍在使用一个已从 DevSpace 删除的 OAuth client_id。仅再次点击“连接”会继续复用这个旧 ID。"
    : "ChatGPT is still using an OAuth client_id that no longer exists in DevSpace. Clicking Connect again will keep reusing that stale ID.";
  const action = chinese
    ? "请关闭此页面，在 ChatGPT 中删除当前 DevSpace 连接或插件，然后重新添加它。ChatGPT 会通过动态注册获得新的客户端 ID，再使用 Owner 密码授权。"
    : "Close this page, remove the current DevSpace connection or app in ChatGPT, then add it again. ChatGPT will dynamically register a new client before Owner-password approval.";
  return `<!doctype html>
<html lang="${chinese ? "zh-CN" : "en"}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #171717; color: #f5f5f5; }
      main { max-width: 560px; margin: 12vh auto; padding: 32px; background: #262626; border: 1px solid #525252; border-radius: 16px; box-shadow: 0 24px 70px rgba(0,0,0,.35); }
      h1 { margin: 0 0 16px; font-size: 28px; }
      p { margin: 12px 0; color: #d4d4d4; line-height: 1.65; }
      .action { padding: 16px; border-radius: 10px; background: #404040; color: #fafafa; }
      code { color: #fde68a; }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>${detail}</p>
      <p class="action">${action}</p>
      <p><code>invalid_client</code></p>
    </main>
  </body>
</html>`;
}

function sendStaleOAuthClientPage(res: Response, uiLocales: string | undefined): void {
  res.status(400);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  );
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.send(staleOAuthClientHtml(uiLocales));
}

function applicableAgentsNotice(
  files: Array<{ path: string; content: string }>,
  workspaceRoot: string,
): string | undefined {
  if (files.length === 0) return undefined;
  const rendered = files.map((file) => {
    const path = formatAgentsPath(file.path, workspaceRoot);
    return `### ${path}\n${file.content}`;
  }).join("\n\n");
  return `New applicable project instructions were loaded lazily. Follow them for subsequent work in their scope.\n\n${rendered}`;
}

export function combineBatchItemsWithInstructions(
  batchItems: BatchItemResult[],
  batchTruncated: boolean,
  agentsNotice: string | undefined,
): {
  items: BatchItemResult[];
  truncated: boolean;
  instructions?: string;
  instructionsDelivered: boolean;
  warning?: string;
} {
  if (!agentsNotice) {
    return { items: batchItems, truncated: batchTruncated, instructionsDelivered: false };
  }
  if (agentsNotice.length > BATCH_TOTAL_MAX_CHARACTERS) {
    const warning = "Applicable project instructions exceeded the batch response budget and were not marked delivered. Use read on one target path before continuing.";
    const limited = limitBatchItems(batchItems, BATCH_TOTAL_MAX_CHARACTERS - warning.length);
    return {
      items: limited.items,
      truncated: true,
      instructionsDelivered: false,
      warning,
    };
  }

  const limited = limitBatchItems(batchItems, BATCH_TOTAL_MAX_CHARACTERS - agentsNotice.length);
  return {
    items: limited.items,
    instructions: agentsNotice,
    truncated: batchTruncated || limited.truncated,
    instructionsDelivered: true,
  };
}

function limitBatchItems(
  batchItems: BatchItemResult[],
  maximumCharacters: number,
): { items: BatchItemResult[]; truncated: boolean } {
  let remaining = Math.max(0, maximumCharacters);
  let truncated = false;
  const items = batchItems.map((item) => {
    const limited = limitBatchText(item.result, remaining);
    remaining = Math.max(0, remaining - limited.text.length);
    truncated ||= limited.truncated;
    return {
      ...item,
      result: limited.text,
      truncated: item.truncated || limited.truncated,
    };
  });
  return { items, truncated };
}

async function applicableMutationGate(
  workspaces: WorkspaceRegistry,
  workspace: Workspace,
  paths: string[],
  instructionToken?: string,
): Promise<{ content: ToolContent[]; isError: true } | undefined> {
  let generation = workspaces.instructionAcknowledgementGeneration(workspace);
  if (instructionToken) {
    await workspaces.acknowledgeInstructions(workspace, instructionToken);
    generation = workspaces.instructionAcknowledgementGeneration(workspace);
  }
  const files = await workspaces.loadApplicableAgentsFiles(
    workspace,
    paths,
    { requireAcknowledged: true },
  );
  if (workspaces.instructionAcknowledgementGeneration(workspace) !== generation) {
    return {
      content: [textBlock(
        "No mutation or command was executed because applicable instructions were acknowledged by another concurrent call. Retry this tool call.",
      )],
      isError: true,
    };
  }
  if (files.length === 0) return undefined;
  const token = await workspaces.createInstructionAcknowledgement(workspace, files);
  const notice = applicableAgentsNotice(files, workspace.root)!;
  return {
    content: [textBlock(
      `No mutation or command was executed because new scoped instructions must be reviewed first. Follow them, then retry the same tool call with instructionToken=${token}.\n\n${notice}`,
    )],
    isError: true,
  };
}

export function commandInstructionScopePaths(
  workspaceRoot: string,
  command: string,
  cwd: string,
  workingDirectory: string | undefined,
): { paths: string[] } | { error: { content: ToolContent[]; isError: true } } {
  if (isInteractiveShellCommand(command)) {
    return { paths: [workingDirectory ?? "."] };
  }
  const analysis = analyzeShellCommandScopes(command, cwd, workspaceRoot);
  if (analysis.unresolvedCwds.length > 0) {
    const unresolved = analysis.unresolvedCwds
      .map((entry) => `${entry.fragment} (${entry.reason})`)
      .join(", ");
    return {
      error: {
        content: [textBlock(
          "No command was executed because a shell directory change could not be checked against scoped project instructions. " +
          "Use the workingDirectory field or a literal cd/pushd path, then retry. " +
          `Unresolved directory change: ${unresolved}`,
        )],
        isError: true,
      },
    };
  }

  return {
    paths: [workingDirectory ?? ".", ...analysis.staticCwds],
  };
}

export function processInputInstructionScopePaths(
  workspaceRoot: string,
  chars: string | undefined,
  processContext: {
    cwd: string;
    scopePaths: string[];
    inputMode?: "shell" | "opaque";
    pendingInput?: string;
    inputRevision?: number;
  },
  options: { flushPending?: boolean } = {},
):
  | { paths: string[]; preparedInput: PreparedProcessInput }
  | { error: { content: ToolContent[]; isError: true } }
  | undefined {
  if (processContext.inputMode === "opaque") return undefined;
  if (
    (chars === undefined || chars.length === 0) &&
    !(options.flushPending && (processContext.pendingInput?.length ?? 0) > 0)
  ) return undefined;
  if (chars?.includes("\u0003")) {
    if (chars !== "\u0003") {
      return {
        error: {
          content: [textBlock(
            "No process input was sent because Ctrl-C must be sent in a separate write_stdin call.",
          )],
          isError: true,
        },
      };
    }
    return {
      paths: [],
      preparedInput: {
        expectedRevision: processContext.inputRevision ?? 0,
        pendingInput: "",
        charsToWrite: "\u0003",
        nextCwd: processContext.cwd,
        instructionScopePaths: [],
      },
    };
  }

  const combinedInput = `${processContext.pendingInput ?? ""}${chars ?? ""}`;
  if (Buffer.byteLength(combinedInput, "utf8") > MAX_PROCESS_INPUT_BYTES) {
    return {
      error: {
        content: [textBlock(`Process input exceeds the ${MAX_PROCESS_INPUT_BYTES}-byte limit.`)],
        isError: true,
      },
    };
  }
  const newlineIndex = Math.max(combinedInput.lastIndexOf("\n"), combinedInput.lastIndexOf("\r"));
  if (newlineIndex < 0 && !options.flushPending) {
    return {
      paths: [],
      preparedInput: {
        expectedRevision: processContext.inputRevision ?? 0,
        pendingInput: combinedInput,
        charsToWrite: "",
        nextCwd: processContext.cwd,
        instructionScopePaths: [],
      },
    };
  }

  const completeInput = options.flushPending
    ? combinedInput
    : combinedInput.slice(0, newlineIndex + 1);
  const pendingInput = options.flushPending ? "" : combinedInput.slice(newlineIndex + 1);
  const paths = new Set(processContext.scopePaths);
  let currentCwd = processContext.cwd;
  for (const command of completeInput.split(/\r\n|\n|\r/u)) {
    if (command.trim().length === 0) continue;
    if (hasUntrackableInteractiveCwd(command)) {
      return {
        error: {
          content: [textBlock(
            "No process input was sent because eval, source, aliases, or shell functions can change an interactive cwd without a verifiable path. Use one standalone literal `cd path` line, or start a new exec_command with workingDirectory.",
          )],
          isError: true,
        },
      };
    }
    const inputScopes = commandInstructionScopePaths(
      workspaceRoot,
      command,
      currentCwd,
      currentCwd,
    );
    if ("error" in inputScopes) return inputScopes;
    for (const path of inputScopes.paths) paths.add(path);

    const analysis = analyzeShellCommandScopes(command, currentCwd, workspaceRoot);
    if (analysis.staticCwds.length > 0) {
      const standaloneCd = /^\s*cd(?:\s+--)?\s+[^;&|<>]+\s*$/u.test(command);
      if (!standaloneCd || analysis.staticCwds.length !== 1) {
        return {
          error: {
            content: [textBlock(
              "No process input was sent because interactive directory changes must use one standalone literal cd command per line. Send `cd path` first, then send the next command in a later line or write_stdin call.",
            )],
            isError: true,
          },
        };
      }
      currentCwd = analysis.staticCwds[0]!;
    }
  }
  return {
    paths: [...paths],
    preparedInput: {
      expectedRevision: processContext.inputRevision ?? 0,
      pendingInput,
      charsToWrite: completeInput,
      nextCwd: currentCwd,
      instructionScopePaths: [...paths],
    },
  };
}

function hasUntrackableInteractiveCwd(command: string): boolean {
  const trimmed = command.trim();
  return (
    /(?:^|&&|\|\||[;|&])\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+)\s+)*(?:(?:command|builtin)\s+)?(?:eval|source|\.)\b/u.test(trimmed) ||
    /(?:^|&&|\|\||[;|&])\s*(?:alias|unalias|function)\b/u.test(trimmed) ||
    /(?:^|&&|\|\||[;|&])\s*[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)\s*\{/u.test(trimmed)
  );
}

export function processInputPolicyViolation(
  preparedInput: PreparedProcessInput | undefined,
  context?: { cwd: string; workspaceRoot: string },
): string | undefined {
  const command = preparedInput?.charsToWrite;
  if (!command || command === "\u0003") return undefined;
  const policy = classifyCommand(command);
  if (policy.decision === "deny") {
    return `Process input blocked by command policy: ${policy.reason}\n${policy.advice ?? ""}`.trim();
  }
  if (context) {
    const violation = validateShellWriteTargets(command, context.cwd, context.workspaceRoot);
    if (violation) return `Process input blocked: ${violation.reason}`;
  }
  return undefined;
}

function textSummary(content: ToolContent[]): {
  lines: number;
  characters: number;
} {
  const text = contentText(content);
  return {
    lines: text.length === 0 ? 0 : text.split("\n").length,
    characters: text.length,
  };
}

function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n")
    ? content.slice(0, -1).split("\n").length
    : content.split("\n").length;
}

function countDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { additions: 0, removals: 0 };

  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { additions, removals };
}

function newFilePatch(path: string, content: string): string {
  const lines =
    content.length === 0
      ? []
      : content.endsWith("\n")
        ? content.slice(0, -1).split("\n")
        : content.split("\n");
  const hunkLength = lines.length;
  const hunkRange = hunkLength === 0 ? "+0,0" : `+1,${hunkLength}`;
  const body = lines.map((line) => `+${line}`).join("\n");

  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 ${hunkRange} @@`,
    body,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function assetBaseUrl(config: ServerConfig): string {
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
}

function uiManifestUrl(): URL {
  return new URL("../dist/ui/.vite/manifest.json", import.meta.url);
}

function readWorkspaceAppManifest(): WorkspaceAppManifest {
  return JSON.parse(readFileSync(uiManifestUrl(), "utf8")) as WorkspaceAppManifest;
}

function getWorkspaceAppManifestEntry(): WorkspaceAppManifestEntry {
  const manifest = readWorkspaceAppManifest();
  const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];

  if (!entry?.file) {
    throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
  }

  return entry;
}

export function workspaceAppAssetPaths(): Set<string> {
  const manifest = readWorkspaceAppManifest();
  const assets = new Set<string>();
  const visited = new Set<string>();

  const visit = (key: string): void => {
    if (visited.has(key)) return;
    visited.add(key);
    const entry = manifest[key];
    if (!entry) return;
    assets.add(entry.file);
    for (const path of [...(entry.css ?? []), ...(entry.assets ?? [])]) assets.add(path);
    for (const dependency of [...(entry.imports ?? []), ...(entry.dynamicImports ?? [])]) {
      visit(dependency);
    }
  };

  visit(WORKSPACE_APP_MANIFEST_ENTRY);
  return assets;
}

function assetUrl(baseUrl: string, assetPath: string): string {
  return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}

function workspaceAppHtml(config: ServerConfig): string {
  const baseUrl = assetBaseUrl(config);
  const entry = getWorkspaceAppManifestEntry();
  const stylesheets = (entry.css ?? [])
    .map(
      (stylesheet) =>
        `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevSpace Workspace</title>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app" class="shell">
      <section class="empty">Waiting for a tool result.</section>
    </main>
  </body>
</html>`;
}

function appCsp(config: ServerConfig): {
  resourceDomains: string[];
  connectDomains: string[];
} {
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  return {
    resourceDomains: [publicBaseUrl],
    connectDomains: [publicBaseUrl],
  };
}

function uiBuildDirectory(): string {
  return fileURLToPath(new URL("../dist/ui", import.meta.url));
}

function setAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

async function assertWorkspaceAppAssets(): Promise<void> {
  const candidates = [...workspaceAppAssetPaths()].map(
    (assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url),
  );

  for (const candidate of candidates) {
    await access(candidate);
  }
}

export function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? `Process running with session ID ${snapshot.sessionId}.` +
      (snapshot.stdinClosed ? " Stdin is closed; poll only." : "")
    : snapshot.signal
      ? `Process exited after signal ${snapshot.signal}.`
      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  const truncationNote = snapshot.outputTruncated
    ? `\n[inline output truncated: head + tail retained, ~${snapshot.outputOmittedBytes} bytes omitted, original ~${snapshot.originalTokenCount} tokens]` +
      (snapshot.outputId
        ? `\n[recover retained output with ${toolNames.readProcessOutput}: outputId=${snapshot.outputId}, offset=0]`
        : "")
    : "";
  const durableNote = snapshot.droppedBytes > 0
    ? `\n[durable output quota reached: ${snapshot.droppedBytes} bytes were irrecoverably dropped]`
    : snapshot.outputStorageError
      ? `\n[durable output unavailable: ${snapshot.outputStorageError}]`
      : "";
  return snapshot.output
    ? `${snapshot.output.replace(/\n$/, "")}\n${status}${truncationNote}${durableNote}`
    : `${status}${truncationNote}${durableNote}`;
}

function processOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    sessionId: z.number().optional(),
    running: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    wallTimeMs: z.number().nonnegative(),
    outputTruncated: z.boolean(),
    outputId: z.string().optional(),
    droppedBytes: z.number().int().nonnegative(),
    timedOut: z.boolean(),
    ...extra,
  };
}

function processToolResponse(
  tool: "exec_command" | "write_stdin" | "bash",
  workspaceId: string,
  snapshot: ProcessSnapshot,
  summary: Record<string, unknown>,
) {
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  const outputSummary = textSummary(snapshot.output ? [textBlock(snapshot.output)] : []);
  return {
    content,
    _meta: {
      tool,
      card: {
        workspaceId,
        summary: { ...summary, ...outputSummary },
      },
    },
    structuredContent: {
      sessionId: snapshot.sessionId,
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      wallTimeMs: snapshot.wallTimeMs,
      outputTruncated: snapshot.outputTruncated,
      outputId: snapshot.outputId,
      droppedBytes: snapshot.droppedBytes,
      timedOut: snapshot.timedOut,
    },
  };
}

function registerWriteStdinTool(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  processSessions: ProcessSessionManager,
  ownerClientId: string,
  options: { startedBy: "exec_command" | "bash" },
): void {
  const startedBy =
    options.startedBy === "bash"
      ? `${toolNames.shell} (run_in_background) or exec_command`
      : "exec_command";

  registerAppTool(
    server,
    toolNames.writeStdin,
    {
      title: "Write to process",
      description: "Poll or write a process. Unknown sessionId means rerun the command.",
      inputSchema: {
        workspaceId: z.string(),
        instructionToken: z
          .string()
          .optional()
          .describe("Scoped instruction token."),
        sessionId: z
          .number()
          .describe(`Session ID from ${startedBy}.`),
        chars: z
          .string()
          .max(MAX_PROCESS_INPUT_BYTES)
          .optional()
          .describe("Input; omit to poll."),
        closeStdin: z
          .boolean()
          .optional()
          .describe("Close pipe stdin; unavailable for PTY."),
        columns: z.number().int().min(1).max(1_000).optional().describe("PTY width."),
        rows: z.number().int().min(1).max(1_000).optional().describe("PTY height."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(600_000)
          .optional()
          .describe("Wait ms; default 5000 polling or 250 writing."),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Inline token budget; default 10000."),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, instructionToken, sessionId, chars, closeStdin, columns, rows, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(ownerClientId, workspaceId);
      const processContext = processSessions.instructionContext(
        ownerClientId,
        workspaceId,
        sessionId,
      );
      const inputScopes = processInputInstructionScopePaths(
        workspace.root,
        chars,
        processContext,
        { flushPending: closeStdin === true },
      );
      if (inputScopes) {
        if ("error" in inputScopes) return inputScopes.error;
        const policyViolation = processInputPolicyViolation(inputScopes.preparedInput, {
          cwd: processContext.cwd,
          workspaceRoot: workspace.root,
        });
        if (policyViolation) {
          const content = [textBlock(policyViolation)];
          logFailedToolResponse(
            config,
            { tool: toolNames.writeStdin, workspaceId },
            content,
            startedAt,
          );
          return { content, isError: true };
        }
        const instructionGate = await applicableMutationGate(
          workspaces,
          workspace,
          inputScopes.paths,
          instructionToken,
        );
        if (instructionGate) return instructionGate;
      }
      const snapshot = await processSessions.write({
        ownerClientId,
        workspaceId,
        sessionId,
        chars,
        closeStdin,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
        preparedInput: inputScopes && "paths" in inputScopes
          ? inputScopes.preparedInput
          : undefined,
      });

      logToolCall(config, {
        tool: toolNames.writeStdin,
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return processToolResponse(toolNames.writeStdin as "write_stdin", workspaceId, snapshot, {
        sessionId,
        charactersWritten: inputScopes && "paths" in inputScopes
          ? inputScopes.preparedInput.charsToWrite.length
          : chars?.length ?? 0,
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );
}

function registerReadProcessOutputTool(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  processSessions: ProcessSessionManager,
  processOutputStore: ProcessOutputStore,
  ownerClientId: string,
): void {
  registerAppTool(
    server,
    toolNames.readProcessOutput,
    {
      title: "Read process output",
      description:
        "Page retained command output by outputId and byte offset.",
      inputSchema: {
        workspaceId: z.string(),
        outputId: z.string().describe("Output ID from a process tool."),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Byte offset; default 0."),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_PROCESS_OUTPUT_READ_BYTES)
          .optional()
          .describe(`Page bytes; default ${DEFAULT_PROCESS_OUTPUT_READ_BYTES}.`),
      },
      outputSchema: {
        outputId: z.string(),
        offset: z.number().int().nonnegative(),
        nextOffset: z.number().int().nonnegative(),
        eof: z.boolean(),
        status: z.enum(["active", "completed", "unknown"]),
        totalBytes: z.number().int().nonnegative(),
        storedBytes: z.number().int().nonnegative(),
        droppedBytes: z.number().int().nonnegative(),
      },
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ workspaceId, outputId, offset, limit }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(ownerClientId, workspaceId);
      processSessions.flushOutput(ownerClientId, workspaceId, outputId);
      const page = processOutputStore.read(ownerClientId, workspaceId, outputId, {
        offset: offset ?? 0,
        limit: limit ?? DEFAULT_PROCESS_OUTPUT_READ_BYTES,
      });
      const notes = [
        `Process output ${outputId}: bytes ${page.offset}-${page.nextOffset} of ${page.storedBytes} stored (${page.status}).`,
        page.droppedBytes > 0
          ? `${page.droppedBytes} byte(s) exceeded the durable quota and cannot be recovered.`
          : undefined,
        !page.eof
          ? `Continue with offset=${page.nextOffset}.`
          : page.status === "active"
            ? "Reached the current end; more output may arrive while the process is running."
            : "Reached the retained end of output.",
      ].filter((value): value is string => Boolean(value));
      const result = page.content
        ? `${notes.join("\n")}\n\n${page.content}`
        : notes.join("\n");
      const { content: _pageContent, ...pageMetadata } = page;
      logToolCall(config, {
        tool: toolNames.readProcessOutput,
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(result)],
        _meta: {
          tool: toolNames.readProcessOutput,
          card: {
            workspaceId,
            summary: {
              offset: page.offset,
              nextOffset: page.nextOffset,
              eof: page.eof,
              status: page.status,
              storedBytes: page.storedBytes,
              droppedBytes: page.droppedBytes,
            },
          },
        },
        structuredContent: { outputId, ...pageMetadata },
      };
    },
  );
}

function registerCodexProcessTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  processSessions: ProcessSessionManager,
  ownerClientId: string,
): void {
  registerAppTool(
    server,
    "exec_command",
    {
      title: "Execute command",
      description: "Run a terminal command. Returns sessionId while the process is still running.",
      inputSchema: {
        workspaceId: z.string(),
        instructionToken: z.string().optional().describe("Scoped instruction token."),
        cmd: z.string().min(1).max(SHELL_COMMAND_MAX_CHARACTERS).describe("Command."),
        stdin: z
          .string()
          .max(MAX_PROCESS_INPUT_BYTES)
          .optional()
          .describe("Initial stdin; closes by default."),
        closeStdin: z
          .boolean()
          .optional()
          .describe("Close after stdin; defaults true. PTY requires false."),
        tty: z
          .boolean()
          .optional()
          .describe("Allocate a PTY; default false."),
        columns: z.number().int().min(1).max(1_000).optional().describe("PTY width; default 80."),
        rows: z.number().int().min(1).max(1_000).optional().describe("PTY height; default 24."),
        workingDirectory: z
          .string()
          .optional()
          .describe("Workspace-relative cwd; default root."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(600_000)
          .optional()
          .describe("Wait ms before yielding; default 10000."),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Inline token budget; default 10000."),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, instructionToken, cmd, stdin, closeStdin, tty, columns, rows, workingDirectory, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(ownerClientId, workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
      const commandScopes = commandInstructionScopePaths(
        workspace.root,
        cmd,
        cwd,
        workingDirectory,
      );
      if ("error" in commandScopes) return commandScopes.error;
      const effectiveCloseStdin = closeStdin ?? stdin !== undefined;
      let instructionScopePaths = commandScopes.paths;
      if (isInteractiveShellCommand(cmd) && stdin !== undefined) {
        if (!effectiveCloseStdin) {
          return {
            content: [textBlock(
              "Initial stdin for a direct interactive shell must close after the script. Set closeStdin=true, or start the shell first and use write_stdin.",
            )],
            isError: true,
          };
        }
        const initialInputScopes = processInputInstructionScopePaths(
          workspace.root,
          stdin,
          {
            cwd,
            scopePaths: commandScopes.paths,
            inputMode: "shell",
            pendingInput: "",
            inputRevision: 0,
          },
          { flushPending: true },
        );
        if (initialInputScopes) {
          if ("error" in initialInputScopes) return initialInputScopes.error;
          const inputPolicyViolation = processInputPolicyViolation(initialInputScopes.preparedInput, {
            cwd,
            workspaceRoot: workspace.root,
          });
          if (inputPolicyViolation) {
            return { content: [textBlock(inputPolicyViolation)], isError: true };
          }
          instructionScopePaths = [...new Set([
            ...instructionScopePaths,
            ...initialInputScopes.paths,
          ])];
        }
      }
      const instructionGate = await applicableMutationGate(
        workspaces,
        workspace,
        instructionScopePaths,
        instructionToken,
      );
      if (instructionGate) return instructionGate;

      const policy = classifyCommand(cmd);
      if (policy.decision === "deny") {
        const text = `Command blocked by command policy: ${policy.reason}\n${policy.advice ?? ""}`.trim();
        const content = [textBlock(text)];
        logFailedToolResponse(
          config,
          {
            tool: "exec_command",
            workspaceId,
            workingDirectory: workingDirectory ?? ".",
            command: cmd,
            commandLength: cmd.length,
          },
          content,
          startedAt,
        );
        return {
          content,
          isError: true,
          structuredContent: {
            running: false,
            wallTimeMs: Math.round(performance.now() - startedAt),
            outputTruncated: false,
            droppedBytes: 0,
            timedOut: false,
          },
        };
      }

      const writeTargetViolation = validateShellWriteTargets(cmd, cwd, workspace.root);
      if (writeTargetViolation) {
        const content = [textBlock(`Command blocked: ${writeTargetViolation.reason}`)];
        logFailedToolResponse(
          config,
          {
            tool: "exec_command",
            workspaceId,
            workingDirectory: workingDirectory ?? ".",
            command: cmd,
            commandLength: cmd.length,
          },
          content,
          startedAt,
        );
        return {
          content,
          isError: true,
          structuredContent: {
            running: false,
            wallTimeMs: Math.round(performance.now() - startedAt),
            outputTruncated: false,
            droppedBytes: 0,
            timedOut: false,
          },
        };
      }

      const snapshot = await processSessions.start({
        ownerClientId,
        workspaceId,
        command: cmd,
        cwd,
        workspaceRoot: workspace.root,
        tty,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
        instructionScopePaths,
        instructionInputMode: isInteractiveShellCommand(cmd) ? "shell" : "opaque",
        stdin,
        closeStdin,
      });

      logToolCall(config, {
        tool: "exec_command",
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: cmd,
        commandLength: cmd.length,
        stdinBytes: stdin === undefined ? 0 : Buffer.byteLength(stdin, "utf8"),
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return processToolResponse("exec_command", workspaceId, snapshot, {
        command: cmd,
        workingDirectory: workingDirectory ?? ".",
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );

  registerWriteStdinTool(server, config, workspaces, processSessions, ownerClientId, {
    startedBy: "exec_command",
  });
}

function createMcpServer(
  config: ServerConfig,
  ownerClientId: string,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  processOutputStore: ProcessOutputStore,
  localAgentProviders: LocalAgentProviderAvailability[],
  runtimeDiagnostics: RuntimeDiagnostics,
  activeToolHandlers: ActiveRequestBarrier,
): McpServer {
  const server = new McpServer(
    DEVSPACE_SERVER_INFO,
    {
      instructions: serverInstructions(config),
    },
  );
  const enabledTools = new Set(toolSurface(config));
  toolHandlerBarriers.set(server, activeToolHandlers);
  registerReadProcessOutputTool(
    server,
    config,
    workspaces,
    processSessions,
    processOutputStore,
    ownerClientId,
  );

  registerAppResource(
    server,
    "DevSpace Diff Card",
    WORKSPACE_APP_URI,
    {
      description: "Interactive card for viewing DevSpace file diffs.",
      _meta: {
        ui: {
          csp: appCsp(config),
        },
      },
    },
    async () => {
      await assertWorkspaceAppAssets();
      return {
        contents: [
          {
            uri: WORKSPACE_APP_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: workspaceAppHtml(config),
            _meta: {
              "openai/widgetDescription":
                "Interactive DevSpace card for workspace details, tool results, and aggregate file changes.",
              ui: {
                csp: appCsp(config),
              },
            },
          },
        ],
      };
    },
  );

  registerAppTool(
    server,
    "open_workspace",
    {
      title: "Open workspace",
      description:
        "Open or recover an allowed local project. Replace any rejected workspaceId with the returned ID.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Allowed absolute or ~/ project path.",
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "checkout (default) or an isolated managed worktree.",
          ),
        baseRef: z
          .string()
          .optional()
          .describe("Worktree base ref; defaults to HEAD."),
      },
      outputSchema: {
        workspaceId: z.string(),
        reused: z.boolean(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        agentsFiles: z.array(workspaceAgentsFileOutputSchema),
        skills: z.array(workspaceSkillOutputSchema),
        skillsOmitted: z.number().int().nonnegative(),
        agents: z.array(workspaceLocalAgentOutputSchema).optional(),
      },
      ...toolWidgetDescriptorMeta(config, "workspace", {
        invoking: "Opening workspace…",
        invoked: "Workspace opened",
      }),
      annotations: OPEN_WORKSPACE_ANNOTATIONS,
    },
    async ({ path, mode, baseRef }) => {
      const startedAt = performance.now();
      const { workspace, agentsFiles, availableAgentsFiles, instructionScan, reused } = await workspaces.openWorkspace(
        ownerClientId,
        { path, mode, baseRef },
      );
      if (enabledTools.has("show_changes")) {
        await reviewCheckpoints.initializeWorkspace({
          workspaceId: workspace.id,
          root: workspace.root,
        });
        void reviewCheckpoints.cleanupStaleRefs({
          gitRoot: workspace.root,
          activeWorkspaceIds: reviewCheckpoints.activeWorkspaceIds(),
        }).catch((error) => {
          runtimeDiagnostics.recordFailure("review_ref_cleanup_failed", error);
          logEvent(config.logging, "warn", "review_ref_cleanup_failed", {
            workspaceId: workspace.id,
            ...errorFields(error),
          });
        });
      }
      const skillCatalog = buildWorkspaceSkillCatalog(workspace.skills);
      const visibleSkills = skillCatalog.skills;
      const visibleAgentProviders = config.subagents ? localAgentProviders : [];
      const visibleAgents = workspace.agentProfiles.map((profile) => {
        const summary = summarizeLocalAgentProfile(profile);
        const availability = visibleAgentProviders.find((provider) => provider.name === summary.provider);
        return {
          ...summary,
          providerAvailable: availability?.available,
          providerUnavailableReason: availability?.reason,
        };
      });
      const loadedAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const availableAgentsFileOutputs = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const instruction = config.skillsEnabled
        ? `Follow loaded agentsFiles instructions. Nested project instructions are loaded lazily when later tools enter their scope. When a task matches an available skill, call ${toolNames.loadSkill} with its skillId before proceeding; load it again after backend restart or workspace recovery. Only load a skill with allowImplicitInvocation=false when the user explicitly names or requests it.`
        : "Follow loaded agentsFiles instructions. Nested project instructions are loaded lazily when later tools enter their scope.";
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            `${reused ? "Reused" : "Opened"} workspace ${workspace.id}`,
            `Root: ${workspace.root}`,
            `Mode: ${workspace.mode}`,
            workspace.sourceRoot ? `Source root: ${workspace.sourceRoot}` : undefined,
            workspace.worktree ? `Worktree base: ${workspace.worktree.baseRef} (${workspace.worktree.baseSha})` : undefined,
            loadedAgentsFiles.length > 0
              ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
              : undefined,
            "Nested project instructions: lazy path-based loading enabled.",
            !instructionScan.complete
              ? `Warning: nested instruction scan was incomplete (${instructionScan.reason ?? "unknown"}); some instruction files may be missing.`
              : undefined,
            visibleSkills.length > 0
              ? `Available skills: ${visibleSkills.length} shown of ${skillCatalog.totalSkills}; use the structured skills catalog and load_skill.`
              : undefined,
            skillCatalog.omittedSkills > 0
              ? `Skill catalog budget reached: ${skillCatalog.omittedSkills} of ${skillCatalog.totalSkills} skill(s) omitted.`
              : undefined,
            visibleAgentProviders.some((provider) => provider.available)
              ? `Available subagent providers: ${visibleAgentProviders.filter((provider) => provider.available).map((provider) => provider.name).join(", ")}`
              : undefined,
            visibleAgentProviders.some((provider) => !provider.available)
              ? `Unavailable subagent providers: ${visibleAgentProviders.filter((provider) => !provider.available).map(formatUnavailableAgentProvider).join(", ")}`
              : undefined,
            visibleAgents.length > 0
              ? `Available subagent profiles: ${visibleAgents.map(formatVisibleAgent).join(", ")}`
              : undefined,
            workspace.skillDiagnostics.length > 0
              ? `Skill discovery warnings: ${workspace.skillDiagnostics.length}.`
              : undefined,
            instruction,
          ].filter(Boolean).join("\n"),
        },
      ];
      logToolCall(config, {
        tool: "open_workspace",
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      if (!instructionScan.complete) {
        logEvent(config.logging, "warn", "workspace_instruction_scan_incomplete", {
          clientIdHash: identifierHash(ownerClientId),
          workspaceId: workspace.id,
          reason: instructionScan.reason,
          directoriesScanned: instructionScan.directoriesScanned,
          entriesScanned: instructionScan.entriesScanned,
          unreadableDirectories: instructionScan.unreadableDirectories,
          durationMs: instructionScan.durationMs,
        });
      }

      return {
        content: resultContent,
        _meta: {
          tool: "open_workspace",
          card: {
            workspaceId: workspace.id,
            root: workspace.root,
            path: workspace.root,
            summary: {
              mode: workspace.mode,
              reused,
              agentsFiles: loadedAgentsFiles.length,
              availableAgentsFiles: availableAgentsFileOutputs.length,
              skills: visibleSkills.length,
              agentProviders: visibleAgentProviders.length,
              agents: visibleAgents.length,
              skillDiagnostics: workspace.skillDiagnostics.length,
              instructionScanComplete: instructionScan.complete,
            },
          },
        },
        structuredContent: {
          workspaceId: workspace.id,
          reused,
          root: workspace.root,
          mode: workspace.mode,
          agentsFiles: loadedAgentsFiles,
          skills: visibleSkills,
          skillsOmitted: skillCatalog.omittedSkills,
          ...(visibleAgents.length > 0 ? { agents: visibleAgents } : {}),
        },
      };
    },
  );

  if (enabledTools.has(toolNames.loadSkill)) {
    registerAppTool(
      server,
      toolNames.loadSkill,
    {
      title: "Load skill",
      description:
        "Load Skill instructions and unlock support files; load again after backend restart or workspace recovery.",
      inputSchema: {
        workspaceId: z.string(),
        skillId: z
          .string()
          .optional()
          .describe("Skill ID from open_workspace."),
        name: z
          .string()
          .optional()
          .describe("Exact unique skill name."),
      },
      outputSchema: {
        skillId: z.string(),
        name: z.string(),
      },
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, skillId, name }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(ownerClientId, workspaceId);
      let resolvedSkillId = skillId;
      if (!resolvedSkillId) {
        if (!name) throw new Error("load_skill requires skillId, or an exact unique name.");
        const matches = workspace.skills.filter((skill) => skill.name === name);
        if (matches.length === 0) {
          throw new Error(`No advertised skill named ${JSON.stringify(name)} exists in workspace ${workspaceId}.`);
        }
        if (matches.length > 1) {
          throw new Error(
            `Skill name ${JSON.stringify(name)} is ambiguous; use one of these skillIds: ${matches.map((skill) => skill.skillId).join(", ")}`,
          );
        }
        resolvedSkillId = matches[0]!.skillId;
      }

      const loaded = await workspaces.loadSkill(ownerClientId, workspaceId, resolvedSkillId);
      const output = {
        skillId: loaded.skill.skillId,
        name: loaded.skill.name,
      };
      logToolCall(config, {
        tool: toolNames.loadSkill,
        workspaceId,
        path: loaded.skill.filePath,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(
          `Loaded skill ${loaded.skill.name} (${loaded.skill.scope}, ${loaded.skill.skillId}).\n\n${loaded.content}`,
        )],
        structuredContent: output,
      };
      },
    );
  }

  registerAppTool(
    server,
    "close_workspace",
    {
      title: "Close workspace",
      description:
        "Release a workspace only when the user asks. Stops its processes; dirty managed worktrees remain open.",
      inputSchema: {
        workspaceId: z.string(),
      },
      outputSchema: {
        closed: z.boolean(),
        processesTerminated: z.number().int().nonnegative(),
      },
      ...toolWidgetDescriptorMeta(config, "workspace", {
        invoking: "Closing workspace…",
        invoked: "Workspace close processed",
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId }) => {
      const startedAt = performance.now();
      const closeLease = await workspaces.acquireExclusiveClose(ownerClientId, workspaceId);
      const workspace = closeLease.workspace;
      let processesTerminated = 0;
      let worktreeRemoved = false;
      let worktreeRetainedReason: "dirty" | undefined;
      let closed = false;
      try {
        processesTerminated = await processSessions.terminateWorkspace(ownerClientId, workspaceId);
        if (workspace.mode === "worktree" && workspace.sourceRoot && workspace.worktree?.managed) {
          const removal = await removeManagedWorktree({
            sourceRoot: workspace.sourceRoot,
            worktreePath: workspace.root,
            config,
          });
          worktreeRemoved = removal.removed;
          if (removal.removed || removal.reason === "missing") {
            try {
              await reviewCheckpoints.cleanupWorkspace({ workspaceId });
            } catch (error) {
              runtimeDiagnostics.recordFailure("review_cleanup_failed", error);
              logEvent(config.logging, "warn", "review_cleanup_failed", { workspaceId, ...errorFields(error) });
            }
            closed = closeLease.commit({ delete: true });
          } else {
            worktreeRetainedReason = "dirty";
            closeLease.abort();
          }
        } else {
          try {
            await reviewCheckpoints.cleanupWorkspace({ workspaceId });
          } catch (error) {
            runtimeDiagnostics.recordFailure("review_cleanup_failed", error);
            logEvent(config.logging, "warn", "review_cleanup_failed", { workspaceId, ...errorFields(error) });
          }
          closed = closeLease.commit();
        }
      } catch (error) {
        closeLease.abort();
        throw error;
      } finally {
        processSessions.reopenWorkspace(ownerClientId, workspaceId);
      }
      logToolCall(config, {
        tool: "close_workspace",
        workspaceId,
        success: closed,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(
          `${closed ? "Closed" : "Kept open"} workspace ${workspaceId}. Terminated ${processesTerminated} running process(es).` +
          (worktreeRemoved
            ? " Removed its clean managed worktree."
            : worktreeRetainedReason
              ? ` Retained its managed worktree (${worktreeRetainedReason}).`
              : ""),
        )],
        structuredContent: {
          closed,
          processesTerminated,
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.read,
    {
      title: "Read file",
      description:
        [
          "Read one workspace file.",
          config.skillsEnabled
            ? "Loaded Skill files are also readable."
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      inputSchema: {
        workspaceId: z.string(),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "Workspace-relative or loaded Skill path."
              : "Workspace-relative path.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed start line."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum lines."),
      },
      outputSchema: {
        lines: z.number().int().nonnegative(),
        characters: z.number().int().nonnegative(),
      },
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(ownerClientId, workspaceId);
      let readPath = workspaces.resolveReadPath(workspace, input.path);
      const newlyLoadedAgentsFiles = readPath.skillRead
        ? []
        : await workspaces.loadApplicableAgentsFiles(workspace, [input.path]);
      readPath = workspaces.confineReadPath(readPath);
      const response = await readFileTool(
        { ...input, path: readPath.absolutePath },
        {
          cwd: workspace.root,
          root: workspace.root,
          readRoots: readPath.readRoots,
        },
      );

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
      }
      const agentsNotice = applicableAgentsNotice(newlyLoadedAgentsFiles, workspace.root);
      const content = agentsNotice
        ? [...response.content, textBlock(agentsNotice)]
        : response.content;
      if (agentsNotice) {
        await workspaces.markAgentsFilesDelivered(workspace, newlyLoadedAgentsFiles);
      }

      const summary = {
        ...textSummary(content),
        offset: input.offset ?? 1,
        limited: input.limit !== undefined,
      };
      if (!response.isError) {
        logToolCall(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
      }

      return {
        ...response,
        content,
        _meta: {
          tool: toolNames.read,
          card: {
            workspaceId,
            path: input.path,
            summary,
          },
        },
        structuredContent: {
          lines: summary.lines,
          characters: summary.characters,
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.batchRead,
    {
      title: "Batch read files",
      description:
        `Read up to ${BATCH_MAX_ITEMS} already-known independent files in one ordered call.`,
      inputSchema: {
        workspaceId: z.string(),
        files: z
          .array(z.object({
            path: z.string().min(1).max(1_024).describe("Workspace-relative path."),
            offset: z.number().int().positive().optional().describe("1-indexed start line."),
            limit: z
              .number()
              .int()
              .positive()
              .max(BATCH_READ_MAX_LINES)
              .optional()
              .describe(`Maximum lines; default ${BATCH_READ_DEFAULT_LINES}.`),
          }))
          .min(1)
          .max(BATCH_MAX_ITEMS),
      },
      outputSchema: {
        items: z.array(batchItemOutputSchema),
        truncated: z.boolean(),
        instructions: z.string().optional(),
      },
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, files }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(ownerClientId, workspaceId);
      const newlyLoadedAgentsFiles = await workspaces.loadApplicableAgentsFiles(
        workspace,
        files.map((file) => file.path),
      );
      const batch = await runBoundedBatch(
        files.map((file) => ({ ...file, operation: "read" })),
        async (file) => {
          const readPath = workspaces.confineReadPath(workspaces.resolveReadPath(workspace, file.path));
          const response = await readFileTool(
            {
              path: readPath.absolutePath,
              offset: file.offset,
              limit: file.limit ?? BATCH_READ_DEFAULT_LINES,
            },
            {
              cwd: workspace.root,
              root: workspace.root,
              readRoots: readPath.readRoots,
            },
          );
          return { ok: !response.isError, result: contentText(response.content) };
        },
      );
      const agentsNotice = applicableAgentsNotice(newlyLoadedAgentsFiles, workspace.root);
      const combined = combineBatchItemsWithInstructions(batch.items, batch.truncated, agentsNotice);
      if (combined.instructionsDelivered) {
        await workspaces.markAgentsFilesDelivered(workspace, newlyLoadedAgentsFiles);
      }
      const failed = combined.items.filter((item) => !item.ok).length;
      const content = [textBlock(
        `Batch read completed: ${combined.items.length} item(s), ${failed} failed${combined.truncated ? ", output truncated" : ""}.${combined.warning ? ` ${combined.warning}` : ""}`,
      )];
      logToolCall(config, {
        tool: toolNames.batchRead,
        workspaceId,
        success: batch.items.every((item) => item.ok),
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content,
        _meta: {
          tool: toolNames.batchRead,
          card: {
            workspaceId,
            summary: { items: combined.items.length, failed, truncated: combined.truncated },
          },
        },
        structuredContent: {
          items: combined.items,
          truncated: combined.truncated,
          ...(combined.instructions ? { instructions: combined.instructions } : {}),
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.batchInspect,
    {
      title: "Batch inspect workspace",
      description:
        `Run up to ${BATCH_MAX_ITEMS} already-known independent grep, glob, or ls inspections in order.`,
      inputSchema: {
        workspaceId: z.string(),
        operations: z
          .array(z.discriminatedUnion("operation", [
            z.object({
              operation: z.literal("grep"),
              pattern: z.string().min(1).max(1_000),
              path: z.string().min(1).max(1_024).optional().describe("Scope; defaults to root."),
              include: z.string().max(1_000).optional().describe("Optional include glob."),
            }),
            z.object({
              operation: z.literal("glob"),
              pattern: z.string().min(1).max(1_000),
              path: z.string().min(1).max(1_024).optional().describe("Scope; defaults to root."),
            }),
            z.object({
              operation: z.literal("ls"),
              path: z.string().min(1).max(1_024).describe("Directory path."),
            }),
          ]))
          .min(1)
          .max(BATCH_MAX_ITEMS),
      },
      outputSchema: {
        items: z.array(batchItemOutputSchema),
        truncated: z.boolean(),
        instructions: z.string().optional(),
      },
      ...toolWidgetDescriptorMeta(config, "search"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, operations }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(ownerClientId, workspaceId);
      const normalized = operations.map((operation) => ({
        ...operation,
        path: operation.path ?? ".",
      }));
      const newlyLoadedAgentsFiles = await workspaces.loadApplicableAgentsFiles(
        workspace,
        normalized.map((operation) => operation.path),
      );
      const batch = await runBoundedBatch(normalized, async (operation) => {
        workspaces.confineWorkspacePath(workspace, operation.path);
        const response = operation.operation === "grep"
          ? await grepFilesTool(
              { pattern: operation.pattern, path: operation.path, glob: operation.include },
              { cwd: workspace.root, root: workspace.root },
            )
          : operation.operation === "glob"
            ? await findFilesTool(
                { pattern: operation.pattern, path: operation.path },
                { cwd: workspace.root, root: workspace.root },
              )
            : await listDirectoryTool(
                { path: operation.path },
                { cwd: workspace.root, root: workspace.root },
              );
        return { ok: !response.isError, result: contentText(response.content) };
      });
      const agentsNotice = applicableAgentsNotice(newlyLoadedAgentsFiles, workspace.root);
      const combined = combineBatchItemsWithInstructions(batch.items, batch.truncated, agentsNotice);
      if (combined.instructionsDelivered) {
        await workspaces.markAgentsFilesDelivered(workspace, newlyLoadedAgentsFiles);
      }
      const failed = combined.items.filter((item) => !item.ok).length;
      const content = [textBlock(
        `Batch inspection completed: ${combined.items.length} item(s), ${failed} failed${combined.truncated ? ", output truncated" : ""}.${combined.warning ? ` ${combined.warning}` : ""}`,
      )];
      logToolCall(config, {
        tool: toolNames.batchInspect,
        workspaceId,
        success: batch.items.every((item) => item.ok),
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content,
        _meta: {
          tool: toolNames.batchInspect,
          card: {
            workspaceId,
            summary: { items: combined.items.length, failed, truncated: combined.truncated },
          },
        },
        structuredContent: {
          items: combined.items,
          truncated: combined.truncated,
          ...(combined.instructions ? { instructions: combined.instructions } : {}),
        },
      };
    },
  );

  if (enabledTools.has(toolNames.write)) {
  registerAppTool(
    server,
    toolNames.write,
    {
      title: "Write file",
      description: `Create or fully replace one file; use ${toolNames.edit} for targeted changes.`,
      inputSchema: {
        workspaceId: z.string(),
        instructionToken: z.string().optional().describe("Token from a blocked write."),
        path: z.string().describe("Workspace-relative file."),
        content: z.string().describe("Complete file content."),
      },
      outputSchema: {
        additions: z.number().int().nonnegative(),
        removals: z.number().int().nonnegative(),
        lines: z.number().int().nonnegative(),
        characters: z.number().int().nonnegative(),
      },
      ...toolWidgetDescriptorMeta(config, "write"),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, instructionToken, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(ownerClientId, workspaceId);
      workspaces.confineWorkspacePath(workspace, input.path);
      const instructionGate = await applicableMutationGate(workspaces, workspace, [input.path], instructionToken);
      if (instructionGate) return instructionGate;
      const response = await writeFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.write,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const patch = newFilePatch(input.path, input.content);
      const stats = countDiffStats(patch);
      const summary = {
        ...stats,
        lines: contentLineCount(input.content),
        characters: input.content.length,
      };
      logToolCall(config, {
        tool: toolNames.write,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.write,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              patch,
            },
          },
        },
        structuredContent: summary,
      };
    },
  );

  registerAppTool(
    server,
    toolNames.edit,
    {
      title: "Edit file",
      description: "Apply exact-text replacements to one file.",
      inputSchema: {
        workspaceId: z.string(),
        instructionToken: z.string().optional().describe("Token from a blocked edit."),
        path: z.string().describe("Workspace-relative file."),
        edits: z
          .array(
            z.object({
              oldText: z.string().describe("Exact unique text to replace."),
              newText: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
      },
      outputSchema: {
        status: z.literal("applied"),
        additions: z.number().int().nonnegative(),
        removals: z.number().int().nonnegative(),
        editCount: z.number().int().nonnegative(),
      },
      ...toolWidgetDescriptorMeta(config, "edit"),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, instructionToken, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(ownerClientId, workspaceId);
      workspaces.confineWorkspacePath(workspace, input.path);
      const instructionGate = await applicableMutationGate(workspaces, workspace, [input.path], instructionToken);
      if (instructionGate) return instructionGate;
      const response = await editFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.edit,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const stats = countDiffStats(
        response.details?.patch ?? response.details?.diff,
      );
      const summary = {
        ...stats,
        editCount: input.edits.length,
      };
      const editResultText = `Edited ${input.path} (+${stats.additions} -${stats.removals}).`;
      const editContent = [textBlock(editResultText)];
      logToolCall(config, {
        tool: toolNames.edit,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: editContent,
        _meta: {
          tool: toolNames.edit,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              diff: response.details?.diff,
              patch: response.details?.patch,
            },
          },
        },
        structuredContent: {
          status: "applied",
          ...summary,
        },
      };
    },
  );
  }

  if (enabledTools.has(toolNames.applyPatch)) {
    registerAppTool(
      server,
      "apply_patch",
      {
        title: "Apply patch",
        description:
          "Apply a Codex patch to workspace-relative files.",
        inputSchema: {
          workspaceId: z.string(),
          instructionToken: z.string().optional().describe("Scoped instruction token."),
          patch: z
            .string()
            .describe("*** Begin Patch / *** End Patch text."),
        },
        outputSchema: {
          additions: z.number(),
          removals: z.number(),
          files: z.array(
            z.object({
              path: z.string(),
              previousPath: z.string().optional(),
              operation: z.enum(["add", "update", "delete", "move"]),
            }),
          ),
        },
        ...toolWidgetDescriptorMeta(config, "edit"),
        annotations: EDIT_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, instructionToken, patch }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(ownerClientId, workspaceId);
        const patchPaths = parsePatch(patch).flatMap((action) =>
          action.kind === "update" && action.moveTo
            ? [action.path, action.moveTo]
            : [action.path],
        );
        const instructionGate = await applicableMutationGate(workspaces, workspace, patchPaths, instructionToken);
        if (instructionGate) return instructionGate;
        const applied = await applyPatch(workspace.root, patch);
        const paths = applied.files.map((file) => file.path).join(", ");
        const result = `Applied patch to ${applied.files.length} file(s): ${paths}`;
        const content = [textBlock(result)];
        const displayPath = applied.files.length === 1
          ? applied.files[0]?.path
          : `${applied.files.length} files`;

        logToolCall(config, {
          tool: "apply_patch",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: "apply_patch",
            card: {
              workspaceId,
              path: displayPath,
              summary: {
                files: applied.files.length,
                additions: applied.additions,
                removals: applied.removals,
              },
              files: applied.files,
              payload: { patch: applied.patch },
            },
          },
          structuredContent: {
            additions: applied.additions,
            removals: applied.removals,
            files: applied.files,
          },
        };
      },
    );
  }

  if (enabledTools.has("show_changes")) {
    registerAppTool(
      server,
      "show_changes",
      {
        title: "Show changes",
        description:
          "Show and advance the aggregate diff checkpoint after this turn's final edit.",
        inputSchema: {
          workspaceId: z.string(),
        },
        outputSchema: reviewSummaryOutputSchema.shape,
        ...toolWidgetDescriptorMeta(config, "show_changes", {
          invoking: "Preparing changes…",
          invoked: "Changes ready",
        }),
        annotations: SHOW_CHANGES_ANNOTATIONS,
      },
      async ({ workspaceId }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(ownerClientId, workspaceId);
        const review = await reviewCheckpoints.reviewChanges({
          workspaceId,
          root: workspace.root,
          since: "last_shown",
          markReviewed: true,
        });

        const content = [textBlock(review.result)];
        logToolCall(config, {
          tool: "show_changes",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: "show_changes",
            card: {
              workspaceId,
              summary: review.summary,
              files: review.files,
              payload: {
                patch: review.patch,
              },
            },
          },
          structuredContent: { ...review.summary },
        };
      },
    );
  }

  if (enabledTools.has(toolNames.grep)) {
    registerAppTool(
      server,
      toolNames.grep,
      {
        title: "Grep",
        description: "Search workspace file contents; supports path and include filters.",
        inputSchema: {
          workspaceId: z.string(),
          pattern: z.string().describe("Search pattern."),
          path: z.string().optional().describe("Workspace-relative scope."),
          include: z.string().optional().describe("Optional include glob."),
        },
        outputSchema: {
          lines: z.number().int().nonnegative(),
          characters: z.number().int().nonnegative(),
        },
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(ownerClientId, workspaceId);
        if (input.path) workspaces.confineWorkspacePath(workspace, input.path);
        const newlyLoadedAgentsFiles = await workspaces.loadApplicableAgentsFiles(
          workspace,
          [input.path ?? "."],
        );
        const response = await grepFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.grep,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }
        const agentsNotice = applicableAgentsNotice(newlyLoadedAgentsFiles, workspace.root);
        if (agentsNotice) await workspaces.markAgentsFilesDelivered(workspace, newlyLoadedAgentsFiles);
        const content = agentsNotice ? [...response.content, textBlock(agentsNotice)] : response.content;

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(content),
        };
        logToolCall(config, {
          tool: toolNames.grep,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          content,
          _meta: {
            tool: toolNames.grep,
            card: {
              workspaceId,
              path: input.path,
              summary,
            },
          },
          structuredContent: textSummary(content),
        };
      },
    );

    registerAppTool(
      server,
      toolNames.glob,
      {
        title: "Glob",
        description: "Find workspace files by glob pattern.",
        inputSchema: {
          workspaceId: z.string(),
          pattern: z.string().describe("File glob pattern."),
          path: z.string().optional().describe("Workspace-relative scope."),
        },
        outputSchema: {
          lines: z.number().int().nonnegative(),
          characters: z.number().int().nonnegative(),
        },
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(ownerClientId, workspaceId);
        if (input.path) workspaces.confineWorkspacePath(workspace, input.path);
        const newlyLoadedAgentsFiles = await workspaces.loadApplicableAgentsFiles(
          workspace,
          [input.path ?? "."],
        );
        const response = await findFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.glob,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }
        const agentsNotice = applicableAgentsNotice(newlyLoadedAgentsFiles, workspace.root);
        if (agentsNotice) await workspaces.markAgentsFilesDelivered(workspace, newlyLoadedAgentsFiles);
        const content = agentsNotice ? [...response.content, textBlock(agentsNotice)] : response.content;

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(content),
        };
        logToolCall(config, {
          tool: toolNames.glob,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          content,
          _meta: {
            tool: toolNames.glob,
            card: {
              workspaceId,
              path: input.path,
              summary,
            },
          },
          structuredContent: textSummary(content),
        };
      },
    );

    registerAppTool(
      server,
      toolNames.ls,
      {
        title: "Ls",
        description: "List one workspace directory.",
        inputSchema: {
          workspaceId: z.string(),
          path: z.string().describe("Workspace-relative directory."),
        },
        outputSchema: {
          lines: z.number().int().nonnegative(),
          characters: z.number().int().nonnegative(),
        },
        ...toolWidgetDescriptorMeta(config, "directory"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(ownerClientId, workspaceId);
        workspaces.confineWorkspacePath(workspace, input.path);
        const newlyLoadedAgentsFiles = await workspaces.loadApplicableAgentsFiles(workspace, [input.path]);
        const response = await listDirectoryTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.ls,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }
        const agentsNotice = applicableAgentsNotice(newlyLoadedAgentsFiles, workspace.root);
        if (agentsNotice) await workspaces.markAgentsFilesDelivered(workspace, newlyLoadedAgentsFiles);
        const content = agentsNotice ? [...response.content, textBlock(agentsNotice)] : response.content;

        const summary = textSummary(content);
        logToolCall(config, {
          tool: toolNames.ls,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          content,
          _meta: {
            tool: toolNames.ls,
            card: {
              workspaceId,
              path: input.path,
              summary,
            },
          },
          structuredContent: textSummary(content),
        };
      },
    );
  }

  if (enabledTools.has(toolNames.shell)) {
    const bashDescription = buildBashToolDescription({
      toolNames: {
        openWorkspace: toolNames.openWorkspace,
        read: toolNames.read,
        write: toolNames.write,
        edit: toolNames.edit,
        grep: toolNames.grep,
        glob: toolNames.glob,
        ls: toolNames.ls,
        shell: toolNames.shell,
        writeStdin: toolNames.writeStdin,
        readProcessOutput: toolNames.readProcessOutput,
      },
      hasInspectionTools: config.toolMode === "full",
    });

    registerAppTool(
      server,
      toolNames.shell,
      {
        title: "Bash",
        description: bashDescription,
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          instructionToken: z.string().optional().describe("One-time token returned by a previous blocked command in this instruction scope."),
          command: z
            .string()
            .min(1)
            .max(SHELL_COMMAND_MAX_CHARACTERS)
            .describe(
              `The command to execute. Prefer ${toolNames.edit}/${toolNames.write} for project file changes. HEREDOC is allowed for git commit / gh pr message bodies.`,
            ),
          stdin: z
            .string()
            .max(MAX_PROCESS_INPUT_BYTES)
            .optional()
            .describe("Initial stdin; closes by default."),
          closeStdin: z
            .boolean()
            .optional()
            .describe("Close after stdin; defaults true."),
          description: z.string().optional().describe(BASH_DESCRIPTION_PARAM),
          workingDirectory: z
            .string()
            .optional()
            .describe(BASH_WORKING_DIRECTORY_PARAM),
          timeout: z
            .number()
            .positive()
            .max(BASH_MAX_TIMEOUT_SECONDS)
            .optional()
            .describe(
              `Timeout in seconds. Defaults to ${BASH_DEFAULT_TIMEOUT_SECONDS}, max ${BASH_MAX_TIMEOUT_SECONDS}.`,
            ),
          run_in_background: z
            .boolean()
            .optional()
            .describe(
              `Set to true to run this command in the background. Returns a sessionId; use ${toolNames.writeStdin} to poll output, send input, or send Ctrl-C. Do not append & yourself when using this parameter.`,
            ),
          maxOutputTokens: z
            .number()
            .int()
            .positive()
            .max(100_000)
            .optional()
            .describe("Approximate inline output token budget. Defaults to 10000; this does not delete durable output."),
        },
        outputSchema: processOutputSchema({
          description: z.string().optional(),
          cwd: z.string().optional(),
        }),
        ...toolWidgetDescriptorMeta(config, "shell"),
        annotations: SHELL_TOOL_ANNOTATIONS,
      },
      async ({
        workspaceId,
        instructionToken,
        command,
        stdin,
        closeStdin,
        description,
        workingDirectory,
        timeout,
        run_in_background,
        maxOutputTokens,
      }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(ownerClientId, workspaceId);
        const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
        const commandScopes = commandInstructionScopePaths(
          workspace.root,
          command,
          cwd,
          workingDirectory,
        );
        if ("error" in commandScopes) return commandScopes.error;
        const effectiveCloseStdin = closeStdin ?? stdin !== undefined;
        let instructionScopePaths = commandScopes.paths;
        if (isInteractiveShellCommand(command) && stdin !== undefined) {
          if (!effectiveCloseStdin) {
            return {
              content: [textBlock(
                "Initial stdin for a direct interactive shell must close after the script. Set closeStdin=true, or start the shell first and use write_stdin.",
              )],
              isError: true,
            };
          }
          const initialInputScopes = processInputInstructionScopePaths(
            workspace.root,
            stdin,
            {
              cwd,
              scopePaths: commandScopes.paths,
              inputMode: "shell",
              pendingInput: "",
              inputRevision: 0,
            },
            { flushPending: true },
          );
          if (initialInputScopes) {
            if ("error" in initialInputScopes) return initialInputScopes.error;
            const inputPolicyViolation = processInputPolicyViolation(initialInputScopes.preparedInput, {
              cwd,
              workspaceRoot: workspace.root,
            });
            if (inputPolicyViolation) {
              return { content: [textBlock(inputPolicyViolation)], isError: true };
            }
            instructionScopePaths = [...new Set([
              ...instructionScopePaths,
              ...initialInputScopes.paths,
            ])];
          }
        }
        const instructionGate = await applicableMutationGate(
          workspaces,
          workspace,
          instructionScopePaths,
          instructionToken,
        );
        if (instructionGate) return instructionGate;

        try {
          const response = await runWorkspaceBash({
            workspaces,
            processSessions,
            workspace,
            writeStdinTool: toolNames.writeStdin,
            readProcessOutputTool: toolNames.readProcessOutput,
            instructionScopePaths,
            input: {
              command,
              stdin,
              closeStdin,
              description,
              workingDirectory,
              timeout,
              runInBackground: run_in_background,
              maxOutputTokens,
            },
          });

          const summary = {
            command,
            description,
            workingDirectory: workingDirectory ?? response.cwd,
            running: response.snapshot.running,
            exitCode: response.snapshot.exitCode,
            wallTimeMs: response.snapshot.wallTimeMs,
            ...textSummary(response.content),
          };

          if (response.isError) {
            logFailedToolResponse(
              config,
              {
                tool: toolNames.shell,
                workspaceId,
                workingDirectory: workingDirectory ?? response.cwd,
                command,
                commandLength: command.length,
              },
              response.content,
              startedAt,
            );
          } else {
            logToolCall(config, {
              tool: toolNames.shell,
              workspaceId,
              workingDirectory: workingDirectory ?? response.cwd,
              command,
              commandLength: command.length,
              success: true,
              durationMs: Math.round(performance.now() - startedAt),
            });
          }

          return {
            content: response.content,
            isError: response.isError,
            _meta: {
              tool: toolNames.shell,
              card: {
                workspaceId,
                path: workingDirectory,
                summary,
              },
            },
            structuredContent: {
              sessionId: response.snapshot.sessionId,
              running: response.snapshot.running,
              exitCode: response.snapshot.exitCode,
              signal: response.snapshot.signal,
              wallTimeMs: response.snapshot.wallTimeMs,
              outputTruncated: response.snapshot.outputTruncated,
              outputId: response.snapshot.outputId,
              droppedBytes: response.snapshot.droppedBytes,
              timedOut: response.snapshot.timedOut,
              description,
              cwd: response.cwd,
            },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const content = [{ type: "text" as const, text: message }];
          logFailedToolResponse(
            config,
            {
              tool: toolNames.shell,
              workspaceId,
              workingDirectory: workingDirectory ?? ".",
              command,
              commandLength: command.length,
            },
            content,
            startedAt,
          );
          return { content, isError: true };
        }
      },
    );

    registerWriteStdinTool(server, config, workspaces, processSessions, ownerClientId, {
      startedBy: "bash",
    });
  }

  if (enabledTools.has(toolNames.execCommand)) {
    registerCodexProcessTools(server, config, workspaces, processSessions, ownerClientId);
  }

  return server;
}

export { readinessSnapshot } from "./runtime-control-plane.js";

export function createServer(configInput?: ServerConfig): RunningServer {
  const managesRuntimeConfig = configInput === undefined;
  const config = configInput ?? loadConfig();
  const processGeneration = randomUUID();
  const runtimeDiagnostics = new RuntimeDiagnostics();
  const activeMcpRequests = new ActiveRequestBarrier();
  const activeToolHandlers = new ActiveRequestBarrier();
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  const transports = new McpSessionRegistry<Transport>({
    maxSessions: config.resources.maxMcpSessions,
    maxSessionsPerClient: config.resources.maxMcpSessionsPerClient,
    closeTimeoutMs: config.resources.mcpSessionCloseTimeoutMs,
  });
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
  if (oauthProvider.ownerCredentialChanged) {
    logEvent(config.logging, "warn", "oauth_owner_credential_changed", {
      tokensRevoked: true,
      clientsPreserved: true,
    });
  }
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const localAgentStore = createLocalAgentStore(config);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager();
  const processOutputStore = new ProcessOutputStore({
    stateDir: config.stateDir,
    maxFileBytes: config.resources.maxProcessOutputFileBytes,
    maxStorageBytes: config.resources.maxProcessOutputStorageBytes,
    completedTtlMs: config.resources.completedProcessOutputTtlMs,
  });
  processOutputStore.cleanupExpired(1_000);
  const processSessions = new ProcessSessionManager({
    maxSessions: config.resources.maxProcessSessions,
    maxSessionsPerClient: config.resources.maxProcessSessionsPerClient,
    maxSessionsPerWorkspace: config.resources.maxProcessSessionsPerWorkspace,
    maxRuntimeMs: config.resources.maxCommandRuntimeMs,
    terminationGraceMs: config.resources.processShutdownGraceMs,
    outputStore: processOutputStore,
  });
  let closing = false;
  const localAgentProviders = config.subagents
    ? getLocalAgentProviderAvailabilitySnapshot()
    : [];
  const pendingRootsCleanup = new Map<string, { workspaceId: string; ownerClientId: string }>();
  let rootsReloadTail: Promise<void> = Promise.resolve();
  const reloadAllowedRoots = (): Promise<{
    changed: boolean;
    added: number;
    removed: number;
    invalidatedWorkspaces: number;
    terminatedProcesses: number;
    cleanupFailures: number;
    cleanupPending: number;
  }> => {
    const operation = rootsReloadTail.then(async () => {
      const nextRoots = managesRuntimeConfig ? loadConfig().allowedRoots : config.allowedRoots;
      const update = workspaces.applyAllowedRoots(nextRoots);
      const persistencePending = update.persistenceFailures > 0;
      for (const invalidated of update.invalidated) {
        pendingRootsCleanup.set(
          `${invalidated.ownerClientId}\0${invalidated.workspaceId}`,
          invalidated,
        );
      }
      const cleanupResults = await Promise.all(Array.from(pendingRootsCleanup.entries()).map(
        async ([key, invalidated]) => {
          let terminatedProcesses = 0;
          let failed = false;
          try {
            terminatedProcesses = await processSessions.terminateWorkspace(
              invalidated.ownerClientId,
              invalidated.workspaceId,
            );
          } catch (error) {
            processSessions.blockWorkspace(invalidated.ownerClientId, invalidated.workspaceId);
            failed = true;
            runtimeDiagnostics.recordFailure("allowed_roots_process_cleanup_failed", error);
          }
          try {
            await reviewCheckpoints.cleanupWorkspace({ workspaceId: invalidated.workspaceId });
          } catch (error) {
            failed = true;
            runtimeDiagnostics.recordFailure("allowed_roots_review_cleanup_failed", error);
          }
          if (!failed && !persistencePending) pendingRootsCleanup.delete(key);
          return { terminatedProcesses, failed };
        },
      ));
      const terminatedProcesses = cleanupResults.reduce(
        (count, cleanup) => count + cleanup.terminatedProcesses,
        0,
      );
      const cleanupFailures =
        cleanupResults.filter((cleanup) => cleanup.failed).length + update.persistenceFailures;
      const result = {
        changed: update.changed,
        added: update.added,
        removed: update.removed,
        invalidatedWorkspaces: update.invalidated.length,
        terminatedProcesses,
        cleanupFailures,
        cleanupPending: pendingRootsCleanup.size,
      };
      if (update.changed) logEvent(config.logging, "info", "allowed_roots_reloaded", result);
      return result;
    });
    rootsReloadTail = operation.then(() => undefined, () => undefined);
    return operation;
  };

  let configWatcher: FSWatcher | undefined;
  let configReloadTimer: NodeJS.Timeout | undefined;
  let configPollTimer: NodeJS.Timeout | undefined;
  if (managesRuntimeConfig) {
    const configPath = devspaceConfigPath();
    const scheduleReload = (attempt = 0): void => {
      if (closing) return;
      if (configReloadTimer) clearTimeout(configReloadTimer);
      configReloadTimer = setTimeout(() => {
        configReloadTimer = undefined;
        void reloadAllowedRoots().then((result) => {
          if (result.cleanupPending > 0) scheduleReload(attempt + 1);
        }).catch((error) => {
          runtimeDiagnostics.recordFailure("allowed_roots_reload_failed", error);
          logEvent(config.logging, "error", "allowed_roots_reload_failed", errorFields(error));
          scheduleReload(attempt + 1);
        });
      }, attempt === 0 ? 75 : Math.min(30_000, 100 * 2 ** Math.min(attempt, 8)));
      configReloadTimer.unref();
    };
    try {
      configWatcher = watch(dirname(configPath), { persistent: false }, () => {
        // Atomic writers rename a temporary file over config.json. macOS may
        // report only the temporary filename, so every event in this private
        // config directory must debounce into a reload attempt.
        scheduleReload();
      });
      configWatcher.on("error", (error) => {
        runtimeDiagnostics.recordFailure("allowed_roots_watcher_failed", error);
        logEvent(config.logging, "error", "allowed_roots_watcher_failed", errorFields(error));
      });
    } catch (error) {
      runtimeDiagnostics.recordFailure("allowed_roots_watcher_failed", error);
      logEvent(config.logging, "error", "allowed_roots_watcher_failed", errorFields(error));
    }
    scheduleReload();
    configPollTimer = setInterval(() => {
      void reloadAllowedRoots().then((result) => {
        if (result.cleanupPending > 0) scheduleReload(1);
      }).catch((error) => {
        runtimeDiagnostics.recordFailure("allowed_roots_reload_failed", error);
        logEvent(config.logging, "error", "allowed_roots_reload_failed", errorFields(error));
      });
    }, 30_000);
    configPollTimer.unref();
  }

  const logSessionCloseResults = (
    reason: "idle_timeout" | "capacity_reclaim" | "global_revocation" | "server_shutdown",
    results: McpSessionCloseResult[],
  ) => {
    for (const result of results) {
      if (result.error) {
        logEvent(config.logging, "warn", "mcp_session_close_failed", {
          reason,
          sessionIdPrefix: sessionIdPrefix(result.sessionId),
          error:
            result.error instanceof Error
              ? result.error.message
              : String(result.error),
        });
        continue;
      }

      logEvent(config.logging, "info", "mcp_session_closed", {
        reason,
        sessionIdPrefix: sessionIdPrefix(result.sessionId),
      });
    }
  };

  let cleanupRunning = false;
  let cleanupPromise: Promise<void> | undefined;
  const sessionCleanupTimer = setInterval(() => {
    if (cleanupRunning) return;
    cleanupRunning = true;
    cleanupPromise = (async () => {
      const results = await transports.closeIdle(config.resources.mcpSessionIdleTimeoutMs);
      logSessionCloseResults("idle_timeout", results);
      const closedWorkspaceIds = workspaces.closeExpiredSessions(
        config.resources.workspaceIdleTtlMs,
        (ownerClientId, workspaceId) => processSessions.hasActive(ownerClientId, workspaceId),
      );
      const reviewCleanupResults = await Promise.allSettled(
        closedWorkspaceIds.map((workspaceId) => reviewCheckpoints.cleanupWorkspace({ workspaceId })),
      );
      for (const result of reviewCleanupResults) {
        if (result.status === "rejected") {
          runtimeDiagnostics.recordFailure("review_cleanup_failed", result.reason);
        }
      }
      workspaces.cleanupLifecycleState();
      oauthProvider.cleanupExpired();
      localAgentStore.cleanup();
      processOutputStore.cleanupExpired();
      await cleanupDetachedAgentPromptArtifacts();
    })().catch((error) => {
      runtimeDiagnostics.recordFailure("resource_cleanup_failed", error);
      logEvent(config.logging, "error", "resource_cleanup_failed", errorFields(error));
    }).finally(() => {
      cleanupRunning = false;
      cleanupPromise = undefined;
    });
  }, config.resources.cleanupIntervalMs);
  sessionCleanupTimer.unref();

  if (config.logging.trustProxy) {
    // The public listener is reached through a local Cloudflare Tunnel process.
    // Trust only loopback proxy peers, never arbitrary forwarding headers.
    app.set("trust proxy", "loopback");
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;

    res.on("finish", () => {
      const path = requestPath(req);
      if (!config.logging.requests) return;
      if (!config.logging.assets && path.startsWith("/mcp-app-assets")) return;

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config),
      });
    });

    next();
  });

  app.use("/authorize", async (req, res, next) => {
    if (req.method !== "GET") {
      next();
      return;
    }
    const clientId = typeof req.query.client_id === "string" ? req.query.client_id : undefined;
    if (!clientId || !oauthProvider.clientsStore.getClient) {
      next();
      return;
    }
    try {
      const client = await oauthProvider.clientsStore.getClient(clientId);
      if (client) {
        next();
        return;
      }
      logEvent(config.logging, "warn", "oauth_stale_client", {
        requestId: res.locals.requestId as string | undefined,
        clientIdHash: identifierHash(clientId),
        ...requestLogFields(req, config),
      });
      const uiLocales = typeof req.query.ui_locales === "string" ? req.query.ui_locales : undefined;
      sendStaleOAuthClientPage(res, uiLocales);
    } catch (error) {
      next(error);
    }
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: "DevSpace",
    }),
  );

  app.options("/mcp-app-assets/{*asset}", (_req, res) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  });

  const allowedUiAssets = workspaceAppAssetPaths();
  app.use("/mcp-app-assets", (req, res, next) => {
    const assetPath = req.path.replace(/^\/+/, "");
    if (!allowedUiAssets.has(assetPath)) {
      res.sendStatus(404);
      return;
    }
    next();
  });

  app.use(
    "/mcp-app-assets",
    express.static(uiBuildDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: setAssetHeaders,
    }),
  );

  app.use(createRuntimeControlPlane({
    ownerToken: config.oauth.ownerToken,
    generation: processGeneration,
    runtimeConfig: { toolMode: config.toolMode, widgets: config.widgets },
    allowedRootsRevision: () => allowedRootsRevision(config.allowedRoots),
    allowedRootsCleanupPending: () => pendingRootsCleanup.size,
    isClosing: () => closing,
    workspaceDatabaseReady: () => workspaces.isReady(),
    oauthDatabaseReady: () => oauthProvider.isReady(),
    mcpUsage: () => transports.usageSnapshot(),
    processUsage: () => processSessions.usageSnapshot(),
    processOutputUsage: () => processOutputStore.usageSnapshot(),
    workspaceUsage: () => workspaces.usageSnapshot(),
    oauthUsage: () => oauthProvider.diagnosticSnapshot(),
    reloadAllowedRoots,
    revokeAll: () => oauthProvider.revokeAll(),
    runtimeDiagnostics,
    onGlobalRevocation: async (revoked) => {
      logEvent(config.logging, "warn", "oauth_global_revocation", { ...revoked });
      const closeResults = await transports.closeActive();
      logSessionCloseResults("global_revocation", closeResults);
    },
  }));

  app.all("/mcp", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);

    if (closing) {
      sendJsonRpcError(res, 503, -32000, "Server is shutting down");
      return;
    }

    const releaseActiveRequest = activeMcpRequests.enter();
    try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        res.off("finish", responseFinished);
        res.off("close", responseFinished);
        if (error) reject(error);
        else resolve();
      };
      const responseFinished = () => finish();
      res.once("finish", responseFinished);
      res.once("close", responseFinished);
      bearerAuth(req, res, (error?: unknown) => finish(error));
    });
    if (res.headersSent) return;

    const ownerClientId = req.auth?.clientId;
    if (!ownerClientId || !req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) {
      logEvent(config.logging, "warn", "auth_denied", {
        requestId,
        method: req.method,
        path: requestPath(req),
        reason: ownerClientId ? "invalid_oauth_resource" : "missing_oauth_client",
        ...requestLogFields(req, config),
      });
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      method: req.method,
      sessionIdPresent: Boolean(sessionId),
      sessionIdPrefix: sessionIdPrefix(sessionId),
      isInitialize: initializeRequest,
      clientIdHash: identifierHash(ownerClientId),
    });

    if (containsBatchedToolCall(req.body)) {
      sendJsonRpcError(
        res,
        400,
        -32600,
        "Tool calls must be sent individually; use batch_read or batch_inspect for bounded multi-file work",
      );
      return;
    }

    let reservation: McpSessionReservation | undefined;
    let acquiredSessionId: string | undefined;
    let newTransport: Transport | undefined;
    try {
      let transport: Transport | undefined;

      if (sessionId) {
        transport = transports.acquire(sessionId, ownerClientId);
        if (!transport) {
          sendJsonRpcError(
            res,
            404,
            -32000,
            "Unknown MCP session. Reconnect to DevSpace, then retry this request once; it was not executed.",
          );
          return;
        }
        acquiredSessionId = sessionId;
      } else if (initializeRequest) {
        const reservationResult = await transports.reserveWithIdleReclaim(ownerClientId);
        if (reservationResult.reclaimed) {
          logSessionCloseResults("capacity_reclaim", [reservationResult.reclaimed]);
        }
        if (!reservationResult.reservation) {
          logEvent(config.logging, "warn", "mcp_session_rejected", {
            reason: "capacity",
            clientIdHash: identifierHash(ownerClientId),
            maxSessions: config.resources.maxMcpSessions,
          });
          sendJsonRpcError(res, 503, -32000, "MCP session capacity reached");
          return;
        }
        reservation = reservationResult.reservation;
        if (closing) {
          transports.releaseReservation(reservation);
          reservation = undefined;
          sendJsonRpcError(res, 503, -32000, "Server is shutting down");
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport && reservation) {
              transports.register(newSessionId, ownerClientId, transport, reservation, 1);
              reservation = undefined;
              acquiredSessionId = newSessionId;
            }
            logEvent(config.logging, "info", "mcp_session_created", {
              requestId,
              sessionIdPrefix: sessionIdPrefix(newSessionId),
              clientIdHash: identifierHash(ownerClientId),
              ...requestLogFields(req, config),
            });
          },
        });
        newTransport = transport;

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (
            closedSessionId &&
            transports.removeOnTransportClose(closedSessionId) === "unexpected"
          ) {
            logEvent(config.logging, "info", "mcp_session_closed", {
              reason: "transport_close",
              sessionIdPrefix: sessionIdPrefix(closedSessionId),
            });
          }
        };

        const server = createMcpServer(
          config,
          ownerClientId,
          workspaces,
          reviewCheckpoints,
          processSessions,
          processOutputStore,
          localAgentProviders,
          runtimeDiagnostics,
          activeToolHandlers,
        );
        await server.connect(transport);
      } else {
        sendJsonRpcError(
          res,
          400,
          -32000,
          "No valid MCP session. Reconnect to DevSpace, then retry this request once; it was not executed.",
        );
        return;
      }

      const workspaceId = workspaceOperationId(req.body);
      const handleRequest = () => requestContext.run(
        { clientId: ownerClientId, requestId },
        () => transport.handleRequest(req, res, req.body),
      );
      if (workspaceId) {
        await workspaces.withWorkspaceOperation(ownerClientId, workspaceId, handleRequest);
      } else {
        await handleRequest();
      }
    } catch (error) {
      const workspaceError = recoverableWorkspaceError(error);
      if (workspaceError && !res.headersSent) {
        logEvent(config.logging, "warn", "workspace_reopen_required", {
          requestId,
          clientIdHash: identifierHash(ownerClientId),
          workspaceId: workspaceOperationId(req.body),
        });
        sendCallToolErrorResult(res, workspaceError, jsonRpcRequestId(req.body));
        return;
      }
      runtimeDiagnostics.recordFailure("mcp_request_error", error);
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        clientIdHash: identifierHash(ownerClientId),
        ...errorFields(error),
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error", jsonRpcRequestId(req.body));
      }
    } finally {
      if (reservation) {
        transports.releaseReservation(reservation);
        reservation = undefined;
        if (newTransport && !newTransport.sessionId) {
          try {
            await newTransport.close();
          } catch {
            // The request error above already records initialization failures.
          }
        }
      }
      if (acquiredSessionId) transports.release(acquiredSessionId, ownerClientId);
    }
    } finally {
      releaseActiveRequest();
    }
  });

  const beginClose = (): Promise<void> => {
    closing = true;
    transports.seal();
    clearInterval(sessionCleanupTimer);
    if (configReloadTimer) clearTimeout(configReloadTimer);
    if (configPollTimer) clearInterval(configPollTimer);
    configWatcher?.close();
    return Promise.resolve();
  };
  let closePromise: Promise<void> | undefined;
  return {
    app,
    config,
    localAgentProviders,
    beginClose,
    close: () => {
      closePromise ??= (async () => {
        await beginClose();
        await cleanupPromise;
        await rootsReloadTail;
        const [requestsDrained, toolsDrained] = await Promise.all([
          activeMcpRequests.waitForIdle(config.resources.httpDrainTimeoutMs),
          activeToolHandlers.waitForIdle(config.resources.httpDrainTimeoutMs),
        ]);
        if (!requestsDrained || !toolsDrained) {
          runtimeDiagnostics.recordFailure("mcp_request_drain_timeout");
          throw new Error(
            `Active MCP requests or tool handlers did not drain within ${config.resources.httpDrainTimeoutMs}ms; resources remain open to avoid inconsistent state.`,
          );
        }
        const closeResults = await transports.closeAll();
        logSessionCloseResults("server_shutdown", closeResults);
        if (transports.size > 0) {
          const retryResults = await transports.closeAll();
          logSessionCloseResults("server_shutdown", retryResults);
        }
        const closeErrors: unknown[] = [];
        try {
          await processSessions.shutdown();
        } catch (error) {
          closeErrors.push(error);
        }
        try {
          processOutputStore.close();
        } catch (error) {
          closeErrors.push(error);
        }
        try {
          oauthProvider.close();
        } catch (error) {
          closeErrors.push(error);
        }
        try {
          localAgentStore.close();
        } catch (error) {
          closeErrors.push(error);
        }
        try {
          workspaceStore.close?.();
        } catch (error) {
          closeErrors.push(error);
        }
        if (closeErrors.length > 0) throw new AggregateError(closeErrors, "Failed to close DevSpace resources");
      })();
      return closePromise;
    },
  };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config, beginClose, close, localAgentProviders } = createServer();
  const httpServer = app.listen(config.port, config.host, () => {
    logEvent(config.logging, "info", "server_ready", {
      host: config.host,
      port: config.port,
      publicBaseUrl: config.publicBaseUrl,
      allowedRootCount: config.allowedRoots.length,
      allowedHostCount: config.allowedHosts.length,
      toolMode: config.toolMode,
      widgetMode: config.widgets,
      trustProxy: config.logging.trustProxy,
      subagentProviders: config.subagents
        ? formatLocalAgentProviderAvailabilitySummary(localAgentProviders)
        : undefined,
    });
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logEvent(config.logging, "info", "server_stopping");
    await beginClose();
    await shutdownHttpServer(httpServer, close, config.resources.httpDrainTimeoutMs);
    logEvent(config.logging, "info", "server_stopped");
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      logEvent(config.logging, "error", "server_shutdown_failed", errorFields(error));
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}
