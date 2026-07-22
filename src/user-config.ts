import { randomBytes } from "node:crypto";
import {
  closeSync,
  chmodSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";
import {
  MAX_TIMER_MS,
  MIN_COMMAND_RUNTIME_MS,
  RESOURCE_LIMIT_MAXIMUMS,
} from "./resource-limits.js";
import {
  isValidProjectDocFallbackFilename,
  MAX_PROJECT_DOC_FALLBACK_FILENAMES,
  MAX_PROJECT_DOC_FALLBACK_FILENAME_LENGTH,
} from "./project-instructions.js";
import { z } from "zod";

const projectDocFallbackFilenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PROJECT_DOC_FALLBACK_FILENAME_LENGTH)
  .refine(isValidProjectDocFallbackFilename, "Must be a filename without path separators.");

const projectDocFallbackFilenamesSchema = z
  .array(projectDocFallbackFilenameSchema)
  .max(MAX_PROJECT_DOC_FALLBACK_FILENAMES);

const devspaceUserConfigSchema = z.object({
  host: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65_535).optional(),
  allowedRoots: z.array(z.string()).optional(),
  publicBaseUrl: z.string().nullable().optional(),
  allowedHosts: z.array(z.string()).optional(),
  stateDir: z.string().optional(),
  worktreeRoot: z.string().optional(),
  agentDir: z.string().optional(),
  projectDocFallbackFilenames: projectDocFallbackFilenamesSchema.optional(),
  project_doc_fallback_filenames: projectDocFallbackFilenamesSchema.optional(),
  subagents: z.boolean().optional(),
  toolMode: z.enum(["minimal", "full", "codex"]).optional(),
  widgets: z.enum(["off", "changes", "full"]).optional(),
  resources: z.object({
    maxMcpSessions: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxMcpSessions).optional(),
    maxProcessSessions: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxProcessSessions).optional(),
    maxProcessSessionsPerWorkspace: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxProcessSessionsPerWorkspace).optional(),
    maxCommandRuntimeMs: z.number().int().min(MIN_COMMAND_RUNTIME_MS).max(MAX_TIMER_MS).optional(),
    maxResidentWorkspaces: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxResidentWorkspaces).optional(),
    maxManagedWorktrees: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxManagedWorktrees).optional(),
  }).passthrough().optional(),
}).passthrough();

const devspaceAuthConfigSchema = z.object({
  ownerToken: z.string().optional(),
}).passthrough();

export interface DevspaceUserConfig {
  host?: string;
  port?: number;
  allowedRoots?: string[];
  publicBaseUrl?: string | null;
  allowedHosts?: string[];
  stateDir?: string;
  worktreeRoot?: string;
  agentDir?: string;
  projectDocFallbackFilenames?: string[];
  project_doc_fallback_filenames?: string[];
  subagents?: boolean;
  toolMode?: "minimal" | "full" | "codex";
  widgets?: "off" | "changes" | "full";
  resources?: {
    maxMcpSessions?: number;
    maxProcessSessions?: number;
    maxProcessSessionsPerWorkspace?: number;
    maxCommandRuntimeMs?: number;
    maxResidentWorkspaces?: number;
    maxManagedWorktrees?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface DevspaceAuthConfig {
  ownerToken?: string;
}

export interface DevspaceFiles {
  dir: string;
  configPath: string;
  authPath: string;
  configExists: boolean;
  authExists: boolean;
  config: DevspaceUserConfig;
  auth: DevspaceAuthConfig;
}

export function devspaceConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(expandHomePath(env.DEVSPACE_CONFIG_DIR ?? join(homedir(), ".devspace")));
}

export function devspaceConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(devspaceConfigDir(env), "config.json");
}

export function devspaceAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(devspaceConfigDir(env), "auth.json");
}

export function devspaceSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(devspaceConfigDir(env), "skills");
}

export function devspaceAgentsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(devspaceConfigDir(env), "agents");
}

export function loadDevspaceFiles(env: NodeJS.ProcessEnv = process.env): DevspaceFiles {
  const dir = devspaceConfigDir(env);
  const configPath = join(dir, "config.json");
  const authPath = join(dir, "auth.json");
  const configExists = existsSync(configPath);
  const authExists = existsSync(authPath);

  return {
    dir,
    configPath,
    authPath,
    configExists,
    authExists,
    config: configExists ? readJsonFile(configPath, devspaceUserConfigSchema) : {},
    auth: authExists ? readJsonFile(authPath, devspaceAuthConfigSchema) : {},
  };
}

export function writeDevspaceConfig(
  config: DevspaceUserConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = devspaceConfigPath(env);
  mkdirSync(devspaceConfigDir(env), { recursive: true });
  writeJsonFile(filePath, config, 0o600);
  return filePath;
}

export function writeDevspaceAuth(
  auth: DevspaceAuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = devspaceAuthPath(env);
  mkdirSync(devspaceConfigDir(env), { recursive: true });
  writeJsonFile(filePath, auth, 0o600);
  return filePath;
}

export function generateOwnerToken(): string {
  return randomBytes(32).toString("base64url");
}

export function ensureDevspaceDefaultSkills(env: NodeJS.ProcessEnv = process.env): string[] {
  const targetPath = join(devspaceSkillsDir(env), "subagent-delegation", "SKILL.md");
  if (existsSync(targetPath)) return [];

  const sourcePath = new URL("../skills/subagent-delegation/SKILL.md", import.meta.url);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, readFileSync(sourcePath, "utf8"), { mode: 0o644 });
  return [targetPath];
}

export function resolveSubagentsFlag(
  config: Pick<DevspaceUserConfig, "subagents">,
  env: NodeJS.ProcessEnv = process.env,
): boolean | undefined {
  if (env.DEVSPACE_SUBAGENTS === undefined) return config.subagents;
  const value = env.DEVSPACE_SUBAGENTS.toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`Invalid DEVSPACE_SUBAGENTS: ${env.DEVSPACE_SUBAGENTS} (expected boolean)`);
}

function readJsonFile<T>(filePath: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(readFileSync(filePath, "utf8")));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${filePath}: ${reason}`);
  }
}

function writeJsonFile(filePath: string, value: unknown, mode: number): void {
  const temporaryPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor: number | undefined;

  try {
    descriptor = openSync(temporaryPath, "wx", mode);
    writeFileSync(descriptor, JSON.stringify(value, null, 2) + "\n", "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, mode);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may already have been renamed or never created.
    }
    throw error;
  }
}
