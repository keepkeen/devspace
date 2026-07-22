import { realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { loadConfigForAdmin, type ToolMode, type WidgetMode } from "./config.js";
import { expandHomePath } from "./roots.js";
import {
  MAX_TIMER_MS,
  MIN_COMMAND_RUNTIME_MS,
  RESOURCE_LIMIT_MAXIMUMS,
} from "./resource-limits.js";
import { loadDevspaceFiles, writeDevspaceConfig } from "./user-config.js";

export interface AdminResourceLimits {
  maxMcpSessions: number;
  maxProcessSessions: number;
  maxProcessSessionsPerWorkspace: number;
  maxCommandRuntimeMs: number;
  maxResidentWorkspaces: number;
  maxManagedWorktrees: number;
}

export interface AdminConfig {
  allowedRoots: string[];
  toolMode: ToolMode;
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

const adminConfigSchema = z.object({
  allowedRoots: z.array(z.string().trim().min(1)).min(1).max(128),
  toolMode: z.enum(["minimal", "full", "codex"]),
  widgets: z.enum(["off", "changes", "full"]),
  resources: z.object({
    maxMcpSessions: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxMcpSessions),
    maxProcessSessions: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxProcessSessions),
    maxProcessSessionsPerWorkspace: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxProcessSessionsPerWorkspace),
    maxCommandRuntimeMs: z.number().int().min(MIN_COMMAND_RUNTIME_MS).max(MAX_TIMER_MS),
    maxResidentWorkspaces: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxResidentWorkspaces),
    maxManagedWorktrees: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxManagedWorktrees),
  }).strict(),
}).strict();

export function loadAdminConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const config = loadConfigForAdmin(env);
  return parseAdminConfigShape({
    allowedRoots: config.allowedRoots,
    toolMode: config.toolMode,
    widgets: config.widgets,
    resources: pickAdminResourceLimits(config.resources),
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
  if (
    parsed.resources.maxProcessSessionsPerWorkspace >
    parsed.resources.maxProcessSessions
  ) {
    fields["resources.maxProcessSessionsPerWorkspace"] =
      "Per-workspace process sessions cannot exceed global process sessions.";
  }
  if (Object.keys(fields).length > 0) throw new AdminConfigValidationError(fields);

  return { ...parsed, allowedRoots };
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
  if (config.resources.maxProcessSessionsPerWorkspace > config.resources.maxProcessSessions) {
    warnings["resources.maxProcessSessionsPerWorkspace"] =
      "Per-workspace process sessions exceed the global process-session limit.";
  }
  return warnings;
}

export function adminConfigOverridePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const paths: string[] = [];
  if (env.DEVSPACE_ALLOWED_ROOTS !== undefined) paths.push("allowedRoots");
  if (env.DEVSPACE_TOOL_MODE !== undefined || env.DEVSPACE_MINIMAL_TOOLS !== undefined) {
    paths.push("toolMode");
  }
  if (env.DEVSPACE_WIDGETS !== undefined) paths.push("widgets");

  const resourceOverrides: Array<[keyof AdminResourceLimits, string]> = [
    ["maxMcpSessions", "DEVSPACE_MAX_MCP_SESSIONS"],
    ["maxProcessSessions", "DEVSPACE_MAX_PROCESS_SESSIONS"],
    ["maxProcessSessionsPerWorkspace", "DEVSPACE_MAX_PROCESS_SESSIONS_PER_WORKSPACE"],
    ["maxCommandRuntimeMs", "DEVSPACE_MAX_COMMAND_RUNTIME_SECONDS"],
    ["maxResidentWorkspaces", "DEVSPACE_MAX_RESIDENT_WORKSPACES"],
    ["maxManagedWorktrees", "DEVSPACE_MAX_MANAGED_WORKTREES"],
  ];
  for (const [field, variable] of resourceOverrides) {
    if (env[variable] !== undefined) paths.push(`resources.${field}`);
  }
  return paths;
}

export function saveAdminConfig(
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
): { config: AdminConfig; restartRequired: boolean } {
  const config = validateAdminConfig(input);
  const previous = loadAdminConfig(env);
  const overridePaths = adminConfigOverridePaths(env);
  const overrideFields: Record<string, string> = {};
  for (const path of overridePaths) {
    if (!configValuesEqual(valueAtPath(config, path), valueAtPath(previous, path))) {
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
  if (!overridePaths.includes("toolMode")) nextConfig.toolMode = config.toolMode;
  if (!overridePaths.includes("widgets")) nextConfig.widgets = config.widgets;
  const persistedMaxProcessSessions = resources.maxProcessSessions ?? 32;
  const persistedPerWorkspace = resources.maxProcessSessionsPerWorkspace ?? 8;
  if (persistedPerWorkspace > persistedMaxProcessSessions) {
    throw new AdminConfigValidationError({
      "resources.maxProcessSessionsPerWorkspace":
        "The saved per-workspace limit cannot exceed the saved global process-session limit after environment overrides are removed.",
    });
  }
  writeDevspaceConfig(
    nextConfig,
    env,
  );

  const saved = loadAdminConfig(env);

  return {
    config: saved,
    restartRequired: !configValuesEqual(previous, saved),
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
  if (path === "allowedRoots" || path === "toolMode" || path === "widgets") return config[path];
  const resourceKey = path.slice("resources.".length) as keyof AdminResourceLimits;
  return config.resources[resourceKey];
}

function configValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pickAdminResourceLimits(resources: AdminResourceLimits): AdminResourceLimits {
  return {
    maxMcpSessions: resources.maxMcpSessions,
    maxProcessSessions: resources.maxProcessSessions,
    maxProcessSessionsPerWorkspace: resources.maxProcessSessionsPerWorkspace,
    maxCommandRuntimeMs: resources.maxCommandRuntimeMs,
    maxResidentWorkspaces: resources.maxResidentWorkspaces,
    maxManagedWorktrees: resources.maxManagedWorktrees,
  };
}
