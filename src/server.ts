import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { basename, dirname, relative, sep } from "node:path";
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
import {
  applyPreparedPatch,
  FileVersionConflictError,
  InvalidPatchError,
  preparePatch,
} from "./apply-patch.js";
import { readFileVersion, type FileVersion } from "./file-version.js";
import { loadConfig, type ServerConfig, type WidgetMode } from "./config.js";
import {
  logEvent,
  requestIp,
  requestPath,
  commandPreview,
  connectionRef,
  errorFields,
  identifierHash,
  sessionIdPrefix,
  workspaceActivityRef,
} from "./logger.js";
import {
  buildCodexServerInstructions,
  buildWorkspaceLifecycleInstruction,
} from "./bash-prompt.js";
import { classifyCommand } from "./command-policy.js";
import {
  validateShellProtectedPaths,
  validateShellWriteTargets,
} from "./shell-write-targets.js";
import { analyzeShellCommandScopes } from "./shell-command-scopes.js";
import { executableChain, isShellProgram, unwrapShellWrappers } from "./shell-command-analysis.js";
import {
  BATCH_MAX_ITEMS,
  BATCH_READ_DEFAULT_LINES,
  BATCH_READ_MAX_LINES,
  runBoundedBatch,
  type BatchItemResult,
} from "./batch-tools.js";
import {
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
} from "./pi-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import {
  McpSessionRegistry,
  type McpSessionCloseResult,
  type McpSessionReservation,
  type StatelessMcpRequestLease,
} from "./mcp-sessions.js";
import {
  isInteractiveShellCommand,
  MAX_PROCESS_INPUT_BYTES,
  ProcessSessionManager,
  UnknownProcessSessionError,
  type PreparedProcessInput,
  type ProcessSnapshot,
} from "./process-sessions.js";
import {
  ProcessOutputNotFoundError,
  ProcessOutputStore,
} from "./process-output-store.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { skillUriRoot, SkillUriError, type Skill } from "./skills.js";
import { createWorkspaceStore } from "./workspace-store.js";
import {
  MutationOperationStore,
  type MutationOperationKey,
} from "./mutation-operation-store.js";
import {
  formatAgentsPath,
  InstructionTokenError,
  InstructionBudgetError,
  SkillLoadError,
  SkillNotLoadedError,
  StaleWorkspaceGenerationError,
  UnknownWorkspaceError,
  UnknownWorkspaceAliasError,
  WorkspaceReadOnlyError,
  WorkspaceAliasConflictError,
  WorkspaceQuotaError,
  WorkspaceRegistry,
  WorkspaceResumeRequiredError,
  WorkspaceContextSessionError,
  type ApplicableAgentsFile,
  type WorkspaceContext,
  type WorkspaceSummary,
  type Workspace,
} from "./workspaces.js";
import { GitWorktreeError, removeManagedWorktree } from "./git-worktrees.js";
import { RuntimeDiagnostics } from "./runtime-diagnostics.js";
import { ActiveRequestBarrier } from "./request-barrier.js";
import { createRuntimeControlPlane } from "./runtime-control-plane.js";
import { AccessDeniedError, allowedRootsRevision, isPathInsideRoot } from "./roots.js";
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
import {
  createWorkspaceContextReceiptManager,
  serializeWorkspaceContext,
  type WorkspaceContextInstructionItem,
  type WorkspaceContextReceiptBinding,
  type WorkspaceContextReceiptManager,
} from "./workspace-context-protocol.js";
import {
  createApplyPatchEffects,
  createProcessInteractEffects,
  createProcessStartEffects,
  createReviewEffects,
  createWorkspaceCloseEffects,
  createWorkspaceOpenEffects,
  createWorkspaceRevokeEffects,
  type ToolEffects,
} from "./tool-effects.js";

const SHELL_COMMAND_MAX_CHARACTERS = 100_000;

type Transport = StreamableHTTPServerTransport;
type McpTransportMode = "stateful" | "stateless";
interface RequestCorrelationState {
  workspaceId?: string;
  workspaceActivityRef?: string;
}

const requestContext = new AsyncLocalStorage<{
  clientId: string;
  requestId?: string;
  correlation: RequestCorrelationState;
  workspaceBinding?: WorkspaceContextReceiptBinding;
}>();
const toolHandlerBarriers = new WeakMap<McpServer, ActiveRequestBarrier>();
const toolErrorReporters = new WeakMap<McpServer, (tool: string, error: unknown) => void>();

interface PublicToolError {
  code: string;
  text: string;
  retryable?: boolean;
  safeToRetry?: boolean;
  recovery?: string;
  phase?: OperationPhase;
  effectsKnown?: boolean;
  operationId?: string;
}

type OperationPhase = "not_started" | "committed" | "outcome_unknown";

interface OperationEnvelope {
  id: string;
  phase: OperationPhase;
  safeToRetry: boolean;
  effectsKnown: boolean;
}

class PublicActionError extends Error {
  constructor(
    readonly code: string,
    readonly publicText: string,
    readonly semantics: Omit<PublicToolError, "code" | "text"> = {},
  ) {
    super(publicText);
    this.name = "PublicActionError";
  }
}

class MutationExecutionError extends Error {
  constructor(
    readonly operationId: string,
    cause: unknown,
  ) {
    super("Mutation outcome is unknown.", { cause });
    this.name = "MutationExecutionError";
  }
}

function publicToolError(error: unknown, toolName: string): PublicToolError | undefined {
  if (error instanceof MutationExecutionError) {
    return {
      code: "tool_failed",
      text: "tool_failed: The mutation may have executed; inspect effects or operation status before any rerun.",
      retryable: false,
      safeToRetry: false,
      recovery: "verify_effects",
      phase: "outcome_unknown",
      effectsKnown: false,
      operationId: error.operationId,
    };
  }
  if (error instanceof PublicActionError) {
    return { code: error.code, text: `${error.code}: ${error.publicText}`, ...error.semantics };
  }
  if (error instanceof UnknownWorkspaceError) {
    return {
      code: error.code,
      text: "unknown_workspace: Call open_workspace for the project, replace workspaceId, and retry once.",
      recovery: "open_workspace",
    };
  }
  if (error instanceof UnknownProcessSessionError) {
    return {
      code: error.code,
      text: "unknown_process_session: Stop polling; read the prior outputId if available, then verify effects before rerun.",
      safeToRetry: false,
      recovery: "verify_process_effects",
    };
  }
  if (error instanceof ProcessOutputNotFoundError) {
    return {
      code: error.code,
      text: "process_output_not_found: Stop paging this outputId; verify effects before rerun.",
      retryable: false,
      recovery: "stop_paging",
    };
  }
  if (error instanceof InstructionTokenError) {
    return {
      code: error.code,
      text: "instruction_token_invalid: Retry the same tool without instructionToken to receive current instructions.",
      recovery: "refresh_instructions",
    };
  }
  if (error instanceof SkillNotLoadedError) {
    return {
      code: error.code,
      text: `${error.code}: ${error.publicText}`,
    };
  }
  if (error instanceof SkillLoadError) {
    const changed = error.code === "skill_manifest_changed" || error.code === "skill_metadata_changed";
    return {
      code: error.code,
      text: `${error.code}: ${error.publicText}`,
      retryable: changed,
      safeToRetry: false,
      recovery: changed ? "skill_reload_required" : "inspect_skill_error",
      phase: "not_started",
    };
  }
  if (error instanceof SkillUriError) {
    return {
      code: error.code,
      text: `${error.code}: ${error.publicText}`,
    };
  }
  if (error instanceof WorkspaceResumeRequiredError) {
    return {
      code: error.code,
      text: "workspace_resume_required: Call list_workspaces, then resume_workspace with contextMode=\"full\".",
      recovery: "resume_workspace",
    };
  }
  if (error instanceof WorkspaceContextSessionError) {
    return {
      code: error.code,
      text: "workspace_context_required: Call get_workspace_context with the current receipt, or resume_workspace after reconnecting.",
      retryable: true,
      safeToRetry: true,
      recovery: "get_workspace_context",
      phase: "not_started",
    };
  }
  if (error instanceof StaleWorkspaceGenerationError) {
    return {
      code: error.code,
      text: "stale_workspace_generation: Call list_workspaces, then resume_workspace with contextMode=\"full\" before retrying.",
      retryable: true,
      safeToRetry: true,
      recovery: "resume_workspace",
      phase: "not_started",
    };
  }
  if (error instanceof UnknownWorkspaceAliasError) {
    return {
      code: error.code,
      text: "unknown_workspace_alias: Call list_workspaces and use a current alias.",
      recovery: "list_workspaces",
    };
  }
  if (error instanceof WorkspaceReadOnlyError) {
    return {
      code: error.code,
      text: "workspace_read_only: Open a managed worktree, or explicitly open checkout with writeAccess=\"read_write\".",
      retryable: false,
      recovery: "open_writable_workspace",
    };
  }
  if (error instanceof FileVersionConflictError) {
    return {
      code: "file_version_conflict",
      text: `file_version_conflict: ${error.path} changed; read it again before applying a new patch.`,
      retryable: true,
      safeToRetry: false,
      recovery: "read_file_again",
      phase: "not_started",
    };
  }
  if (error instanceof InvalidPatchError) {
    return {
      code: error.code,
      text: `${error.code}: ${error.publicText}`,
      retryable: true,
      safeToRetry: true,
      recovery: "read",
      phase: "not_started",
    };
  }
  if (error instanceof WorkspaceQuotaError) {
    return {
      code: error.code,
      text: `${error.code}: ${error.publicText}`,
      retryable: true,
      safeToRetry: true,
      recovery: "close_workspace",
      phase: "not_started",
    };
  }
  if (error instanceof WorkspaceAliasConflictError) {
    return {
      code: error.code,
      text: `${error.code}: Resume the existing workspace with alias ${JSON.stringify(error.currentAlias)}.`,
      retryable: true,
      safeToRetry: true,
      recovery: "resume_workspace",
      phase: "not_started",
    };
  }
  if (error instanceof InstructionBudgetError) {
    return {
      code: error.code,
      text: `${error.code}: ${error.publicText}`,
      retryable: false,
      safeToRetry: false,
      recovery: "user_action_required",
      phase: "not_started",
    };
  }
  if (error instanceof GitWorktreeError) {
    const details: Record<GitWorktreeError["code"], { code: string; text: string; recovery: string }> = {
      GIT_NOT_AVAILABLE: {
        code: "git_not_available",
        text: "Git is unavailable; install Git or open the project in checkout mode.",
        recovery: "open_workspace",
      },
      GIT_REPOSITORY_NOT_FOUND: {
        code: "git_repository_not_found",
        text: "Worktree mode requires a Git repository; use checkout mode or initialize the repository first.",
        recovery: "open_workspace",
      },
      GIT_REPOSITORY_HAS_NO_COMMITS: {
        code: "git_repository_has_no_commits",
        text: "Worktree mode requires an initial commit; create one or use checkout mode.",
        recovery: "open_workspace",
      },
      GIT_INVALID_BASE_REF: {
        code: "git_invalid_base_ref",
        text: "The requested baseRef does not resolve to a commit; choose a valid ref and call open_workspace again.",
        recovery: "open_workspace",
      },
      GIT_WORKTREE_CREATE_FAILED: {
        code: "git_worktree_create_failed",
        text: "Git could not create the managed worktree; inspect the repository state, then retry open_workspace.",
        recovery: "open_workspace",
      },
    };
    const detail = details[error.code];
    return {
      code: detail.code,
      text: `${detail.code}: ${detail.text}`,
      retryable: true,
      safeToRetry: true,
      recovery: detail.recovery,
      phase: "not_started",
    };
  }
  if (error instanceof AccessDeniedError) {
    return toolName === toolNames.openWorkspace
      ? {
          code: "path_not_allowed",
          text: "path_not_allowed: Open an approved project path; for isolation use mode=\"worktree\" on its source project.",
        }
      : {
          code: "path_denied",
          text: "path_denied: Use a path inside the opened workspace.",
        };
  }
  return undefined;
}

function structuredToolError(error: PublicToolError) {
  const defaults = error.code === "instructions_required"
    ? {
        retryable: true,
        safeToRetry: true,
        recovery: "load_workspace_instructions",
        phase: "not_started" as const,
      }
    : error.code === "instruction_state_changed"
      ? {
          retryable: true,
          safeToRetry: true,
          recovery: "reload_workspace_instructions",
          phase: "not_started" as const,
        }
      : error.code === "tool_failed"
    ? {
        retryable: false,
        safeToRetry: false,
        recovery: "verify_effects",
        phase: "outcome_unknown" as const,
      }
      : {
        retryable: true,
        safeToRetry: true,
        recovery: "correct_and_retry",
        phase: "not_started" as const,
      };
  const phase = error.phase ?? defaults.phase;
  return {
    code: error.code,
    retryable: error.retryable ?? defaults.retryable,
    safeToRetry: error.safeToRetry ?? defaults.safeToRetry,
    recovery: error.recovery ?? defaults.recovery,
    phase,
    effectsKnown: error.effectsKnown ?? phase !== "outcome_unknown",
  };
}

function operationEnvelope(
  id: string,
  phase: OperationPhase,
  safeToRetry: boolean,
  effectsKnown: boolean,
): OperationEnvelope {
  return { id, phase, safeToRetry, effectsKnown };
}

function attachOperationEnvelope<T>(
  value: T,
  operation: OperationEnvelope,
): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const structured = record.structuredContent &&
      typeof record.structuredContent === "object" &&
      !Array.isArray(record.structuredContent)
    ? record.structuredContent as Record<string, unknown>
    : {};
  return {
    ...record,
    structuredContent: { ...structured, operation },
  } as T;
}

function operationSemanticsFromResult(value: unknown): Omit<OperationEnvelope, "id"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { phase: "committed", safeToRetry: false, effectsKnown: true };
  }
  const record = value as Record<string, unknown>;
  const structured = record.structuredContent &&
      typeof record.structuredContent === "object" &&
      !Array.isArray(record.structuredContent)
    ? record.structuredContent as Record<string, unknown>
    : undefined;
  const meta = record._meta && typeof record._meta === "object" && !Array.isArray(record._meta)
    ? record._meta as Record<string, unknown>
    : undefined;
  const rawError = structured?.error ?? meta?.error;
  const error = rawError && typeof rawError === "object" && !Array.isArray(rawError)
    ? rawError as Record<string, unknown>
    : undefined;
  const normalizedError = typeof error?.code === "string"
    ? structuredToolError({
        code: error.code,
        text: "",
        ...(typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}),
        ...(typeof error.safeToRetry === "boolean" ? { safeToRetry: error.safeToRetry } : {}),
        ...(typeof error.recovery === "string" ? { recovery: error.recovery } : {}),
        ...(error.phase === "not_started" ||
            error.phase === "committed" ||
            error.phase === "outcome_unknown"
          ? { phase: error.phase }
          : {}),
        ...(typeof error.effectsKnown === "boolean" ? { effectsKnown: error.effectsKnown } : {}),
      })
    : undefined;
  const phase = normalizedError?.phase ?? "committed";
  return {
    phase,
    safeToRetry: normalizedError?.safeToRetry ?? false,
    effectsKnown: normalizedError?.effectsKnown ?? phase !== "outcome_unknown",
  };
}

function attachWorkspaceEnvelope(
  structured: Record<string, unknown>,
): Record<string, unknown> {
  const binding = requestContext.getStore()?.workspaceBinding;
  if (!binding) return structured;
  const existingWorkspace = structured.workspace &&
      typeof structured.workspace === "object" &&
      !Array.isArray(structured.workspace)
    ? structured.workspace as Record<string, unknown>
    : undefined;
  const existingContext = structured.context &&
      typeof structured.context === "object" &&
      !Array.isArray(structured.context)
    ? structured.context as Record<string, unknown>
    : undefined;
  return {
    ...structured,
    workspace: existingWorkspace ?? {
      ref: binding.workspaceId,
      generation: binding.generation,
    },
    context: {
      phase: binding.phase,
      instructionRevision: binding.instructionRevision,
      skillRevision: binding.skillRevision,
      ...(existingContext ?? {}),
    },
  };
}

interface PendingMutationOperation {
  requestHash: string;
  result: Promise<unknown>;
}

function mutationRequestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const RELEASABLE_MUTATION_PREFLIGHT_CODES = new Set([
  "instructions_required",
  "instruction_state_changed",
  "instruction_token_invalid",
  "if_match_required",
  "if_match_ambiguous",
  "blind_write_reason_required",
]);

function releasableMutationPreflightCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const meta = (value as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const error = (meta as { error?: unknown }).error;
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && RELEASABLE_MUTATION_PREFLIGHT_CODES.has(code)
    ? code
    : undefined;
}

async function runMutationOperation<T>(options: {
  store: MutationOperationStore;
  pending: Map<string, PendingMutationOperation>;
  key: MutationOperationKey;
  workspaceGeneration: number;
  request: unknown;
  execute: () => Promise<T>;
}): Promise<T> {
  const requestHash = mutationRequestHash({
    workspaceId: options.key.workspaceId,
    workspaceGeneration: options.workspaceGeneration,
    tool: options.key.tool,
    request: options.request,
  });
  const identity = [
    options.key.ownerClientId,
    options.key.operationId,
  ].join("\0");
  const inFlight = options.pending.get(identity);
  if (inFlight) {
    if (inFlight.requestHash !== requestHash) {
      throw new PublicActionError(
        "operation_id_conflict",
        "This operationId was already used with different arguments; use a new operationId.",
        {
          retryable: false,
          safeToRetry: false,
          recovery: "new_operation_id",
          operationId: options.key.operationId,
        },
      );
    }
    return await inFlight.result as T;
  }

  const reservation = options.store.reserve(options.key, requestHash, options.workspaceGeneration);
  if (reservation.status === "replay") {
    const replayed = reservation.result as T;
    const record = replayed && typeof replayed === "object" && !Array.isArray(replayed)
      ? replayed as Record<string, unknown>
      : undefined;
    const structured = record?.structuredContent &&
        typeof record.structuredContent === "object" &&
        !Array.isArray(record.structuredContent)
      ? record.structuredContent as Record<string, unknown>
      : undefined;
    return structured?.operation
      ? replayed
      : attachOperationEnvelope(
          replayed,
          operationEnvelope(options.key.operationId, "committed", false, true),
        );
  }
  if (reservation.status === "conflict") {
    throw new PublicActionError(
      "operation_id_conflict",
      "This operationId was already used with different arguments; use a new operationId.",
      {
        retryable: false,
        safeToRetry: false,
        recovery: "new_operation_id",
        operationId: options.key.operationId,
      },
    );
  }
  if (reservation.status === "stale_generation") {
    throw new PublicActionError(
      "stale_workspace_generation",
      "Call list_workspaces, then resume_workspace with contextMode=\"full\" before retrying.",
      {
        retryable: true,
        safeToRetry: true,
        recovery: "resume_workspace",
        phase: "not_started",
        operationId: options.key.operationId,
      },
    );
  }
  if (reservation.status === "outcome_unknown") {
    throw new PublicActionError(
      "operation_outcome_unknown",
      "Do not rerun automatically; verify the operation's effects first.",
      {
        retryable: false,
        safeToRetry: false,
        recovery: "verify_effects",
        phase: "outcome_unknown",
        effectsKnown: false,
        operationId: options.key.operationId,
      },
    );
  }
  if (reservation.status === "result_unavailable") {
    throw new PublicActionError(
      "operation_result_unavailable",
      "The operation completed, but its replay result is unavailable; verify effects instead of rerunning.",
      {
        retryable: false,
        safeToRetry: false,
        recovery: "verify_effects",
        phase: "committed",
        effectsKnown: false,
        operationId: options.key.operationId,
      },
    );
  }

  const result = (async () => {
    try {
      const value = await options.execute();
      if (releasableMutationPreflightCode(value)) {
        options.store.cancelPending(options.key, requestHash);
        return attachOperationEnvelope(
          value,
          operationEnvelope(options.key.operationId, "not_started", true, true),
        );
      }
      const semantics = operationSemanticsFromResult(value);
      const enveloped = attachOperationEnvelope(
        value,
        operationEnvelope(
          options.key.operationId,
          semantics.phase,
          semantics.safeToRetry,
          semantics.effectsKnown,
        ),
      );
      options.store.settle(options.key, requestHash, enveloped);
      return enveloped;
    } catch (error) {
      const knownFailure = publicToolError(error, options.key.tool);
      if (knownFailure && (knownFailure.phase ?? "not_started") === "not_started") {
        const structuredError = structuredToolError({
          ...knownFailure,
          operationId: options.key.operationId,
        });
        const response = {
          content: [textBlock(knownFailure.text)],
          isError: true as const,
          structuredContent: { ok: false, error: structuredError },
          _meta: { error: structuredError },
        };
        const enveloped = attachOperationEnvelope(
          response,
          operationEnvelope(
            options.key.operationId,
            structuredError.phase,
            structuredError.safeToRetry,
            structuredError.effectsKnown,
          ),
        );
        if (RELEASABLE_MUTATION_PREFLIGHT_CODES.has(knownFailure.code)) {
          options.store.cancelPending(options.key, requestHash);
        } else {
          options.store.settle(options.key, requestHash, enveloped);
        }
        return enveloped as T;
      }
      options.store.markOutcomeUnknown(options.key, requestHash);
      throw new MutationExecutionError(options.key.operationId, error);
    } finally {
      options.pending.delete(identity);
    }
  })();
  options.pending.set(identity, { requestHash, result });
  return await result;
}

export function isChatGptOAuthClient(
  client: { redirect_uris?: readonly string[] } | undefined,
): boolean {
  const redirectUris = client?.redirect_uris;
  if (!redirectUris?.length) return false;
  return redirectUris.every((redirectUri) => {
    try {
      const parsed = new URL(redirectUri);
      return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "chatgpt.com";
    } catch {
      return false;
    }
  });
}

export function isExpectedPiToolError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR";
}

const registerAppTool: typeof registerSdkAppTool = ((...args: unknown[]) => {
  const server = args[0] as McpServer;
  const toolName = typeof args[1] === "string" ? args[1] : "unknown";
  const handlerIndex = args.length - 1;
  const handler = args[handlerIndex];
  const barrier = toolHandlerBarriers.get(server);
  if (typeof handler === "function") {
    const invoke = async (handlerArgs: unknown[]) => {
      try {
        const result: unknown = await handler(...handlerArgs);
        if (!result || typeof result !== "object" || Array.isArray(result)) return result;
        const record = result as Record<string, unknown>;
        const meta = record._meta && typeof record._meta === "object" && !Array.isArray(record._meta)
          ? record._meta as Record<string, unknown>
          : {};
        if (record.isError === true) {
          const existingError = meta.error && typeof meta.error === "object" && !Array.isArray(meta.error)
            ? meta.error as Record<string, unknown>
            : {};
          const code = typeof existingError.code === "string" ? existingError.code : "tool_rejected";
          const retryable = typeof existingError.retryable === "boolean"
            ? existingError.retryable
            : undefined;
          const safeToRetry = typeof existingError.safeToRetry === "boolean"
            ? existingError.safeToRetry
            : undefined;
          const recovery = typeof existingError.recovery === "string"
            ? existingError.recovery
            : undefined;
          const phase = existingError.phase === "not_started" ||
              existingError.phase === "committed" ||
              existingError.phase === "outcome_unknown"
            ? existingError.phase
            : undefined;
          const effectsKnown = typeof existingError.effectsKnown === "boolean"
            ? existingError.effectsKnown
            : undefined;
          const error = structuredToolError({
            code,
            text: "",
            ...(retryable === undefined ? {} : { retryable }),
            ...(safeToRetry === undefined ? {} : { safeToRetry }),
            ...(recovery === undefined ? {} : { recovery }),
            ...(phase === undefined ? {} : { phase }),
            ...(effectsKnown === undefined ? {} : { effectsKnown }),
          });
          const structured = record.structuredContent && typeof record.structuredContent === "object" && !Array.isArray(record.structuredContent)
            ? record.structuredContent as Record<string, unknown>
            : {};
          return {
            ...record,
            structuredContent: attachWorkspaceEnvelope({ ...structured, ok: false, error }),
            _meta: { ...meta, tool: toolName, error },
          };
        }
        const structured = record.structuredContent &&
            typeof record.structuredContent === "object" &&
            !Array.isArray(record.structuredContent)
          ? record.structuredContent as Record<string, unknown>
          : undefined;
        return {
          ...record,
          ...(structured ? { structuredContent: attachWorkspaceEnvelope(structured) } : {}),
          _meta: { ...meta, tool: toolName },
        };
      } catch (error) {
        const publicError = publicToolError(error, toolName) ?? {
          code: "tool_failed",
          text: "tool_failed: The tool failed before completion; inspect DevSpace server logs.",
        };
        if (publicError.code === "tool_failed") {
          toolErrorReporters.get(server)?.(toolName, error);
        }
        const structuredError = structuredToolError(publicError);
        const result = {
          content: [{ type: "text" as const, text: publicError.text }],
          isError: true,
          structuredContent: attachWorkspaceEnvelope({ ok: false, error: structuredError }),
          _meta: { tool: toolName, error: structuredError },
        };
        return publicError.operationId
          ? attachOperationEnvelope(
              result,
              operationEnvelope(
                publicError.operationId,
                structuredError.phase,
                structuredError.safeToRetry,
                structuredError.effectsKnown,
              ),
            )
          : result;
      }
    };
    args[handlerIndex] = (...handlerArgs: unknown[]) => barrier
      ? barrier.track(() => invoke(handlerArgs))
      : invoke(handlerArgs);
  }
  const definition = args[2];
  if (
    definition &&
    typeof definition === "object" &&
    !Array.isArray(definition) &&
    !("_meta" in definition)
  ) {
    return (server.registerTool as (...parameters: unknown[]) => unknown)(
      toolName,
      definition,
      args[handlerIndex],
    );
  }
  return (registerSdkAppTool as (...parameters: unknown[]) => unknown)(...args);
}) as typeof registerSdkAppTool;

type WorkspaceToolLease = "shared" | "exclusive";
type WorkspaceContextRequirement = "metadata" | "context_loaded";
const workspaceToolLeases = new Map<string, WorkspaceToolLease>();
const workspaceToolContextRequirements = new Map<string, WorkspaceContextRequirement>();

function workspaceToolRegistrar(
  lease: WorkspaceToolLease,
  requirement: WorkspaceContextRequirement,
): typeof registerSdkAppTool {
  return ((...args: unknown[]) => {
    const toolName = typeof args[1] === "string" ? args[1] : "unknown";
    workspaceToolLeases.set(toolName, lease);
    workspaceToolContextRequirements.set(toolName, requirement);
    const definition = args[2];
    if (definition && typeof definition === "object" && !Array.isArray(definition)) {
      const record = definition as Record<string, unknown>;
      const input = record.inputSchema && typeof record.inputSchema === "object" && !Array.isArray(record.inputSchema)
        ? record.inputSchema as Record<string, unknown>
        : {};
      const {
        workspaceId: _workspaceId,
        workspaceGeneration: _workspaceGeneration,
        ...toolInput
      } = input;
      record.inputSchema = {
        receipt: z.string().regex(/^wctx3\.[A-Za-z0-9_-]{43}$/u),
        ...toolInput,
      };
    }
    const handlerIndex = args.length - 1;
    const handler = args[handlerIndex];
    if (typeof handler === "function") {
      args[handlerIndex] = (...handlerArgs: unknown[]) => {
        const binding = requestContext.getStore()?.workspaceBinding;
        if (!binding) {
          throw new PublicActionError(
            "workspace_context_required",
            "Call resume_workspace or get_workspace_context to obtain a fresh receipt, then retry once.",
            { retryable: true, safeToRetry: true, recovery: "resume_workspace", phase: "not_started" },
          );
        }
        const input = handlerArgs[0] && typeof handlerArgs[0] === "object" && !Array.isArray(handlerArgs[0])
          ? handlerArgs[0] as Record<string, unknown>
          : {};
        return handler({
          ...input,
          workspaceId: binding.workspaceId,
          workspaceGeneration: binding.generation,
        }, ...handlerArgs.slice(1));
      };
    }
    return (registerAppTool as (...parameters: unknown[]) => unknown)(...args);
  }) as typeof registerSdkAppTool;
}

const registerWorkspaceTool = workspaceToolRegistrar("shared", "context_loaded");
const registerContextWorkspaceTool = workspaceToolRegistrar("shared", "metadata");
const registerExclusiveWorkspaceTool = workspaceToolRegistrar("exclusive", "metadata");
// MCP clients can reconnect without closing the previous transport. Bound stale
// session retention so abandoned MCP servers do not accumulate for the life of the process.
const WORKSPACE_APP_URI = "ui://devspace/workspace-app.html";
const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
export const OPEN_WORKSPACE_ANNOTATIONS = {
  destructiveHint: false,
  openWorldHint: false,
} as const;
const EDIT_TOOL_ANNOTATIONS = {
  openWorldHint: false,
};
export const SHOW_CHANGES_ANNOTATIONS = {
  destructiveHint: false,
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

type ToolWidgetKind =
  | "workspace"
  | "read"
  | "edit"
  | "search"
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
  if (!shouldAttachWidget(config.widgets, kind)) return {} as ToolWidgetDescriptorMeta;

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
  listWorkspaces: "list_workspaces",
  resumeWorkspace: "resume_workspace",
  getWorkspaceContext: "get_workspace_context",
  loadWorkspaceInstructions: "load_workspace_instructions",
  listSkills: "list_skills",
  loadSkill: "load_skill",
  getOperationStatus: "get_operation_status",
  readProcessOutput: "read_process_output",
  closeWorkspace: "close_workspace",
  revokeWorkspace: "revoke_workspace",
  read: "read",
  batchRead: "batch_read",
  batchInspect: "batch_inspect",
  writeStdin: "write_stdin",
  applyPatch: "apply_patch",
  execCommand: "exec_command",
} as const;

function toolDescription(parts: {
  use: string;
  avoid: string;
  requires: string;
  returns: string;
}): string {
  return `Use when ${parts.use} Avoid ${parts.avoid} Needs ${parts.requires} Returns ${parts.returns}`;
}

export function toolSurface(config: Pick<ServerConfig, "widgets" | "skillsEnabled">): string[] {
  const tools: string[] = [
    toolNames.openWorkspace,
    toolNames.listWorkspaces,
    toolNames.resumeWorkspace,
    toolNames.getWorkspaceContext,
    toolNames.loadWorkspaceInstructions,
    toolNames.getOperationStatus,
    toolNames.closeWorkspace,
    toolNames.revokeWorkspace,
    toolNames.read,
    toolNames.batchRead,
    toolNames.batchInspect,
    toolNames.applyPatch,
    toolNames.execCommand,
    toolNames.writeStdin,
    toolNames.readProcessOutput,
  ];
  if (config.skillsEnabled) tools.push(toolNames.listSkills, toolNames.loadSkill);
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
    getWorkspaceContext: toolNames.getWorkspaceContext,
    listWorkspaces: toolNames.listWorkspaces,
    resumeWorkspace: toolNames.resumeWorkspace,
    closeWorkspace: toolNames.closeWorkspace,
  });
  return (
    lifecycleInstruction + " " + buildCodexServerInstructions({
      read: toolNames.read,
      batchRead: toolNames.batchRead,
      batchInspect: toolNames.batchInspect,
      loadSkill: config.skillsEnabled ? toolNames.loadSkill : undefined,
      readProcessOutput: toolNames.readProcessOutput,
      writeStdin: toolNames.writeStdin,
    })
  );
}

const workspaceSkillOutputSchema = z.object({
  skillId: z.string(),
  name: z.string(),
  description: z.string(),
  path: z.string().optional(),
  scope: z.string().optional(),
  explicitOnly: z.literal(true).optional(),
});

export const MAX_SKILL_CATALOG_BYTES = 8_000;

export interface WorkspaceSkillCatalogEntry {
  skillId: string;
  name: string;
  description: string;
  path?: string;
  scope?: string;
  explicitOnly?: true;
}

export interface WorkspaceSkillCatalog {
  skills: WorkspaceSkillCatalogEntry[];
  totalSkills: number;
  omittedSkills: number;
  truncated: boolean;
  bytes: number;
}

function workspaceInstructionRecord(
  file: Pick<ApplicableAgentsFile, "path" | "content">,
  workspaceRoot: string,
): WorkspaceContextInstructionItem {
  const repositoryInstruction = isPathInsideRoot(file.path, workspaceRoot);
  const path = repositoryInstruction
    ? formatAgentsPath(file.path, workspaceRoot)
    : "user-instructions";
  const relativeScope = repositoryInstruction ? dirname(path) : ".";
  return {
    ...(repositoryInstruction
      ? { source: "repository" as const, trust: "repository_untrusted" as const }
      : { source: "user" as const, trust: "user_trusted" as const }),
    scope: relativeScope === "." ? "." : relativeScope.split(sep).join("/"),
    path,
    hash: `sha256-v1:${createHash("sha256").update(file.content).digest("hex")}`,
    content: file.content,
  };
}

function truncateCatalogDescription(description: string, maximum: number): string {
  if (description.length <= maximum) return description;
  if (maximum <= 1) return "…".slice(0, maximum);
  return `${description.slice(0, maximum - 1)}…`;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Builds the model-visible catalog under one exact serialized UTF-8 byte budget. */
export function buildWorkspaceSkillCatalog(
  skills: readonly Skill[],
  maximumBytes = MAX_SKILL_CATALOG_BYTES,
): WorkspaceSkillCatalog {
  const entries: WorkspaceSkillCatalogEntry[] = [];
  let truncated = false;
  const groups = new Map<string, Skill[]>();
  for (const skill of skills) {
    const group = groups.get(skill.name) ?? [];
    group.push(skill);
    groups.set(skill.name, group);
  }

  for (const group of groups.values()) {
    const duplicateName = group.length > 1;
    let candidates = group.map((skill): WorkspaceSkillCatalogEntry => {
      const description = truncateCatalogDescription(skill.description, 320);
      if (description !== skill.description) truncated = true;
      return {
        skillId: skill.skillId,
        name: skill.name,
        description,
        ...(duplicateName
          ? {
              scope: skill.scope,
              path: `${skill.source}:${relative(skill.sourceRoot, skill.filePath).split(sep).join("/")}`,
            }
          : {}),
        ...(!skill.allowImplicitInvocation ? { explicitOnly: true as const } : {}),
      };
    });

    let serializedLength = serializedBytes([...entries, ...candidates]);
    if (serializedLength > maximumBytes && candidates.some((entry) => entry.description.length > 80)) {
      const excessPerEntry = Math.ceil((serializedLength - maximumBytes) / candidates.length);
      candidates = candidates.map((entry) => ({
        ...entry,
        description: truncateCatalogDescription(
          entry.description,
          Math.max(80, entry.description.length - excessPerEntry),
        ),
      }));
      serializedLength = serializedBytes([...entries, ...candidates]);
      truncated = true;
    }

    if (serializedLength > maximumBytes) {
      truncated = true;
      continue;
    }
    entries.push(...candidates);
  }

  return {
    skills: entries,
    totalSkills: skills.length,
    omittedSkills: skills.length - entries.length,
    truncated,
    bytes: serializedBytes(entries),
  };
}

interface SkillCursorPayload {
  revision: string;
  query: string;
  offset: number;
}

function encodeSkillCursor(payload: SkillCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeSkillCursor(cursor: string): SkillCursorPayload {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<SkillCursorPayload>;
    if (
      typeof value.revision !== "string" ||
      typeof value.query !== "string" ||
      !Number.isSafeInteger(value.offset) ||
      (value.offset ?? -1) < 0
    ) {
      throw new Error("invalid cursor fields");
    }
    return value as SkillCursorPayload;
  } catch {
    throw new PublicActionError("invalid_skill_cursor", "The Skill cursor is invalid; restart the listing without a cursor.");
  }
}

function renderWorkspaceContext(
  context: WorkspaceContext,
  contextMode: WorkspaceContextMode,
  knownInstructionRevision: string | undefined,
  knownSkillRevision: string | undefined,
  contextSessionId: string,
  instructionsAcknowledged: boolean,
  receipts: WorkspaceContextReceiptManager,
) {
  const {
    workspace,
    agentsFiles,
    instructionRevision,
    skillRevision,
    instructionScan,
    reused,
  } = context;
  const skillCatalog = buildWorkspaceSkillCatalog(workspace.skills);
  const instructionsIncluded = contextMode === "full" || (
    contextMode === "retained" && knownInstructionRevision !== instructionRevision
  );
  const skillsIncluded = contextMode === "full" || (
    contextMode === "retained" && knownSkillRevision !== skillRevision
  );
  const loadedInstructions = agentsFiles.map((file) => workspaceInstructionRecord(file, workspace.root));
  const returnedInstructions = instructionsIncluded ? loadedInstructions : [];
  const visibleSkills = skillsIncluded ? skillCatalog.skills : [];
  const serialized = serializeWorkspaceContext({
    ownerClientId: workspace.ownerClientId,
    workspaceId: workspace.id,
    contextSessionId,
    phase: contextMode === "metadata" ? "metadata" : "context_loaded",
    workspace: {
      ref: workspace.id,
      generation: workspace.stateGeneration,
      mode: workspace.mode,
      writeAccess: workspace.writeAccess,
    },
    instructions: {
      revision: instructionRevision,
      complete: instructionScan.complete,
      included: instructionsIncluded,
      acknowledged: instructionsAcknowledged,
      items: returnedInstructions,
      ...(instructionScan.reason ? { incompleteReason: instructionScan.reason } : {}),
    },
    skills: {
      revision: skillRevision,
      count: skillCatalog.totalSkills,
      included: skillsIncluded,
      items: visibleSkills,
      warningCount: workspace.skillDiagnostics.length,
    },
  }, receipts);

  return {
    ...serialized,
    summary: {
      workspaceInstructions: returnedInstructions.length,
      instructionsIncluded,
      skills: visibleSkills.length,
      skillsIncluded,
      skillDiagnostics: workspace.skillDiagnostics.length,
      instructionScanComplete: instructionScan.complete,
      contextMode,
      reused,
    },
  };
}

type WorkspaceContextMode = "full" | "retained" | "metadata";

const workspaceContextModeSchema = z.enum(["full", "retained", "metadata"]);

const structuredToolErrorFields = {
  error: z.unknown().optional(),
};

const workspaceHandleInputSchema = {
  workspaceId: z.string(),
  workspaceGeneration: z.number().int().positive(),
};

const DEFAULT_PROCESS_OUTPUT_READ_BYTES = 40_000;
const MAX_PROCESS_OUTPUT_READ_BYTES = 40_000;

const batchItemOutputSchema = z.object({
  ok: z.boolean(),
  ref: z.string().optional(),
  result: z.string(),
  truncated: z.literal(true).optional(),
});

function compactBatchItems(items: BatchItemResult[]) {
  return items.map((item) => ({
    ok: item.ok,
    ...(item.ref ? { ref: item.ref } : {}),
    result: item.result,
    ...(item.truncated ? { truncated: true as const } : {}),
  }));
}

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
  code?: string,
  options: {
    binding?: WorkspaceContextReceiptBinding;
    operationId?: string;
  } = {},
): void {
  const structuredError = code
    ? structuredToolError({
        code,
        text: message,
        recovery: code === "workspace_resume_required" ||
            code === "stale_workspace_generation" ||
            code === "workspace_context_required"
          ? "resume_workspace"
          : code === "workspace_context_incomplete"
            ? "get_workspace_context"
          : "open_workspace",
      })
    : undefined;
  const structuredContent = structuredError
    ? {
        ok: false,
        error: structuredError,
        ...(options.binding
          ? {
              workspace: {
                ref: options.binding.workspaceId,
                generation: options.binding.generation,
              },
              context: {
                phase: options.binding.phase,
                instructionRevision: options.binding.instructionRevision,
                skillRevision: options.binding.skillRevision,
              },
            }
          : {}),
        ...(options.operationId
          ? {
              operation: operationEnvelope(
                options.operationId,
                structuredError.phase,
                structuredError.safeToRetry,
                structuredError.effectsKnown,
              ),
            }
          : {}),
      }
    : undefined;
  res.status(200).json({
    jsonrpc: "2.0",
    result: {
      content: [{ type: "text", text: message }],
      isError: true,
      ...(structuredError
        ? {
            structuredContent,
            _meta: { error: structuredError },
          }
        : {}),
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
  return error instanceof UnknownWorkspaceError ||
    error instanceof WorkspaceResumeRequiredError ||
    error instanceof StaleWorkspaceGenerationError
    ? publicToolError(error, toolNames.openWorkspace)?.text
    : undefined;
}

export function workspaceOperationId(body: unknown): string | undefined {
  return workspaceToolLease(body) === "shared" ? toolCallWorkspaceId(body) : undefined;
}

export function workspaceToolLease(body: unknown): WorkspaceToolLease | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const request = body as { method?: unknown; params?: unknown };
  if (request.method !== "tools/call" || !request.params || typeof request.params !== "object") {
    return undefined;
  }
  const name = (request.params as { name?: unknown }).name;
  return typeof name === "string" ? workspaceToolLeases.get(name) : undefined;
}

export function workspaceToolContextRequirement(
  body: unknown,
): WorkspaceContextRequirement | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const request = body as { method?: unknown; params?: unknown };
  if (request.method !== "tools/call" || !request.params || typeof request.params !== "object") {
    return undefined;
  }
  const name = (request.params as { name?: unknown }).name;
  return typeof name === "string" ? workspaceToolContextRequirements.get(name) : undefined;
}

export function toolCallWorkspaceReceipt(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const request = body as { method?: unknown; params?: unknown };
  if (request.method !== "tools/call" || !request.params || typeof request.params !== "object") {
    return undefined;
  }
  const args = (request.params as { arguments?: unknown }).arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const receipt = (args as { receipt?: unknown }).receipt;
  return typeof receipt === "string" && receipt.length > 0 ? receipt : undefined;
}

export function toolCallOperationId(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const request = body as { method?: unknown; params?: unknown };
  if (request.method !== "tools/call" || !request.params || typeof request.params !== "object") {
    return undefined;
  }
  const args = (request.params as { arguments?: unknown }).arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const operationId = (args as { operationId?: unknown }).operationId;
  return typeof operationId === "string" && operationId.length > 0 && operationId.length <= 128
    ? operationId
    : undefined;
}

export function workspaceOperationGeneration(body: unknown): number | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const params = "params" in body && body.params && typeof body.params === "object"
    ? body.params as Record<string, unknown>
    : undefined;
  const args = params?.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const generation = (args as Record<string, unknown>).workspaceGeneration;
  return typeof generation === "number" && Number.isSafeInteger(generation) && generation > 0
    ? generation
    : undefined;
}

export function toolCallWorkspaceId(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const request = body as { method?: unknown; params?: unknown };
  if (request.method !== "tools/call" || !request.params || typeof request.params !== "object") {
    return undefined;
  }
  const params = request.params as { arguments?: unknown };
  if (!params.arguments || typeof params.arguments !== "object") return undefined;
  const workspaceId = (params.arguments as { workspaceId?: unknown }).workspaceId;
  return typeof workspaceId === "string" && workspaceId.length > 0 ? workspaceId : undefined;
}

function correlationLogFields(
  clientId: string | undefined,
  workspaceId?: string,
): Record<string, string | undefined> {
  return {
    // Retained for existing log consumers. `connectionRef` is the clearer name.
    clientIdHash: identifierHash(clientId),
    connectionRef: connectionRef(clientId),
    workspaceActivityRef: workspaceActivityRef(clientId, workspaceId),
  };
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
  const { command, ...safeFields } = fields;
  const context = requestContext.getStore();
  const workspaceId = fields.workspaceId ?? context?.correlation.workspaceId;
  if (context && workspaceId) {
    context.correlation.workspaceId = workspaceId;
    context.correlation.workspaceActivityRef = workspaceActivityRef(context.clientId, workspaceId);
  }
  if (!config.logging.toolCalls) return;

  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    requestId: context?.requestId,
    ...correlationLogFields(context?.clientId, workspaceId),
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

function rejectedToolResult(code: string, text: string) {
  return {
    content: [textBlock(text)],
    isError: true as const,
    _meta: { error: { code } },
  };
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

function currentWorkspaceContextSessionId(): string {
  const contextSessionId = requestContext.getStore()?.workspaceBinding?.contextSessionId;
  if (!contextSessionId) throw new WorkspaceContextSessionError();
  return contextSessionId;
}

async function applicableMutationGate(
  workspaces: WorkspaceRegistry,
  workspace: Workspace,
  paths: string[],
  instructionToken?: string,
): Promise<{ content: ToolContent[]; isError: true } | undefined> {
  const contextSessionId = currentWorkspaceContextSessionId();
  let generation = workspaces.instructionAcknowledgementGeneration(
    workspace,
    contextSessionId,
  );
  if (instructionToken) {
    await workspaces.acknowledgeInstructions(workspace, contextSessionId, instructionToken);
    generation = workspaces.instructionAcknowledgementGeneration(workspace, contextSessionId);
  }
  const files = await workspaces.loadApplicableAgentsFiles(
    workspace,
    paths,
    { contextSessionId, requireAcknowledged: true },
  );
  if (workspaces.instructionAcknowledgementGeneration(workspace, contextSessionId) !== generation) {
    return rejectedToolResult(
      "instruction_state_changed",
      "No mutation or command was executed because applicable instructions were acknowledged by another concurrent call. Retry this tool call.",
    );
  }
  if (files.length === 0) return undefined;
  return rejectedToolResult(
    "instructions_required",
    `No mutation or command was executed. Call ${toolNames.loadWorkspaceInstructions} for the intended target paths, review its structured workspaceInstructions, then retry with its instructionToken.`,
  );
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
      error: rejectedToolResult(
        "command_scope_unresolved",
          "No command was executed because a shell directory change could not be checked against scoped project instructions. " +
          "Use the workingDirectory field or a literal cd/pushd path, then retry. " +
          `Unresolved directory change: ${unresolved}`,
      ),
    };
  }

  return {
    paths: [workingDirectory ?? ".", ...analysis.staticCwds],
  };
}

function directCommandScopePaths(
  workspaces: WorkspaceRegistry,
  workspace: Workspace,
  program: string,
  args: string[],
  workingDirectory: string | undefined,
): { paths: string[] } | { error: { content: ToolContent[]; isError: true } } {
  const tokens = [program, ...args];
  const chain = executableChain(tokens);
  if (chain.includes("sudo")) {
    return { error: rejectedToolResult("command_blocked", "No command was executed. Direct sudo is blocked.") };
  }
  const effective = unwrapShellWrappers(tokens);
  if (effective.length === 0) {
    return {
      error: rejectedToolResult(
        "command_wrapper_unresolved",
        "No command was executed. This direct wrapper hides the effective argv; pass program and args without env -S/--split-string.",
      ),
    };
  }
  const executable = basename(effective[0]!).toLowerCase();
  const effectiveArgs = effective.slice(1);
  if (executable === "rm" && effectiveArgs.some((argument) => /^-[^-]*[rf]/u.test(argument) || argument === "--recursive" || argument === "--force")) {
    return { error: rejectedToolResult("command_blocked", "No command was executed. Forced or recursive rm is blocked.") };
  }
  let delegated = effective;
  let launchesShell = false;
  for (let depth = 0; depth < 8; depth += 1) {
    const delegatedExecutable = basename(delegated[0] ?? "").toLowerCase();
    if (isShellProgram(delegated[0])) {
      launchesShell = true;
      break;
    }
    if (!["busybox", "toybox"].includes(delegatedExecutable)) break;
    const appletIndex = delegated.slice(1).findIndex((argument) => !argument.startsWith("-"));
    if (appletIndex < 0) break;
    delegated = unwrapShellWrappers(delegated.slice(appletIndex + 1));
    if (delegated.length === 0) break;
  }
  if (launchesShell) {
    return {
      error: rejectedToolResult(
        "explicit_shell_required",
        "No command was executed. Interactive shell programs are not accepted as direct argv; use shell=true with command so each input can be checked.",
      ),
    };
  }

  const paths = new Set<string>([workingDirectory ?? "."]);
  const wrapperTokens = tokens.slice(0, tokens.length - effective.length);
  for (let index = 0; index < wrapperTokens.length; index += 1) {
    const token = wrapperTokens[index]!;
    const attachedShortPath = token.match(/^-(?:C|o)(.+)$/u)?.[1];
    const attachedPath = attachedShortPath ?? (token.startsWith("--chdir=")
      ? token.slice("--chdir=".length)
      : token.startsWith("--output=")
        ? token.slice("--output=".length)
        : undefined);
    const separatePath = ["-C", "--chdir", "-o", "--output"].includes(token)
      ? wrapperTokens[index + 1]
      : undefined;
    const path = attachedPath ?? separatePath;
    if (!path) continue;
    try {
      workspaces.confineWorkspacePath(workspace, path);
      paths.add(path);
    } catch {
      return {
        error: rejectedToolResult(
          "command_write_outside_workspace",
          "No command was executed. A direct wrapper path leaves the workspace.",
        ),
      };
    }
    if (separatePath) index += 1;
  }
  if (executable === "cp" || executable === "mv") {
    for (let index = 0; index < effectiveArgs.length; index += 1) {
      const token = effectiveArgs[index]!;
      const attachedTarget = token.match(/^-t(.+)$/u)?.[1]
        ?? (token.startsWith("--target-directory=")
          ? token.slice("--target-directory=".length)
          : undefined);
      const separateTarget = token === "-t" || token === "--target-directory"
        ? effectiveArgs[index + 1]
        : undefined;
      const target = attachedTarget ?? separateTarget;
      if (!target) continue;
      try {
        workspaces.confineWorkspacePath(workspace, target);
        paths.add(target);
      } catch {
        return {
          error: rejectedToolResult(
            "command_write_outside_workspace",
            "No command was executed. A direct command target directory leaves the workspace.",
          ),
        };
      }
      if (separateTarget) index += 1;
    }
  }
  const operands = effectiveArgs.filter((argument) => argument.length > 0 && !argument.startsWith("-"));
  const mutationOperands = executable === "cp" || executable === "mv"
    ? operands
    : ["mkdir", "touch", "rm", "rmdir", "tee", "chmod", "chown"].includes(executable)
      ? operands
      : [];
  for (const operand of mutationOperands) {
    try {
      workspaces.confineWorkspacePath(workspace, operand);
      paths.add(operand);
    } catch {
      return {
        error: rejectedToolResult(
          "command_write_outside_workspace",
          "No command was executed. A direct command path operand leaves the workspace.",
        ),
      };
    }
  }
  return { paths: [...paths] };
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
  context?: {
    cwd: string;
    workspaceRoot: string;
    protectedRoots?: string[];
    allowedProtectedSubtrees?: string[];
  },
): string | undefined {
  const command = preparedInput?.charsToWrite;
  if (!command || command === "\u0003") return undefined;
  const policy = classifyCommand(command);
  if (policy.decision === "deny") {
    return `No process input was sent. Blocked by command policy: ${policy.reason}\n${policy.advice ?? ""}`.trim();
  }
  if (context) {
    const violation = validateShellWriteTargets(command, context.cwd, context.workspaceRoot);
    if (violation) return `No process input was sent. ${shellWriteViolationText(violation)}`;
    const protectedPathViolation = validateShellProtectedPaths(
      command,
      context.cwd,
      context.workspaceRoot,
      context.protectedRoots ?? [],
      context.allowedProtectedSubtrees ?? [],
    );
    if (protectedPathViolation) {
      return `No process input was sent. ${shellProtectedPathViolationText(protectedPathViolation.reason)}`;
    }
  }
  return undefined;
}

function shellWriteViolationText(violation: { target: string; reason: string }): string {
  if (violation.target === "<analysis-limit>") {
    return `${violation.reason} Simplify the command or run a shorter statically inspectable command.`;
  }
  return `${violation.reason}. Keep temporary output inside the workspace, or return it through stdout and page long output with outputId. Splitting the command will not make an outside path writable.`;
}

function shellProtectedPathViolationText(reason: string): string {
  return `${reason}. Use the opened project/worktree through its workspaceId; do not inspect DevSpace's internal state directory.`;
}

function protectedShellRoots(config: ServerConfig): string[] {
  return [...new Set([
    dirname(config.devspaceSkillsDir),
    config.stateDir,
    config.worktreeRoot,
  ])];
}

function allowedProtectedShellSubtrees(workspace: Workspace): string[] {
  return workspace.mode === "worktree" && workspace.worktree?.managed === true
    ? [workspace.root]
    : [];
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
    ? "Process running." +
      (snapshot.stdinClosed ? " Stdin is closed." : "")
    : snapshot.signal
      ? `Process exited (signal ${snapshot.signal}).`
      : `Process exited (code ${snapshot.exitCode ?? "unknown"}).`;
  const truncationNote = snapshot.outputTruncated
    ? `\n[truncated: ~${snapshot.outputOmittedBytes} bytes omitted` +
      (snapshot.outputId && !snapshot.outputStorageError
        ? `; use ${toolNames.readProcessOutput} offset=0]`
        : "]")
    : "";
  const durableNote = snapshot.droppedBytes > 0
    ? `\n[durable output quota reached: ${snapshot.droppedBytes} bytes were irrecoverably dropped]`
    : snapshot.outputStorageError
      ? "\n[durable output unavailable]"
      : "";
  return snapshot.output
    ? `${snapshot.output.replace(/\n$/, "")}\n${status}${truncationNote}${durableNote}`
    : `${status}${truncationNote}${durableNote}`;
}

export function processCallSucceeded(snapshot: ProcessSnapshot): boolean {
  return snapshot.running || (
    snapshot.exitCode === 0 &&
    snapshot.signal === undefined &&
    !snapshot.timedOut
  );
}

export function processModelState(snapshot: ProcessSnapshot) {
  const failed = !snapshot.running && (
    snapshot.timedOut ||
    snapshot.signal !== undefined ||
    (snapshot.exitCode !== undefined && snapshot.exitCode !== 0)
  );
  return {
    ok: !failed,
    status: snapshot.running ? "running" as const : "exited" as const,
    commandExecuted: true as const,
    ...(snapshot.running && snapshot.sessionId !== undefined
      ? { sessionId: snapshot.sessionId }
      : {}),
    ...(snapshot.outputId && !snapshot.outputStorageError && (snapshot.running || snapshot.outputTruncated)
      ? { outputId: snapshot.outputId }
      : {}),
    ...(!snapshot.running && snapshot.exitCode !== undefined && snapshot.exitCode !== 0
      ? { exitCode: snapshot.exitCode }
      : {}),
    ...(!snapshot.running && snapshot.signal ? { signal: snapshot.signal } : {}),
    ...(snapshot.timedOut ? { timedOut: true as const } : {}),
  };
}

function processOutputSchema(extra: z.ZodRawShape = {}) {
  return z.object({
    ok: z.boolean(),
    ...structuredToolErrorFields,
    status: z.enum(["running", "exited"]).optional(),
    commandExecuted: z.literal(true).optional(),
    sessionId: z.number().optional(),
    outputId: z.string().optional(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    timedOut: z.literal(true).optional(),
    effects: z.unknown().optional(),
    ...extra,
  }).passthrough();
}

function extensibleOutputSchema<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).passthrough();
}

function processToolResponse(
  tool: "exec_command" | "write_stdin",
  workspaceId: string,
  snapshot: ProcessSnapshot,
  summary: Record<string, unknown>,
  effects?: ToolEffects,
) {
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  const outputSummary = textSummary(snapshot.output ? [textBlock(snapshot.output)] : []);
  const structuredContent = {
    ...processModelState(snapshot),
    ...(effects ? { effects } : {}),
  };
  const recoverableOutputId = snapshot.outputStorageError ? undefined : snapshot.outputId;
  return {
    content,
    _meta: {
      tool,
      card: {
        workspaceId,
        sessionId: snapshot.sessionId,
        outputId: recoverableOutputId,
        summary: {
          ...summary,
          ...outputSummary,
          sessionId: snapshot.sessionId,
          running: snapshot.running,
          exitCode: snapshot.exitCode,
          signal: snapshot.signal,
          wallTimeMs: snapshot.wallTimeMs,
          outputTruncated: snapshot.outputTruncated,
          outputId: recoverableOutputId,
          droppedBytes: snapshot.droppedBytes,
          timedOut: snapshot.timedOut,
        },
      },
    },
    structuredContent,
  };
}

function registerWriteStdinTool(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  processSessions: ProcessSessionManager,
  mutationOperations: MutationOperationStore,
  pendingMutationOperations: Map<string, PendingMutationOperation>,
  ownerClientId: string,
): void {
  registerWorkspaceTool(
    server,
    toolNames.writeStdin,
    {
      title: "Write to process",
      description: toolDescription({
        use: "polling or interacting with a live process.",
        avoid: "starting a replacement command.",
        requires: "receipt and sessionId; operationId when sending input, closing stdin, or resizing.",
        returns: "process state and input effects.",
      }),
      inputSchema: {
        ...workspaceHandleInputSchema,
        operationId: z.string().min(1).max(128).optional(),
        instructionToken: z
          .string()
          .optional(),
        sessionId: z
          .number(),
        chars: z
          .string()
          .max(MAX_PROCESS_INPUT_BYTES)
          .optional(),
        closeStdin: z
          .boolean()
          .optional(),
        columns: z.number().int().min(1).max(1_000).optional(),
        rows: z.number().int().min(1).max(1_000).optional(),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(600_000)
          .optional(),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional(),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
    },
    async ({ workspaceId, workspaceGeneration, operationId, instructionToken, sessionId, chars, closeStdin, columns, rows, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(ownerClientId, workspaceId);
      const mutatesProcess = chars !== undefined || closeStdin === true || columns !== undefined || rows !== undefined;
      if (mutatesProcess && !operationId) {
        throw new PublicActionError(
          "operation_id_required",
          "A mutating write_stdin call requires a new operationId.",
          {
            retryable: true,
            safeToRetry: true,
            recovery: "add_operation_id",
            phase: "not_started",
          },
        );
      }
      if (mutatesProcess) workspaces.assertWorkspaceWritable(workspace);
      const execute = async () => {
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
            protectedRoots: protectedShellRoots(config),
            allowedProtectedSubtrees: allowedProtectedShellSubtrees(workspace),
          });
          if (policyViolation) {
            const content = [textBlock(policyViolation)];
            logFailedToolResponse(
              config,
              { tool: toolNames.writeStdin, workspaceId },
              content,
              startedAt,
            );
            return { ...rejectedToolResult("process_input_blocked", policyViolation), content };
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
        const submittedChars = inputScopes && "paths" in inputScopes
          ? inputScopes.preparedInput.charsToWrite
          : chars ?? "";
        return processToolResponse(toolNames.writeStdin as "write_stdin", workspaceId, snapshot, {
          sessionId,
          charactersWritten: submittedChars.length,
          running: snapshot.running,
          exitCode: snapshot.exitCode,
          wallTimeMs: snapshot.wallTimeMs,
        }, mutatesProcess ? createProcessInteractEffects({
          observedAt: new Date().toISOString(),
          submitted: {
            stdinBytes: Buffer.byteLength(submittedChars, "utf8"),
            closeStdin: closeStdin === true,
            interrupt: submittedChars.includes("\x03"),
            ...((columns !== undefined || rows !== undefined)
              ? { resize: { columns, rows } }
              : {}),
          },
          snapshot,
        }) : undefined);
      };
      if (!mutatesProcess) return execute();
      return runMutationOperation({
        store: mutationOperations,
        pending: pendingMutationOperations,
        key: { ownerClientId, workspaceId, tool: toolNames.writeStdin, operationId: operationId! },
        workspaceGeneration,
        request: { sessionId, chars, closeStdin, columns, rows, yieldTimeMs, maxOutputTokens },
        execute,
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
  registerWorkspaceTool(
    server,
    toolNames.readProcessOutput,
    {
      title: "Read process output",
      description: toolDescription({
        use: "paging retained output to EOF.",
        avoid: "polling a live session.",
        requires: "receipt and outputId.",
        returns: "one page plus nextOffset/eof.",
      }),
      inputSchema: {
        ...workspaceHandleInputSchema,
        outputId: z.string(),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional(),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_PROCESS_OUTPUT_READ_BYTES)
          .optional(),
      },
      outputSchema: extensibleOutputSchema({
        ok: z.boolean(),
        ...structuredToolErrorFields,
        nextOffset: z.number().int().nonnegative().optional(),
        eof: z.literal(true).optional(),
        status: z.enum(["active", "unknown"]).optional(),
      }),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ workspaceId, outputId, offset, limit }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(ownerClientId, workspaceId);
      processSessions.flushOutput(ownerClientId, workspaceId, outputId);
      const page = processOutputStore.read(ownerClientId, workspaceId, outputId, {
        offset: offset ?? 0,
        limit: limit ?? DEFAULT_PROCESS_OUTPUT_READ_BYTES,
      });
      const status = page.status;
      const notes = [
        page.droppedBytes > 0
          ? `[${page.droppedBytes} durable byte(s) unavailable]`
          : undefined,
        status === "unknown"
          ? "[completion unknown; verify side effects before rerun]"
          : undefined,
      ].filter((value): value is string => Boolean(value));
      const result = [page.content || (!notes.length ? "No retained output." : undefined), ...notes]
        .filter((value): value is string => Boolean(value))
        .join("\n");
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
            outputId,
            offset: page.offset,
            nextOffset: page.nextOffset,
            eof: page.eof,
            status,
            totalBytes: page.totalBytes,
            storedBytes: page.storedBytes,
            droppedBytes: page.droppedBytes,
          },
        },
        structuredContent: {
          ok: true,
          ...(!page.eof || status === "active" ? { nextOffset: page.nextOffset } : {}),
          ...(page.eof && status !== "active" ? { eof: true as const } : {}),
          ...(status === "active" || status === "unknown" ? { status } : {}),
        },
      };
    },
  );
}

function registerProcessTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  processSessions: ProcessSessionManager,
  mutationOperations: MutationOperationStore,
  pendingMutationOperations: Map<string, PendingMutationOperation>,
  ownerClientId: string,
): void {
  registerWorkspaceTool(
    server,
    "exec_command",
    {
      title: "Execute command",
      description: toolDescription({
        use: "running a workspace command; prefer program+args.",
        avoid: "shell mode without shell syntax.",
        requires: "writable receipt; operationId for retry.",
        returns: "process state and effect limits.",
      }),
      inputSchema: {
        ...workspaceHandleInputSchema,
        operationId: z.string().min(1).max(128),
        instructionToken: z.string().optional(),
        program: z.string().min(1).max(4_096).optional(),
        args: z.array(z.string().max(16_384)).max(1_024).optional(),
        shell: z.boolean().optional(),
        command: z.string().min(1).max(SHELL_COMMAND_MAX_CHARACTERS).optional(),
        cmd: z.string().min(1).max(SHELL_COMMAND_MAX_CHARACTERS).optional(),
        stdin: z
          .string()
          .max(MAX_PROCESS_INPUT_BYTES)
          .optional(),
        closeStdin: z
          .boolean()
          .optional(),
        tty: z
          .boolean()
          .optional(),
        columns: z.number().int().min(1).max(1_000).optional(),
        rows: z.number().int().min(1).max(1_000).optional(),
        workingDirectory: z
          .string()
          .optional(),
        cwd: z.string().optional(),
        environment: z.record(z.string(), z.string().max(65_536)).optional(),
        network: z.enum(["inherit", "deny"]).optional(),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(600_000)
          .optional(),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(config.resources.maxCommandRuntimeMs)
          .optional(),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional(),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
    },
    async ({ workspaceId, workspaceGeneration, operationId, instructionToken, program, args, shell, command, cmd: legacyCmd, stdin, closeStdin, tty, columns, rows, workingDirectory, cwd: requestedCwd, environment, network, yieldTimeMs, timeoutMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(ownerClientId, workspaceId);
      const execute = async () => {
      workspaces.assertWorkspaceWritable(workspace);
      if (network === "deny") {
        throw new PublicActionError(
          "network_control_unavailable",
          "This DevSpace runtime cannot enforce per-process network denial; run under an OS sandbox or omit network=deny.",
          { retryable: false, safeToRetry: false, recovery: "use_os_sandbox" },
        );
      }
      for (const [name, value] of Object.entries(environment ?? {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || value.includes("\0")) {
          throw new PublicActionError("environment_invalid", "Environment names must be portable identifiers and values cannot contain NUL bytes.");
        }
        if (["DEVSPACE_WORKSPACE_ID", "DEVSPACE_WORKSPACE_ROOT", "CDPATH"].includes(name)) {
          throw new PublicActionError("environment_reserved", `Environment variable ${name} is managed by DevSpace.`);
        }
      }
      if (requestedCwd !== undefined && workingDirectory !== undefined) {
        throw new PublicActionError("command_shape_invalid", "Provide cwd or legacy workingDirectory, not both.");
      }
      const effectiveWorkingDirectory = requestedCwd ?? workingDirectory;
      const direct = program !== undefined;
      const shellCommand = command ?? legacyCmd;
      if (direct && (shell === true || shellCommand !== undefined)) {
        throw new PublicActionError("command_shape_invalid", "Use either program/args or shell=true with command, not both.");
      }
      if (!direct && shellCommand === undefined) {
        throw new PublicActionError("command_shape_invalid", "Provide program for direct execution or shell=true with command.");
      }
      if (command !== undefined && shell !== true) {
        throw new PublicActionError("explicit_shell_required", "Set shell=true when using command.");
      }
      if (shell === false && !direct) {
        throw new PublicActionError("command_shape_invalid", "shell=false requires program.");
      }
      const directArgs = args ?? [];
      if (!direct && args !== undefined) {
        throw new PublicActionError("command_shape_invalid", "args requires program.");
      }
      const commandText = direct ? [program, ...directArgs].join(" ") : shellCommand!;
      const cwd = workspaces.resolveWorkingDirectory(workspace, effectiveWorkingDirectory);
      const commandScopes = direct
        ? directCommandScopePaths(workspaces, workspace, program, directArgs, effectiveWorkingDirectory)
        : commandInstructionScopePaths(workspace.root, shellCommand!, cwd, effectiveWorkingDirectory);
      if ("error" in commandScopes) return commandScopes.error;
      const effectiveCloseStdin = closeStdin ?? stdin !== undefined;
      let instructionScopePaths = commandScopes.paths;
      if (!direct && isInteractiveShellCommand(shellCommand!) && stdin !== undefined) {
        if (!effectiveCloseStdin) {
          return {
            content: [textBlock(
              "Initial stdin for a direct interactive shell must close after the script. Set closeStdin=true, or start the shell first and use write_stdin.",
            )],
            isError: true,
          };
        }
        const initialInputAnalysis = analyzeShellCommandScopes(stdin, cwd, workspace.root);
        if (initialInputAnalysis.unresolvedCwds.length > 0) {
          const unresolved = initialInputAnalysis.unresolvedCwds
            .map((entry) => `${entry.fragment} (${entry.reason})`)
            .join(", ");
          return {
            content: [textBlock(
              "No command was executed because a directory change in the supplied shell script could not be checked against scoped project instructions. " +
              "Use workingDirectory or a literal cd/pushd path, then retry. " +
              `Unresolved directory change: ${unresolved}`,
            )],
            isError: true,
          };
        }
        const initialInputPaths = [
          effectiveWorkingDirectory ?? ".",
          ...initialInputAnalysis.staticCwds,
        ];
        const preparedInput: PreparedProcessInput = {
          expectedRevision: 0,
          pendingInput: "",
          charsToWrite: stdin,
          nextCwd: cwd,
          instructionScopePaths: initialInputPaths,
        };
        const inputPolicyViolation = processInputPolicyViolation(preparedInput, {
          cwd,
          workspaceRoot: workspace.root,
          protectedRoots: protectedShellRoots(config),
          allowedProtectedSubtrees: allowedProtectedShellSubtrees(workspace),
        });
        if (inputPolicyViolation) {
          return rejectedToolResult("process_input_blocked", inputPolicyViolation);
        }
        instructionScopePaths = [...new Set([
          ...instructionScopePaths,
          ...initialInputPaths,
        ])];
      }
      if (!direct) {
      const policy = classifyCommand(shellCommand!);
      if (policy.decision === "deny") {
        const text = `No command was executed. Blocked by command policy: ${policy.reason}\n${policy.advice ?? ""}`.trim();
        const content = [textBlock(text)];
        logFailedToolResponse(
          config,
          {
            tool: "exec_command",
            workspaceId,
            workingDirectory: effectiveWorkingDirectory ?? ".",
            command: shellCommand!,
            commandLength: shellCommand!.length,
          },
          content,
          startedAt,
        );
        return { ...rejectedToolResult("command_blocked", text), content };
      }

      const writeTargetViolation = validateShellWriteTargets(shellCommand!, cwd, workspace.root);
      if (writeTargetViolation) {
        const content = [textBlock(
          `No command was executed. ${shellWriteViolationText(writeTargetViolation)}`,
        )];
        logFailedToolResponse(
          config,
          {
            tool: "exec_command",
            workspaceId,
            workingDirectory: effectiveWorkingDirectory ?? ".",
            command: shellCommand!,
            commandLength: shellCommand!.length,
          },
          content,
          startedAt,
        );
        return {
          ...rejectedToolResult("command_write_outside_workspace", contentText(content)),
          content,
        };
      }

      const protectedPathViolation = validateShellProtectedPaths(
        shellCommand!,
        cwd,
        workspace.root,
        protectedShellRoots(config),
        allowedProtectedShellSubtrees(workspace),
      );
      if (protectedPathViolation) {
        const content = [textBlock(
          `No command was executed. ${shellProtectedPathViolationText(protectedPathViolation.reason)}`,
        )];
        logFailedToolResponse(
          config,
          {
            tool: "exec_command",
            workspaceId,
            workingDirectory: effectiveWorkingDirectory ?? ".",
            command: shellCommand!,
            commandLength: shellCommand!.length,
          },
          content,
          startedAt,
        );
        return {
          ...rejectedToolResult("protected_path_blocked", contentText(content)),
          content,
        };
      }
      }

        const instructionGate = await applicableMutationGate(
          workspaces,
          workspace,
          instructionScopePaths,
          instructionToken,
        );
        if (instructionGate) return instructionGate;
        const snapshot = await processSessions.start({
          ownerClientId,
          workspaceId,
          command: direct ? { program: program!, args: directArgs } : shellCommand!,
          cwd,
          workspaceRoot: workspace.root,
          tty,
          columns,
          rows,
          yieldTimeMs,
          runtimeLimitMs: timeoutMs,
          maxOutputTokens,
          instructionScopePaths,
          instructionInputMode: !direct && isInteractiveShellCommand(shellCommand!) ? "shell" : "opaque",
          environment,
          stdin,
          closeStdin,
        });
        logToolCall(config, {
          tool: "exec_command",
          workspaceId,
          workingDirectory: effectiveWorkingDirectory ?? ".",
          command: commandText,
          commandLength: commandText.length,
          stdinBytes: stdin === undefined ? 0 : Buffer.byteLength(stdin, "utf8"),
          success: processCallSucceeded(snapshot),
          durationMs: Math.round(performance.now() - startedAt),
        });
        return processToolResponse("exec_command", workspaceId, snapshot, {
          command: commandText,
          workingDirectory: effectiveWorkingDirectory ?? ".",
          running: snapshot.running,
          exitCode: snapshot.exitCode,
          wallTimeMs: snapshot.wallTimeMs,
        }, createProcessStartEffects({
          observedAt: new Date().toISOString(),
          submitted: {
            stdinBytes: stdin === undefined ? 0 : Buffer.byteLength(stdin, "utf8"),
            closeStdin: stdin === undefined ? closeStdin === true : closeStdin !== false,
            interrupt: false,
            ...((columns !== undefined || rows !== undefined)
              ? { resize: { columns, rows } }
              : {}),
          },
          snapshot,
          networkAllowed: true,
        }));
      };
      return runMutationOperation({
        store: mutationOperations,
        pending: pendingMutationOperations,
        key: { ownerClientId, workspaceId, tool: toolNames.execCommand, operationId },
        workspaceGeneration,
        request: { program, args, shell, command, legacyCmd, stdin, closeStdin, tty, columns, rows, workingDirectory, requestedCwd, environment, network, yieldTimeMs, timeoutMs, maxOutputTokens },
        execute,
      });
    },
  );

  registerWriteStdinTool(
    server,
    config,
    workspaces,
    processSessions,
    mutationOperations,
    pendingMutationOperations,
    ownerClientId,
  );
}

function createMcpServer(
  config: ServerConfig,
  ownerClientId: string,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  processOutputStore: ProcessOutputStore,
  mutationOperations: MutationOperationStore,
  pendingMutationOperations: Map<string, PendingMutationOperation>,
  localAgentProviders: LocalAgentProviderAvailability[],
  runtimeDiagnostics: RuntimeDiagnostics,
  activeToolHandlers: ActiveRequestBarrier,
  contextReceipts: WorkspaceContextReceiptManager,
): McpServer {
  const server = new McpServer(
    DEVSPACE_SERVER_INFO,
    {
      instructions: serverInstructions(config),
    },
  );
  const enabledTools = new Set(toolSurface(config));
  toolHandlerBarriers.set(server, activeToolHandlers);
  toolErrorReporters.set(server, (tool, error) => {
    runtimeDiagnostics.recordFailure("mcp_tool_error", error);
    logEvent(config.logging, "error", "mcp_tool_error", {
      requestId: requestContext.getStore()?.requestId,
      ...correlationLogFields(ownerClientId, requestContext.getStore()?.correlation.workspaceId),
      tool,
      ...errorFields(error),
    });
  });
  const reportPiToolError = (error: unknown): void => {
    const expected = isExpectedPiToolError(error);
    if (!expected) runtimeDiagnostics.recordFailure("pi_tool_error", error);
    logEvent(config.logging, expected ? "info" : "error", expected ? "pi_tool_expected_error" : "pi_tool_error", {
      requestId: requestContext.getStore()?.requestId,
      ...correlationLogFields(ownerClientId, requestContext.getStore()?.correlation.workspaceId),
      ...errorFields(error),
    });
  };
  registerReadProcessOutputTool(
    server,
    config,
    workspaces,
    processSessions,
    processOutputStore,
    ownerClientId,
  );

  if (config.widgets !== "off") {
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
  }

  const returnWorkspaceContext = async (
    tool: "open_workspace" | "resume_workspace" | "get_workspace_context",
    context: WorkspaceContext,
    contextMode: WorkspaceContextMode,
    knownInstructionRevision: string | undefined,
    knownSkillRevision: string | undefined,
    startedAt: number,
  ) => {
    const { workspace, instructionScan } = context;
    if (enabledTools.has("show_changes") && workspace.writeAccess === "read_write") {
      await reviewCheckpoints.initializeWorkspace({ workspaceId: workspace.id, root: workspace.root });
    }
    const summary = workspaces.workspaceSummary(ownerClientId, workspace.alias);
    const currentBinding = requestContext.getStore()?.workspaceBinding;
    const contextSessionId = workspaces.createInstructionContext(
      workspace,
      tool === toolNames.getWorkspaceContext &&
          currentBinding?.workspaceId === workspace.id &&
          currentBinding.generation === workspace.stateGeneration
        ? currentBinding.contextSessionId
        : undefined,
    );
    const instructionsIncluded = contextMode === "full" || (
      contextMode === "retained" && knownInstructionRevision !== context.instructionRevision
    );
    if (instructionsIncluded) {
      await workspaces.markAgentsFilesAcknowledged(
        workspace,
        contextSessionId,
        context.agentsFiles,
      );
    }
    const instructionsAcknowledged = contextMode !== "metadata" &&
      workspaces.instructionsAcknowledged(
        workspace,
        contextSessionId,
        context.agentsFiles,
      );
    const rendered = renderWorkspaceContext(
      context,
      contextMode,
      knownInstructionRevision,
      knownSkillRevision,
      contextSessionId,
      instructionsAcknowledged,
      contextReceipts,
    );
    logToolCall(config, {
      tool,
      workspaceId: workspace.id,
      path: workspace.root,
      success: true,
      durationMs: Math.round(performance.now() - startedAt),
    });
    if (!instructionScan.complete) {
      logEvent(config.logging, "warn", "workspace_instruction_scan_incomplete", {
        ...correlationLogFields(ownerClientId, workspace.id),
        reason: instructionScan.reason,
        durationMs: instructionScan.durationMs,
      });
    }
    return {
      content: rendered.content,
      _meta: {
        tool,
        card: {
          alias: summary.alias,
          displayPath: summary.displayPath,
          ...(contextMode === "metadata" ? {} : { workspaceId: workspace.id }),
          summary: { mode: workspace.mode, writeAccess: workspace.writeAccess, ...rendered.summary },
        },
      },
      structuredContent: {
        ...rendered.structuredContent,
        ...(tool === toolNames.openWorkspace
          ? {
              effects: createWorkspaceOpenEffects({
                observedAt: new Date().toISOString(),
                reused: context.reused,
                managedWorktree: workspace.worktree?.managed === true,
              }),
            }
          : {}),
      },
    };
  };

  registerAppTool(server, toolNames.listWorkspaces, {
    title: "List workspaces",
    description: toolDescription({
      use: "finding resumable workspace aliases.",
      avoid: "filesystem discovery.",
      requires: "an authorized connection.",
      returns: "aliases, modes, generations, and state.",
    }),
    inputSchema: {},
    ...toolWidgetDescriptorMeta(config, "workspace"),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const summaries = workspaces.listWorkspaces(ownerClientId);
    return {
      content: [textBlock(`Found ${summaries.length} resumable workspace(s).`)],
      structuredContent: {
        ok: true,
        workspaces: summaries.map(({ createdAt: _createdAt, lastUsedAt: _lastUsedAt, ...summary }) => summary),
      },
    };
  });

  registerAppTool(server, toolNames.getOperationStatus, {
    title: "Get operation status",
    description: toolDescription({
      use: "checking a prior mutation operationId.",
      avoid: "treating a missing result as no effects.",
      requires: "the original operationId.",
      returns: "durable state without rerunning.",
    }),
    inputSchema: {
      operationId: z.string().min(1).max(128),
    },
    ...toolWidgetDescriptorMeta(config, "workspace"),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ operationId }) => {
    const status = mutationOperations.getOperationStatus(ownerClientId, operationId);
    if (!status) {
      throw new PublicActionError(
        "unknown_operation",
        "No retained operation with that operationId belongs to this connection.",
        { retryable: false, safeToRetry: false, recovery: "do_not_assume_not_executed" },
      );
    }
    return {
      content: [textBlock(`Operation is ${status.state}.`)],
      structuredContent: {
        ok: true,
        state: status.state,
        tool: status.tool,
        workspaceGeneration: status.workspaceGeneration,
        resultAvailable: status.resultAvailable,
        safeToRetry: false,
        workspace: {
          ref: status.workspaceId,
          generation: status.workspaceGeneration,
        },
        operation: operationEnvelope(
          status.operationId,
          status.state === "settled" ? "committed" : "outcome_unknown",
          false,
          status.state === "settled" && status.resultAvailable,
        ),
      },
    };
  });

  const contextOptionsInputSchema = {
    contextMode: workspaceContextModeSchema.optional(),
    knownInstructionRevision: z.string().max(128).optional(),
    knownSkillRevision: z.string().max(128).optional(),
  };
  const resumeInputSchema = {
    alias: z.string().min(1).max(64),
    ...contextOptionsInputSchema,
  };

  registerAppTool(server, toolNames.resumeWorkspace, {
    title: "Resume workspace",
    description: toolDescription({
      use: "resuming by alias after a new chat or restart.",
      avoid: "reopening the host path.",
      requires: "a listed alias.",
      returns: "v3 context and fresh receipt.",
    }),
    inputSchema: resumeInputSchema,
    ...toolWidgetDescriptorMeta(config, "workspace"),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ alias, contextMode, knownInstructionRevision, knownSkillRevision }) => {
    const startedAt = performance.now();
    const context = await workspaces.resumeWorkspace(ownerClientId, alias);
    return returnWorkspaceContext(
      toolNames.resumeWorkspace,
      context,
      contextMode ?? "full",
      knownInstructionRevision,
      knownSkillRevision,
      startedAt,
    );
  });

  registerContextWorkspaceTool(server, toolNames.getWorkspaceContext, {
    title: "Get workspace context",
    description: toolDescription({
      use: "reloading an active workspace's context.",
      avoid: "ordinary file reads.",
      requires: "a valid receipt.",
      returns: "v3 context and fresh receipt.",
    }),
    inputSchema: { ...workspaceHandleInputSchema, ...contextOptionsInputSchema },
    ...toolWidgetDescriptorMeta(config, "workspace"),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ workspaceId, workspaceGeneration, contextMode, knownInstructionRevision, knownSkillRevision }) => {
    const startedAt = performance.now();
    const context = await workspaces.getWorkspaceContext(
      ownerClientId,
      workspaceId,
      workspaceGeneration,
    );
    return returnWorkspaceContext(
      toolNames.getWorkspaceContext,
      context,
      contextMode ?? "full",
      knownInstructionRevision,
      knownSkillRevision,
      startedAt,
    );
  });

  registerAppTool(server, toolNames.openWorkspace, {
    title: "Open workspace",
    description: toolDescription({
      use: "opening an approved project; metadata-only by default.",
      avoid: "reopening a resumable alias.",
      requires: "a user-approved path.",
      returns: "receipt; then call get_workspace_context for full context.",
    }),
    inputSchema: {
      path: z.string(),
      alias: z.string().min(1).max(64).optional(),
      mode: z.enum(["checkout", "worktree"]).optional(),
      writeAccess: z.enum(["read_only", "read_write"]).optional(),
      baseRef: z.string().optional(),
      forceNew: z.boolean().optional().describe("Create a separate managed worktree instead of reusing an equivalent active one."),
      contextMode: workspaceContextModeSchema.optional(),
      knownInstructionRevision: z.string().max(128).optional(),
      knownSkillRevision: z.string().max(128).optional(),
    },
    ...toolWidgetDescriptorMeta(config, "workspace", {
      invoking: "Opening workspace…",
      invoked: "Workspace opened",
    }),
    annotations: OPEN_WORKSPACE_ANNOTATIONS,
  }, async ({
    path,
    alias,
    mode,
    writeAccess,
    baseRef,
    forceNew,
    contextMode,
    knownInstructionRevision,
    knownSkillRevision,
  }) => {
    const startedAt = performance.now();
    const effectiveMode = mode ?? "checkout";
    const context = await workspaces.openWorkspace(ownerClientId, {
      path,
      alias,
      mode: effectiveMode,
      baseRef,
      writeAccess,
      forceNew,
    });
    return returnWorkspaceContext(
      toolNames.openWorkspace,
      context,
      contextMode ?? "metadata",
      knownInstructionRevision,
      knownSkillRevision,
      startedAt,
    );
  });

  registerWorkspaceTool(server, toolNames.loadWorkspaceInstructions, {
    title: "Load workspace instructions",
    description: toolDescription({
      use: "loading scoped instructions before mutation.",
      avoid: "unrelated directories.",
      requires: "receipt and intended paths.",
      returns: "instruction items and one-use token.",
    }),
    inputSchema: {
      ...workspaceHandleInputSchema,
      paths: z.array(z.string().min(1).max(1_024)).min(1).max(16),
    },
    ...toolWidgetDescriptorMeta(config, "read"),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ workspaceId, paths }) => {
    const workspace = workspaces.getWorkspace(ownerClientId, workspaceId);
    const contextSessionId = currentWorkspaceContextSessionId();
    const files = await workspaces.loadApplicableAgentsFiles(
      workspace,
      paths,
      { contextSessionId, requireAcknowledged: true },
    );
    const instructionToken = files.length > 0
      ? await workspaces.createInstructionAcknowledgement(workspace, contextSessionId, files)
      : undefined;
    return {
      content: [textBlock(
        files.length > 0
          ? "Workspace instructions loaded."
          : "No new workspace instructions apply.",
      )],
      structuredContent: {
        schemaVersion: 2,
        instructions: {
          items: files.map((file) => workspaceInstructionRecord(file, workspace.root)),
        },
        ...(instructionToken ? { instructionToken } : {}),
      },
    };
  });

  if (enabledTools.has(toolNames.listSkills)) {
    registerWorkspaceTool(server, toolNames.listSkills, {
      title: "List skills",
      description: toolDescription({
        use: "searching or paging Skills.",
        avoid: "reading manifests directly.",
        requires: "a receipt.",
        returns: "matching metadata and next cursor.",
      }),
      inputSchema: {
        ...workspaceHandleInputSchema,
        query: z.string().max(200).optional(),
        cursor: z.string().max(2_048).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, async ({ workspaceId, query, cursor, limit }) => {
      const workspace = workspaces.getWorkspace(ownerClientId, workspaceId);
      const revision = workspaces.skillRevision(workspace);
      const normalizedQuery = (query ?? "").trim().toLocaleLowerCase("en-US");
      const decoded = cursor ? decodeSkillCursor(cursor) : undefined;
      if (decoded && (decoded.revision !== revision || decoded.query !== normalizedQuery)) {
        throw new PublicActionError(
          "skill_cursor_stale",
          "The Skill catalog or query changed; restart the listing without a cursor.",
        );
      }
      const allEntries = buildWorkspaceSkillCatalog(workspace.skills, Number.MAX_SAFE_INTEGER)
        .skills
        .filter((entry) => {
          if (!normalizedQuery) return true;
          return [entry.name, entry.description, entry.scope ?? ""]
            .some((value) => value.toLocaleLowerCase("en-US").includes(normalizedQuery));
        })
        .sort((left, right) => left.name.localeCompare(right.name) || left.skillId.localeCompare(right.skillId));
      const offset = decoded?.offset ?? 0;
      if (offset > allEntries.length) {
        throw new PublicActionError("invalid_skill_cursor", "The Skill cursor offset is invalid; restart without a cursor.");
      }
      const pageSize = limit ?? 20;
      const skills = allEntries.slice(offset, offset + pageSize);
      const nextOffset = offset + skills.length;
      const nextCursor = nextOffset < allEntries.length
        ? encodeSkillCursor({ revision, query: normalizedQuery, offset: nextOffset })
        : undefined;
      return {
        content: [textBlock(`Found ${allEntries.length} matching Skill(s); returned ${skills.length}.`)],
        structuredContent: {
          ok: true,
          skills,
          total: allEntries.length,
          ...(nextCursor ? { nextCursor } : {}),
        },
      };
    });
  }

  if (enabledTools.has(toolNames.loadSkill)) {
    registerWorkspaceTool(
      server,
      toolNames.loadSkill,
    {
      title: "Load skill",
      description: toolDescription({
        use: "loading one advertised Skill.",
        avoid: "ambiguous names.",
        requires: "receipt and skillId or unique name.",
        returns: "manifest text and skill:// root.",
      }),
      inputSchema: {
        ...workspaceHandleInputSchema,
        skillId: z
          .string()
          .optional(),
        name: z
          .string()
          .optional(),
      },
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ workspaceId, skillId, name }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(ownerClientId, workspaceId);
      let resolvedSkillId = skillId;
      if (!resolvedSkillId) {
        if (!name) {
          throw new PublicActionError(
            "skill_selection_required",
            "Provide skillId or an exact unique name.",
          );
        }
        const matches = workspace.skills.filter((skill) => skill.name === name);
        if (matches.length === 0) {
          throw new PublicActionError(
            "skill_not_found",
            "No matching Skill is available; reopen the workspace without knownSkillRevision if the retained catalog is stale.",
          );
        }
        if (matches.length > 1) {
          throw new PublicActionError(
            "skill_ambiguous",
            `Use one of these skillIds: ${matches.map((skill) => skill.skillId).join(", ")}`,
          );
        }
        resolvedSkillId = matches[0]!.skillId;
      }

      const loaded = await workspaces.loadSkill(ownerClientId, workspaceId, resolvedSkillId);
      logToolCall(config, {
        tool: toolNames.loadSkill,
        workspaceId,
        path: loaded.skill.filePath,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content: [textBlock(
          `Loaded skill ${loaded.skill.name}. Read support files under ${skillUriRoot(loaded.skill.skillId)}<relative-path>.\n\n${loaded.content}`,
        )],
      };
      },
    );
  }

  registerExclusiveWorkspaceTool(
    server,
    "close_workspace",
    {
      title: "Close workspace",
      description: toolDescription({
        use: "closing on explicit user request.",
        avoid: "end-of-turn cleanup.",
        requires: "a receipt and operationId.",
        returns: "close effects; dirty worktrees stay open.",
      }),
      inputSchema: {
        ...workspaceHandleInputSchema,
        operationId: z.string().min(1).max(128),
      },
      ...toolWidgetDescriptorMeta(config, "workspace", {
        invoking: "Closing workspace…",
        invoked: "Workspace close processed",
      }),
      annotations: {
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, workspaceGeneration, operationId }) => {
      const startedAt = performance.now();
      const execute = async () => {
        const closeLease = await workspaces.acquireExclusiveClose(
          ownerClientId,
          workspaceId,
          workspaceGeneration,
        );
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
              closed = closeLease.commit();
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
            worktreeRetainedReason
              ? `Workspace remains open: dirty worktree retained; ${processesTerminated} process(es) terminated.`
              : `Workspace closed; ${processesTerminated} process(es) terminated.` +
                (worktreeRemoved ? " Clean managed worktree removed." : ""),
          )],
          structuredContent: {
            ok: !worktreeRetainedReason,
            effects: createWorkspaceCloseEffects({
              observedAt: new Date().toISOString(),
              closed,
              managedWorktree: workspace.worktree?.managed === true,
              worktreeRemoved,
              processesTerminated,
            }),
          },
          _meta: {
            tool: "close_workspace",
            ...(worktreeRetainedReason ? {
              error: {
                code: "workspace_dirty",
                retryable: false,
                safeToRetry: false,
                recovery: "show_changes",
                phase: "committed",
                effectsKnown: true,
              },
            } : {}),
            card: {
              workspaceId,
              summary: {
                closed,
                processesTerminated,
                worktreeRemoved,
                ...(worktreeRetainedReason ? { reason: worktreeRetainedReason } : {}),
              },
            },
          },
          ...(worktreeRetainedReason ? { isError: true as const } : {}),
        };
      };
      return runMutationOperation({
        store: mutationOperations,
        pending: pendingMutationOperations,
        key: { ownerClientId, workspaceId, tool: toolNames.closeWorkspace, operationId },
        workspaceGeneration,
        request: {},
        execute,
      });
    },
  );

  registerExclusiveWorkspaceTool(server, toolNames.revokeWorkspace, {
    title: "Revoke workspace",
    description: toolDescription({
      use: "permanently revoking a workspace.",
      avoid: "temporary inactivity.",
      requires: "receipt, operationId, and explicit user intent.",
      returns: "revoke effects; dirty worktrees stay.",
    }),
    inputSchema: {
      ...workspaceHandleInputSchema,
      operationId: z.string().min(1).max(128),
    },
    ...toolWidgetDescriptorMeta(config, "workspace"),
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ workspaceId, workspaceGeneration, operationId }) => {
    const execute = async () => {
      const closeLease = await workspaces.acquireExclusiveClose(
        ownerClientId,
        workspaceId,
        workspaceGeneration,
      );
      try {
        const processesTerminated = await processSessions.terminateWorkspace(ownerClientId, workspaceId);
        const workspace = closeLease.workspace;
        let worktreeRemoved = false;
        if (workspace.worktree?.managed) {
          const removal = await removeManagedWorktree({
            sourceRoot: workspace.sourceRoot!,
            worktreePath: workspace.root,
            config,
          });
          if (removal.reason === "dirty") {
            closeLease.abort();
            return {
              content: [textBlock(
                `Workspace was not revoked because its managed worktree has uncommitted changes; ${processesTerminated} process(es) were terminated. Review or clean the worktree, then retry.`,
              )],
              isError: true as const,
              structuredContent: {
                ok: false,
                processesTerminated,
                worktreeRetained: true,
                effects: createWorkspaceRevokeEffects({
                  observedAt: new Date().toISOString(),
                  revoked: false,
                  managedWorktree: true,
                  worktreeRemoved: false,
                  processesTerminated,
                }),
              },
              _meta: {
                error: {
                  code: "workspace_dirty",
                  retryable: false,
                  safeToRetry: false,
                  recovery: "show_changes",
                  phase: processesTerminated > 0 ? "committed" : "not_started",
                  effectsKnown: true,
                },
              },
            };
          }
          worktreeRemoved = removal.removed || removal.reason === "missing";
        }
        await reviewCheckpoints.cleanupWorkspace({ workspaceId }).catch((error) => {
          runtimeDiagnostics.recordFailure("review_cleanup_failed", error);
        });
        if (!closeLease.commit({ revoke: true })) {
          throw new UnknownWorkspaceError(workspaceId);
        }
        return {
          content: [textBlock(
            worktreeRemoved
              ? "Workspace access revoked and its clean managed worktree removed."
              : "Workspace access revoked for this connection.",
          )],
          structuredContent: {
            ok: true,
            processesTerminated,
            worktreeRemoved,
            effects: createWorkspaceRevokeEffects({
              observedAt: new Date().toISOString(),
              revoked: true,
              managedWorktree: workspace.worktree?.managed === true,
              worktreeRemoved,
              processesTerminated,
            }),
          },
        };
      } catch (error) {
        closeLease.abort();
        throw error;
      } finally {
        processSessions.reopenWorkspace(ownerClientId, workspaceId);
      }
    };
    return runMutationOperation({
      store: mutationOperations,
      pending: pendingMutationOperations,
      key: { ownerClientId, workspaceId, tool: toolNames.revokeWorkspace, operationId },
      workspaceGeneration,
      request: {},
      execute,
    });
  });

  registerWorkspaceTool(
    server,
    toolNames.read,
    {
      title: "Read file",
      description: toolDescription({
        use: "reading one known workspace file.",
        avoid: "discovery; use batch_inspect.",
        requires: "receipt and known path.",
        returns: "content and version hash.",
      }),
      inputSchema: {
        ...workspaceHandleInputSchema,
        path: z.string(),
        offset: z
          .number()
          .int()
          .positive()
          .optional(),
        limit: z
          .number()
          .int()
          .positive()
          .optional(),
      },
      outputSchema: extensibleOutputSchema({
        ok: z.boolean(),
        ...structuredToolErrorFields,
        scopedInstructionsAvailable: z.literal(true).optional(),
        contentHash: z.string().optional(),
        mtimeNs: z.string().optional(),
      }),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(ownerClientId, workspaceId);
      let readPath = workspaces.resolveReadPath(workspace, input.path);
      const newlyLoadedAgentsFiles = readPath.skillRead
        ? []
        : await workspaces.loadApplicableAgentsFiles(workspace, [input.path], {
            contextSessionId: currentWorkspaceContextSessionId(),
          });
      readPath = workspaces.confineReadPath(readPath);
      const versionBefore = await readFileVersion(readPath.absolutePath);
      const response = await readFileTool(
        { ...input, path: readPath.absolutePath },
        {
          cwd: workspace.root,
          root: workspace.root,
          readRoots: readPath.readRoots,
          onError: reportPiToolError,
        },
      );
      const versionAfter = response.isError ? null : await readFileVersion(readPath.absolutePath);
      if (
        !response.isError &&
        (
          !versionBefore ||
          !versionAfter ||
          versionBefore.hash !== versionAfter.hash ||
          versionBefore.mtimeNs !== versionAfter.mtimeNs
        )
      ) {
        throw new PublicActionError(
          "file_changed_during_read",
          "The file changed during the read; retry read before using its contents.",
          { retryable: true, safeToRetry: true, recovery: "read_file_again" },
        );
      }

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
      }
      const content = response.content;

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
        structuredContent: {
          ok: !response.isError,
          ...(newlyLoadedAgentsFiles.length > 0 ? { scopedInstructionsAvailable: true as const } : {}),
          ...(versionAfter ? { contentHash: versionAfter.hash, mtimeNs: versionAfter.mtimeNs } : {}),
        },
        _meta: {
          tool: toolNames.read,
          card: {
            workspaceId,
            path: input.path,
            summary,
          },
        },
      };
    },
  );

  registerWorkspaceTool(
    server,
    toolNames.batchRead,
    {
      title: "Batch read files",
      description: toolDescription({
        use: `reading up to ${BATCH_MAX_ITEMS} known files.`,
        avoid: "search or directory discovery.",
        requires: "receipt and file paths.",
        returns: "ref-keyed items and partial status.",
      }),
      inputSchema: {
        ...workspaceHandleInputSchema,
        files: z
          .array(z.object({
            ref: z.string().min(1).max(64).optional(),
            path: z.string().min(1).max(1_024),
            offset: z.number().int().positive().optional(),
            limit: z
              .number()
              .int()
              .positive()
              .max(BATCH_READ_MAX_LINES)
              .optional(),
          }))
          .min(1)
          .max(BATCH_MAX_ITEMS),
      },
      outputSchema: extensibleOutputSchema({
        ok: z.boolean(),
        ...structuredToolErrorFields,
        items: z.array(batchItemOutputSchema).optional(),
        status: z.enum(["completed", "partial", "failed"]).optional(),
        succeeded: z.number().int().nonnegative().optional(),
        failed: z.number().int().nonnegative().optional(),
        scopedInstructionsAvailable: z.literal(true).optional(),
        truncated: z.literal(true).optional(),
      }),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ workspaceId, files }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(ownerClientId, workspaceId);
      const newlyLoadedAgentsFiles = await workspaces.loadApplicableAgentsFiles(
        workspace,
        files.map((file) => file.path),
        { contextSessionId: currentWorkspaceContextSessionId() },
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
              onError: reportPiToolError,
            },
          );
          return { ok: !response.isError, result: contentText(response.content) };
        },
        { onError: reportPiToolError },
      );
      const failed = batch.items.filter((item) => !item.ok).length;
      const succeeded = batch.items.length - failed;
      const allFailed = failed === batch.items.length;
      const status = allFailed ? "failed" as const : failed > 0 ? "partial" as const : "completed" as const;
      const content = [textBlock(
        `${allFailed ? "Batch read failed." : failed > 0 ? `Batch read partial: ${failed} failed.` : "Batch read completed."}` +
        `${batch.truncated ? " Results truncated." : ""}`,
      )];
      logToolCall(config, {
        tool: toolNames.batchRead,
        workspaceId,
        success: batch.items.every((item) => item.ok),
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content,
        ...(allFailed ? { isError: true as const } : {}),
        _meta: {
          tool: toolNames.batchRead,
          ...(allFailed ? { error: { code: "batch_read_failed" } } : {}),
          card: {
            workspaceId,
            summary: { items: batch.items.length, failed, truncated: batch.truncated },
            batchItems: batch.items.map(({ index, operation, path, ref }) => ({ index, operation, path, ref })),
          },
        },
        structuredContent: {
          ok: !allFailed,
          status,
          succeeded,
          failed,
          items: compactBatchItems(batch.items),
          ...(newlyLoadedAgentsFiles.length > 0 ? { scopedInstructionsAvailable: true as const } : {}),
          ...(batch.truncated ? { truncated: true as const } : {}),
        },
      };
    },
  );

  registerWorkspaceTool(
    server,
    toolNames.batchInspect,
    {
      title: "Batch inspect workspace",
      description: toolDescription({
        use: `combining up to ${BATCH_MAX_ITEMS} grep, glob, or list operations.`,
        avoid: "reading known files.",
        requires: "a receipt.",
        returns: "ref-keyed items and partial status.",
      }),
      inputSchema: {
        ...workspaceHandleInputSchema,
        operations: z
          .array(z.discriminatedUnion("operation", [
            z.object({
              operation: z.literal("grep"),
              ref: z.string().min(1).max(64).optional(),
              pattern: z.string().min(1).max(1_000),
              path: z.string().min(1).max(1_024).optional(),
              include: z.string().max(1_000).optional(),
            }),
            z.object({
              operation: z.literal("glob"),
              ref: z.string().min(1).max(64).optional(),
              pattern: z.string().min(1).max(1_000),
              path: z.string().min(1).max(1_024).optional(),
            }),
            z.object({
              operation: z.literal("ls"),
              ref: z.string().min(1).max(64).optional(),
              path: z.string().min(1).max(1_024),
            }),
          ]))
          .min(1)
          .max(BATCH_MAX_ITEMS),
      },
      outputSchema: extensibleOutputSchema({
        ok: z.boolean(),
        ...structuredToolErrorFields,
        items: z.array(batchItemOutputSchema).optional(),
        status: z.enum(["completed", "partial", "failed"]).optional(),
        succeeded: z.number().int().nonnegative().optional(),
        failed: z.number().int().nonnegative().optional(),
        scopedInstructionsAvailable: z.literal(true).optional(),
        truncated: z.literal(true).optional(),
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
        { contextSessionId: currentWorkspaceContextSessionId() },
      );
      const batch = await runBoundedBatch(normalized, async (operation) => {
        workspaces.confineWorkspacePath(workspace, operation.path);
        const response = operation.operation === "grep"
          ? await grepFilesTool(
              { pattern: operation.pattern, path: operation.path, glob: operation.include },
              { cwd: workspace.root, root: workspace.root, onError: reportPiToolError },
            )
          : operation.operation === "glob"
            ? await findFilesTool(
                { pattern: operation.pattern, path: operation.path },
                { cwd: workspace.root, root: workspace.root, onError: reportPiToolError },
              )
            : await listDirectoryTool(
                { path: operation.path },
                { cwd: workspace.root, root: workspace.root, onError: reportPiToolError },
              );
        return { ok: !response.isError, result: contentText(response.content) };
      }, { onError: reportPiToolError });
      const failed = batch.items.filter((item) => !item.ok).length;
      const succeeded = batch.items.length - failed;
      const allFailed = failed === batch.items.length;
      const status = allFailed ? "failed" as const : failed > 0 ? "partial" as const : "completed" as const;
      const content = [textBlock(
        `${allFailed ? "Batch inspection failed." : failed > 0 ? `Batch inspection partial: ${failed} failed.` : "Batch inspection completed."}` +
        `${batch.truncated ? " Results truncated." : ""}`,
      )];
      logToolCall(config, {
        tool: toolNames.batchInspect,
        workspaceId,
        success: batch.items.every((item) => item.ok),
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        content,
        ...(allFailed ? { isError: true as const } : {}),
        _meta: {
          tool: toolNames.batchInspect,
          ...(allFailed ? { error: { code: "batch_inspect_failed" } } : {}),
          card: {
            workspaceId,
            summary: { items: batch.items.length, failed, truncated: batch.truncated },
            batchItems: batch.items.map(({ index, operation, path, ref }) => ({ index, operation, path, ref })),
          },
        },
        structuredContent: {
          ok: !allFailed,
          status,
          succeeded,
          failed,
          items: compactBatchItems(batch.items),
          ...(newlyLoadedAgentsFiles.length > 0 ? { scopedInstructionsAvailable: true as const } : {}),
          ...(batch.truncated ? { truncated: true as const } : {}),
        },
      };
    },
  );

  if (enabledTools.has(toolNames.applyPatch)) {
    registerWorkspaceTool(
      server,
      "apply_patch",
      {
        title: "Apply patch",
        description: toolDescription({
          use: "applying one workspace-relative patch.",
          avoid: "blind overwrite after a read.",
          requires: "writable receipt; operationId and ifMatch for retry.",
          returns: "file effects with observed versions.",
        }),
        inputSchema: {
          ...workspaceHandleInputSchema,
          operationId: z.string().min(1).max(128),
          instructionToken: z.string().optional(),
          preconditionMode: z.enum(["strict", "blind"]).optional(),
          blindWriteReason: z.string().min(1).max(500).optional(),
          ifMatch: z.union([
            z.string().regex(/^sha256:[a-f0-9]{64}$/u),
            z.record(
              z.string().min(1).max(1_024),
              z.union([
                z.string().regex(/^sha256:[a-f0-9]{64}$/u),
                z.object({
                  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
                  mtimeNs: z.string().regex(/^\d+$/u).optional(),
                }),
                z.null(),
              ]),
            ),
          ]).optional(),
          patch: z
            .string(),
        },
        ...toolWidgetDescriptorMeta(config, "edit"),
        annotations: EDIT_TOOL_ANNOTATIONS,
      },
      async ({
        workspaceId,
        workspaceGeneration,
        operationId,
        instructionToken,
        preconditionMode,
        blindWriteReason,
        ifMatch,
        patch,
      }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(ownerClientId, workspaceId);
        const execute = async () => {
        workspaces.assertWorkspaceWritable(workspace);
        const preparedPatch = preparePatch(patch);
        const patchPaths = [...preparedPatch.paths];
        const uniquePatchPaths = [...new Set(patchPaths)];
        const effectivePreconditionMode = preconditionMode ?? "strict";
        if (effectivePreconditionMode === "blind" && !blindWriteReason) {
          throw new PublicActionError(
            "blind_write_reason_required",
            "Blind patching requires a concise reason tied to explicit user authorization.",
            {
              retryable: true,
              safeToRetry: true,
              recovery: "provide_blind_write_reason",
              phase: "not_started",
            },
          );
        }
        const normalizedIfMatch = typeof ifMatch === "string"
          ? uniquePatchPaths.length === 1
            ? { [uniquePatchPaths[0]!]: ifMatch }
            : (() => {
                throw new PublicActionError(
                  "if_match_ambiguous",
                  "A scalar ifMatch is valid only for a one-path patch; use a path-to-version object.",
                );
              })()
          : ifMatch
            ? Object.fromEntries(Object.entries(ifMatch).map(([path, version]) => [
                path,
                version && typeof version === "object"
                  ? { hash: version.contentHash, ...(version.mtimeNs ? { mtimeNs: version.mtimeNs } : {}) }
                  : version,
              ])) as Record<string, string | FileVersion | null>
            : undefined;
          if (effectivePreconditionMode === "strict") {
            const missingPreconditions = uniquePatchPaths.filter(
              (path) => !normalizedIfMatch || !Object.hasOwn(normalizedIfMatch, path),
            );
            if (missingPreconditions.length > 0) {
              throw new PublicActionError(
                "if_match_required",
                "Strict patching requires an ifMatch entry for every touched path. " +
                  "Use the latest read version for existing files and null for paths expected not to exist. " +
                  `Missing: ${missingPreconditions.join(", ")}`,
                {
                  retryable: true,
                  safeToRetry: true,
                  recovery: "read_files_and_add_if_match",
                  phase: "not_started",
                },
              );
            }
          }
          const instructionGate = await applicableMutationGate(workspaces, workspace, patchPaths, instructionToken);
          if (instructionGate) return instructionGate;
          const applied = await applyPreparedPatch(workspace.root, preparedPatch, { ifMatch: normalizedIfMatch });
          const result = `Applied patch to ${applied.files.length} file(s) (+${applied.additions} -${applied.removals}).`;
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
            structuredContent: {
              ok: true,
              effects: createApplyPatchEffects(new Date().toISOString(), applied.files),
              preconditions: {
                mode: effectivePreconditionMode,
                complete: uniquePatchPaths.every(
                  (path) => Boolean(normalizedIfMatch && Object.hasOwn(normalizedIfMatch, path)),
                ),
                ...(effectivePreconditionMode === "blind" ? { blindWriteReason } : {}),
              },
            },
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
          };
        };
        return runMutationOperation({
          store: mutationOperations,
          pending: pendingMutationOperations,
          key: { ownerClientId, workspaceId, tool: toolNames.applyPatch, operationId },
          workspaceGeneration,
          request: { patch, ifMatch, preconditionMode, blindWriteReason },
          execute,
        });
      },
    );
  }

  if (enabledTools.has("show_changes")) {
    registerWorkspaceTool(
      server,
      "show_changes",
      {
        title: "Show changes",
        description: toolDescription({
          use: "reviewing changes since the checkpoint.",
          avoid: "ordinary file discovery.",
          requires: "a writable receipt and operationId.",
          returns: "diff metadata and checkpoint effects.",
        }),
        inputSchema: {
          ...workspaceHandleInputSchema,
          operationId: z.string().min(1).max(128),
        },
        ...toolWidgetDescriptorMeta(config, "show_changes", {
          invoking: "Preparing changes…",
          invoked: "Changes ready",
        }),
        annotations: SHOW_CHANGES_ANNOTATIONS,
      },
      async ({ workspaceId, workspaceGeneration, operationId }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(ownerClientId, workspaceId);
        const execute = async () => {
          workspaces.assertWorkspaceWritable(workspace);
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
            structuredContent: {
              ok: true,
              effects: createReviewEffects({
                observedAt: new Date().toISOString(),
                since: "last_shown",
                advanced: true,
              }),
            },
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
          };
        };
        return runMutationOperation({
          store: mutationOperations,
          pending: pendingMutationOperations,
          key: { ownerClientId, workspaceId, tool: "show_changes", operationId },
          workspaceGeneration,
          request: { since: "last_shown", markReviewed: true },
          execute,
        });
      },
    );
  }

  if (enabledTools.has(toolNames.execCommand)) {
    registerProcessTools(
      server,
      config,
      workspaces,
      processSessions,
      mutationOperations,
      pendingMutationOperations,
      ownerClientId,
    );
  }

  return server;
}

export { readinessSnapshot } from "./runtime-control-plane.js";

export function createServer(configInput?: ServerConfig): RunningServer {
  const managesRuntimeConfig = configInput === undefined;
  const config = configInput ?? loadConfig();
  const processGeneration = randomUUID();
  const contextReceipts = createWorkspaceContextReceiptManager({ processGeneration });
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
  const processOutputStore = new ProcessOutputStore({
    stateDir: config.stateDir,
    maxFileBytes: config.resources.maxProcessOutputFileBytes,
    maxStorageBytes: config.resources.maxProcessOutputStorageBytes,
    completedTtlMs: config.resources.completedProcessOutputTtlMs,
  });
  // The process-output writer lock is the singleton server lease. Acquire it
  // before recovering pending mutations so a competing startup cannot mutate
  // the live server's idempotency records and then fail the singleton check.
  const mutationOperations = new MutationOperationStore(config.stateDir);
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const oauthProvider = new SingleUserOAuthProvider(
    config.oauth,
    mcpUrl,
    config.stateDir,
    ({ event, clientId }) => {
      logEvent(config.logging, event === "oauth_authorization_failed" || event === "oauth_authorization_rate_limited" ? "warn" : "info", event, {
        ...correlationLogFields(clientId),
      });
    },
    (clientId) => {
      const bumpedWorkspaces = workspaces.bumpAuthorityGenerations(clientId);
      logEvent(config.logging, "info", "oauth_authorization_epoch_changed", {
        ...correlationLogFields(clientId),
        bumpedWorkspaces,
      });
    },
  );
  if (oauthProvider.ownerCredentialChanged) {
    workspaces.bumpAuthorityGenerations();
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
  const pendingMutationOperations = new Map<string, PendingMutationOperation>();
  const localAgentStore = createLocalAgentStore(config);
  const reviewCheckpoints = createReviewCheckpointManager();
  processOutputStore.cleanupExpired(1_000);
  mutationOperations.cleanupExpired(1_000);
  const processSessions = new ProcessSessionManager({
    maxSessions: config.resources.maxProcessSessions,
    maxSessionsPerClient: config.resources.maxProcessSessionsPerClient,
    maxSessionsPerWorkspace: config.resources.maxProcessSessionsPerWorkspace,
    maxRuntimeMs: config.resources.maxCommandRuntimeMs,
    terminationGraceMs: config.resources.processShutdownGraceMs,
    outputStore: processOutputStore,
    onOutputStorageError: (error, context) => {
      runtimeDiagnostics.recordFailure("process_output_storage_failed", error);
      logEvent(config.logging, "error", "process_output_storage_failed", {
        ...correlationLogFields(context.ownerClientId, context.workspaceId),
        workspaceId: context.workspaceId,
        outputId: context.outputId,
        ...errorFields(error),
      });
    },
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

  let revocationCleanupTail: Promise<void> = Promise.resolve();
  const drainRevocationCleanupJobs = (): Promise<void> => {
    const operation = revocationCleanupTail.then(async () => {
      const listJobs = workspaceStore.listRevocationCleanupJobs?.bind(workspaceStore);
      const claimJob = workspaceStore.claimRevocationCleanupJob?.bind(workspaceStore);
      const finalizeJob = workspaceStore.finalizeRevocationCleanupJob?.bind(workspaceStore);
      const failJob = workspaceStore.failRevocationCleanupJob?.bind(workspaceStore);
      if (!listJobs || !claimJob || !finalizeJob || !failJob) return;
      for (const pending of listJobs(100)) {
        const job = claimJob(pending.id);
        if (!job?.claimToken) continue;
        processSessions.blockWorkspace(job.ownerClientId, job.workspaceId);
        workspaces.evictRevokedWorkspace(job.ownerClientId, job.workspaceId, job.workspaceRoot);
        try {
          await processSessions.terminateWorkspace(job.ownerClientId, job.workspaceId);
          processOutputStore.retireWorkspace(job.ownerClientId, job.workspaceId);
          await reviewCheckpoints.cleanupWorkspace({
            workspaceId: job.workspaceId,
            root: job.workspaceRoot,
          });
          let retainedDirtyWorktreeReason: string | undefined;
          if (job.managed) {
            if (!job.sourceRoot) throw new Error("Managed worktree revocation job has no source root.");
            const removal = await removeManagedWorktree({
              sourceRoot: job.sourceRoot,
              worktreePath: job.workspaceRoot,
              config,
            });
            if (removal.reason === "dirty") retainedDirtyWorktreeReason = "dirty";
          }
          if (!finalizeJob({
            id: job.id,
            claimToken: job.claimToken,
            ...(retainedDirtyWorktreeReason ? { retainedDirtyWorktreeReason } : {}),
          })) {
            throw new Error("Revocation cleanup claim changed before completion.");
          }
          processSessions.reopenWorkspace(job.ownerClientId, job.workspaceId);
        } catch (error) {
          failJob({
            id: job.id,
            claimToken: job.claimToken,
            error: error instanceof Error ? error.message : String(error),
          });
          runtimeDiagnostics.recordFailure("oauth_revocation_cleanup_failed", error);
          logEvent(config.logging, "error", "oauth_revocation_cleanup_failed", {
            workspaceId: job.workspaceId,
            ...correlationLogFields(job.ownerClientId, job.workspaceId),
            ...errorFields(error),
          });
        }
      }
    });
    revocationCleanupTail = operation.then(() => undefined, () => undefined);
    return operation;
  };

  oauthProvider.queueOrphanedWorkspaceCleanup();
  void drainRevocationCleanupJobs();

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
      mutationOperations.cleanupExpired();
      await drainRevocationCleanupJobs();
      workspaceStore.cleanupRevocationHistory?.(
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString(),
        100,
      );
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
        clientIdHash: res.locals.clientIdHash as string | undefined,
        connectionRef: res.locals.connectionRef as string | undefined,
        workspaceActivityRef: (res.locals.correlation as RequestCorrelationState | undefined)?.workspaceActivityRef,
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
        ...correlationLogFields(clientId),
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
    runtimeConfig: { widgets: config.widgets },
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
    beforeGlobalRevocation: async () => {
      const closeResults = await transports.closeActive();
      logSessionCloseResults("global_revocation", closeResults);
      await activeToolHandlers.waitForIdle();
    },
    revokeAll: () => oauthProvider.revokeAll(),
    runtimeDiagnostics,
    onGlobalRevocation: async (revoked) => {
      logEvent(config.logging, "warn", "oauth_global_revocation", { ...revoked });
      await drainRevocationCleanupJobs();
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
    if (ownerClientId) {
      res.locals.clientIdHash = identifierHash(ownerClientId);
      res.locals.connectionRef = connectionRef(ownerClientId);
    }
    if (!ownerClientId || !req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) {
      logEvent(config.logging, "warn", "auth_denied", {
        requestId,
        method: req.method,
        path: requestPath(req),
        reason: ownerClientId ? "invalid_oauth_resource" : "missing_oauth_client",
        ...correlationLogFields(ownerClientId, toolCallWorkspaceId(req.body)),
        ...requestLogFields(req, config),
      });
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    const requestWorkspaceId = toolCallWorkspaceId(req.body);
    const correlation: RequestCorrelationState = {
      workspaceId: requestWorkspaceId,
      workspaceActivityRef: workspaceActivityRef(ownerClientId, requestWorkspaceId),
    };
    res.locals.correlation = correlation;

    let transportMode: McpTransportMode = "stateful";
    try {
      const oauthClient = oauthProvider.clientsStore.getClient
        ? await oauthProvider.clientsStore.getClient(ownerClientId)
        : undefined;
      if (isChatGptOAuthClient(oauthClient)) transportMode = "stateless";
    } catch (error) {
      logEvent(config.logging, "warn", "mcp_transport_classification_failed", {
        requestId,
        ...correlationLogFields(ownerClientId, toolCallWorkspaceId(req.body)),
        ...errorFields(error),
      });
    }

    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      method: req.method,
      sessionIdPresent: Boolean(sessionId),
      sessionIdPrefix: sessionIdPrefix(sessionId),
      isInitialize: initializeRequest,
      transportMode,
      ...correlationLogFields(ownerClientId, toolCallWorkspaceId(req.body)),
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
    let statelessServer: McpServer | undefined;
    let statelessRequestLease: StatelessMcpRequestLease | undefined;
    try {
      let transport: Transport | undefined;

      if (transportMode === "stateless") {
        if (req.method !== "POST") {
          res.setHeader("Allow", "POST");
          sendJsonRpcError(res, 405, -32000, "Method not allowed; stateless MCP accepts POST only.");
          return;
        }
        statelessRequestLease = transports.tryAcquireStatelessRequest(ownerClientId);
        if (!statelessRequestLease) {
          logEvent(config.logging, "warn", "mcp_session_rejected", {
            reason: "stateless_request_capacity",
            ...correlationLogFields(ownerClientId, toolCallWorkspaceId(req.body)),
            maxSessions: config.resources.maxMcpSessions,
            maxSessionsPerClient: config.resources.maxMcpSessionsPerClient,
          });
          sendJsonRpcError(res, 503, -32000, "MCP request capacity reached");
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        statelessServer = createMcpServer(
          config,
          ownerClientId,
          workspaces,
          reviewCheckpoints,
          processSessions,
          processOutputStore,
          mutationOperations,
          pendingMutationOperations,
          localAgentProviders,
          runtimeDiagnostics,
          activeToolHandlers,
          contextReceipts,
        );
        await statelessServer.connect(transport);
      } else if (sessionId) {
        transport = transports.acquire(sessionId, ownerClientId);
        if (!transport) {
          logEvent(config.logging, "warn", "unknown_mcp_session", {
            requestId,
            method: req.method,
            sessionIdPrefix: sessionIdPrefix(sessionId),
            ...correlationLogFields(ownerClientId, toolCallWorkspaceId(req.body)),
            reason: "not_found_or_not_owned",
          });
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
            ...correlationLogFields(ownerClientId, toolCallWorkspaceId(req.body)),
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
              ...correlationLogFields(ownerClientId, toolCallWorkspaceId(req.body)),
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
              ...correlationLogFields(ownerClientId, toolCallWorkspaceId(req.body)),
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
          mutationOperations,
          pendingMutationOperations,
          localAgentProviders,
          runtimeDiagnostics,
          activeToolHandlers,
          contextReceipts,
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

      const lease = workspaceToolLease(req.body);
      const contextRequirement = workspaceToolContextRequirement(req.body);
      const receipt = lease ? toolCallWorkspaceReceipt(req.body) : undefined;
      const workspaceBinding = receipt ? contextReceipts.resolve(receipt) : undefined;
      if (lease && (!workspaceBinding || workspaceBinding.ownerClientId !== ownerClientId)) {
        sendCallToolErrorResult(
          res,
          "workspace_context_required: Call list_workspaces, then resume_workspace with contextMode=\"full\" to obtain a fresh receipt.",
          jsonRpcRequestId(req.body),
          "workspace_context_required",
          { operationId: toolCallOperationId(req.body) },
        );
        return;
      }
      if (
        workspaceBinding?.phase === "metadata" &&
        contextRequirement === "context_loaded"
      ) {
        sendCallToolErrorResult(
          res,
          "workspace_context_incomplete: Call get_workspace_context with this receipt and contextMode=\"full\", then retry once with the returned receipt.",
          jsonRpcRequestId(req.body),
          "workspace_context_incomplete",
          {
            binding: workspaceBinding,
            operationId: toolCallOperationId(req.body),
          },
        );
        return;
      }
      if (workspaceBinding) {
        correlation.workspaceId = workspaceBinding.workspaceId;
        correlation.workspaceActivityRef = workspaceActivityRef(
          ownerClientId,
          workspaceBinding.workspaceId,
        );
      }
      const handleRequest = () => requestContext.run(
        { clientId: ownerClientId, requestId, correlation, workspaceBinding },
        () => transport.handleRequest(req, res, req.body),
      );
      if (lease === "shared" && workspaceBinding) {
        await workspaces.withWorkspaceOperation(
          ownerClientId,
          workspaceBinding.workspaceId,
          workspaceBinding.generation,
          handleRequest,
        );
      } else {
        await handleRequest();
      }
    } catch (error) {
      const workspaceError = recoverableWorkspaceError(error);
      if (workspaceError && !res.headersSent) {
        logEvent(config.logging, "warn", "workspace_reopen_required", {
          requestId,
          ...correlationLogFields(ownerClientId, toolCallWorkspaceId(req.body)),
          workspaceId: workspaceOperationId(req.body),
        });
        sendCallToolErrorResult(
          res,
          workspaceError,
          jsonRpcRequestId(req.body),
          error instanceof WorkspaceResumeRequiredError
            ? "workspace_resume_required"
            : error instanceof StaleWorkspaceGenerationError
              ? "stale_workspace_generation"
            : "unknown_workspace",
          { operationId: toolCallOperationId(req.body) },
        );
        return;
      }
      runtimeDiagnostics.recordFailure("mcp_request_error", error);
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        ...correlationLogFields(ownerClientId, toolCallWorkspaceId(req.body)),
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
      if (statelessRequestLease) {
        transports.releaseStatelessRequest(statelessRequestLease);
        statelessRequestLease = undefined;
      }
      if (statelessServer) {
        try {
          await statelessServer.close();
        } catch (error) {
          runtimeDiagnostics.recordFailure("stateless_mcp_cleanup_failed", error);
          logEvent(config.logging, "warn", "stateless_mcp_cleanup_failed", {
            requestId,
            ...correlationLogFields(ownerClientId, toolCallWorkspaceId(req.body)),
            ...errorFields(error),
          });
        }
      }
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
          mutationOperations.close();
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
