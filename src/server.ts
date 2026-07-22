import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, statSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
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
import { analyzeShellCommandScopes } from "./shell-command-scopes.js";
import {
  BATCH_MAX_ITEMS,
  BATCH_READ_DEFAULT_LINES,
  BATCH_READ_MAX_LINES,
  BATCH_TOTAL_MAX_CHARACTERS,
  limitBatchText,
  runBoundedBatch,
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
import { ProcessSessionManager, type ProcessSnapshot } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { formatPathForPrompt } from "./skills.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { formatAgentsPath, WorkspaceRegistry, type Workspace } from "./workspaces.js";
import { removeManagedWorktree } from "./git-worktrees.js";
import { RuntimeDiagnostics } from "./runtime-diagnostics.js";
import { ActiveRequestBarrier } from "./request-barrier.js";
import { createRuntimeControlPlane } from "./runtime-control-plane.js";
import { DEVSPACE_SERVER_INFO } from "./version.js";
import { summarizeLocalAgentProfile } from "./local-agent-profiles.js";
import { createLocalAgentStore } from "./local-agent-store.js";
import { cleanupDetachedAgentPromptArtifacts } from "./detached-agent-cleanup.js";
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
  const handlerIndex = args.length - 1;
  const handler = args[handlerIndex];
  const barrier = toolHandlerBarriers.get(server);
  if (barrier && typeof handler === "function") {
    args[handlerIndex] = (...handlerArgs: unknown[]) => barrier.track(() => handler(...handlerArgs));
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
} as const;

interface ToolLogFields {
  tool: string;
  workspaceId?: string;
  path?: string;
  workingDirectory?: string;
  command?: string;
  commandLength?: number;
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
      ? " If the turn successfully modifies files by creating, editing, overwriting, deleting, moving, or applying patches, call show_changes exactly once for that workspace after the final related file change and before your final response so the user can inspect the aggregate diff for that turn. Do not call it after every individual file change; do not skip it because individual file-change tools already returned diffs."
      : "";

  if (config.toolMode === "codex") {
    return (
      lifecycleInstruction + " " + buildCodexServerInstructions({
        read: toolNames.read,
        batchRead: toolNames.batchRead,
        batchInspect: toolNames.batchInspect,
        writeStdin: toolNames.writeStdin,
      }) + showChangesInstruction
    );
  }

  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's path before proceeding. Skill paths may be outside the workspace, but ${toolNames.read} only permits advertised SKILL.md files and files under already-loaded skill directories. `
    : "";

  const agentsMd = `Follow instructions returned by ${toolNames.openWorkspace} and later tools. Nested project instructions are loaded lazily when a tool enters their scope. If a mutation or command is blocked with an instructionToken, review the scoped instructions and pass that exact token when retrying the same tool call. When 2–8 files or inspections are already known, prefer ${toolNames.batchRead} or ${toolNames.batchInspect}; keep iterative discovery when each next target depends on the previous result. `;

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

function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z
      .string()
      .describe(
        "Model-readable result text for follow-up reasoning and plain MCP hosts.",
      ),
    ...extra,
  };
}

const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

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

const workspaceLocalAgentProviderOutputSchema = z.object({
  name: z.string(),
  available: z.boolean(),
  reason: z.string().optional(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

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
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
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

export function isCompleteReadResult(
  input: { offset?: number; limit?: number },
  details: { truncation?: { truncated: boolean } } | undefined,
): boolean {
  return (
    input.offset === undefined &&
    input.limit === undefined &&
    details?.truncation?.truncated !== true
  );
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

export function combineBatchResultWithInstructions(
  batchResult: string,
  batchTruncated: boolean,
  agentsNotice: string | undefined,
): { result: string; truncated: boolean; instructionsDelivered: boolean } {
  if (!agentsNotice) {
    return { result: batchResult, truncated: batchTruncated, instructionsDelivered: false };
  }
  const separator = "\n\n";
  if (agentsNotice.length + separator.length > BATCH_TOTAL_MAX_CHARACTERS) {
    const warning = "Applicable project instructions exceeded the batch response budget and were not marked delivered. Use read on one target path to receive them before continuing.";
    const available = Math.max(0, BATCH_TOTAL_MAX_CHARACTERS - warning.length - separator.length);
    const limitedBatch = limitBatchText(batchResult, available);
    return {
      result: `${limitedBatch.text}${separator}${warning}`,
      truncated: true,
      instructionsDelivered: false,
    };
  }
  const available = BATCH_TOTAL_MAX_CHARACTERS - agentsNotice.length - separator.length;
  const limitedBatch = limitBatchText(batchResult, available);
  return {
    result: `${limitedBatch.text}${separator}${agentsNotice}`,
    truncated: batchTruncated || limitedBatch.truncated,
    instructionsDelivered: true,
  };
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

  const unavailable = analysis.staticCwdAlternatives.find((alternatives) =>
    alternatives.some((path) => {
      try {
        return !statSync(path).isDirectory();
      } catch {
        return true;
      }
    })
  );
  if (unavailable) {
    return {
      error: {
        content: [textBlock(
          "No command was executed because a literal cd/pushd destination does not yet exist as a directory. " +
          "Create or populate the directory in one call, then run the scoped command in a second call. " +
          `Unavailable directory candidates: ${unavailable.join(", ")}`,
        )],
        isError: true,
      },
    };
  }

  return {
    paths: [workingDirectory ?? ".", ...analysis.staticCwds],
  };
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

function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? `Process running with session ID ${snapshot.sessionId}.`
    : snapshot.signal
      ? `Process exited after signal ${snapshot.signal}.`
      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  const truncationNote = snapshot.outputTruncated
    ? `\n[output truncated: head + tail retained, ~${snapshot.outputOmittedBytes} bytes omitted, original ~${snapshot.originalTokenCount} tokens]`
    : "";
  return snapshot.output
    ? `${snapshot.output.replace(/\n$/, "")}\n${status}${truncationNote}`
    : `${status}${truncationNote}`;
}

function processOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return resultOutputSchema({
    sessionId: z.number().optional(),
    running: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    wallTimeMs: z.number().nonnegative(),
    outputTruncated: z.boolean(),
    originalTokenCount: z.number().nonnegative(),
    outputOmittedBytes: z.number().nonnegative(),
    timedOut: z.boolean(),
    ...extra,
  });
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
        payload: { content },
      },
    },
    structuredContent: {
      result,
      sessionId: snapshot.sessionId,
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      wallTimeMs: snapshot.wallTimeMs,
      outputTruncated: snapshot.outputTruncated,
      originalTokenCount: snapshot.originalTokenCount,
      outputOmittedBytes: snapshot.outputOmittedBytes,
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
      description:
        `Poll or write characters to a process returned by ${startedBy}. Parameter names are camelCase: sessionId, yieldTimeMs, maxOutputTokens, workspaceId (not session_id / yield_time_ms). Omit chars or pass empty string to poll. Pass \\u0003 for Ctrl-C.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier from open_workspace (required; DevSpace-specific)."),
        sessionId: z
          .number()
          .describe(
            `Process session id returned by ${startedBy} as sessionId (camelCase, not session_id).`,
          ),
        chars: z.string().optional().describe("Characters to write. Omit or pass an empty string to poll."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this width."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this height."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(600_000)
          .optional()
          .describe(
            "Milliseconds to wait (camelCase, not yield_time_ms). Defaults to 5000 when polling, 250 when writing.",
          ),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Output token budget (camelCase, not max_output_tokens). Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, sessionId, chars, columns, rows, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(ownerClientId, workspaceId);
      const snapshot = await processSessions.write({
        ownerClientId,
        workspaceId,
        sessionId,
        chars,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
      });

      logToolCall(config, {
        tool: toolNames.writeStdin,
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return processToolResponse(toolNames.writeStdin as "write_stdin", workspaceId, snapshot, {
        sessionId,
        charactersWritten: chars?.length ?? 0,
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
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
      description:
        "Use this when a task requires a terminal command, such as a test, build, git operation, package script, or environment check. Returns completed output or a sessionId for write_stdin when the process is still running.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier from open_workspace (required on every call; DevSpace-specific)."),
        instructionToken: z.string().optional().describe("One-time token returned when scoped project instructions must be reviewed before retrying this command."),
        cmd: z.string().min(1).max(SHELL_COMMAND_MAX_CHARACTERS).describe("Shell command to execute."),
        tty: z
          .boolean()
          .optional()
          .describe("Allocate a pseudo-terminal for interactive commands. Defaults to false."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Initial PTY width. Defaults to 80."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Initial PTY height. Defaults to 24."),
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Working directory relative to the workspace root (camelCase name, not workdir). Defaults to workspace root. Does not persist across calls.",
          ),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(600_000)
          .optional()
          .describe(
            "Milliseconds to wait before returning a running session (camelCase, not yield_time_ms). Defaults to 10000.",
          ),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe(
            "Approximate output token budget (camelCase, not max_output_tokens). Defaults to 10000.",
          ),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, instructionToken, cmd, tty, columns, rows, workingDirectory, yieldTimeMs, maxOutputTokens }) => {
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
      const instructionGate = await applicableMutationGate(
        workspaces,
        workspace,
        commandScopes.paths,
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
            result: text,
            running: false,
            wallTimeMs: Math.round(performance.now() - startedAt),
            outputTruncated: false,
            originalTokenCount: 0,
            outputOmittedBytes: 0,
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
      });

      logToolCall(config, {
        tool: "exec_command",
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: cmd,
        commandLength: cmd.length,
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
  toolHandlerBarriers.set(server, activeToolHandlers);

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
        "Use this when a conversation needs access to a project on the user's local machine but has no workspaceId for it, or when switching project folders, worktrees, or checkout/worktree mode. Pass the exact project path; checkout mode reuses the active workspace for the same authorized client and canonical path.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path, or a leading-tilde home path such as ~/project, to a local project directory inside an allowed root.",
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "Defaults to checkout. Use checkout to work in the actual directory. Use worktree to create an isolated managed Git worktree for parallel work.",
          ),
        baseRef: z
          .string()
          .optional()
          .describe("Git ref to base a worktree on. Only used with mode=\"worktree\". Defaults to HEAD."),
      },
      outputSchema: {
        workspaceId: z.string(),
        reused: z.boolean(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        sourceRoot: z.string().optional(),
        worktree: z
          .object({
            path: z.string(),
            baseRef: z.string(),
            baseSha: z.string(),
            dirtySource: z.boolean(),
            detached: z.boolean(),
            managed: z.boolean(),
          })
          .optional(),
        agentsFiles: z.array(workspaceAgentsFileOutputSchema),
        availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema),
        instructionScan: z.object({
          complete: z.boolean(),
          lazy: z.boolean(),
          reason: z.enum(["max_depth", "max_entries", "deadline", "io_error"]).optional(),
          directoriesScanned: z.number().int().nonnegative(),
          entriesScanned: z.number().int().nonnegative(),
          filesFound: z.number().int().nonnegative(),
          unreadableDirectories: z.number().int().nonnegative(),
          durationMs: z.number().int().nonnegative(),
        }),
        skills: z.array(workspaceSkillOutputSchema),
        agentProviders: z.array(workspaceLocalAgentProviderOutputSchema),
        agents: z.array(workspaceLocalAgentOutputSchema),
        skillDiagnostics: z.array(z.unknown()),
        instruction: z.string(),
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
      if (config.widgets === "changes") {
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
      const visibleSkills = workspace.skills
        .filter((skill) => !skill.disableModelInvocation)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: formatPathForPrompt(skill.filePath),
        }));
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
        ? "Follow loaded agentsFiles instructions. Nested project instructions are loaded lazily when later tools enter their scope. When a task matches an available skill in skills, read its path before proceeding."
        : "Follow loaded agentsFiles instructions. Nested project instructions are loaded lazily when later tools enter their scope.";
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            `${reused ? "Reused" : "Opened"} workspace ${workspace.id}`,
            `Root: ${workspace.root}`,
            `Mode: ${workspace.mode}`,
            loadedAgentsFiles.length > 0
              ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
              : undefined,
            "Nested project instructions: lazy path-based loading enabled.",
            !instructionScan.complete
              ? `Warning: nested instruction scan was incomplete (${instructionScan.reason ?? "unknown"}); some instruction files may be missing.`
              : undefined,
            visibleSkills.length > 0
              ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
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
          sourceRoot: workspace.sourceRoot,
          worktree: workspace.worktree,
          agentsFiles: loadedAgentsFiles,
          availableAgentsFiles: availableAgentsFileOutputs,
          instructionScan,
          skills: visibleSkills,
          agentProviders: visibleAgentProviders,
          agents: visibleAgents,
          skillDiagnostics: workspace.skillDiagnostics,
          instruction,
        },
      };
    },
  );

  registerAppTool(
    server,
    "close_workspace",
    {
      title: "Close workspace",
      description:
        "Use this only after the user explicitly asks to close or release a workspace; never call it automatically at the end of a turn, task, or conversation. It terminates running processes and removes clean managed worktrees, while dirty managed worktrees remain open with closed=false.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
      },
      outputSchema: {
        workspaceId: z.string(),
        closed: z.boolean(),
        processesTerminated: z.number().int().nonnegative(),
        worktreeRemoved: z.boolean(),
        worktreeRetainedReason: z.literal("dirty").optional(),
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
          workspaceId,
          closed,
          processesTerminated,
          worktreeRemoved,
          worktreeRetainedReason,
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
          "Use this when inspecting a workspace file or an advertised project instruction file.",
          config.skillsEnabled
            ? "Advertised skill files are also readable when a matching skill applies."
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "File path to read, relative to the workspace root. May also be an advertised skill path from open_workspace skills."
              : "File path to read, relative to the workspace root.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of lines to read."),
      },
      outputSchema: resultOutputSchema(),
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
      } else {
        const completeSkillRead =
          readPath.skillRead?.isSkillFile === true &&
          isCompleteReadResult(input, response.details);
        workspaces.markReadPathLoaded(workspace, readPath, completeSkillRead);
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
            payload: { content },
          },
        },
        structuredContent: {
          result: contentText(content),
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
        `Use this instead of repeated read calls when 2–${BATCH_MAX_ITEMS} workspace files are already known. Reads run concurrently with stable ordered, bounded output and per-file errors. Keep using read for one file or when the next path depends on the current result.`,
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        files: z
          .array(z.object({
            path: z.string().min(1).max(1_024).describe("File path relative to the workspace root."),
            offset: z.number().int().positive().optional().describe("1-indexed starting line."),
            limit: z
              .number()
              .int()
              .positive()
              .max(BATCH_READ_MAX_LINES)
              .optional()
              .describe(`Maximum lines for this file; defaults to ${BATCH_READ_DEFAULT_LINES}.`),
          }))
          .min(1)
          .max(BATCH_MAX_ITEMS),
      },
      outputSchema: resultOutputSchema({
        items: z.array(batchItemOutputSchema),
        truncated: z.boolean(),
      }),
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
          if (!response.isError) workspaces.markReadPathLoaded(workspace, readPath, false);
          return { ok: !response.isError, result: contentText(response.content) };
        },
      );
      const agentsNotice = applicableAgentsNotice(newlyLoadedAgentsFiles, workspace.root);
      const combined = combineBatchResultWithInstructions(batch.result, batch.truncated, agentsNotice);
      if (combined.instructionsDelivered) {
        await workspaces.markAgentsFilesDelivered(workspace, newlyLoadedAgentsFiles);
      }
      const { result } = combined;
      const content = [textBlock(result)];
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
            summary: { items: batch.items.length, failed: batch.items.filter((item) => !item.ok).length, truncated: combined.truncated },
            payload: { content },
          },
        },
        structuredContent: { result, items: batch.items, truncated: combined.truncated },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.batchInspect,
    {
      title: "Batch inspect workspace",
      description:
        `Use this when 2–${BATCH_MAX_ITEMS} searches, globs, or directory listings are already known and independent. Operations run concurrently with stable ordered, bounded output and per-operation errors. Do not use it for shell commands or speculative steps whose inputs depend on earlier results.`,
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        operations: z
          .array(z.discriminatedUnion("operation", [
            z.object({
              operation: z.literal("grep"),
              pattern: z.string().min(1).max(1_000),
              path: z.string().min(1).max(1_024).optional().describe("Workspace-relative scope; defaults to the workspace root."),
              include: z.string().max(1_000).optional().describe("Optional include glob."),
            }),
            z.object({
              operation: z.literal("glob"),
              pattern: z.string().min(1).max(1_000),
              path: z.string().min(1).max(1_024).optional().describe("Workspace-relative scope; defaults to the workspace root."),
            }),
            z.object({
              operation: z.literal("ls"),
              path: z.string().min(1).max(1_024).describe("Workspace-relative directory path."),
            }),
          ]))
          .min(1)
          .max(BATCH_MAX_ITEMS),
      },
      outputSchema: resultOutputSchema({
        items: z.array(batchItemOutputSchema),
        truncated: z.boolean(),
      }),
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
      const combined = combineBatchResultWithInstructions(batch.result, batch.truncated, agentsNotice);
      if (combined.instructionsDelivered) {
        await workspaces.markAgentsFilesDelivered(workspace, newlyLoadedAgentsFiles);
      }
      const { result } = combined;
      const content = [textBlock(result)];
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
            summary: { items: batch.items.length, failed: batch.items.filter((item) => !item.ok).length, truncated: combined.truncated },
            payload: { content },
          },
        },
        structuredContent: { result, items: batch.items, truncated: combined.truncated },
      };
    },
  );

  if (config.toolMode !== "codex") {
  registerAppTool(
    server,
    toolNames.write,
    {
      title: "Write file",
      description:
        `Use this when creating a file or completely replacing its contents. Prefer ${toolNames.edit} for targeted changes to an existing file.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        instructionToken: z.string().optional().describe("One-time token returned by a previous blocked write in this instruction scope."),
        path: z
          .string()
          .describe("File path to write, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
      },
      outputSchema: resultOutputSchema(),
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
              content: response.content,
              patch,
            },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.edit,
    {
      title: "Edit file",
      description:
        `Use this for targeted exact-text replacements in one file. Prefer it over ${toolNames.write} when preserving the rest of an existing file.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        instructionToken: z.string().optional().describe("One-time token returned by a previous blocked edit in this instruction scope."),
        path: z
          .string()
          .describe("File path to edit, relative to the workspace root."),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .describe(
                  "Exact text to replace. Must match uniquely in the original file.",
                ),
              newText: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
      },
      outputSchema: resultOutputSchema({
        status: z.literal("applied"),
      }),
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
          result: contentText(editContent),
        },
      };
    },
  );
  }

  if (config.toolMode === "codex") {
    registerAppTool(
      server,
      "apply_patch",
      {
        title: "Apply patch",
        description:
          "Use this when modifying one or more workspace files with a Codex-style patch. Supports adding, updating, deleting, and moving files with workspace-relative paths.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          instructionToken: z.string().optional().describe("One-time token returned by a previous blocked patch in this instruction scope."),
          patch: z
            .string()
            .describe("Patch text enclosed by *** Begin Patch and *** End Patch markers."),
        },
        outputSchema: resultOutputSchema({
          additions: z.number(),
          removals: z.number(),
          files: z.array(
            z.object({
              path: z.string(),
              previousPath: z.string().optional(),
              operation: z.enum(["add", "update", "delete", "move"]),
            }),
          ),
        }),
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
            result,
            additions: applied.additions,
            removals: applied.removals,
            files: applied.files,
          },
        };
      },
    );
  }

  if (config.widgets === "changes") {
    registerAppTool(
      server,
      "show_changes",
      {
        title: "Show changes",
        description:
          "Use this when the current turn modified files and the user should inspect the aggregate diff. It renders changes since the previous call and advances that review checkpoint.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
        },
        outputSchema: resultOutputSchema(),
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
          structuredContent: {
            result: contentText(content),
          },
        };
      },
    );
  }

  if (config.toolMode === "full") {
    registerAppTool(
      server,
      toolNames.grep,
      {
        title: "Grep",
        description:
          "Use this when searching workspace file contents for text, symbols, or usage sites. It respects project ignore rules and can be scoped by path or include glob.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          pattern: z.string().describe("Search pattern."),
          path: z
            .string()
            .optional()
            .describe(
              "Optional path or glob scope relative to the workspace root.",
            ),
          include: z.string().optional().describe("Optional include glob."),
        },
        outputSchema: resultOutputSchema(),
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
              payload: { content },
            },
          },
          structuredContent: {
            result: contentText(content),
          },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.glob,
      {
        title: "Glob",
        description:
          "Use this when discovering workspace files by glob pattern or narrowing a file set before reading. It respects project ignore rules and can be scoped by path.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          pattern: z.string().describe("File glob pattern."),
          path: z
            .string()
            .optional()
            .describe("Optional path scope relative to the workspace root."),
        },
        outputSchema: resultOutputSchema(),
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
              payload: { content },
            },
          },
          structuredContent: {
            result: contentText(content),
          },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.ls,
      {
        title: "Ls",
        description:
          "Use this when inspecting the entries in a workspace directory before choosing files to read or modify.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          path: z
            .string()
            .describe(
              "Directory path to list, relative to the workspace root.",
            ),
        },
        outputSchema: resultOutputSchema(),
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
              payload: { content },
            },
          },
          structuredContent: {
            result: contentText(content),
          },
        };
      },
    );
  }

  if (config.toolMode !== "codex") {
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
            .describe("Approximate output token budget. Defaults to 10000."),
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
        const instructionGate = await applicableMutationGate(
          workspaces,
          workspace,
          commandScopes.paths,
          instructionToken,
        );
        if (instructionGate) return instructionGate;

        try {
          const response = await runWorkspaceBash({
            workspaces,
            processSessions,
            workspace,
            writeStdinTool: toolNames.writeStdin,
            input: {
              command,
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
                payload: { content: response.content },
              },
            },
            structuredContent: {
              result: contentText(response.content),
              sessionId: response.snapshot.sessionId,
              running: response.snapshot.running,
              exitCode: response.snapshot.exitCode,
              signal: response.snapshot.signal,
              wallTimeMs: response.snapshot.wallTimeMs,
              outputTruncated: response.snapshot.outputTruncated,
              originalTokenCount: response.snapshot.originalTokenCount,
              outputOmittedBytes: response.snapshot.outputOmittedBytes,
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

  if (config.toolMode === "codex") {
    registerCodexProcessTools(server, config, workspaces, processSessions, ownerClientId);
  }

  return server;
}

export { readinessSnapshot } from "./runtime-control-plane.js";

export function createServer(config = loadConfig()): RunningServer {
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
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const localAgentStore = createLocalAgentStore(config);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager();
  const processSessions = new ProcessSessionManager({
    maxSessions: config.resources.maxProcessSessions,
    maxSessionsPerClient: config.resources.maxProcessSessionsPerClient,
    maxSessionsPerWorkspace: config.resources.maxProcessSessionsPerWorkspace,
    maxRuntimeMs: config.resources.maxCommandRuntimeMs,
    terminationGraceMs: config.resources.processShutdownGraceMs,
  });
  let closing = false;
  const localAgentProviders = config.subagents
    ? getLocalAgentProviderAvailabilitySnapshot()
    : [];

  const logSessionCloseResults = (
    reason: "idle_timeout" | "capacity_reclaim" | "server_shutdown",
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
    app.set("trust proxy", true);
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
    isClosing: () => closing,
    workspaceDatabaseReady: () => workspaces.isReady(),
    oauthDatabaseReady: () => oauthProvider.isReady(),
    mcpUsage: () => transports.usageSnapshot(),
    processUsage: () => processSessions.usageSnapshot(),
    workspaceUsage: () => workspaces.usageSnapshot(),
    oauthUsage: () => oauthProvider.diagnosticSnapshot(),
    revokeAll: () => oauthProvider.revokeAll(),
    runtimeDiagnostics,
    onGlobalRevocation: (revoked) => {
      logEvent(config.logging, "warn", "oauth_global_revocation", { ...revoked });
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
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
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
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
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
          localAgentProviders,
          runtimeDiagnostics,
          activeToolHandlers,
        );
        await server.connect(transport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
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
      runtimeDiagnostics.recordFailure("mcp_request_error", error);
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        clientIdHash: identifierHash(ownerClientId),
        ...errorFields(error),
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
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
