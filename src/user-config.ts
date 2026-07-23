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
  statSync,
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
import {
  CURRENT_CONFIG_SCHEMA_VERSION,
  migrateConfigDocument,
} from "./config-migrations.js";

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
  schemaVersion: z.literal(CURRENT_CONFIG_SCHEMA_VERSION),
  host: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65_535).optional(),
  allowedRoots: z.array(z.string()).optional(),
  publicBaseUrl: z.string().nullable().optional(),
  allowedHosts: z.array(z.string()).optional(),
  stateDir: z.string().optional(),
  worktreeRoot: z.string().optional(),
  agentDir: z.string().optional(),
  skillPaths: z.array(z.string().trim().min(1)).optional(),
  disabledSkillPaths: z.array(z.string().trim().min(1)).optional(),
  adminSkillsDir: z.string().trim().min(1).optional(),
  projectDocFallbackFilenames: projectDocFallbackFilenamesSchema.optional(),
  project_doc_fallback_filenames: projectDocFallbackFilenamesSchema.optional(),
  subagents: z.boolean().optional(),
  toolMode: z.enum(["minimal", "full", "codex"]).optional(),
  widgets: z.enum(["off", "changes", "full"]).optional(),
  resources: z.object({
    maxMcpSessions: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxMcpSessions).optional(),
    maxMcpSessionsPerClient: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxMcpSessionsPerClient).optional(),
    maxProcessSessions: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxProcessSessions).optional(),
    maxProcessSessionsPerClient: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxProcessSessionsPerClient).optional(),
    maxProcessSessionsPerWorkspace: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxProcessSessionsPerWorkspace).optional(),
    maxProcessOutputFileBytes: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxProcessOutputFileBytes).optional(),
    maxProcessOutputStorageBytes: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxProcessOutputStorageBytes).optional(),
    completedProcessOutputTtlMs: z.number().int().min(1_000).max(MAX_TIMER_MS).optional(),
    maxCommandRuntimeMs: z.number().int().min(MIN_COMMAND_RUNTIME_MS).max(MAX_TIMER_MS).optional(),
    maxResidentWorkspaces: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxResidentWorkspaces).optional(),
    maxActiveWorkspacesPerClient: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxActiveWorkspacesPerClient).optional(),
    maxManagedWorktrees: z.number().int().min(1).max(RESOURCE_LIMIT_MAXIMUMS.maxManagedWorktrees).optional(),
  }).passthrough().optional(),
}).passthrough();

const devspaceAuthConfigSchema = z.object({
  ownerToken: z.string().optional(),
}).passthrough();

export interface DevspaceUserConfig {
  schemaVersion?: typeof CURRENT_CONFIG_SCHEMA_VERSION;
  host?: string;
  port?: number;
  allowedRoots?: string[];
  publicBaseUrl?: string | null;
  allowedHosts?: string[];
  stateDir?: string;
  worktreeRoot?: string;
  agentDir?: string;
  skillPaths?: string[];
  disabledSkillPaths?: string[];
  adminSkillsDir?: string;
  projectDocFallbackFilenames?: string[];
  project_doc_fallback_filenames?: string[];
  subagents?: boolean;
  toolMode?: "minimal" | "full" | "codex";
  widgets?: "off" | "changes" | "full";
  resources?: {
    maxMcpSessions?: number;
    maxMcpSessionsPerClient?: number;
    maxProcessSessions?: number;
    maxProcessSessionsPerClient?: number;
    maxProcessSessionsPerWorkspace?: number;
    maxProcessOutputFileBytes?: number;
    maxProcessOutputStorageBytes?: number;
    completedProcessOutputTtlMs?: number;
    maxCommandRuntimeMs?: number;
    maxResidentWorkspaces?: number;
    maxActiveWorkspacesPerClient?: number;
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
    config: configExists ? readAndMigrateConfigFile(configPath) : {},
    auth: authExists ? readJsonFile(authPath, devspaceAuthConfigSchema) : {},
  };
}

export function writeDevspaceConfig(
  config: DevspaceUserConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: { lockHeld?: boolean } = {},
): string {
  const write = () => {
    const filePath = devspaceConfigPath(env);
    mkdirSync(devspaceConfigDir(env), { recursive: true });
    writeJsonFile(filePath, {
      ...config,
      schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
    }, 0o600);
    return filePath;
  };
  return options.lockHeld ? write() : withDevspaceConfigLockSync(env, write);
}

export function updateDevspaceConfig(
  update: (config: DevspaceUserConfig) => DevspaceUserConfig,
  env: NodeJS.ProcessEnv = process.env,
): { config: DevspaceUserConfig; path: string } {
  return withDevspaceConfigLockSync(env, () => {
    const config = update(loadDevspaceFiles(env).config);
    return { config, path: writeDevspaceConfig(config, env, { lockHeld: true }) };
  });
}

export function withDevspaceConfigLockSync<T>(
  env: NodeJS.ProcessEnv,
  action: () => T,
): T {
  const lockPath = `${devspaceConfigPath(env)}.lock`;
  const token = `${process.pid}:${randomBytes(16).toString("hex")}`;
  const deadline = Date.now() + 5_000;
  mkdirSync(devspaceConfigDir(env), { recursive: true });

  while (true) {
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      writeFileSync(descriptor, token, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30_000) unlinkSync(lockPath);
      } catch (staleError) {
        if ((staleError as NodeJS.ErrnoException).code !== "ENOENT") throw staleError;
      }
      if (Date.now() >= deadline) throw new Error("The configuration is currently being changed by another process.");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }

  try {
    return action();
  } finally {
    try {
      if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
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

function readAndMigrateConfigFile(filePath: string): DevspaceUserConfig {
  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
    const migration = migrateConfigDocument(JSON.parse(source));
    const config = devspaceUserConfigSchema.parse(migration.config);
    if (migration.changed) persistConfigMigration(filePath, source, config, migration.fromVersion);
    return config;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${filePath}: ${reason}`);
  }
}

function persistConfigMigration(
  filePath: string,
  source: string,
  config: DevspaceUserConfig,
  fromVersion: number,
): void {
  const backupPath = `${filePath}.backup-v${fromVersion}`;
  if (!existsSync(backupPath)) writeJsonBackup(backupPath, source);
  try {
    writeJsonFile(filePath, config, 0o600);
  } catch (error) {
    try {
      writeJsonFile(filePath, JSON.parse(source), 0o600);
    } catch {
      // Preserve the original migration error; the backup remains available.
    }
    throw error;
  }
}

function writeJsonBackup(filePath: string, source: string): void {
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = openSync(filePath, "wx", 0o600);
    created = true;
    writeFileSync(descriptor, source, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(filePath, 0o600);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (created) {
      try {
        unlinkSync(filePath);
      } catch {
        // Preserve the original error.
      }
    }
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
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
