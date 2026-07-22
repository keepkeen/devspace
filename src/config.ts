import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig, LogFormat, LogLevel } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import { MAX_TIMER_MS, RESOURCE_LIMIT_MAXIMUMS } from "./resource-limits.js";
import {
  devspaceAgentsDir,
  devspaceSkillsDir,
  loadDevspaceFiles,
  type DevspaceUserConfig,
} from "./user-config.js";

export type ToolMode = "minimal" | "full" | "codex";
export type WidgetMode = "off" | "changes" | "full";
const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface ResourceLimitsConfig {
  mcpSessionIdleTimeoutMs: number;
  mcpSessionCloseTimeoutMs: number;
  cleanupIntervalMs: number;
  maxMcpSessions: number;
  maxProcessSessions: number;
  maxProcessSessionsPerWorkspace: number;
  maxCommandRuntimeMs: number;
  processShutdownGraceMs: number;
  httpDrainTimeoutMs: number;
  workspaceIdleTtlMs: number;
  maxResidentWorkspaces: number;
  maxManagedWorktrees: number;
}

export interface InstructionScanConfig {
  maxDepth: number;
  maxEntries: number;
  deadlineMs: number;
}

export interface ServerConfig {
  host: string;
  port: number;
  oauth: OAuthConfig;
  allowedRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  toolMode: ToolMode;
  widgets: WidgetMode;
  stateDir: string;
  worktreeRoot: string;
  skillsEnabled: boolean;
  skillPaths: string[];
  devspaceSkillsDir: string;
  devspaceAgentsDir: string;
  subagents: boolean;
  agentDir: string;
  logging: LoggingConfig;
  resources: ResourceLimitsConfig;
  instructionScan: InstructionScanConfig;
}

function parsePort(value: string | number | undefined): number {
  if (value === undefined || value === "") return 7676;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
}

function parseAllowedRoots(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    const roots = value.map((entry) => entry.trim()).filter(Boolean);
    return (roots.length > 0 ? roots : [process.cwd()]).map((root) => resolve(expandHomePath(root)));
  }

  const rawRoots =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  const roots = rawRoots.length > 0 ? rawRoots : [process.cwd()];
  return roots.map((root) => resolve(expandHomePath(root)));
}

function parseAllowedHosts(value: string | string[] | undefined, derivedHosts: string[]): string[] {
  if (Array.isArray(value)) {
    return normalizeAllowedHosts(value, derivedHosts);
  }

  const rawHosts =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  return normalizeAllowedHosts(rawHosts, derivedHosts);
}

function normalizeAllowedHosts(rawHosts: string[], derivedHosts: string[]): string[] {
  const hosts = rawHosts.length > 0 ? rawHosts : derivedHosts;
  if (hosts.includes("*")) return ["*"];
  return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined) return false;

  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Invalid ${name}: ${value} (expected boolean)`);
}

function parseToolMode(
  env: NodeJS.ProcessEnv,
  configuredMode: ToolMode | undefined,
): ToolMode {
  const mode = env.DEVSPACE_TOOL_MODE;
  if (mode === "minimal" || mode === "full" || mode === "codex") return mode;
  if (mode) throw new Error(`Invalid DEVSPACE_TOOL_MODE: ${mode}`);

  if (env.DEVSPACE_MINIMAL_TOOLS !== undefined) {
    return parseBoolean(env.DEVSPACE_MINIMAL_TOOLS, "DEVSPACE_MINIMAL_TOOLS") ? "minimal" : "full";
  }
  if (configuredMode) return configuredMode;
  // Default to the Codex-style unified exec surface (exec_command + write_stdin),
  // which best fits browser MCP hosts like ChatGPT that have no per-command
  // approval surface. Set DEVSPACE_TOOL_MODE=full or minimal to use the
  // dedicated read/write/edit/grep/glob/ls/bash tools instead.
  return "codex";
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (!value || value === "info") return "info";
  if (["silent", "error", "warn", "debug"].includes(value)) return value as LogLevel;

  throw new Error(`Invalid DEVSPACE_LOG_LEVEL: ${value}`);
}

function parseLogFormat(value: string | undefined): LogFormat {
  if (!value || value === "json") return "json";
  if (value === "pretty") return "pretty";

  throw new Error(`Invalid DEVSPACE_LOG_FORMAT: ${value}`);
}

function parsePathList(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? []
  );
}

function parseStringList(value: string | undefined, fallback: string[]): string[] {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries && entries.length > 0 ? entries : fallback;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

function parseLoggingConfig(env: NodeJS.ProcessEnv): LoggingConfig {
  return {
    level: parseLogLevel(env.DEVSPACE_LOG_LEVEL),
    format: parseLogFormat(env.DEVSPACE_LOG_FORMAT),
    requests: env.DEVSPACE_LOG_REQUESTS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_REQUESTS, "DEVSPACE_LOG_REQUESTS"),
    assets: parseBoolean(env.DEVSPACE_LOG_ASSETS, "DEVSPACE_LOG_ASSETS"),
    toolCalls: env.DEVSPACE_LOG_TOOL_CALLS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_TOOL_CALLS, "DEVSPACE_LOG_TOOL_CALLS"),
    shellCommands: parseBoolean(env.DEVSPACE_LOG_SHELL_COMMANDS, "DEVSPACE_LOG_SHELL_COMMANDS"),
    trustProxy: parseBoolean(env.DEVSPACE_TRUST_PROXY, "DEVSPACE_TRUST_PROXY"),
  };
}

function seconds(value: string | undefined, fallback: number, name: string): number {
  return parsePositiveInteger(value, fallback, name, Math.floor(MAX_TIMER_MS / 1_000)) * 1_000;
}

function parseResourceLimits(
  env: NodeJS.ProcessEnv,
  configured: DevspaceUserConfig["resources"],
): ResourceLimitsConfig {
  const limits = {
    mcpSessionIdleTimeoutMs: seconds(env.DEVSPACE_MCP_SESSION_IDLE_TIMEOUT_SECONDS, 30 * 60, "DEVSPACE_MCP_SESSION_IDLE_TIMEOUT_SECONDS"),
    mcpSessionCloseTimeoutMs: seconds(env.DEVSPACE_MCP_SESSION_CLOSE_TIMEOUT_SECONDS, 5, "DEVSPACE_MCP_SESSION_CLOSE_TIMEOUT_SECONDS"),
    cleanupIntervalMs: seconds(env.DEVSPACE_RESOURCE_CLEANUP_INTERVAL_SECONDS, 5 * 60, "DEVSPACE_RESOURCE_CLEANUP_INTERVAL_SECONDS"),
    maxMcpSessions: parsePositiveInteger(
      env.DEVSPACE_MAX_MCP_SESSIONS,
      configured?.maxMcpSessions ?? 64,
      "DEVSPACE_MAX_MCP_SESSIONS",
      RESOURCE_LIMIT_MAXIMUMS.maxMcpSessions,
    ),
    maxProcessSessions: parsePositiveInteger(
      env.DEVSPACE_MAX_PROCESS_SESSIONS,
      configured?.maxProcessSessions ?? 32,
      "DEVSPACE_MAX_PROCESS_SESSIONS",
      RESOURCE_LIMIT_MAXIMUMS.maxProcessSessions,
    ),
    maxProcessSessionsPerWorkspace: parsePositiveInteger(
      env.DEVSPACE_MAX_PROCESS_SESSIONS_PER_WORKSPACE,
      configured?.maxProcessSessionsPerWorkspace ?? 8,
      "DEVSPACE_MAX_PROCESS_SESSIONS_PER_WORKSPACE",
      RESOURCE_LIMIT_MAXIMUMS.maxProcessSessionsPerWorkspace,
    ),
    maxCommandRuntimeMs: env.DEVSPACE_MAX_COMMAND_RUNTIME_SECONDS === undefined
      ? configured?.maxCommandRuntimeMs ?? 60 * 60 * 1_000
      : seconds(env.DEVSPACE_MAX_COMMAND_RUNTIME_SECONDS, 60 * 60, "DEVSPACE_MAX_COMMAND_RUNTIME_SECONDS"),
    processShutdownGraceMs: seconds(env.DEVSPACE_PROCESS_SHUTDOWN_GRACE_SECONDS, 5, "DEVSPACE_PROCESS_SHUTDOWN_GRACE_SECONDS"),
    httpDrainTimeoutMs: seconds(env.DEVSPACE_HTTP_DRAIN_TIMEOUT_SECONDS, 30, "DEVSPACE_HTTP_DRAIN_TIMEOUT_SECONDS"),
    workspaceIdleTtlMs: seconds(env.DEVSPACE_WORKSPACE_IDLE_TTL_SECONDS, 7 * 24 * 60 * 60, "DEVSPACE_WORKSPACE_IDLE_TTL_SECONDS"),
    maxResidentWorkspaces: parsePositiveInteger(
      env.DEVSPACE_MAX_RESIDENT_WORKSPACES,
      configured?.maxResidentWorkspaces ?? 256,
      "DEVSPACE_MAX_RESIDENT_WORKSPACES",
      RESOURCE_LIMIT_MAXIMUMS.maxResidentWorkspaces,
    ),
    maxManagedWorktrees: parsePositiveInteger(
      env.DEVSPACE_MAX_MANAGED_WORKTREES,
      configured?.maxManagedWorktrees ?? 64,
      "DEVSPACE_MAX_MANAGED_WORKTREES",
      RESOURCE_LIMIT_MAXIMUMS.maxManagedWorktrees,
    ),
  };
  return limits;
}

function assertResourceLimits(resources: ResourceLimitsConfig): void {
  if (resources.maxProcessSessionsPerWorkspace > resources.maxProcessSessions) {
    throw new Error(
      "DEVSPACE_MAX_PROCESS_SESSIONS_PER_WORKSPACE cannot exceed DEVSPACE_MAX_PROCESS_SESSIONS",
    );
  }
}

function parseInstructionScan(env: NodeJS.ProcessEnv): InstructionScanConfig {
  return {
    maxDepth: parsePositiveInteger(env.DEVSPACE_INSTRUCTION_SCAN_MAX_DEPTH, 32, "DEVSPACE_INSTRUCTION_SCAN_MAX_DEPTH", 256),
    maxEntries: parsePositiveInteger(env.DEVSPACE_INSTRUCTION_SCAN_MAX_ENTRIES, 100_000, "DEVSPACE_INSTRUCTION_SCAN_MAX_ENTRIES", 1_000_000),
    deadlineMs: parsePositiveInteger(env.DEVSPACE_INSTRUCTION_SCAN_DEADLINE_MS, 5_000, "DEVSPACE_INSTRUCTION_SCAN_DEADLINE_MS", MAX_TIMER_MS),
  };
}

function parseWidgetMode(value: string | undefined, configuredMode?: WidgetMode): WidgetMode {
  if (!value) return configuredMode ?? "full";
  if (value === "full") return "full";
  if (value === "off" || value === "changes") return value;

  throw new Error(`Invalid DEVSPACE_WIDGETS: ${value}`);
}

function parseRequiredSecret(value: string | undefined, name: string): string {
  const secret = value?.trim();
  if (!secret) {
    throw new Error(`${name} is required for DevSpace OAuth. Run: devspace init`);
  }
  if (secret.length < 16) {
    throw new Error(`${name} must be at least 16 characters long.`);
  }
  return secret;
}

function parseOAuthConfig(env: NodeJS.ProcessEnv, ownerToken: string | undefined): OAuthConfig {
  return {
    ownerToken: parseRequiredSecret(env.DEVSPACE_OAUTH_OWNER_TOKEN ?? ownerToken, "DEVSPACE_OAUTH_OWNER_TOKEN"),
    accessTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
    ),
    refreshTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
    ),
    scopes: parseStringList(env.DEVSPACE_OAUTH_SCOPES, ["devspace"]),
    allowedRedirectHosts: parseStringList(env.DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS, [
      "chatgpt.com",
      "localhost",
      "127.0.0.1",
    ]),
  };
}

function defaultStateDir(): string {
  return join(homedir(), ".local", "share", "devspace");
}

function defaultWorktreeRoot(): string {
  return join(homedir(), ".devspace", "worktrees");
}

function defaultAgentDir(): string {
  return join(homedir(), ".codex");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const config = loadConfigForAdmin(env);
  assertResourceLimits(config.resources);
  return config;
}

/** Loads individually valid effective values without rejecting repairable cross-field conflicts. */
export function loadConfigForAdmin(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = loadDevspaceFiles(env);
  const host = env.HOST ?? files.config.host ?? "127.0.0.1";
  const port = parsePort(env.PORT ?? files.config.port);
  const publicBaseUrl = parsePublicBaseUrl(
    env.DEVSPACE_PUBLIC_BASE_URL ?? files.config.publicBaseUrl ?? localPublicBaseUrl(host, port),
  );
  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...(files.config.allowedHosts ?? []),
  ];

  return {
    host,
    port,
    oauth: parseOAuthConfig(env, files.auth.ownerToken),
    allowedRoots: parseAllowedRoots(env.DEVSPACE_ALLOWED_ROOTS ?? files.config.allowedRoots),
    allowedHosts: parseAllowedHosts(env.DEVSPACE_ALLOWED_HOSTS, derivedAllowedHosts),
    publicBaseUrl,
    toolMode: parseToolMode(env, files.config.toolMode),
    widgets: parseWidgetMode(env.DEVSPACE_WIDGETS, files.config.widgets),
    stateDir: resolve(expandHomePath(env.DEVSPACE_STATE_DIR ?? files.config.stateDir ?? defaultStateDir())),
    worktreeRoot: resolve(expandHomePath(env.DEVSPACE_WORKTREE_ROOT ?? files.config.worktreeRoot ?? defaultWorktreeRoot())),
    skillsEnabled: env.DEVSPACE_SKILLS === undefined ? true : parseBoolean(env.DEVSPACE_SKILLS, "DEVSPACE_SKILLS"),
    skillPaths: parsePathList(env.DEVSPACE_SKILL_PATHS),
    devspaceSkillsDir: devspaceSkillsDir(env),
    devspaceAgentsDir: devspaceAgentsDir(env),
    subagents:
      env.DEVSPACE_SUBAGENTS === undefined
        ? files.config.subagents === true
        : parseBoolean(env.DEVSPACE_SUBAGENTS, "DEVSPACE_SUBAGENTS"),
    agentDir: resolve(expandHomePath(env.DEVSPACE_AGENT_DIR ?? files.config.agentDir ?? defaultAgentDir())),
    logging: parseLoggingConfig(env),
    resources: parseResourceLimits(env, files.config.resources),
    instructionScan: parseInstructionScan(env),
  };
}

function parsePublicBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function localPublicBaseUrl(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost = publicHost.includes(":") && !publicHost.startsWith("[")
    ? `[${publicHost}]`
    : publicHost;
  return `http://${formattedHost}:${port}`;
}
