import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig, LogFormat, LogLevel } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import {
  DEFAULT_DEVSPACE_OAUTH_SCOPES,
  DEVSPACE_CAPABILITY_SCOPES,
  FULL_DEVSPACE_OAUTH_SCOPES,
} from "./oauth-scopes.js";
import { MAX_TIMER_MS, RESOURCE_LIMIT_MAXIMUMS } from "./resource-limits.js";
import { normalizeProjectDocFallbackFilenames } from "./project-instructions.js";
import {
  devspaceAgentsDir,
  devspaceSkillsDir,
  loadDevspaceFiles,
  type DevspaceUserConfig,
} from "./user-config.js";
import {
  createSecurityKeyring,
  legacyMasterKeyFromOwnerPassword,
  type MasterKeyDerivation,
} from "./security-credentials.js";

export type WidgetMode = "off" | "changes" | "full";
export type McpHttpTransportMode = "stateless" | "stateful";
export type ToolProfile = "browse" | "coding";
const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface ResourceLimitsConfig {
  mcpSessionIdleTimeoutMs: number;
  mcpSessionCloseTimeoutMs: number;
  cleanupIntervalMs: number;
  maxMcpSessions: number;
  maxMcpSessionsPerClient: number;
  maxProcessSessions: number;
  maxProcessSessionsPerClient: number;
  maxProcessSessionsPerWorkspace: number;
  maxProcessOutputFileBytes: number;
  maxProcessOutputStorageBytes: number;
  completedProcessOutputTtlMs: number;
  maxCommandRuntimeMs: number;
  processShutdownGraceMs: number;
  httpDrainTimeoutMs: number;
  workspaceIdleTtlMs: number;
  maxResidentWorkspaces: number;
  maxActiveWorkspacesPerClient: number;
  maxManagedWorktrees: number;
}

export interface ServerConfig {
  host: string;
  port: number;
  oauth: OAuthConfig;
  allowedRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  mcpHttpTransport: McpHttpTransportMode;
  toolProfile: ToolProfile;
  widgets: WidgetMode;
  stateDir: string;
  worktreeRoot: string;
  skillsEnabled: boolean;
  skillPaths: string[];
  disabledSkillPaths: string[];
  adminSkillsDir: string;
  devspaceSkillsDir: string;
  devspaceAgentsDir: string;
  subagents: boolean;
  userInstructionsPath: string | null;
  projectDocFallbackFilenames: string[];
  logging: LoggingConfig;
  resources: ResourceLimitsConfig;
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

function parseProjectDocFallbackFilenames(value: string | string[] | undefined): string[] {
  const entries = Array.isArray(value)
    ? value
    : value?.split(",").map((entry) => entry.trim()).filter(Boolean);
  return normalizeProjectDocFallbackFilenames(entries);
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

function parseOAuthScopes(value: string | undefined): string[] {
  const scopes = [...new Set(parseStringList(value, [...FULL_DEVSPACE_OAUTH_SCOPES]))];
  const invalid = scopes.filter(
    (scope) => !DEVSPACE_CAPABILITY_SCOPES.includes(scope as never),
  );
  if (invalid.length > 0) {
    throw new Error(`Invalid DEVSPACE_OAUTH_SCOPES: ${invalid.join(", ")}`);
  }
  if (scopes.length === 0) throw new Error("DEVSPACE_OAUTH_SCOPES must include at least one capability scope");
  return scopes;
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
    auditEvents: env.DEVSPACE_AUDIT_EVENTS === undefined
      ? true
      : parseBoolean(env.DEVSPACE_AUDIT_EVENTS, "DEVSPACE_AUDIT_EVENTS"),
  };
}

function seconds(value: string | undefined, fallback: number, name: string): number {
  return parsePositiveInteger(value, fallback, name, Math.floor(MAX_TIMER_MS / 1_000)) * 1_000;
}

function parseResourceLimits(
  env: NodeJS.ProcessEnv,
  configured: DevspaceUserConfig["resources"],
): ResourceLimitsConfig {
  const maxMcpSessions = parsePositiveInteger(
    env.DEVSPACE_MAX_MCP_SESSIONS,
    configured?.maxMcpSessions ?? 64,
    "DEVSPACE_MAX_MCP_SESSIONS",
    RESOURCE_LIMIT_MAXIMUMS.maxMcpSessions,
  );
  const maxProcessSessions = parsePositiveInteger(
    env.DEVSPACE_MAX_PROCESS_SESSIONS,
    configured?.maxProcessSessions ?? 32,
    "DEVSPACE_MAX_PROCESS_SESSIONS",
    RESOURCE_LIMIT_MAXIMUMS.maxProcessSessions,
  );
  const limits = {
    mcpSessionIdleTimeoutMs: seconds(env.DEVSPACE_MCP_SESSION_IDLE_TIMEOUT_SECONDS, 30 * 60, "DEVSPACE_MCP_SESSION_IDLE_TIMEOUT_SECONDS"),
    mcpSessionCloseTimeoutMs: seconds(env.DEVSPACE_MCP_SESSION_CLOSE_TIMEOUT_SECONDS, 5, "DEVSPACE_MCP_SESSION_CLOSE_TIMEOUT_SECONDS"),
    cleanupIntervalMs: seconds(env.DEVSPACE_RESOURCE_CLEANUP_INTERVAL_SECONDS, 5 * 60, "DEVSPACE_RESOURCE_CLEANUP_INTERVAL_SECONDS"),
    maxMcpSessions,
    maxMcpSessionsPerClient: parsePositiveInteger(
      env.DEVSPACE_MAX_MCP_SESSIONS_PER_CLIENT,
      configured?.maxMcpSessionsPerClient ?? Math.min(8, maxMcpSessions),
      "DEVSPACE_MAX_MCP_SESSIONS_PER_CLIENT",
      RESOURCE_LIMIT_MAXIMUMS.maxMcpSessionsPerClient,
    ),
    maxProcessSessions,
    maxProcessSessionsPerClient: parsePositiveInteger(
      env.DEVSPACE_MAX_PROCESS_SESSIONS_PER_CLIENT,
      configured?.maxProcessSessionsPerClient ?? Math.min(16, maxProcessSessions),
      "DEVSPACE_MAX_PROCESS_SESSIONS_PER_CLIENT",
      RESOURCE_LIMIT_MAXIMUMS.maxProcessSessionsPerClient,
    ),
    maxProcessSessionsPerWorkspace: parsePositiveInteger(
      env.DEVSPACE_MAX_PROCESS_SESSIONS_PER_WORKSPACE,
      configured?.maxProcessSessionsPerWorkspace ?? 8,
      "DEVSPACE_MAX_PROCESS_SESSIONS_PER_WORKSPACE",
      RESOURCE_LIMIT_MAXIMUMS.maxProcessSessionsPerWorkspace,
    ),
    maxProcessOutputFileBytes: parsePositiveInteger(
      env.DEVSPACE_MAX_PROCESS_OUTPUT_FILE_BYTES,
      configured?.maxProcessOutputFileBytes ?? 64 * 1024 * 1024,
      "DEVSPACE_MAX_PROCESS_OUTPUT_FILE_BYTES",
      RESOURCE_LIMIT_MAXIMUMS.maxProcessOutputFileBytes,
    ),
    maxProcessOutputStorageBytes: parsePositiveInteger(
      env.DEVSPACE_MAX_PROCESS_OUTPUT_STORAGE_BYTES,
      configured?.maxProcessOutputStorageBytes ?? 1024 * 1024 * 1024,
      "DEVSPACE_MAX_PROCESS_OUTPUT_STORAGE_BYTES",
      RESOURCE_LIMIT_MAXIMUMS.maxProcessOutputStorageBytes,
    ),
    completedProcessOutputTtlMs: env.DEVSPACE_COMPLETED_PROCESS_OUTPUT_TTL_SECONDS === undefined
      ? configured?.completedProcessOutputTtlMs ?? 24 * 60 * 60 * 1_000
      : seconds(
        env.DEVSPACE_COMPLETED_PROCESS_OUTPUT_TTL_SECONDS,
        24 * 60 * 60,
        "DEVSPACE_COMPLETED_PROCESS_OUTPUT_TTL_SECONDS",
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
    maxActiveWorkspacesPerClient: parsePositiveInteger(
      env.DEVSPACE_MAX_ACTIVE_WORKSPACES_PER_CLIENT,
      configured?.maxActiveWorkspacesPerClient ?? 32,
      "DEVSPACE_MAX_ACTIVE_WORKSPACES_PER_CLIENT",
      RESOURCE_LIMIT_MAXIMUMS.maxActiveWorkspacesPerClient,
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
  if (resources.maxMcpSessionsPerClient > resources.maxMcpSessions) {
    throw new Error("DEVSPACE_MAX_MCP_SESSIONS_PER_CLIENT cannot exceed DEVSPACE_MAX_MCP_SESSIONS");
  }
  if (resources.maxProcessSessionsPerClient > resources.maxProcessSessions) {
    throw new Error("DEVSPACE_MAX_PROCESS_SESSIONS_PER_CLIENT cannot exceed DEVSPACE_MAX_PROCESS_SESSIONS");
  }
  if (resources.maxProcessSessionsPerWorkspace > resources.maxProcessSessions) {
    throw new Error(
      "DEVSPACE_MAX_PROCESS_SESSIONS_PER_WORKSPACE cannot exceed DEVSPACE_MAX_PROCESS_SESSIONS",
    );
  }
  if (resources.maxProcessSessionsPerWorkspace > resources.maxProcessSessionsPerClient) {
    throw new Error(
      "DEVSPACE_MAX_PROCESS_SESSIONS_PER_WORKSPACE cannot exceed DEVSPACE_MAX_PROCESS_SESSIONS_PER_CLIENT",
    );
  }
  if (resources.maxProcessOutputFileBytes > resources.maxProcessOutputStorageBytes) {
    throw new Error(
      "DEVSPACE_MAX_PROCESS_OUTPUT_FILE_BYTES cannot exceed DEVSPACE_MAX_PROCESS_OUTPUT_STORAGE_BYTES",
    );
  }
}

function parseWidgetMode(value: string | undefined, configuredMode?: WidgetMode): WidgetMode {
  if (!value) return configuredMode ?? "full";
  if (value === "full") return "full";
  if (value === "off" || value === "changes") return value;

  throw new Error(`Invalid DEVSPACE_WIDGETS: ${value}`);
}

function parseToolProfile(
  value: string | undefined,
  configuredProfile?: ToolProfile,
): ToolProfile {
  const profile = value?.trim().toLowerCase();
  if (!profile) return configuredProfile ?? "coding";
  if (profile === "browse" || profile === "coding") return profile;
  throw new Error(
    `Invalid DEVSPACE_TOOL_PROFILE: ${value} (expected browse or coding)`,
  );
}

function parseMcpHttpTransport(
  value: string | undefined,
  configuredMode?: McpHttpTransportMode,
): McpHttpTransportMode {
  const mode = value?.trim().toLowerCase();
  if (!mode) return configuredMode ?? "stateless";
  if (mode === "stateless" || mode === "stateful") return mode;
  throw new Error(
    `Invalid DEVSPACE_MCP_HTTP_TRANSPORT: ${value} (expected stateless or stateful)`,
  );
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

function parseOAuthConfig(
  env: NodeJS.ProcessEnv,
  files: ReturnType<typeof loadDevspaceFiles>,
): OAuthConfig {
  const environmentPassword = env.DEVSPACE_OAUTH_OWNER_TOKEN === undefined
    ? undefined
    : parseRequiredSecret(
        env.DEVSPACE_OAUTH_OWNER_TOKEN,
        "DEVSPACE_OAUTH_OWNER_TOKEN",
      );
  const ownerPassword = environmentPassword ?? files.migratedOwnerPassword;
  const ownerPasswordHash = environmentPassword ? undefined : files.auth.ownerPasswordHash;
  if (!ownerPassword && !ownerPasswordHash) {
    throw new Error("DevSpace Owner password is not configured. Run: devspace init");
  }

  const environmentMasterKey = env.DEVSPACE_MASTER_KEY?.trim();
  const masterKey = environmentMasterKey ?? files.auth.masterKey ?? (
    ownerPassword ? legacyMasterKeyFromOwnerPassword(ownerPassword) : undefined
  );
  if (!masterKey) {
    throw new Error("DevSpace master key is not configured. Run: devspace init");
  }
  const derivation: MasterKeyDerivation = environmentMasterKey
    ? "hkdf-v1"
    : files.auth.keyDerivation ?? "legacy-direct";

  return {
    ownerCredential: {
      ...(ownerPassword ? { password: ownerPassword } : {}),
      ...(ownerPasswordHash ? { passwordHash: ownerPasswordHash } : {}),
    },
    keys: createSecurityKeyring({
      masterKey,
      derivation,
      source: environmentMasterKey
        ? "environment"
        : files.auth.masterKey
          ? "auth_file"
          : "legacy_environment",
    }),
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
    scopes: parseOAuthScopes(env.DEVSPACE_OAUTH_SCOPES),
    trustProxy: parseBoolean(env.DEVSPACE_TRUST_PROXY, "DEVSPACE_TRUST_PROXY"),
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
    oauth: parseOAuthConfig(env, files),
    allowedRoots: parseAllowedRoots(env.DEVSPACE_ALLOWED_ROOTS ?? files.config.allowedRoots),
    allowedHosts: parseAllowedHosts(env.DEVSPACE_ALLOWED_HOSTS, derivedAllowedHosts),
    publicBaseUrl,
    mcpHttpTransport: parseMcpHttpTransport(
      env.DEVSPACE_MCP_HTTP_TRANSPORT,
      files.config.mcpHttpTransport,
    ),
    toolProfile: parseToolProfile(
      env.DEVSPACE_TOOL_PROFILE,
      files.config.toolProfile,
    ),
    widgets: parseWidgetMode(env.DEVSPACE_WIDGETS, files.config.widgets),
    stateDir: resolve(expandHomePath(env.DEVSPACE_STATE_DIR ?? files.config.stateDir ?? defaultStateDir())),
    worktreeRoot: resolve(expandHomePath(env.DEVSPACE_WORKTREE_ROOT ?? files.config.worktreeRoot ?? defaultWorktreeRoot())),
    skillsEnabled: env.DEVSPACE_SKILLS === undefined ? true : parseBoolean(env.DEVSPACE_SKILLS, "DEVSPACE_SKILLS"),
    skillPaths:
      env.DEVSPACE_SKILL_PATHS === undefined
        ? files.config.skillPaths ?? []
        : parsePathList(env.DEVSPACE_SKILL_PATHS),
    disabledSkillPaths:
      env.DEVSPACE_DISABLED_SKILL_PATHS === undefined
        ? files.config.disabledSkillPaths ?? []
        : parsePathList(env.DEVSPACE_DISABLED_SKILL_PATHS),
    adminSkillsDir: env.DEVSPACE_ADMIN_SKILLS_DIR ?? files.config.adminSkillsDir ?? "/etc/codex/skills",
    devspaceSkillsDir: devspaceSkillsDir(env),
    devspaceAgentsDir: devspaceAgentsDir(env),
    subagents:
      env.DEVSPACE_SUBAGENTS === undefined
        ? files.config.subagents === true
        : parseBoolean(env.DEVSPACE_SUBAGENTS, "DEVSPACE_SUBAGENTS"),
    userInstructionsPath: parseOptionalPath(
      env.DEVSPACE_USER_INSTRUCTIONS_PATH ?? files.config.userInstructionsPath,
    ),
    projectDocFallbackFilenames: parseProjectDocFallbackFilenames(
      env.DEVSPACE_PROJECT_DOC_FALLBACK_FILENAMES ??
        files.config.projectDocFallbackFilenames,
    ),
    logging: parseLoggingConfig(env),
    resources: parseResourceLimits(env, files.config.resources),
  };
}

function parseOptionalPath(value: string | null | undefined): string | null {
  const path = value?.trim();
  if (!path) return null;
  const expanded = expandHomePath(path);
  if (!isAbsolute(expanded)) {
    throw new Error("User instructions path must use ~ or an absolute path.");
  }
  return resolve(expanded);
}

function parsePublicBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("DEVSPACE_PUBLIC_BASE_URL must use http or https.");
  }
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
