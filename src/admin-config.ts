import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { loadConfigForAdmin, type WidgetMode } from "./config.js";
import { expandHomePath } from "./roots.js";
import {
  MAX_TIMER_MS,
  MIN_COMMAND_RUNTIME_MS,
  MIN_RECOMMENDED_REQUEST_BODY_BYTES,
  RESOURCE_LIMIT_MAXIMUMS,
} from "./resource-limits.js";
import {
  isValidProjectDocFallbackFilename,
  MAX_PROJECT_DOC_FALLBACK_FILENAMES,
  MAX_PROJECT_DOC_FALLBACK_FILENAME_LENGTH,
  normalizeProjectDocFallbackFilenames,
} from "./project-instructions.js";
import { devspaceConfigPath, loadDevspaceFiles, withDevspaceConfigLockSync, writeDevspaceConfig } from "./user-config.js";

const CONFIG_LOCK_WAIT_MS = 5_000;
const CONFIG_LOCK_STALE_MS = 30_000;

export interface AdminResourceLimits {
  maxMcpSessions: number;
  maxMcpSessionsPerClient: number;
  maxProcessSessions: number;
  maxProcessSessionsPerClient: number;
  maxProcessSessionsPerWorkspace: number;
  maxProcessOutputFileBytes: number;
  maxProcessOutputStorageBytes: number;
  completedProcessOutputTtlMs: number;
  maxCommandRuntimeMs: number;
  maxResidentWorkspaces: number;
  maxActiveWorkspacesPerClient: number;
  maxManagedWorktrees: number;
  maxRequestBodyBytes: number;
}

export interface AdminConfig {
  allowedRoots: string[];
  userInstructionsPath: string | null;
  projectDocFallbackFilenames: string[];
  widgets: WidgetMode;
  resources: AdminResourceLimits;
}

export type AdminConfigWarnings = Record<string, string>;

export class AdminConfigValidationError extends Error {
  readonly fields: Record<string, string>;

  constructor(fields: Record<string, string>) {
    super("The admin configuration is invalid.");
    this.name = "AdminConfigValidationError";
    this.fields = fields;
  }
}

export class AdminConfigConflictError extends Error {
  constructor(readonly currentRevision: string) {
    super("The configuration changed after it was loaded.");
    this.name = "AdminConfigConflictError";
  }
}

export class AdminConfigLockError extends Error {
  constructor() {
    super("The configuration is currently being changed by another process.");
    this.name = "AdminConfigLockError";
  }
}

export interface AdminConfigSnapshot {
  config: AdminConfig;
  revision: string;
}

const adminConfigSchema = z.object({
  allowedRoots: z.array(z.string().trim().min(1)).min(1).max(128),
  userInstructionsPath: z.string().trim().min(1).max(4_096).nullable(),
  projectDocFallbackFilenames: z.array(
    z.string()
      .trim()
      .min(1)
      .max(MAX_PROJECT_DOC_FALLBACK_FILENAME_LENGTH)
      .refine(isValidProjectDocFallbackFilename, "Must be a filename without path separators."),
  ).max(MAX_PROJECT_DOC_FALLBACK_FILENAMES),
  widgets: z.enum(["off", "changes", "full"]),
  resources: z.object({
    maxMcpSessions: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxMcpSessions),
    maxMcpSessionsPerClient: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxMcpSessionsPerClient),
    maxProcessSessions: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxProcessSessions),
    maxProcessSessionsPerClient: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxProcessSessionsPerClient),
    maxProcessSessionsPerWorkspace: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxProcessSessionsPerWorkspace),
    maxProcessOutputFileBytes: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxProcessOutputFileBytes),
    maxProcessOutputStorageBytes: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxProcessOutputStorageBytes),
    completedProcessOutputTtlMs: z.number().int().min(1_000).max(MAX_TIMER_MS),
    maxCommandRuntimeMs: z.number().int().min(MIN_COMMAND_RUNTIME_MS).max(MAX_TIMER_MS),
    maxResidentWorkspaces: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxResidentWorkspaces),
    maxActiveWorkspacesPerClient: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxActiveWorkspacesPerClient),
    maxManagedWorktrees: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxManagedWorktrees),
    maxRequestBodyBytes: z.number().int().min(64 * 1024).max(RESOURCE_LIMIT_MAXIMUMS.maxRequestBodyBytes),
  }).strict(),
}).strict();

export function loadAdminConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const config = loadConfigForAdmin(env);
  return parseAdminConfigShape({
    allowedRoots: config.allowedRoots,
    userInstructionsPath: config.userInstructionsPath,
    projectDocFallbackFilenames: config.projectDocFallbackFilenames,
    widgets: config.widgets,
    resources: pickAdminResourceLimits(config.resources),
  });
}

export async function loadAdminConfigSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AdminConfigSnapshot> {
  const config = loadAdminConfig(env);
  return { config, revision: await adminConfigRevision(env) };
}

export async function saveAdminConfigIfMatch(
  input: unknown,
  expectedRevision: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  config: AdminConfig;
  restartRequired: boolean;
  rootsChanged: boolean;
  revision: string;
}> {
  return withConfigLock(env, async () => {
    const currentRevision = await adminConfigRevision(env);
    if (currentRevision !== expectedRevision) {
      throw new AdminConfigConflictError(currentRevision);
    }
    const saved = saveAdminConfig(input, env, { lockHeld: true });
    return { ...saved, revision: await adminConfigRevision(env) };
  });
}

export function validateAdminConfig(input: unknown): AdminConfig {
  const parsed = parseAdminConfigShape(input);

  const fields: Record<string, string> = {};
  const allowedRoots: string[] = [];
  const seenRoots = new Set<string>();
  for (const [index, root] of parsed.allowedRoots.entries()) {
    const field = `allowedRoots.${index}`;
    try {
      const canonicalRoot = realpathSync(resolve(expandHomePath(root)));
      if (!statSync(canonicalRoot).isDirectory()) {
        fields[field] = "Allowed roots must be existing directories.";
        continue;
      }
      if (dirname(canonicalRoot) === canonicalRoot) {
        fields[field] = "The filesystem root cannot be allowed.";
        continue;
      }
      if (!seenRoots.has(canonicalRoot)) {
        seenRoots.add(canonicalRoot);
        allowedRoots.push(canonicalRoot);
      }
    } catch {
      fields[field] = "Allowed roots must be existing directories.";
    }
  }

  if (allowedRoots.length === 0 && Object.keys(fields).length === 0) {
    fields.allowedRoots = "At least one allowed root is required.";
  }
  let userInstructionsPath = parsed.userInstructionsPath;
  if (userInstructionsPath) {
    try {
      const expandedPath = expandHomePath(userInstructionsPath);
      if (!isAbsolute(expandedPath)) throw new Error("path must be absolute");
      const canonicalPath = realpathSync(resolve(expandedPath));
      if (!statSync(canonicalPath).isFile()) {
        fields.userInstructionsPath = "User instructions must be an existing readable file.";
      } else {
        accessSync(canonicalPath, constants.R_OK);
        userInstructionsPath = canonicalPath;
      }
    } catch {
      fields.userInstructionsPath = "User instructions must be an existing readable file.";
    }
  }
  if (
    parsed.resources.maxProcessSessionsPerWorkspace >
    parsed.resources.maxProcessSessions
  ) {
    fields["resources.maxProcessSessionsPerWorkspace"] =
      "Per-workspace process sessions cannot exceed global process sessions.";
  }
  if (parsed.resources.maxMcpSessionsPerClient > parsed.resources.maxMcpSessions) {
    fields["resources.maxMcpSessionsPerClient"] =
      "Per-client MCP sessions cannot exceed global MCP sessions.";
  }
  if (parsed.resources.maxProcessSessionsPerClient > parsed.resources.maxProcessSessions) {
    fields["resources.maxProcessSessionsPerClient"] =
      "Per-client process sessions cannot exceed global process sessions.";
  }
  if (parsed.resources.maxProcessSessionsPerWorkspace > parsed.resources.maxProcessSessionsPerClient) {
    fields["resources.maxProcessSessionsPerWorkspace"] =
      "Per-workspace process sessions cannot exceed per-client process sessions.";
  }
  if (parsed.resources.maxProcessOutputFileBytes > parsed.resources.maxProcessOutputStorageBytes) {
    fields["resources.maxProcessOutputFileBytes"] =
      "The per-output file limit cannot exceed total process-output storage.";
  }
  if (Object.keys(fields).length > 0) throw new AdminConfigValidationError(fields);

  return {
    ...parsed,
    allowedRoots,
    userInstructionsPath,
    projectDocFallbackFilenames: normalizeProjectDocFallbackFilenames(
      parsed.projectDocFallbackFilenames,
    ),
  };
}

export function adminConfigWarnings(config: AdminConfig): AdminConfigWarnings {
  const warnings: AdminConfigWarnings = {};
  for (const [index, root] of config.allowedRoots.entries()) {
    try {
      const canonicalRoot = realpathSync(resolve(expandHomePath(root)));
      if (!statSync(canonicalRoot).isDirectory()) {
        warnings[`allowedRoots.${index}`] = "This path is no longer an existing directory.";
      } else if (dirname(canonicalRoot) === canonicalRoot) {
        warnings[`allowedRoots.${index}`] = "The filesystem root cannot be allowed.";
      }
    } catch {
      warnings[`allowedRoots.${index}`] = "This path is no longer an existing directory.";
    }
  }
  if (config.userInstructionsPath) {
    try {
      const canonicalPath = realpathSync(resolve(expandHomePath(config.userInstructionsPath)));
      if (!statSync(canonicalPath).isFile()) {
        warnings.userInstructionsPath = "This path is no longer a readable file.";
      } else {
        accessSync(canonicalPath, constants.R_OK);
      }
    } catch {
      warnings.userInstructionsPath = "This path is no longer a readable file.";
    }
  }
  if (config.resources.maxProcessSessionsPerWorkspace > config.resources.maxProcessSessions) {
    warnings["resources.maxProcessSessionsPerWorkspace"] =
      "Per-workspace process sessions exceed the global process-session limit.";
  }
  if (config.resources.maxMcpSessionsPerClient > config.resources.maxMcpSessions) {
    warnings["resources.maxMcpSessionsPerClient"] =
      "Per-client MCP sessions exceed the global MCP-session limit.";
  }
  if (config.resources.maxProcessSessionsPerClient > config.resources.maxProcessSessions) {
    warnings["resources.maxProcessSessionsPerClient"] =
      "Per-client process sessions exceed the global process-session limit.";
  }
  if (config.resources.maxProcessSessionsPerWorkspace > config.resources.maxProcessSessionsPerClient) {
    warnings["resources.maxProcessSessionsPerWorkspace"] =
      "Per-workspace process sessions exceed the per-client process-session limit.";
  }
  if (config.resources.maxProcessOutputFileBytes > config.resources.maxProcessOutputStorageBytes) {
    warnings["resources.maxProcessOutputFileBytes"] =
      "The per-output file limit exceeds total process-output storage.";
  }
  if (config.resources.maxRequestBodyBytes < MIN_RECOMMENDED_REQUEST_BODY_BYTES) {
    warnings["resources.maxRequestBodyBytes"] =
      "This limit may reject a valid maximum-size apply_patch request after JSON escaping.";
  }
  return warnings;
}

export function adminConfigOverridePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const paths: string[] = [];
  if (env.DEVSPACE_ALLOWED_ROOTS !== undefined) paths.push("allowedRoots");
  if (env.DEVSPACE_USER_INSTRUCTIONS_PATH !== undefined) paths.push("userInstructionsPath");
  if (env.DEVSPACE_PROJECT_DOC_FALLBACK_FILENAMES !== undefined) {
    paths.push("projectDocFallbackFilenames");
  }
  if (env.DEVSPACE_WIDGETS !== undefined) paths.push("widgets");

  const resourceOverrides: Array<[keyof AdminResourceLimits, string]> = [
    ["maxMcpSessions", "DEVSPACE_MAX_MCP_SESSIONS"],
    ["maxMcpSessionsPerClient", "DEVSPACE_MAX_MCP_SESSIONS_PER_CLIENT"],
    ["maxProcessSessions", "DEVSPACE_MAX_PROCESS_SESSIONS"],
    ["maxProcessSessionsPerClient", "DEVSPACE_MAX_PROCESS_SESSIONS_PER_CLIENT"],
    ["maxProcessSessionsPerWorkspace", "DEVSPACE_MAX_PROCESS_SESSIONS_PER_WORKSPACE"],
    ["maxProcessOutputFileBytes", "DEVSPACE_MAX_PROCESS_OUTPUT_FILE_BYTES"],
    ["maxProcessOutputStorageBytes", "DEVSPACE_MAX_PROCESS_OUTPUT_STORAGE_BYTES"],
    ["completedProcessOutputTtlMs", "DEVSPACE_COMPLETED_PROCESS_OUTPUT_TTL_SECONDS"],
    ["maxCommandRuntimeMs", "DEVSPACE_MAX_COMMAND_RUNTIME_SECONDS"],
    ["maxResidentWorkspaces", "DEVSPACE_MAX_RESIDENT_WORKSPACES"],
    ["maxActiveWorkspacesPerClient", "DEVSPACE_MAX_ACTIVE_WORKSPACES_PER_CLIENT"],
    ["maxManagedWorktrees", "DEVSPACE_MAX_MANAGED_WORKTREES"],
    ["maxRequestBodyBytes", "DEVSPACE_MAX_REQUEST_BODY_BYTES"],
  ];
  for (const [field, variable] of resourceOverrides) {
    if (env[variable] !== undefined) paths.push(`resources.${field}`);
  }
  return paths;
}

export function saveAdminConfig(
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
  options: { lockHeld?: boolean } = {},
): { config: AdminConfig; restartRequired: boolean; rootsChanged: boolean } {
  if (!options.lockHeld) {
    return withDevspaceConfigLockSync(env, () => saveAdminConfig(input, env, { lockHeld: true }));
  }
  const config = validateAdminConfig(input);
  const previous = loadAdminConfig(env);
  const overridePaths = adminConfigOverridePaths(env);
  const overrideFields: Record<string, string> = {};
  for (const path of overridePaths) {
    if (!configValuesEqualAtPath(path, valueAtPath(config, path), valueAtPath(previous, path))) {
      overrideFields[path] = "This setting is controlled by an environment variable.";
    }
  }
  if (Object.keys(overrideFields).length > 0) {
    throw new AdminConfigValidationError(overrideFields);
  }

  const files = loadDevspaceFiles(env);
  const resources = { ...files.config.resources };
  for (const key of Object.keys(config.resources) as Array<keyof AdminResourceLimits>) {
    if (!overridePaths.includes(`resources.${key}`)) resources[key] = config.resources[key];
  }
  const nextConfig = { ...files.config, resources };
  if (!overridePaths.includes("allowedRoots")) nextConfig.allowedRoots = config.allowedRoots;
  if (!overridePaths.includes("userInstructionsPath")) {
    nextConfig.userInstructionsPath = config.userInstructionsPath;
  }
  if (!overridePaths.includes("projectDocFallbackFilenames")) {
    nextConfig.projectDocFallbackFilenames = config.projectDocFallbackFilenames;
  }
  if (!overridePaths.includes("widgets")) nextConfig.widgets = config.widgets;
  const persistedMaxMcpSessions = resources.maxMcpSessions ?? 64;
  const persistedPerClientMcp = resources.maxMcpSessionsPerClient ?? 8;
  const persistedMaxProcessSessions = resources.maxProcessSessions ?? 32;
  const persistedPerClientProcess = resources.maxProcessSessionsPerClient ?? 16;
  const persistedPerWorkspace = resources.maxProcessSessionsPerWorkspace ?? 8;
  const persistedProcessOutputFileBytes = resources.maxProcessOutputFileBytes ?? 64 * 1024 * 1024;
  const persistedProcessOutputStorageBytes = resources.maxProcessOutputStorageBytes ?? 1024 * 1024 * 1024;
  if (persistedPerClientMcp > persistedMaxMcpSessions) {
    throw new AdminConfigValidationError({
      "resources.maxMcpSessionsPerClient":
        "The saved per-client limit cannot exceed the saved global MCP-session limit after environment overrides are removed.",
    });
  }
  if (persistedPerClientProcess > persistedMaxProcessSessions) {
    throw new AdminConfigValidationError({
      "resources.maxProcessSessionsPerClient":
        "The saved per-client limit cannot exceed the saved global process-session limit after environment overrides are removed.",
    });
  }
  if (persistedPerWorkspace > persistedMaxProcessSessions) {
    throw new AdminConfigValidationError({
      "resources.maxProcessSessionsPerWorkspace":
        "The saved per-workspace limit cannot exceed the saved global process-session limit after environment overrides are removed.",
    });
  }
  if (persistedPerWorkspace > persistedPerClientProcess) {
    throw new AdminConfigValidationError({
      "resources.maxProcessSessionsPerWorkspace":
        "The saved per-workspace limit cannot exceed the saved per-client process-session limit after environment overrides are removed.",
    });
  }
  if (persistedProcessOutputFileBytes > persistedProcessOutputStorageBytes) {
    throw new AdminConfigValidationError({
      "resources.maxProcessOutputFileBytes":
        "The saved per-output file limit cannot exceed saved total process-output storage after environment overrides are removed.",
    });
  }
  writeDevspaceConfig(
    nextConfig,
    env,
    { lockHeld: true },
  );

  const saved = loadAdminConfig(env);

  return {
    config: saved,
    restartRequired: !configValuesEqual(configWithoutAllowedRoots(previous), configWithoutAllowedRoots(saved)),
    rootsChanged: !configValuesEqual(previous.allowedRoots, saved.allowedRoots),
  };
}

function parseAdminConfigShape(input: unknown): AdminConfig {
  const parsed = adminConfigSchema.safeParse(input);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fields[issue.path.join(".") || "config"] ??= issue.message;
    }
    throw new AdminConfigValidationError(fields);
  }
  return parsed.data;
}

function valueAtPath(config: AdminConfig, path: string): unknown {
  if (
    path === "allowedRoots" ||
    path === "userInstructionsPath" ||
    path === "projectDocFallbackFilenames" ||
    path === "widgets"
  ) return config[path];
  const resourceKey = path.slice("resources.".length) as keyof AdminResourceLimits;
  return config.resources[resourceKey];
}

function configValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function configValuesEqualAtPath(path: string, left: unknown, right: unknown): boolean {
  if (path !== "userInstructionsPath") return configValuesEqual(left, right);
  return configValuesEqual(canonicalPathForComparison(left), canonicalPathForComparison(right));
}

function canonicalPathForComparison(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const absolutePath = resolve(expandHomePath(value));
  try {
    return realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
}

function configWithoutAllowedRoots(config: AdminConfig): Omit<AdminConfig, "allowedRoots"> {
  const { allowedRoots: _allowedRoots, ...remaining } = config;
  return remaining;
}

function pickAdminResourceLimits(resources: AdminResourceLimits): AdminResourceLimits {
  return {
    maxMcpSessions: resources.maxMcpSessions,
    maxMcpSessionsPerClient: resources.maxMcpSessionsPerClient,
    maxProcessSessions: resources.maxProcessSessions,
    maxProcessSessionsPerClient: resources.maxProcessSessionsPerClient,
    maxProcessSessionsPerWorkspace: resources.maxProcessSessionsPerWorkspace,
    maxProcessOutputFileBytes: resources.maxProcessOutputFileBytes,
    maxProcessOutputStorageBytes: resources.maxProcessOutputStorageBytes,
    completedProcessOutputTtlMs: resources.completedProcessOutputTtlMs,
    maxCommandRuntimeMs: resources.maxCommandRuntimeMs,
    maxResidentWorkspaces: resources.maxResidentWorkspaces,
    maxActiveWorkspacesPerClient: resources.maxActiveWorkspacesPerClient,
    maxManagedWorktrees: resources.maxManagedWorktrees,
    maxRequestBodyBytes: resources.maxRequestBodyBytes,
  };
}

async function adminConfigRevision(env: NodeJS.ProcessEnv): Promise<string> {
  let contents: Buffer;
  try {
    contents = await readFile(devspaceConfigPath(env));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    contents = Buffer.alloc(0);
  }
  return createHash("sha256").update(contents).digest("base64url");
}

async function withConfigLock<T>(
  env: NodeJS.ProcessEnv,
  action: () => Promise<T>,
): Promise<T> {
  const lockPath = `${devspaceConfigPath(env)}.lock`;
  const token = `${process.pid}:${randomBytes(16).toString("hex")}`;
  const deadline = Date.now() + CONFIG_LOCK_WAIT_MS;
  await mkdir(dirname(lockPath), { recursive: true });

  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(token, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > CONFIG_LOCK_STALE_MS) await unlink(lockPath);
      } catch (staleError) {
        if ((staleError as NodeJS.ErrnoException).code !== "ENOENT") throw staleError;
      }
      if (Date.now() >= deadline) throw new AdminConfigLockError();
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }

  try {
    return await action();
  } finally {
    try {
      if ((await readFile(lockPath, "utf8")) === token) await unlink(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
