import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync, type Stats } from "node:fs";
import type {
  ActiveWorkspaceSummary,
  WorkspaceMode,
  WorkspaceSession,
  WorkspaceSessionCursor,
  WorkspaceStore,
  WorkspaceWriteAccess,
} from "./workspace-store.js";
import { WorkspaceQuotaError } from "./workspace-store.js";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { ServerConfig } from "./config.js";
import {
  createManagedWorktree,
  removeManagedWorktree,
  removeManagedWorktreeSync,
  resolveManagedWorktreeBase,
  restoreManagedWorktree,
} from "./git-worktrees.js";

export { WorkspaceQuotaError } from "./workspace-store.js";
import {
  hasProjectInstructionContent,
  MAX_PROJECT_INSTRUCTION_BYTES,
  projectInstructionFilenames,
} from "./project-instructions.js";
import {
  AccessDeniedError,
  assertAllowedPath,
  isPathInsideRoot,
  resolveAllowedPath,
} from "./roots.js";
import {
  computeSkillOpenAiMetadataHash,
  loadWorkspaceSkills,
  markSkillActivated,
  resolveSkillReadPath,
  SKILL_DISCOVERY_LIMITS,
  type LoadedSkills,
  type Skill,
  type SkillReadResolution,
} from "./skills.js";
import {
  loadLocalAgentProfiles,
  type LocalAgentProfile,
} from "./local-agent-profiles.js";
import {
  WorkspaceRootLockManager,
  type WorkspaceRootLockMode,
} from "./workspace-root-locks.js";

export interface LoadedAgentsFile {
  path: string;
  content: string;
}

export interface ApplicableAgentsFile extends LoadedAgentsFile {
  fingerprint: string;
}

export interface AvailableAgentsFile {
  path: string;
}

export interface WorkspaceWorktree {
  path: string;
  baseRef: string;
  baseSha: string;
  dirtySource: boolean;
  detached: boolean;
  managed: boolean;
}

export interface Workspace {
  id: string;
  connectionPrincipalId: string;
  alias: string;
  root: string;
  mode: WorkspaceMode;
  writeAccess: WorkspaceWriteAccess;
  stateGeneration: number;
  sourceRoot?: string;
  worktree?: WorkspaceWorktree;
  skills: LoadedSkills["skills"];
  skillDiagnostics: LoadedSkills["diagnostics"];
  agentProfiles: LocalAgentProfile[];
  activatedSkillDirs: Set<string>;
  instructionContexts: Map<string, WorkspaceInstructionContext>;
  lastUsedAt: number;
}

export interface WorkspaceInstructionContext {
  id: string;
  connectionPrincipalId: string;
  workspaceId: string;
  workspaceGeneration: number;
  deliveredInstructionVersions: Map<string, string>;
  acknowledgedInstructionVersions: Map<string, string>;
  acknowledgementGeneration: number;
  pendingAcknowledgements: Map<string, {
    createdAt: number;
    files: Array<{ path: string; fingerprint: string; content: string }>;
  }>;
  createdAt: number;
  lastUsedAt: number;
}

export type InstructionScanIncompleteReason = "max_depth" | "max_entries" | "deadline" | "io_error";

export interface InstructionScanResult {
  complete: boolean;
  lazy: boolean;
  reason?: InstructionScanIncompleteReason;
  directoriesScanned: number;
  entriesScanned: number;
  filesFound: number;
  unreadableDirectories: number;
  durationMs: number;
}

export interface WorkspaceContext {
  workspace: Workspace;
  agentsFiles: ApplicableAgentsFile[];
  instructionRevision: string;
  skillRevision: string;
  availableAgentsFiles: AvailableAgentsFile[];
  instructionScan: InstructionScanResult;
  reused: boolean;
  recovery?: {
    kind: "managed_worktree_recreated";
    dataLossPossible: true;
  };
}

export interface WorkspaceReadPath {
  absolutePath: string;
  readRoots: string[];
  skillRead?: SkillReadResolution;
}

export interface LoadedWorkspaceSkill {
  skill: Skill;
  content: string;
}

export interface OpenWorkspaceInput {
  path: string;
  mode?: WorkspaceMode;
  baseRef?: string;
  alias?: string;
  writeAccess?: WorkspaceWriteAccess;
  forceNew?: boolean;
}

export interface WorkspaceSummary {
  alias: string;
  displayPath: string;
  mode: WorkspaceMode;
  managed: boolean;
  dirtySource?: boolean;
  writeAccess: WorkspaceWriteAccess;
  workspaceGeneration: number;
  hydrationStatus: "ready" | "requires_resume" | "recovery_required";
  createdAt: string;
  lastUsedAt: string;
}

export interface WorkspaceCloseLease {
  workspace: Workspace;
  commit(options?: { delete?: boolean; revoke?: boolean }): boolean;
  abort(): void;
}

export interface WorkspaceUsageSnapshot {
  activePersisted: number;
  resident: number;
  closing: number;
  leased: number;
  maxResident: number;
}

export class InstructionBudgetError extends Error {
  readonly code = "instruction_budget_exceeded";
  readonly publicText = "Project instructions exceed the configured size limit. Shorten the relevant instruction files and retry.";

  constructor(message: string) {
    super(message);
    this.name = "InstructionBudgetError";
  }
}

export class WorkspaceAliasConflictError extends Error {
  readonly code = "workspace_alias_conflict";

  constructor(readonly currentAlias: string) {
    super(`An equivalent workspace already uses alias ${currentAlias}.`);
    this.name = "WorkspaceAliasConflictError";
  }
}

export class WorkspaceSelectionRequiredError extends Error {
  readonly code = "workspace_selection_required";

  constructor(readonly aliases: string[]) {
    super("Multiple active managed workspaces match this project.");
    this.name = "WorkspaceSelectionRequiredError";
  }
}

export class WorkspaceRecoveryRequiredError extends Error {
  readonly code = "workspace_recovery_required";

  constructor(readonly alias: string, readonly reason: string) {
    super(`Workspace ${alias} could not be recovered: ${reason}`);
    this.name = "WorkspaceRecoveryRequiredError";
  }
}

class ExistingManagedWorkspaceError extends Error {
  constructor(readonly session: WorkspaceSession) {
    super("An equivalent managed workspace is already active.");
    this.name = "ExistingManagedWorkspaceError";
  }
}

export interface AllowedRootsUpdateResult {
  changed: boolean;
  added: number;
  removed: number;
  persistenceFailures: number;
  invalidated: Array<{ workspaceId: string; connectionPrincipalId: string }>;
}

export class UnknownWorkspaceError extends Error {
  readonly code = "unknown_workspace";

  constructor(readonly workspaceId: string) {
    super("The workspace is no longer available.");
    this.name = "UnknownWorkspaceError";
  }
}

export class InstructionTokenError extends Error {
  readonly code = "instruction_token_invalid";

  constructor() {
    super("The instruction token is no longer valid.");
    this.name = "InstructionTokenError";
  }
}

export class SkillNotLoadedError extends Error {
  readonly code = "skill_not_loaded";
  readonly publicText = "Call load_skill for this workspace, then retry.";

  constructor() {
    super("A Skill must be loaded before its files can be read.");
    this.name = "SkillNotLoadedError";
  }
}

export class SkillLoadError extends Error {
  constructor(
    readonly code:
      | "skill_not_found"
      | "skill_manifest_changed"
      | "skill_metadata_changed"
      | "skill_too_large"
      | "skill_access_denied"
      | "skill_io_error",
    readonly publicText: string,
  ) {
    super(publicText);
    this.name = "SkillLoadError";
  }
}

export class WorkspaceResumeRequiredError extends Error {
  readonly code = "workspace_resume_required";

  constructor() {
    super("The persisted workspace must be resumed before use.");
    this.name = "WorkspaceResumeRequiredError";
  }
}

export class UnknownWorkspaceAliasError extends Error {
  readonly code = "unknown_workspace_alias";

  constructor() {
    super("The workspace alias is unavailable.");
    this.name = "UnknownWorkspaceAliasError";
  }
}

export class WorkspaceReadOnlyError extends Error {
  readonly code = "workspace_read_only";

  constructor() {
    super("The workspace is read-only.");
    this.name = "WorkspaceReadOnlyError";
  }
}

export class StaleWorkspaceGenerationError extends Error {
  readonly code = "stale_workspace_generation";

  constructor() {
    super("The workspace handle generation is stale.");
    this.name = "StaleWorkspaceGenerationError";
  }
}

export class WorkspaceContextSessionError extends Error {
  readonly code = "workspace_context_required";

  constructor() {
    super("The workspace context session is no longer available.");
    this.name = "WorkspaceContextSessionError";
  }
}

interface WorkspaceLifecycleState {
  connectionPrincipalId: string;
  phase: "open" | "closing";
  activeOperations: number;
  drained?: Promise<void>;
  resolveDrained?: () => void;
}

const MAX_INSTRUCTION_VERSIONS_PER_WORKSPACE = 1_024;
const MAX_PENDING_INSTRUCTION_ACKNOWLEDGEMENTS = 32;
const MAX_INSTRUCTION_CONTEXTS_PER_WORKSPACE = 128;
const MAX_EXPIRED_SESSION_CANDIDATE_SCAN = 1_024;
const INSTRUCTION_ACKNOWLEDGEMENT_TTL_MS = 10 * 60_000;
const INSTRUCTION_CONTEXT_TTL_MS = 6 * 60 * 60_000;
const CLOSED_WORKSPACE_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_EMPTY_INSTRUCTION_SCAN_BYTES = 1024 * 1024;

type PathStats = Stats;
type DirectoryOps = {
  stat: (path: string) => Promise<PathStats>;
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
};

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly checkoutWorkspaceIds = new Map<string, string>();
  private readonly pendingCheckoutWorkspaces = new Map<string, Promise<WorkspaceContext>>();
  private readonly pendingManagedWorkspaces = new Map<string, Promise<WorkspaceContext>>();
  private readonly pendingHydrations = new Map<string, Promise<WorkspaceContext>>();
  private readonly lifecycleStates = new Map<string, WorkspaceLifecycleState>();
  private readonly rootLocks = new WorkspaceRootLockManager();
  private readonly instructionDirectoryCache = new Map<string, {
    fingerprint: string;
    files: string[];
  }>();
  private readonly instructionFileCache = new Map<string, {
    fingerprint: string;
    content: string;
  }>();
  private readonly pendingSessionClosures = new Map<string, WorkspaceSession>();
  private pendingManagedWorktreeCreations = 0;
  private expiredSessionScanCursor: WorkspaceSessionCursor | undefined;

  constructor(
    private readonly config: ServerConfig,
    private readonly store?: WorkspaceStore,
  ) {}

  async openWorkspace(
    connectionPrincipalId: string,
    input: string | OpenWorkspaceInput,
  ): Promise<WorkspaceContext> {
    const options = typeof input === "string" ? { path: input } : input;
    const mode = options.mode ?? "checkout";
    const alias = options.alias === undefined ? undefined : validateWorkspaceAlias(options.alias);
    const writeAccess = options.writeAccess ?? (mode === "worktree" ? "read_write" : "read_only");

    try {
      if (mode === "worktree") {
        if (writeAccess !== "read_write") {
          throw new Error("Managed worktree workspaces must use writeAccess=read_write.");
        }
        return await this.openWorktreeWorkspace(
          connectionPrincipalId,
          options.path,
          options.baseRef,
          alias,
          options.forceNew ?? false,
        );
      }

      return await this.openCheckoutWorkspace(
        connectionPrincipalId,
        options.path,
        alias,
        writeAccess,
        options.writeAccess !== undefined,
      );
    } catch (error) {
      if (!(error instanceof AccessDeniedError)) throw error;
      throw new AccessDeniedError(
        `${error.message}. Open the original approved project path. For an isolated checkout, use mode="worktree" and reuse the returned workspaceId; do not open DevSpace's internal worktree directory. If this is a different project, ask the user to add its project root.`,
      );
    }
  }

  getWorkspace(
    connectionPrincipalId: string,
    workspaceId: string,
    expectedGeneration?: number,
  ): Workspace {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace?.connectionPrincipalId === connectionPrincipalId) {
      if (!this.workspaceRootAllowed(workspace.root, workspace.mode, workspace.sourceRoot)) {
        if (workspace.mode === "worktree" && workspace.worktree?.managed) {
          const lifecycle = this.lifecycleStates.get(workspaceId);
          if (lifecycle && (lifecycle.phase === "closing" || lifecycle.activeOperations > 0)) {
            throw new WorkspaceResumeRequiredError();
          }
          this.evictWorkspace(workspaceId, workspace.root);
          throw new WorkspaceResumeRequiredError();
        }
        this.invalidateWorkspace(workspaceId, connectionPrincipalId, workspace.root);
        throw new UnknownWorkspaceError(workspaceId);
      }
      workspace.lastUsedAt = Date.now();
      if (expectedGeneration !== undefined && workspace.stateGeneration !== expectedGeneration) {
        throw new StaleWorkspaceGenerationError();
      }
      this.store?.touchSession(workspaceId, connectionPrincipalId);
      return workspace;
    }

    const session = this.store?.getSession(workspaceId, connectionPrincipalId);
    if (!session) {
      throw new UnknownWorkspaceError(workspaceId);
    }
    throw new WorkspaceResumeRequiredError();
  }

  listWorkspaces(connectionPrincipalId: string): WorkspaceSummary[] {
    this.reconcileMissingManagedSessions();
    const summaries = this.store?.listActiveSessionSummaries?.(connectionPrincipalId)
      ?? Array.from(this.workspaces.values())
        .filter((workspace) => workspace.connectionPrincipalId === connectionPrincipalId)
        .map((workspace): ActiveWorkspaceSummary => ({
          alias: workspace.alias,
          mode: workspace.mode,
          managed: workspace.worktree?.managed ?? false,
          ...(workspace.worktree?.managed
            ? { dirtySource: workspace.worktree.dirtySource }
            : {}),
          writeAccess: workspace.writeAccess,
          stateGeneration: workspace.stateGeneration,
          createdAt: new Date(workspace.lastUsedAt).toISOString(),
          lastUsedAt: new Date(workspace.lastUsedAt).toISOString(),
        }));

    return summaries.map((summary) => {
      const session = this.store?.getActiveSessionByAlias?.(connectionPrincipalId, summary.alias);
      const resident = Array.from(this.workspaces.values()).find(
        (workspace) =>
          workspace.connectionPrincipalId === connectionPrincipalId &&
          workspace.alias === summary.alias,
      );
      const available = resident
        ? this.workspaceRootAllowed(resident.root, resident.mode, resident.sourceRoot)
        : session
          ? this.workspaceRootAllowed(session.root, session.mode, session.sourceRoot)
          : true;
      return {
        alias: summary.alias,
        displayPath: formatWorkspaceDisplayPath(
          resident?.sourceRoot ?? resident?.root ?? session?.sourceRoot ?? session?.root,
        ),
        mode: summary.mode,
        managed: summary.managed,
        ...(summary.managed
          ? { dirtySource: resident?.worktree?.dirtySource ?? session?.dirtySource ?? summary.dirtySource }
          : {}),
        writeAccess: summary.writeAccess,
        workspaceGeneration: summary.stateGeneration,
        hydrationStatus: summary.managed && !available
          ? "recovery_required"
          : resident
            ? "ready"
            : "requires_resume",
        createdAt: summary.createdAt,
        lastUsedAt: summary.lastUsedAt,
      };
    });
  }

  workspaceSummary(connectionPrincipalId: string, alias: string): WorkspaceSummary {
    const normalizedAlias = validateWorkspaceAlias(alias);
    const summary = this.listWorkspaces(connectionPrincipalId)
      .find((candidate) => candidate.alias === normalizedAlias);
    if (!summary) throw new UnknownWorkspaceAliasError();
    return summary;
  }

  activeSessionsSnapshot(): WorkspaceSession[] {
    const sessions = this.store?.listActiveSessions?.()
      ?? Array.from(this.workspaces.values()).map(workspaceToSessionSnapshot);
    return sessions.map((session) => ({ ...session }));
  }

  bumpAuthorityGenerations(connectionPrincipalId?: string): number {
    const updates = this.store?.bumpActiveStateGenerations?.(connectionPrincipalId);
    if (updates) {
      for (const update of updates) {
        const resident = this.workspaces.get(update.id);
        if (resident?.connectionPrincipalId === update.connectionPrincipalId) {
          resident.stateGeneration = update.stateGeneration;
        }
      }
      return updates.length;
    }

    let bumped = 0;
    for (const workspace of this.workspaces.values()) {
      if (
        connectionPrincipalId !== undefined &&
        workspace.connectionPrincipalId !== connectionPrincipalId
      ) continue;
      workspace.stateGeneration += 1;
      bumped += 1;
    }
    return bumped;
  }

  async resumeWorkspace(connectionPrincipalId: string, alias: string): Promise<WorkspaceContext> {
    const normalizedAlias = validateWorkspaceAlias(alias);
    const resident = Array.from(this.workspaces.values()).find(
      (workspace) =>
        workspace.connectionPrincipalId === connectionPrincipalId &&
        workspace.alias === normalizedAlias,
    );
    if (resident) {
      if (this.workspaceRootAllowed(resident.root, resident.mode, resident.sourceRoot)) {
        return this.contextForWorkspace(resident, true);
      }
      const lifecycle = this.lifecycleStates.get(resident.id);
      if (lifecycle && (lifecycle.phase === "closing" || lifecycle.activeOperations > 0)) {
        throw new WorkspaceRecoveryRequiredError(
          normalizedAlias,
          "an active process or operation must finish before the missing worktree can be recreated",
        );
      }
      this.evictWorkspace(resident.id, resident.root);
    }

    const session = this.store?.getActiveSessionByAlias?.(connectionPrincipalId, normalizedAlias);
    if (!session) throw new UnknownWorkspaceAliasError();
    const identity = workspaceIdentity(session.id, connectionPrincipalId);
    const pending = this.pendingHydrations.get(identity);
    if (pending) return pending;

    const hydration = this.hydrateWorkspaceSession(session);
    this.pendingHydrations.set(identity, hydration);
    try {
      return await hydration;
    } finally {
      this.pendingHydrations.delete(identity);
    }
  }

  async getWorkspaceContext(
    connectionPrincipalId: string,
    workspaceId: string,
    workspaceGeneration?: number,
  ): Promise<WorkspaceContext> {
    const workspace = this.getWorkspace(connectionPrincipalId, workspaceId, workspaceGeneration);
    return this.contextForWorkspace(workspace, true);
  }

  assertWorkspaceWritable(workspace: Workspace): void {
    if (workspace.writeAccess !== "read_write") throw new WorkspaceReadOnlyError();
  }

  skillRevision(workspace: Workspace): string {
    return computeSkillRevision(realpathSync(workspace.root), workspace.skills);
  }

  applyAllowedRoots(nextRoots: string[]): AllowedRootsUpdateResult {
    const previous = [...this.config.allowedRoots];
    const normalized = normalizeAllowedRoots(nextRoots, previous);
    const changed = !sameStringArray(previous, normalized);
    if (changed) {
      // Publish the new authorization snapshot before inspecting or closing old
      // sessions so no new operation can enter a root that was just removed.
      this.config.allowedRoots = normalized;
    }
    const sessions = this.store?.listActiveSessions?.() ?? Array.from(this.workspaces.values()).map(
      (workspace): WorkspaceSession => ({
        id: workspace.id,
        connectionPrincipalId: workspace.connectionPrincipalId,
        root: workspace.root,
        status: "active",
        mode: workspace.mode,
        sourceRoot: workspace.sourceRoot,
        baseRef: workspace.worktree?.baseRef,
        baseSha: workspace.worktree?.baseSha,
        dirtySource: workspace.worktree?.dirtySource ?? false,
        managed: workspace.worktree?.managed ?? false,
        createdAt: new Date(workspace.lastUsedAt).toISOString(),
        lastUsedAt: new Date(workspace.lastUsedAt).toISOString(),
      }),
    );
    const revoked = sessions.filter(
      (session) => !this.workspaceRootAllowed(session.root, session.mode, session.sourceRoot),
    );
    for (const session of revoked) {
      this.pendingSessionClosures.set(workspaceIdentity(session.id, session.connectionPrincipalId), session);
    }
    const pendingClosures = Array.from(this.pendingSessionClosures.values());
    const identities = pendingClosures.map(({ id, connectionPrincipalId }) => ({ id, connectionPrincipalId }));
    let persistenceFailures = 0;
    try {
      if (this.store?.closeSessions) {
        this.store.closeSessions(identities);
      } else {
        for (const session of pendingClosures) this.store?.closeSession(session.id, session.connectionPrincipalId);
      }
      this.pendingSessionClosures.clear();
    } catch {
      // The narrower in-memory policy remains authoritative. Return every
      // revoked identity so process cleanup can proceed, then let the caller
      // retry persistent-session reconciliation.
      persistenceFailures = 1;
    }
    for (const session of pendingClosures) {
      this.evictWorkspace(session.id, session.root);
    }
    if (changed) {
      const invalidatedIds = new Set(pendingClosures.map((session) => session.id));
      for (const update of this.store?.bumpActiveStateGenerations?.() ?? []) {
        if (invalidatedIds.has(update.id)) continue;
        const resident = this.workspaces.get(update.id);
        if (resident?.connectionPrincipalId === update.connectionPrincipalId) {
          resident.stateGeneration = update.stateGeneration;
        }
      }
      if (!this.store?.bumpActiveStateGenerations) {
        for (const workspace of this.workspaces.values()) workspace.stateGeneration += 1;
      }
    }

    const previousSet = new Set(previous);
    const nextSet = new Set(normalized);
    return {
      changed,
      added: normalized.filter((root) => !previousSet.has(root)).length,
      removed: previous.filter((root) => !nextSet.has(root)).length,
      persistenceFailures,
      invalidated: pendingClosures.map(({ id, connectionPrincipalId }) => ({
        workspaceId: id,
        connectionPrincipalId: connectionPrincipalId,
      })),
    };
  }

  pendingAllowedRootsCleanupCount(): number {
    return this.pendingSessionClosures.size;
  }

  resolvePath(workspace: Workspace, inputPath: string): string {
    const absolutePath = resolveAllowedPath(inputPath, workspace.root, [workspace.root]);
    if (!isPathInsideRoot(absolutePath, workspace.root)) {
      throw new Error(`Path is outside workspace root: ${inputPath}`);
    }

    return absolutePath;
  }

  resolveReadPath(workspace: Workspace, inputPath: string): WorkspaceReadPath {
    const skillRead = resolveSkillReadPath(
      workspace.skills,
      workspace.activatedSkillDirs,
      inputPath,
      workspace.root,
    );
    if (skillRead) {
      if (!workspace.activatedSkillDirs.has(resolve(skillRead.skill.baseDir))) {
        throw new SkillNotLoadedError();
      }
      return {
        absolutePath: skillRead.absolutePath,
        readRoots: [workspace.root, skillRead.skill.baseDir],
        skillRead,
      };
    }

    const workspaceAbsolutePath = resolveAllowedPath(inputPath, workspace.root, [workspace.root]);
    const lockedSkill = workspace.skills.find((skill) =>
      workspaceAbsolutePath !== skill.filePath &&
      isPathInsideRoot(workspaceAbsolutePath, skill.baseDir) &&
      !workspace.activatedSkillDirs.has(resolve(skill.baseDir))
    );
    if (lockedSkill) {
      throw new SkillNotLoadedError();
    }

    try {
      return {
        absolutePath: this.resolvePath(workspace, inputPath),
        readRoots: [workspace.root],
      };
    } catch (workspaceError) {
      throw workspaceError;
    }
  }

  confineReadPath(readPath: WorkspaceReadPath): WorkspaceReadPath {
    try {
      const canonicalPath = realpathSync(readPath.absolutePath);
      const canonicalRoots = readPath.readRoots.map((root) => realpathSync(root));
      return {
        ...readPath,
        absolutePath: assertAllowedPath(canonicalPath, canonicalRoots),
        readRoots: canonicalRoots,
      };
    } catch (error) {
      if (isMissingPathError(error)) return readPath;
      throw error;
    }
  }

  confineWorkspacePath(workspace: Workspace, inputPath: string): string {
    const absolutePath = this.resolvePath(workspace, inputPath);
    let existing = absolutePath;
    while (isPathInsideRoot(existing, workspace.root)) {
      try {
        const canonicalRoot = realpathSync(workspace.root);
        assertAllowedPath(realpathSync(existing), [canonicalRoot]);
        return absolutePath;
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        const parent = dirname(existing);
        if (parent === existing) break;
        existing = parent;
      }
    }
    throw new Error(`Path cannot be confined to workspace root: ${inputPath}`);
  }

  async loadSkill(
    connectionPrincipalId: string,
    workspaceId: string,
    skillId: string,
  ): Promise<LoadedWorkspaceSkill> {
    const workspace = this.getWorkspace(connectionPrincipalId, workspaceId);
    const skill = workspace.skills.find((candidate) => candidate.skillId === skillId);
    if (!skill) {
      throw new SkillLoadError("skill_not_found", "The requested Skill is not available in this workspace.");
    }
    try {
      const canonicalBaseDir = await realpath(skill.baseDir);
      const canonicalManifest = await realpath(skill.filePath);
      if (
        !isPathInsideRoot(canonicalManifest, canonicalBaseDir) ||
        canonicalManifest !== skill.filePath
      ) {
        throw new SkillLoadError(
          "skill_access_denied",
          "The Skill manifest is outside its advertised directory.",
        );
      }

      const manifestStats = await stat(canonicalManifest);
      if (!manifestStats.isFile()) {
        throw new SkillLoadError("skill_io_error", "The Skill manifest is not a regular file.");
      }
      if (manifestStats.size > SKILL_DISCOVERY_LIMITS.maxSkillBytes) {
        throw new SkillLoadError("skill_too_large", "The Skill manifest exceeds the configured size limit.");
      }

      const content = await readFile(canonicalManifest, "utf8");
      if (Buffer.byteLength(content, "utf8") > SKILL_DISCOVERY_LIMITS.maxSkillBytes) {
        throw new SkillLoadError("skill_too_large", "The Skill manifest exceeds the configured size limit.");
      }
      const manifestHash = createHash("sha256").update(content).digest("hex");
      if (manifestHash !== skill.manifestHash) {
        throw new SkillLoadError(
          "skill_manifest_changed",
          "The Skill manifest changed after discovery; refresh workspace context before loading it.",
        );
      }
      const openAiMetadataHash = computeSkillOpenAiMetadataHash(canonicalBaseDir);
      if (!skill.openAiMetadataHash || openAiMetadataHash !== skill.openAiMetadataHash) {
        throw new SkillLoadError(
          "skill_metadata_changed",
          "The Skill metadata changed after discovery; refresh workspace context before loading it.",
        );
      }

      // Activation is intentionally last: support files only become readable after
      // one complete, successful manifest read.
      markSkillActivated(workspace.activatedSkillDirs, skill);
      return { skill, content };
    } catch (error) {
      if (error instanceof SkillLoadError) throw error;
      if (error && typeof error === "object" && "code" in error) {
        if (error.code === "EACCES" || error.code === "EPERM") {
          throw new SkillLoadError("skill_access_denied", "The Skill manifest cannot be accessed.");
        }
        if (error.code === "ENOENT" || error.code === "ENOTDIR") {
          throw new SkillLoadError("skill_not_found", "The Skill manifest is no longer available.");
        }
      }
      throw new SkillLoadError("skill_io_error", "The Skill manifest could not be read.");
    }
  }

  async loadApplicableAgentsFiles(
    workspace: Workspace,
    inputPaths: string[],
    options: { contextSessionId?: string; requireAcknowledged?: boolean } = {},
  ): Promise<ApplicableAgentsFile[]> {
    const instructionContext = options.contextSessionId === undefined
      ? undefined
      : this.instructionContext(workspace, options.contextSessionId);
    if (options.requireAcknowledged && !instructionContext) {
      throw new WorkspaceContextSessionError();
    }
    const targetDirectories = new Set<string>();
    for (const inputPath of inputPaths) {
      const absolutePath = this.resolvePath(workspace, inputPath);
      const targetDirectory = await canonicalInstructionDirectory(absolutePath, workspace.root);
      targetDirectories.add(targetDirectory);
    }

    const loaded: ApplicableAgentsFile[] = [];
    const loadedPaths = new Set<string>();
    let loadedBytes = 0;
    const knownVersions = options.requireAcknowledged
      ? instructionContext!.acknowledgedInstructionVersions
      : instructionContext?.deliveredInstructionVersions;
    for (const targetDirectory of [...targetDirectories].sort()) {
      const chain = await this.loadInstructionChain(workspace.root, targetDirectory);
      for (const file of chain) {
        const { path } = file;
        if (knownVersions?.get(path) === file.fingerprint) continue;
        if (loadedPaths.has(path)) continue;
        const fileBytes = Buffer.byteLength(file.content, "utf8");
        assertInstructionFitsBudget(path, loadedBytes, fileBytes, "instruction response");
        loaded.push(file);
        loadedPaths.add(path);
        loadedBytes += fileBytes;
      }
    }
    return loaded;
  }

  createInstructionContext(
    workspace: Workspace,
    contextSessionId = `wctxs_${randomUUID()}`,
  ): string {
    const id = validateInstructionContextSessionId(contextSessionId);
    const existing = workspace.instructionContexts.get(id);
    if (existing) {
      if (
        existing.connectionPrincipalId !== workspace.connectionPrincipalId ||
        existing.workspaceId !== workspace.id ||
        existing.workspaceGeneration !== workspace.stateGeneration
      ) {
        throw new WorkspaceContextSessionError();
      }
      existing.lastUsedAt = Date.now();
      workspace.instructionContexts.delete(id);
      workspace.instructionContexts.set(id, existing);
      return id;
    }

    const now = Date.now();
    workspace.instructionContexts.set(id, {
      id,
      connectionPrincipalId: workspace.connectionPrincipalId,
      workspaceId: workspace.id,
      workspaceGeneration: workspace.stateGeneration,
      deliveredInstructionVersions: new Map(),
      acknowledgedInstructionVersions: new Map(),
      acknowledgementGeneration: 0,
      pendingAcknowledgements: new Map(),
      createdAt: now,
      lastUsedAt: now,
    });
    while (workspace.instructionContexts.size > MAX_INSTRUCTION_CONTEXTS_PER_WORKSPACE) {
      const oldest = workspace.instructionContexts.keys().next().value;
      if (!oldest || oldest === id) break;
      workspace.instructionContexts.delete(oldest);
    }
    return id;
  }

  async markAgentsFilesDelivered(
    workspace: Workspace,
    contextSessionId: string,
    files: ApplicableAgentsFile[],
  ): Promise<void> {
    const instructionContext = this.instructionContext(workspace, contextSessionId);
    await this.assertCurrentInstructionChainsWithinBudget(workspace, files);
    let deliveredBytes = 0;
    for (const file of files) {
      const current = await this.readCachedInstruction(file.path);
      if (current.fingerprint !== file.fingerprint) {
        throw new Error("Applicable project instructions changed while marking them delivered. Retry the tool.");
      }
      const fileBytes = Buffer.byteLength(file.content, "utf8");
      assertInstructionFitsBudget(file.path, deliveredBytes, fileBytes, "instruction response");
      deliveredBytes += fileBytes;
    }
    for (const file of files) {
      setBoundedMap(
        instructionContext.deliveredInstructionVersions,
        file.path,
        file.fingerprint,
        MAX_INSTRUCTION_VERSIONS_PER_WORKSPACE,
      );
    }
  }

  async markAgentsFilesAcknowledged(
    workspace: Workspace,
    contextSessionId: string,
    files: ApplicableAgentsFile[],
  ): Promise<void> {
    const instructionContext = this.instructionContext(workspace, contextSessionId);
    await this.assertCurrentInstructionChainsWithinBudget(workspace, files);
    let acknowledgementBytes = 0;
    let changed = false;
    for (const file of files) {
      const current = await this.readCachedInstruction(file.path);
      if (current.fingerprint !== file.fingerprint) {
        throw new Error("Applicable project instructions changed while acknowledging context. Retry the tool.");
      }
      const fileBytes = Buffer.byteLength(file.content, "utf8");
      assertInstructionFitsBudget(
        file.path,
        acknowledgementBytes,
        fileBytes,
        "instruction acknowledgement",
      );
      acknowledgementBytes += fileBytes;
      if (instructionContext.acknowledgedInstructionVersions.get(file.path) !== file.fingerprint) {
        changed = true;
      }
    }
    for (const file of files) {
      setBoundedMap(
        instructionContext.deliveredInstructionVersions,
        file.path,
        file.fingerprint,
        MAX_INSTRUCTION_VERSIONS_PER_WORKSPACE,
      );
      setBoundedMap(
        instructionContext.acknowledgedInstructionVersions,
        file.path,
        file.fingerprint,
        MAX_INSTRUCTION_VERSIONS_PER_WORKSPACE,
      );
    }
    if (changed) instructionContext.acknowledgementGeneration += 1;
  }

  instructionsAcknowledged(
    workspace: Workspace,
    contextSessionId: string,
    files: ApplicableAgentsFile[],
  ): boolean {
    const instructionContext = this.instructionContext(workspace, contextSessionId);
    return files.every(
      (file) => instructionContext.acknowledgedInstructionVersions.get(file.path) === file.fingerprint,
    );
  }

  instructionAcknowledgementGeneration(
    workspace: Workspace,
    contextSessionId: string,
  ): number {
    return this.instructionContext(workspace, contextSessionId).acknowledgementGeneration;
  }

  async createInstructionAcknowledgement(
    workspace: Workspace,
    contextSessionId: string,
    files: ApplicableAgentsFile[],
  ): Promise<string> {
    const instructionContext = this.instructionContext(workspace, contextSessionId);
    await this.assertCurrentInstructionChainsWithinBudget(workspace, files);
    const token = `instructions_${randomUUID()}`;
    const versionedFiles = [];
    let acknowledgementBytes = 0;
    for (const file of files) {
      const current = await this.readCachedInstruction(file.path);
      if (current.fingerprint !== file.fingerprint) {
        throw new Error("Applicable project instructions changed while preparing instructionToken. Retry the tool.");
      }
      const fileBytes = Buffer.byteLength(file.content, "utf8");
      assertInstructionFitsBudget(file.path, acknowledgementBytes, fileBytes, "instruction acknowledgement");
      acknowledgementBytes += fileBytes;
      versionedFiles.push({ path: file.path, fingerprint: file.fingerprint, content: file.content });
    }
    instructionContext.pendingAcknowledgements.set(token, {
      createdAt: Date.now(),
      files: versionedFiles,
    });
    while (instructionContext.pendingAcknowledgements.size > MAX_PENDING_INSTRUCTION_ACKNOWLEDGEMENTS) {
      const oldest = instructionContext.pendingAcknowledgements.keys().next().value;
      if (!oldest) break;
      instructionContext.pendingAcknowledgements.delete(oldest);
    }
    return token;
  }

  async acknowledgeInstructions(
    workspace: Workspace,
    contextSessionId: string,
    token: string,
  ): Promise<void> {
    const instructionContext = this.instructionContext(workspace, contextSessionId);
    const pending = instructionContext.pendingAcknowledgements.get(token);
    if (!pending) throw new InstructionTokenError();
    if (Date.now() - pending.createdAt > INSTRUCTION_ACKNOWLEDGEMENT_TTL_MS) {
      instructionContext.pendingAcknowledgements.delete(token);
      throw new InstructionTokenError();
    }
    for (const file of pending.files) {
      const current = await this.readCachedInstruction(file.path);
      if (current.fingerprint !== file.fingerprint) {
        instructionContext.pendingAcknowledgements.delete(token);
        throw new InstructionTokenError();
      }
    }
    await this.assertCurrentInstructionChainsWithinBudget(workspace, pending.files);
    for (const file of pending.files) {
      setBoundedMap(
        instructionContext.deliveredInstructionVersions,
        file.path,
        file.fingerprint,
        MAX_INSTRUCTION_VERSIONS_PER_WORKSPACE,
      );
      setBoundedMap(
        instructionContext.acknowledgedInstructionVersions,
        file.path,
        file.fingerprint,
        MAX_INSTRUCTION_VERSIONS_PER_WORKSPACE,
      );
    }
    instructionContext.pendingAcknowledgements.delete(token);
    instructionContext.acknowledgementGeneration += 1;
  }

  private instructionContext(
    workspace: Workspace,
    contextSessionId: string,
  ): WorkspaceInstructionContext {
    const id = validateInstructionContextSessionId(contextSessionId);
    const instructionContext = workspace.instructionContexts.get(id);
    if (
      !instructionContext ||
      instructionContext.connectionPrincipalId !== workspace.connectionPrincipalId ||
      instructionContext.workspaceId !== workspace.id ||
      instructionContext.workspaceGeneration !== workspace.stateGeneration
    ) {
      throw new WorkspaceContextSessionError();
    }
    instructionContext.lastUsedAt = Date.now();
    workspace.instructionContexts.delete(id);
    workspace.instructionContexts.set(id, instructionContext);
    return instructionContext;
  }

  resolveWorkingDirectory(workspace: Workspace, workingDirectory: string | undefined): string {
    const directory = workingDirectory
      ? this.confineWorkspacePath(workspace, workingDirectory)
      : workspace.root;
    return assertAllowedPath(realpathSync(directory), [realpathSync(workspace.root)]);
  }

  /**
   * Current cwd for a workspace. DevSpace does not persist shell cwd across
   * bash calls (Codex-style per-turn cwd): every command starts at the
   * workspace root unless `workingDirectory` is passed. This helper returns
   * the workspace root for telemetry / display purposes.
   */
  getShellCwd(workspace: Workspace): string {
    return workspace.root;
  }

  async withWorkspaceOperation<T>(
    connectionPrincipalId: string,
    workspaceId: string,
    workspaceGeneration: number,
    callback: (workspace: Workspace) => T | Promise<T>,
    lockMode: WorkspaceRootLockMode = "read",
  ): Promise<T> {
    const initialWorkspace = this.getWorkspace(
      connectionPrincipalId,
      workspaceId,
      workspaceGeneration,
    );
    const lockKey = this.workspaceRootLockKey(initialWorkspace);
    return this.rootLocks.withLock(lockKey, lockMode, async () => {
      const existingLifecycle = this.lifecycleStates.get(workspaceId);
      if (
        existingLifecycle?.connectionPrincipalId === connectionPrincipalId &&
        existingLifecycle.phase === "closing"
      ) {
        throw new Error(`Workspace ${workspaceId} is closing and cannot accept new operations.`);
      }
      // Revalidate after waiting for the root lock. A close, revoke, allowed-root
      // edit, or generation bump may have invalidated the original handle.
      const workspace = this.getWorkspace(connectionPrincipalId, workspaceId, workspaceGeneration);
      const lifecycle = this.ensureLifecycleState(workspace);
      if (lifecycle.phase === "closing") {
        throw new Error(`Workspace ${workspaceId} is closing and cannot accept new operations.`);
      }
      lifecycle.activeOperations += 1;
      try {
        return await callback(workspace);
      } finally {
        lifecycle.activeOperations -= 1;
        if (lifecycle.activeOperations < 0) {
          throw new Error(`Workspace ${workspaceId} operation count underflow.`);
        }
        if (lifecycle.activeOperations === 0) lifecycle.resolveDrained?.();
        this.evictResidentWorkspaces();
      }
    });
  }

  async withExclusiveWorkspaceRoot<T>(
    connectionPrincipalId: string,
    workspaceId: string,
    workspaceGeneration: number,
    callback: (workspace: Workspace) => T | Promise<T>,
  ): Promise<T> {
    const initialWorkspace = this.getWorkspace(
      connectionPrincipalId,
      workspaceId,
      workspaceGeneration,
    );
    const lockKey = this.workspaceRootLockKey(initialWorkspace);
    return this.rootLocks.withLock(lockKey, "write", async () => {
      const workspace = this.getWorkspace(connectionPrincipalId, workspaceId, workspaceGeneration);
      return callback(workspace);
    });
  }

  async acquireExclusiveClose(
    connectionPrincipalId: string,
    workspaceId: string,
    workspaceGeneration?: number,
    options: { beforeDrain?: () => unknown | Promise<unknown> } = {},
  ): Promise<WorkspaceCloseLease> {
    const existingLifecycle = this.lifecycleStates.get(workspaceId);
    if (
      existingLifecycle?.connectionPrincipalId === connectionPrincipalId &&
      existingLifecycle.phase === "closing"
    ) {
      throw new Error(`Workspace ${workspaceId} is already closing.`);
    }
    const workspace = this.getWorkspace(connectionPrincipalId, workspaceId, workspaceGeneration);
    const lifecycle = this.ensureLifecycleState(workspace);
    lifecycle.phase = "closing";
    try {
      await options.beforeDrain?.();
      if (lifecycle.activeOperations > 0) {
        lifecycle.drained = new Promise<void>((resolve) => {
          lifecycle.resolveDrained = resolve;
        });
        await lifecycle.drained;
      }
    } catch (error) {
      lifecycle.phase = "open";
      lifecycle.drained = undefined;
      lifecycle.resolveDrained = undefined;
      this.evictResidentWorkspaces();
      throw error;
    }

    let finished = false;
    const abort = () => {
      if (finished) return;
      finished = true;
      lifecycle.phase = "open";
      lifecycle.drained = undefined;
      lifecycle.resolveDrained = undefined;
      this.evictResidentWorkspaces();
    };
    return {
      workspace,
      commit: (options = {}) => {
        if (finished) return false;
        const closed = this.store
          ? options.revoke
            ? this.store.revokeSession?.(workspaceId, connectionPrincipalId) !== undefined
            : options.delete
            ? this.store.deleteSession(workspaceId, connectionPrincipalId)
            : this.store.closeSession(workspaceId, connectionPrincipalId)
          : this.workspaces.has(workspaceId);
        if (!closed) {
          abort();
          return false;
        }
        finished = true;
        this.workspaces.delete(workspaceId);
        this.lifecycleStates.delete(workspaceId);
        this.removeCheckoutWorkspaceId(workspaceId);
        this.purgeInstructionCachesForUnusedRoot(workspace.root);
        return true;
      },
      abort,
    };
  }

  private workspaceRootLockKey(workspace: Workspace): string {
    try {
      return realpathSync(workspace.root);
    } catch {
      return resolve(workspace.root);
    }
  }

  usageSnapshot(connectionPrincipalId?: string): WorkspaceUsageSnapshot {
    const resident = Array.from(this.workspaces.values())
      .filter((workspace) =>
        !connectionPrincipalId || workspace.connectionPrincipalId === connectionPrincipalId)
      .length;
    const lifecycle = Array.from(this.lifecycleStates.values())
      .filter((state) =>
        !connectionPrincipalId || state.connectionPrincipalId === connectionPrincipalId);
    return {
      activePersisted: this.store?.countActiveSessions?.(connectionPrincipalId) ?? resident,
      resident,
      closing: lifecycle.filter((state) => state.phase === "closing").length,
      leased: lifecycle.reduce((count, state) => count + state.activeOperations, 0),
      maxResident: this.config.resources.maxResidentWorkspaces,
    };
  }

  cleanupLifecycleState(now = Date.now()): {
    expiredInstructionTokens: number;
    deletedClosedWorkspaceSessions: number;
  } {
    let expiredInstructionTokens = 0;
    for (const workspace of this.workspaces.values()) {
      for (const [contextSessionId, instructionContext] of workspace.instructionContexts) {
        if (now - instructionContext.lastUsedAt > INSTRUCTION_CONTEXT_TTL_MS) {
          expiredInstructionTokens += instructionContext.pendingAcknowledgements.size;
          workspace.instructionContexts.delete(contextSessionId);
          continue;
        }
        for (const [token, pending] of instructionContext.pendingAcknowledgements) {
          if (now - pending.createdAt <= INSTRUCTION_ACKNOWLEDGEMENT_TTL_MS) continue;
          instructionContext.pendingAcknowledgements.delete(token);
          expiredInstructionTokens += 1;
        }
        trimMap(
          instructionContext.deliveredInstructionVersions,
          MAX_INSTRUCTION_VERSIONS_PER_WORKSPACE,
        );
        trimMap(
          instructionContext.acknowledgedInstructionVersions,
          MAX_INSTRUCTION_VERSIONS_PER_WORKSPACE,
        );
      }
    }
    this.trimInstructionCaches();
    this.evictResidentWorkspaces();
    const historyBefore = new Date(now - CLOSED_WORKSPACE_HISTORY_RETENTION_MS).toISOString();
    const deletedClosedWorkspaceSessions = this.store?.deleteClosedSessions?.(
      historyBefore,
      this.config.resources.maxResidentWorkspaces,
    ) ?? 0;
    return { expiredInstructionTokens, deletedClosedWorkspaceSessions };
  }

  closeWorkspace(connectionPrincipalId: string, workspaceId: string): boolean {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace && workspace.connectionPrincipalId !== connectionPrincipalId) return false;
    const lifecycle = this.lifecycleStates.get(workspaceId);
    if (lifecycle && (lifecycle.phase === "closing" || lifecycle.activeOperations > 0)) return false;
    const closed = this.store?.closeSession(workspaceId, connectionPrincipalId) ?? Boolean(workspace);
    if (closed) {
      this.workspaces.delete(workspaceId);
      this.lifecycleStates.delete(workspaceId);
      this.removeCheckoutWorkspaceId(workspaceId);
      if (workspace) this.purgeInstructionCachesForUnusedRoot(workspace.root);
    }
    return closed;
  }

  deleteWorkspace(connectionPrincipalId: string, workspaceId: string): boolean {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace && workspace.connectionPrincipalId !== connectionPrincipalId) return false;
    const lifecycle = this.lifecycleStates.get(workspaceId);
    if (lifecycle && (lifecycle.phase === "closing" || lifecycle.activeOperations > 0)) return false;
    const deleted = this.store?.deleteSession(workspaceId, connectionPrincipalId) ?? Boolean(workspace);
    if (deleted) {
      this.workspaces.delete(workspaceId);
      this.lifecycleStates.delete(workspaceId);
      this.removeCheckoutWorkspaceId(workspaceId);
      if (workspace) this.purgeInstructionCachesForUnusedRoot(workspace.root);
    }
    return deleted;
  }

  evictRevokedWorkspace(
    connectionPrincipalId: string,
    workspaceId: string,
    root: string,
  ): void {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace && workspace.connectionPrincipalId !== connectionPrincipalId) return;
    this.workspaces.delete(workspaceId);
    this.lifecycleStates.delete(workspaceId);
    this.removeCheckoutWorkspaceId(workspaceId);
    this.purgeInstructionCachesForUnusedRoot(workspace?.root ?? root);
  }

  closeExpiredSessions(
    idleTtlMs: number,
    hasActiveProcess: (connectionPrincipalId: string, workspaceId: string) => boolean,
  ): string[] {
    if (!this.store) return [];
    const before = new Date(Date.now() - idleTtlMs).toISOString();
    const closed: string[] = [];
    let cursor = this.expiredSessionScanCursor;
    let scanned = 0;
    let reachedEnd = false;
    while (scanned < MAX_EXPIRED_SESSION_CANDIDATE_SCAN) {
      const pageLimit = Math.min(
        this.config.resources.maxResidentWorkspaces,
        MAX_EXPIRED_SESSION_CANDIDATE_SCAN - scanned,
      );
      const candidates = this.store.listExpiredSessions(before, pageLimit, cursor);
      if (candidates.length === 0) {
        reachedEnd = true;
        break;
      }
      scanned += candidates.length;
      const lastCandidate = candidates.at(-1)!;
      cursor = { lastUsedAt: lastCandidate.lastUsedAt, id: lastCandidate.id };

      for (const session of candidates) {
        if (hasActiveProcess(session.connectionPrincipalId, session.id)) continue;
        const lifecycle = this.lifecycleStates.get(session.id);
        if (lifecycle && (lifecycle.phase === "closing" || lifecycle.activeOperations > 0)) continue;
        if (session.managed) {
          if (!session.sourceRoot) {
            this.invalidateWorkspace(session.id, session.connectionPrincipalId, session.root);
            closed.push(session.id);
            continue;
          }
          try {
            const removal = removeManagedWorktreeSync({
              sourceRoot: session.sourceRoot,
              worktreePath: session.root,
              config: {
                ...this.config,
                allowedRoots: [...this.config.allowedRoots, session.sourceRoot],
              },
            });
            if (removal.reason === "dirty") continue;
          } catch {
            continue;
          }
        }
        if (!this.store.closeSession(session.id, session.connectionPrincipalId)) continue;
        this.workspaces.delete(session.id);
        this.lifecycleStates.delete(session.id);
        this.removeCheckoutWorkspaceId(session.id);
        this.purgeInstructionCachesForUnusedRoot(session.root);
        closed.push(session.id);
      }
      if (candidates.length < pageLimit) {
        reachedEnd = true;
        break;
      }
    }
    this.expiredSessionScanCursor = reachedEnd ? undefined : cursor;
    return closed;
  }

  isReady(): boolean {
    return this.store?.isReady() ?? true;
  }

  private async openCheckoutWorkspace(
    connectionPrincipalId: string,
    path: string,
    alias: string | undefined,
    writeAccess: WorkspaceWriteAccess,
    replaceWriteAccess: boolean,
  ): Promise<WorkspaceContext> {
    const root = assertAllowedPath(path, this.config.allowedRoots);
    const rootStats = await ensureCheckoutWorkspaceRoot(root);
    if (!rootStats.isDirectory()) {
      throw new Error(`Workspace root must be a directory: ${path}`);
    }

    const canonicalRoot = await realpath(root);
    const canonicalAllowedRoots = await Promise.all(
      this.config.allowedRoots
        .filter((allowedRoot) => isPathInsideRoot(root, allowedRoot))
        .map((allowedRoot) => realpath(allowedRoot)),
    );
    const validatedRoot = assertAllowedPath(canonicalRoot, canonicalAllowedRoots);
    const checkoutKey = checkoutWorkspaceKey(connectionPrincipalId, canonicalRoot);
    const previous = this.pendingCheckoutWorkspaces.get(checkoutKey);
    const opening = (async () => {
      if (previous) await previous.catch(() => undefined);
      return this.createWorkspaceContext({
        connectionPrincipalId,
        alias,
        root: validatedRoot,
        canonicalRoot,
        mode: "checkout",
        writeAccess,
        replaceWriteAccess,
      });
    })();
    this.pendingCheckoutWorkspaces.set(checkoutKey, opening);
    try {
      return await opening;
    } finally {
      if (this.pendingCheckoutWorkspaces.get(checkoutKey) === opening) {
        this.pendingCheckoutWorkspaces.delete(checkoutKey);
      }
    }
  }

  private async openWorktreeWorkspace(
    connectionPrincipalId: string,
    path: string,
    baseRef: string | undefined,
    alias: string | undefined,
    forceNew: boolean,
  ): Promise<WorkspaceContext> {
    const resolvedBase = await resolveManagedWorktreeBase({
      sourcePath: path,
      baseRef,
      config: this.config,
    });
    this.reconcileMissingManagedSessions();

    if (!forceNew) {
      if (alias) {
        const residentByAlias = Array.from(this.workspaces.values()).find(
          (workspace) =>
            workspace.connectionPrincipalId === connectionPrincipalId &&
            workspace.alias === alias,
        );
        if (residentByAlias) {
          if (
            residentByAlias.worktree?.managed &&
            residentByAlias.sourceRoot === resolvedBase.sourceRoot
          ) {
            return this.contextForWorkspace(residentByAlias, true);
          }
          throw new WorkspaceAliasConflictError(alias);
        }
        const persistedByAlias = this.store?.getActiveSessionByAlias?.(
          connectionPrincipalId,
          alias,
        );
        if (persistedByAlias) {
          if (
            persistedByAlias.managed &&
            persistedByAlias.mode === "worktree" &&
            persistedByAlias.sourceRoot === resolvedBase.sourceRoot
          ) {
            return this.reuseManagedSession(persistedByAlias, alias);
          }
          throw new WorkspaceAliasConflictError(alias);
        }
      }

      const resident = Array.from(this.workspaces.values()).find(
        (workspace) => workspace.connectionPrincipalId === connectionPrincipalId &&
          workspace.worktree?.managed &&
          workspace.sourceRoot === resolvedBase.sourceRoot &&
          workspace.worktree.baseSha === resolvedBase.baseSha,
      );
      if (resident) {
        if (alias && resident.alias !== alias) {
          throw new WorkspaceAliasConflictError(resident.alias);
        }
        return this.contextForWorkspace(resident, true);
      }

      const persisted = this.store?.findActiveManagedSession?.(
        connectionPrincipalId,
        resolvedBase.sourceRoot,
        resolvedBase.baseSha,
      );
      if (persisted) return this.reuseManagedSession(persisted, alias);

      if (baseRef === undefined) {
        const candidates = this.activeManagedSessionsForSource(
          connectionPrincipalId,
          resolvedBase.sourceRoot,
        );
        if (candidates.length === 1) {
          return this.reuseManagedSession(candidates[0]!, alias);
        }
        if (candidates.length > 1) {
          throw new WorkspaceSelectionRequiredError(
            candidates.flatMap((session) => session.alias ? [session.alias] : []),
          );
        }
      }
    }

    const managedKey = managedWorkspaceKey(
      connectionPrincipalId,
      resolvedBase.sourceRoot,
      resolvedBase.baseSha,
    );
    if (!forceNew) {
      const pending = this.pendingManagedWorkspaces.get(managedKey);
      if (pending) {
        return pending.then((context) => {
          if (alias && context.workspace.alias !== alias) {
            throw new WorkspaceAliasConflictError(context.workspace.alias);
          }
          return { ...context, reused: true };
        });
      }
    }

    const opening = this.createManagedWorkspaceContext(
      connectionPrincipalId,
      path,
      alias,
      forceNew,
      resolvedBase,
    );
    if (!forceNew) this.pendingManagedWorkspaces.set(managedKey, opening);
    try {
      return await opening;
    } finally {
      if (!forceNew) this.pendingManagedWorkspaces.delete(managedKey);
    }
  }

  private async createManagedWorkspaceContext(
    connectionPrincipalId: string,
    path: string,
    alias: string | undefined,
    forceNew: boolean,
    resolvedBase: Awaited<ReturnType<typeof resolveManagedWorktreeBase>>,
  ): Promise<WorkspaceContext> {
    const retainedManagedWorktrees = this.store?.countManagedWorktrees()
      ?? Array.from(this.workspaces.values()).filter((workspace) => workspace.worktree?.managed).length;
    if (retainedManagedWorktrees + this.pendingManagedWorktreeCreations >= this.config.resources.maxManagedWorktrees) {
      throw new WorkspaceQuotaError(
        "managed_worktree_quota",
        `Managed worktree limit reached (${this.config.resources.maxManagedWorktrees}). Close an unused managed workspace before opening another.`,
      );
    }
    this.pendingManagedWorktreeCreations += 1;
    try {
      const worktree = await createManagedWorktree({
        sourcePath: path,
        config: this.config,
        resolvedBase,
      });
      try {
        return await this.createWorkspaceContext({
          connectionPrincipalId,
          alias,
          root: worktree.path,
          mode: "worktree",
          writeAccess: "read_write",
          sourceRoot: worktree.sourceRoot,
          worktree,
          forceNew,
        });
      } catch (error) {
        try {
          const cleanup = await removeManagedWorktree({
            sourceRoot: worktree.sourceRoot,
            worktreePath: worktree.path,
            config: {
              ...this.config,
              allowedRoots: [...this.config.allowedRoots, worktree.sourceRoot],
            },
          });
          if (!cleanup.removed && cleanup.reason !== "missing") {
            throw new Error(`Created worktree could not be rolled back (${cleanup.reason}).`);
          }
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Workspace creation failed and worktree rollback failed");
        }
        if (error instanceof ExistingManagedWorkspaceError) {
          return this.reuseManagedSession(error.session, alias);
        }
        throw error;
      }
    } finally {
      this.pendingManagedWorktreeCreations -= 1;
    }
  }

  private async createWorkspaceContext(input: {
    connectionPrincipalId: string;
    alias?: string;
    root: string;
    canonicalRoot?: string;
    mode: WorkspaceMode;
    writeAccess: WorkspaceWriteAccess;
    replaceWriteAccess?: boolean;
    sourceRoot?: string;
    worktree?: WorkspaceWorktree;
    forceNew?: boolean;
  }): Promise<WorkspaceContext> {
    const checkoutKey = input.canonicalRoot
      ? checkoutWorkspaceKey(input.connectionPrincipalId, input.canonicalRoot)
      : undefined;
    const indexedCheckoutId = checkoutKey
      ? this.checkoutWorkspaceIds.get(checkoutKey)
      : undefined;
    const residentCheckoutId = indexedCheckoutId && this.workspaces.has(indexedCheckoutId)
      ? indexedCheckoutId
      : undefined;
    if (residentCheckoutId && this.lifecycleStates.get(residentCheckoutId)?.phase === "closing") {
      throw new Error(`Workspace ${residentCheckoutId} is closing and cannot be reopened yet.`);
    }
    const workspace: Workspace = {
      id: residentCheckoutId ?? `ws_${randomUUID()}`,
      connectionPrincipalId: input.connectionPrincipalId,
      alias: input.alias ?? this.defaultWorkspaceAlias(
        input.connectionPrincipalId,
        input.sourceRoot ?? input.canonicalRoot ?? input.root,
      ),
      root: input.root,
      mode: input.mode,
      writeAccess: input.writeAccess,
      stateGeneration: 1,
      sourceRoot: input.sourceRoot,
      worktree: input.worktree,
      ...this.loadSkillsForWorkspace(input.root),
      agentProfiles: await loadLocalAgentProfiles(this.config, input.root),
      activatedSkillDirs: new Set(),
      instructionContexts: new Map(),
      lastUsedAt: Date.now(),
    };
    let reused = Boolean(residentCheckoutId);

    const agentsFiles = await this.loadInitialAgentsFiles(workspace.root);
    workspace.root = this.assertWorkspaceRootAllowed(
      workspace.root,
      workspace.mode,
      workspace.sourceRoot,
    );
    const availableAgentsFiles: AvailableAgentsFile[] = [];
    const instructionScan = lazyInstructionScan();
    if (input.mode === "checkout" && input.canonicalRoot && this.store?.createOrReuseCheckoutSession) {
      const session = this.store.createOrReuseCheckoutSession({
        id: workspace.id,
        connectionPrincipalId: workspace.connectionPrincipalId,
        alias: workspace.alias,
        root: workspace.root,
        canonicalRoot: input.canonicalRoot,
        writeAccess: workspace.writeAccess,
        replaceWriteAccess: input.replaceWriteAccess,
        requestedAlias: input.alias ?? null,
        stateGeneration: workspace.stateGeneration,
        maxActiveSessionsPerClient: this.config.resources.maxActiveWorkspacesPerClient,
      });
      if (this.lifecycleStates.get(session.id)?.phase === "closing") {
        throw new Error(`Workspace ${session.id} is closing and cannot be reopened yet.`);
      }
      reused = session.id !== workspace.id;
      if (input.alias && session.alias !== input.alias) {
        throw new WorkspaceAliasConflictError(session.alias ?? "the existing alias");
      }
      const resident = this.workspaces.get(session.id);
      if (resident?.connectionPrincipalId === session.connectionPrincipalId) {
        resident.root = session.root;
        resident.writeAccess = session.writeAccess ?? resident.writeAccess;
        resident.stateGeneration = session.stateGeneration ?? resident.stateGeneration;
        return this.contextForWorkspace(resident, true);
      }
      workspace.id = session.id;
      workspace.alias = session.alias ?? this.store.allocateSessionAlias?.(
        session.id,
        session.connectionPrincipalId,
        workspace.alias,
      ) ?? workspace.alias;
      workspace.root = session.root;
      workspace.writeAccess = session.writeAccess ?? workspace.writeAccess;
      workspace.stateGeneration = session.stateGeneration ?? workspace.stateGeneration;
      if (reused && !this.workspaces.has(session.id)) {
        workspace.stateGeneration = this.store.bumpStateGeneration?.(
          session.id,
          session.connectionPrincipalId,
        ) ?? workspace.stateGeneration + 1;
      }
    } else if (residentCheckoutId) {
      const resident = this.workspaces.get(residentCheckoutId)!;
      if (input.alias && resident.alias !== input.alias) {
        throw new WorkspaceAliasConflictError(resident.alias);
      }
      if (input.replaceWriteAccess && resident.writeAccess !== input.writeAccess) {
        resident.writeAccess = input.writeAccess;
        resident.stateGeneration += 1;
      }
      return this.contextForWorkspace(resident, true);
    } else if (workspace.mode === "worktree" && workspace.worktree && this.store?.createOrReuseManagedSession) {
      const session = this.store.createOrReuseManagedSession({
        id: workspace.id,
        connectionPrincipalId: workspace.connectionPrincipalId,
        alias: workspace.alias,
        root: workspace.root,
        sourceRoot: workspace.sourceRoot!,
        baseRef: workspace.worktree.baseRef,
        baseSha: workspace.worktree.baseSha,
        dirtySource: workspace.worktree.dirtySource,
        forceNew: input.forceNew,
        stateGeneration: workspace.stateGeneration,
        maxActiveSessionsPerClient: this.config.resources.maxActiveWorkspacesPerClient,
      });
      if (session.id !== workspace.id) throw new ExistingManagedWorkspaceError(session);
      workspace.alias = session.alias ?? workspace.alias;
    } else {
      this.store?.createSession({
        id: workspace.id,
        connectionPrincipalId: workspace.connectionPrincipalId,
        alias: workspace.alias,
        root: workspace.root,
        mode: workspace.mode,
        sourceRoot: workspace.sourceRoot,
        baseRef: workspace.worktree?.baseRef,
        baseSha: workspace.worktree?.baseSha,
        dirtySource: workspace.worktree?.dirtySource,
        managed: workspace.worktree?.managed,
        writeAccess: workspace.writeAccess,
        stateGeneration: workspace.stateGeneration,
        maxActiveSessionsPerClient: this.config.resources.maxActiveWorkspacesPerClient,
      });
    }
    if (checkoutKey) this.checkoutWorkspaceIds.set(checkoutKey, workspace.id);
    this.workspaces.set(workspace.id, workspace);
    this.ensureLifecycleState(workspace);
    this.evictResidentWorkspaces();

    return {
      workspace,
      agentsFiles,
      instructionRevision: computeInstructionRevision(agentsFiles),
      skillRevision: computeSkillRevision(realpathSync(workspace.root), workspace.skills),
      availableAgentsFiles,
      instructionScan,
      reused,
    };
  }

  private async hydrateWorkspaceSession(session: WorkspaceSession): Promise<WorkspaceContext> {
    this.store?.touchSession(session.id, session.connectionPrincipalId);
    const storedSession = this.store?.getSession(session.id, session.connectionPrincipalId);
    if (this.store && !storedSession) throw new UnknownWorkspaceAliasError();
    session = storedSession ?? session;
    const lifecycle = this.lifecycleStates.get(session.id) ?? {
      connectionPrincipalId: session.connectionPrincipalId,
      phase: "open" as const,
      activeOperations: 0,
    };
    if (
      lifecycle.connectionPrincipalId !== session.connectionPrincipalId ||
      lifecycle.phase === "closing"
    ) {
      throw new UnknownWorkspaceAliasError();
    }
    this.lifecycleStates.set(session.id, lifecycle);
    lifecycle.activeOperations += 1;
    let published = false;
    try {
      const alias = session.alias
        ?? this.store?.allocateSessionAlias?.(
          session.id,
          session.connectionPrincipalId,
          this.defaultWorkspaceAlias(
            session.connectionPrincipalId,
            session.sourceRoot ?? session.root,
          ),
        )
        ?? `ws-${randomUUID()}`;
      let recovery: WorkspaceContext["recovery"];
      let recoveredWorktree: WorkspaceWorktree | undefined;
      if (session.mode === "worktree" && session.managed) {
        try {
          const metadata = await stat(session.root);
          if (!metadata.isDirectory()) {
            throw new WorkspaceRecoveryRequiredError(alias, "the saved worktree path is not a directory");
          }
        } catch (error) {
          if (error instanceof WorkspaceRecoveryRequiredError) throw error;
          if (!isMissingPathError(error)) {
            throw new WorkspaceRecoveryRequiredError(alias, "the saved worktree path is not accessible");
          }
          if (!session.sourceRoot || !session.baseSha) {
            throw new WorkspaceRecoveryRequiredError(alias, "the saved source repository metadata is incomplete");
          }
          try {
            recoveredWorktree = await restoreManagedWorktree({
              sourceRoot: session.sourceRoot,
              worktreePath: session.root,
              baseRef: session.baseRef ?? "HEAD",
              baseSha: session.baseSha,
              dirtySource: session.dirtySource,
              config: this.config,
            });
            this.store?.updateManagedSessionBaseSha?.(
              session.id,
              session.connectionPrincipalId,
              recoveredWorktree.baseSha,
            );
            recovery = {
              kind: "managed_worktree_recreated",
              dataLossPossible: true,
            };
          } catch {
            throw new WorkspaceRecoveryRequiredError(
              alias,
              "the source repository or saved base commit is unavailable",
            );
          }
        }
      }
      let root: string;
      try {
        root = this.assertWorkspaceRootAllowed(session.root, session.mode, session.sourceRoot);
      } catch {
        if (session.mode === "worktree" && session.managed) {
          throw new WorkspaceRecoveryRequiredError(
            alias,
            "the source repository is no longer approved or accessible",
          );
        }
        this.invalidateWorkspace(session.id, session.connectionPrincipalId, session.root);
        throw new UnknownWorkspaceAliasError();
      }
      const bumpedGeneration = this.store?.bumpStateGeneration?.(
        session.id,
        session.connectionPrincipalId,
      );
      if (this.store?.bumpStateGeneration && bumpedGeneration === undefined) {
        throw new UnknownWorkspaceAliasError();
      }
      const stateGeneration = bumpedGeneration ?? (session.stateGeneration ?? 1) + 1;
      const workspace: Workspace = {
        id: session.id,
        connectionPrincipalId: session.connectionPrincipalId,
        alias,
        root,
        mode: session.mode,
        writeAccess: session.writeAccess ?? "read_write",
        stateGeneration,
        sourceRoot: session.sourceRoot,
        worktree: session.mode === "worktree"
          ? recoveredWorktree ?? {
              path: root,
              baseRef: session.baseRef ?? "HEAD",
              baseSha: session.baseSha ?? "",
              dirtySource: session.dirtySource,
              detached: true,
              managed: session.managed,
            }
          : undefined,
        ...this.loadSkillsForWorkspace(root),
        agentProfiles: await loadLocalAgentProfiles(this.config, root),
        activatedSkillDirs: new Set(),
        instructionContexts: new Map(),
        lastUsedAt: Date.now(),
      };
      const context = await this.contextForWorkspace(workspace, true);
      const activeSession = this.store?.getSession(
        workspace.id,
        workspace.connectionPrincipalId,
      );
      if (this.store && !activeSession) throw new UnknownWorkspaceAliasError();
      if (activeSession) {
        workspace.writeAccess = activeSession.writeAccess ?? workspace.writeAccess;
        workspace.stateGeneration = activeSession.stateGeneration ?? workspace.stateGeneration;
      }
      this.workspaces.set(workspace.id, workspace);
      if (workspace.mode === "checkout") {
        this.checkoutWorkspaceIds.set(
          checkoutWorkspaceKey(
            workspace.connectionPrincipalId,
            realpathSync(workspace.root),
          ),
          workspace.id,
        );
      }
      this.ensureLifecycleState(workspace);
      published = true;
      this.evictResidentWorkspaces();
      return recovery ? { ...context, recovery } : context;
    } finally {
      lifecycle.activeOperations -= 1;
      if (lifecycle.activeOperations === 0) lifecycle.resolveDrained?.();
      if (!published && lifecycle.activeOperations === 0 && this.lifecycleStates.get(session.id) === lifecycle) {
        this.lifecycleStates.delete(session.id);
      }
      this.evictResidentWorkspaces();
    }
  }

  private async reuseManagedSession(
    originalSession: WorkspaceSession,
    alias: string | undefined,
  ): Promise<WorkspaceContext> {
    const session = originalSession.alias
      ? originalSession
      : {
          ...originalSession,
          alias: this.store?.allocateSessionAlias?.(
            originalSession.id,
            originalSession.connectionPrincipalId,
            this.defaultWorkspaceAlias(
              originalSession.connectionPrincipalId,
              originalSession.sourceRoot ?? originalSession.root,
            ),
          ),
        };
    if (alias && session.alias !== alias) {
      throw new WorkspaceAliasConflictError(session.alias ?? "the existing alias");
    }
    const resident = this.workspaces.get(session.id);
    if (resident?.connectionPrincipalId === session.connectionPrincipalId) {
      return this.contextForWorkspace(resident, true);
    }
    return this.hydrateWorkspaceSession(session);
  }

  private activeManagedSessionsForSource(
    connectionPrincipalId: string,
    sourceRoot: string,
  ): WorkspaceSession[] {
    const sessions = (this.store?.findActiveManagedSessionsBySource?.(
      connectionPrincipalId,
      sourceRoot,
    ) ?? []).map((session) => session.alias ? session : {
      ...session,
      alias: this.store?.allocateSessionAlias?.(
        session.id,
        connectionPrincipalId,
        this.defaultWorkspaceAlias(connectionPrincipalId, sourceRoot),
      ),
    });
    const byId = new Map(sessions.map((session) => [session.id, session]));
    for (const workspace of this.workspaces.values()) {
      if (
        workspace.connectionPrincipalId !== connectionPrincipalId ||
        workspace.sourceRoot !== sourceRoot ||
        !workspace.worktree?.managed
      ) continue;
      byId.set(workspace.id, workspaceToSessionSnapshot(workspace));
    }
    return [...byId.values()].sort(
      (left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt),
    );
  }

  private defaultWorkspaceAlias(
    connectionPrincipalId: string,
    path: string,
  ): string {
    const normalized = basename(resolve(path))
      .replace(/[^A-Za-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 48) || "project";
    const occupied = new Set<string>();
    for (const session of this.store?.listActiveSessions?.() ?? []) {
      if (session.connectionPrincipalId === connectionPrincipalId && session.alias) {
        occupied.add(session.alias);
      }
    }
    for (const workspace of this.workspaces.values()) {
      if (workspace.connectionPrincipalId === connectionPrincipalId) {
        occupied.add(workspace.alias);
      }
    }
    if (!occupied.has(normalized)) return normalized;
    for (let suffix = 2; suffix <= 999; suffix += 1) {
      const candidate = `${normalized.slice(0, 59 - String(suffix).length)}-${suffix}`;
      if (!occupied.has(candidate)) return candidate;
    }
    return `project-${randomUUID().slice(0, 8)}`;
  }

  private async contextForWorkspace(workspace: Workspace, reused: boolean): Promise<WorkspaceContext> {
    const refreshedSkills = this.loadSkillsForWorkspace(workspace.root);
    const retainedActivatedSkillDirs = retainActivatedSkillDirs(
      workspace.skills,
      refreshedSkills.skills,
      workspace.activatedSkillDirs,
    );
    workspace.lastUsedAt = Date.now();
    this.store?.touchSession(workspace.id, workspace.connectionPrincipalId);
    const refreshedAgentProfiles = await loadLocalAgentProfiles(this.config, workspace.root);
    workspace.skills = refreshedSkills.skills;
    workspace.skillDiagnostics = refreshedSkills.skillDiagnostics;
    workspace.agentProfiles = refreshedAgentProfiles;
    workspace.activatedSkillDirs = retainedActivatedSkillDirs;
    const agentsFiles = await this.loadInitialAgentsFiles(workspace.root);
    return {
      workspace,
      agentsFiles,
      instructionRevision: computeInstructionRevision(agentsFiles),
      skillRevision: computeSkillRevision(realpathSync(workspace.root), workspace.skills),
      availableAgentsFiles: [],
      instructionScan: lazyInstructionScan(),
      reused,
    };
  }

  private loadSkillsForWorkspace(root: string): Pick<Workspace, "skills" | "skillDiagnostics"> {
    const result = loadWorkspaceSkills(this.config, root);
    return {
      skills: result.skills,
      skillDiagnostics: result.diagnostics,
    };
  }

  private assertWorkspaceRootAllowed(root: string, mode: WorkspaceMode, sourceRoot: string | undefined): string {
    const canonicalAllowedRoots = this.config.allowedRoots
      .map(tryRealpathSync)
      .filter((path): path is string => Boolean(path));
    if (mode === "worktree") {
      if (!sourceRoot) {
        throw new Error(`Stored worktree workspace is missing sourceRoot: ${root}`);
      }
      assertAllowedPath(realpathSync(sourceRoot), canonicalAllowedRoots);
      assertAllowedPath(realpathSync(root), [realpathSync(this.config.worktreeRoot)]);
      return assertAllowedPath(root, [this.config.worktreeRoot]);
    }

    return assertAllowedPath(realpathSync(root), canonicalAllowedRoots);
  }

  private workspaceRootAllowed(root: string, mode: WorkspaceMode, sourceRoot: string | undefined): boolean {
    try {
      this.assertWorkspaceRootAllowed(root, mode, sourceRoot);
      return true;
    } catch {
      return false;
    }
  }

  private reconcileMissingManagedSessions(): void {
    const sessions = this.store?.listActiveSessions?.()
      ?? Array.from(this.workspaces.values()).map((workspace): WorkspaceSession => ({
        id: workspace.id,
        connectionPrincipalId: workspace.connectionPrincipalId,
        alias: workspace.alias,
        root: workspace.root,
        status: "active",
        mode: workspace.mode,
        sourceRoot: workspace.sourceRoot,
        baseRef: workspace.worktree?.baseRef,
        baseSha: workspace.worktree?.baseSha,
        dirtySource: workspace.worktree?.dirtySource ?? false,
        managed: workspace.worktree?.managed ?? false,
        writeAccess: workspace.writeAccess,
        stateGeneration: workspace.stateGeneration,
        createdAt: new Date(workspace.lastUsedAt).toISOString(),
        lastUsedAt: new Date(workspace.lastUsedAt).toISOString(),
      }));
    for (const session of sessions) {
      if (!session.managed || this.workspaceRootAllowed(session.root, session.mode, session.sourceRoot)) continue;
      const lifecycle = this.lifecycleStates.get(session.id);
      if (lifecycle && (lifecycle.phase === "closing" || lifecycle.activeOperations > 0)) continue;
      // Keep managed sessions discoverable by alias. A missing path can often
      // be recreated from the persisted source root and base SHA during resume.
      this.evictWorkspace(session.id, session.root);
    }
  }

  private invalidateWorkspace(
    workspaceId: string,
    connectionPrincipalId: string,
    root: string,
  ): void {
    this.store?.closeSession(workspaceId, connectionPrincipalId);
    this.evictWorkspace(workspaceId, root);
  }

  private evictWorkspace(workspaceId: string, root: string): void {
    this.workspaces.delete(workspaceId);
    this.lifecycleStates.delete(workspaceId);
    this.removeCheckoutWorkspaceId(workspaceId);
    this.purgeInstructionCachesForUnusedRoot(root);
  }

  private async loadInitialAgentsFiles(root: string): Promise<ApplicableAgentsFile[]> {
    return this.loadInstructionChain(root, root);
  }

  private async loadUserInstructionsFile(): Promise<ApplicableAgentsFile | undefined> {
    if (!this.config.userInstructionsPath) return undefined;
    const path = await realpath(this.config.userInstructionsPath);
    if (!(await stat(path)).isFile()) {
      throw new Error(`User instructions path must be a file: ${this.config.userInstructionsPath}`);
    }
    const file = await this.readCachedInstruction(path);
    if (!hasProjectInstructionContent(file.content)) return undefined;
    return { path, content: file.content, fingerprint: file.fingerprint };
  }

  private async loadInstructionChain(root: string, targetDirectory: string): Promise<ApplicableAgentsFile[]> {
    const loadedFiles: ApplicableAgentsFile[] = [];
    let loadedBytes = 0;
    const userFile = await this.loadUserInstructionsFile();
    if (userFile) {
      const fileBytes = Buffer.byteLength(userFile.content, "utf8");
      assertInstructionFitsBudget(userFile.path, loadedBytes, fileBytes, "instruction chain");
      loadedFiles.push(userFile);
      loadedBytes += fileBytes;
    }

    for (const directory of ancestorDirectories(root, targetDirectory)) {
      const file = await this.instructionFileForDirectory(root, directory);
      if (!file) continue;
      const fileBytes = Buffer.byteLength(file.content, "utf8");
      assertInstructionFitsBudget(file.path, loadedBytes, fileBytes, "instruction chain");
      loadedFiles.push(file);
      loadedBytes += fileBytes;
    }
    return loadedFiles;
  }

  private async assertCurrentInstructionChainsWithinBudget(
    workspace: Workspace,
    files: Array<{ path: string }>,
  ): Promise<void> {
    const targets = new Set<string>();
    for (const file of files) {
      targets.add(isPathInsideRoot(file.path, workspace.root) ? dirname(file.path) : workspace.root);
    }
    for (const target of [...targets].sort()) {
      await this.loadInstructionChain(workspace.root, target);
    }
  }

  private async instructionFileForDirectory(root: string, directory: string): Promise<ApplicableAgentsFile | undefined> {
    const resolvedRoot = await realpath(root);
    const resolvedDirectory = await realpath(directory);
    if (!isPathInsideRoot(resolvedDirectory, resolvedRoot)) return undefined;
    const directoryStats = await stat(resolvedDirectory);
    const fingerprintParts = [statsFingerprint(directoryStats)];

    const discoveredFiles: string[] = [];
    for (const name of projectInstructionFilenames(this.config.projectDocFallbackFilenames)) {
      const candidate = join(resolvedDirectory, name);
      try {
        const candidateStats = await lstat(candidate);
        if (!candidateStats.isFile()) continue;
        const resolvedPath = await realpath(candidate);
        if (!isPathInsideRoot(resolvedPath, resolvedRoot)) continue;
        const file = await this.readCachedInstruction(resolvedPath);
        fingerprintParts.push(`${name}:${resolvedPath}:${file.fingerprint}`);
        if (!hasProjectInstructionContent(file.content)) continue;
        discoveredFiles.push(resolvedPath);
        break;
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
    }
    const files = discoveredFiles;
    const fingerprint = fingerprintParts.join("\0");
    const cached = this.instructionDirectoryCache.get(resolvedDirectory);
    if (cached?.fingerprint === fingerprint) {
      refreshMapEntry(this.instructionDirectoryCache, resolvedDirectory, cached);
    } else {
      this.instructionDirectoryCache.set(resolvedDirectory, { fingerprint, files });
      this.trimInstructionCaches();
    }
    const path = files[0];
    if (!path) return undefined;
    const file = await this.readCachedInstruction(path);
    return { path, content: file.content, fingerprint: file.fingerprint };
  }

  private async readCachedInstruction(path: string): Promise<{
    fingerprint: string;
    content: string;
  }> {
    const metadata = await stat(path);
    const fingerprint = statsFingerprint(metadata);
    const cached = this.instructionFileCache.get(path);
    if (cached?.fingerprint === fingerprint) {
      refreshMapEntry(this.instructionFileCache, path, cached);
      return cached;
    }
    let content: string;
    if (metadata.size > MAX_PROJECT_INSTRUCTION_BYTES) {
      if (metadata.size > MAX_EMPTY_INSTRUCTION_SCAN_BYTES) {
        assertInstructionFitsBudget(path, 0, metadata.size, "instruction file");
      }
      const oversizedCandidate = await readFile(path, "utf8");
      if (hasProjectInstructionContent(oversizedCandidate)) {
        assertInstructionFitsBudget(path, 0, metadata.size, "instruction file");
      }
      content = "";
    } else {
      content = await readFile(path, "utf8");
    }
    const entry = { fingerprint, content };
    this.instructionFileCache.set(path, entry);
    this.trimInstructionCaches();
    return entry;
  }

  private evictResidentWorkspaces(): void {
    while (this.workspaces.size > this.config.resources.maxResidentWorkspaces) {
      let oldest: Workspace | undefined;
      for (const workspace of this.workspaces.values()) {
        const lifecycle = this.lifecycleStates.get(workspace.id);
        if (lifecycle && (lifecycle.phase === "closing" || lifecycle.activeOperations > 0)) continue;
        if (!oldest || workspace.lastUsedAt < oldest.lastUsedAt) oldest = workspace;
      }
      if (!oldest) return;
      this.workspaces.delete(oldest.id);
      this.lifecycleStates.delete(oldest.id);
    }
  }

  private removeCheckoutWorkspaceId(workspaceId: string): void {
    for (const [key, indexedWorkspaceId] of this.checkoutWorkspaceIds) {
      if (indexedWorkspaceId === workspaceId) this.checkoutWorkspaceIds.delete(key);
    }
  }

  private ensureLifecycleState(workspace: Workspace): WorkspaceLifecycleState {
    const existing = this.lifecycleStates.get(workspace.id);
    if (existing) return existing;
    const state: WorkspaceLifecycleState = {
      connectionPrincipalId: workspace.connectionPrincipalId,
      phase: "open",
      activeOperations: 0,
    };
    this.lifecycleStates.set(workspace.id, state);
    return state;
  }

  private trimInstructionCaches(): void {
    const residentLimit = Math.max(64, this.config.resources.maxResidentWorkspaces * 8);
    trimMap(this.instructionDirectoryCache, residentLimit);
    trimMap(this.instructionFileCache, residentLimit);
  }

  private purgeInstructionCachesForUnusedRoot(root: string): void {
    if (Array.from(this.workspaces.values()).some((workspace) => workspace.root === root)) return;
    for (const path of this.instructionDirectoryCache.keys()) {
      if (isPathInsideRoot(path, root)) this.instructionDirectoryCache.delete(path);
    }
    for (const path of this.instructionFileCache.keys()) {
      if (isPathInsideRoot(path, root)) this.instructionFileCache.delete(path);
    }
  }
}

function checkoutWorkspaceKey(
  connectionPrincipalId: string,
  canonicalRoot: string,
): string {
  return JSON.stringify([connectionPrincipalId, canonicalRoot]);
}

export async function ensureCheckoutWorkspaceRoot(
  path: string,
  ops: DirectoryOps = { stat, mkdir },
): Promise<PathStats> {
  try {
    return await ops.stat(path);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  await ops.mkdir(path, { recursive: true });
  return await ops.stat(path);
}

export function formatAgentsPath(path: string, workspaceRoot: string | undefined): string {
  if (!workspaceRoot) return path.split(sep).join("/");

  const relationship = relative(workspaceRoot, path);
  if (
    relationship === "" ||
    relationship.startsWith("..") ||
    relationship === ".." ||
    relationship.includes(`..${sep}`)
  ) {
    return path.split(sep).join("/");
  }

  return relationship.split(sep).join("/");
}

async function tryRealpath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

function tryRealpathSync(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function normalizeAllowedRoots(roots: string[], previouslyAllowedRoots: string[]): string[] {
  if (roots.length === 0) throw new Error("At least one allowed root is required.");
  const previous = new Set(previouslyAllowedRoots.map((root) => resolve(root)));
  const normalized = Array.from(new Set(roots.map((root) => {
    const absolute = resolve(root);
    let canonical: string;
    try {
      canonical = realpathSync(absolute);
    } catch (error) {
      // A configured root may disappear between startup and a later unrelated
      // root edit. Preserve that already-granted lexical path, but never accept
      // a newly added path that cannot be canonicalized.
      if (isMissingPathError(error) && previous.has(absolute)) return absolute;
      throw error;
    }
    if (!statSync(canonical).isDirectory()) {
      throw new Error(`Allowed root must be a directory: ${root}`);
    }
    if (dirname(canonical) === canonical) {
      throw new Error("The filesystem root cannot be allowed.");
    }
    return canonical;
  })));
  if (normalized.length === 0) throw new Error("At least one allowed root is required.");
  return normalized;
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateWorkspaceAlias(alias: string): string {
  const normalized = alias.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(normalized)) {
    throw new Error("Workspace alias must be 1-64 letters, digits, dots, underscores, or hyphens.");
  }
  return normalized;
}

function validateInstructionContextSessionId(contextSessionId: string): string {
  if (!/^wctxs_[A-Za-z0-9-]{1,128}$/u.test(contextSessionId)) {
    throw new WorkspaceContextSessionError();
  }
  return contextSessionId;
}

function formatWorkspaceDisplayPath(path: string | undefined): string {
  if (!path) return "workspace";
  const resolvedPath = resolve(path);
  return `…/${basename(resolvedPath)}`;
}

function workspaceIdentity(workspaceId: string, connectionPrincipalId: string): string {
  return `${connectionPrincipalId}\0${workspaceId}`;
}

function managedWorkspaceKey(
  connectionPrincipalId: string,
  sourceRoot: string,
  baseSha: string,
): string {
  return `${connectionPrincipalId}\0${sourceRoot}\0${baseSha}`;
}

function lazyInstructionScan(): InstructionScanResult {
  return {
    complete: true,
    lazy: true,
    directoriesScanned: 0,
    entriesScanned: 0,
    filesFound: 0,
    unreadableDirectories: 0,
    durationMs: 0,
  };
}

async function canonicalInstructionDirectory(path: string, root: string): Promise<string> {
  let candidate = path;
  while (isPathInsideRoot(candidate, root)) {
    try {
      const metadata = await stat(candidate);
      const directory = metadata.isDirectory() ? candidate : dirname(candidate);
      const canonicalDirectory = await realpath(directory);
      const canonicalRoot = await realpath(root);
      return assertAllowedPath(canonicalDirectory, [canonicalRoot]);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }
  return root;
}

function ancestorDirectories(root: string, target: string): string[] {
  const relationship = relative(root, target);
  if (relationship === "") return [root];
  const parts = relationship.split(sep).filter(Boolean);
  const directories = [root];
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    directories.push(current);
  }
  return directories;
}

function statsFingerprint(metadata: Stats): string {
  return `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
}

function computeInstructionRevision(files: LoadedAgentsFile[]): string {
  const hash = createHash("sha256");
  hash.update("devspace-instructions-v1\0", "utf8");
  for (const file of files) {
    const path = Buffer.from(file.path, "utf8");
    const content = Buffer.from(file.content, "utf8");
    hash.update(`${path.byteLength}:`, "utf8");
    hash.update(path);
    hash.update(`${content.byteLength}:`, "utf8");
    hash.update(content);
  }
  return `sha256-v1:${hash.digest("base64url")}`;
}

function retainActivatedSkillDirs(
  previousSkills: readonly Skill[],
  refreshedSkills: readonly Skill[],
  activatedSkillDirs: ReadonlySet<string>,
): Set<string> {
  const previousById = new Map(previousSkills.map((skill) => [skill.skillId, skill]));
  const retained = new Set<string>();
  for (const refreshed of refreshedSkills) {
    const previous = previousById.get(refreshed.skillId);
    if (!previous || !activatedSkillDirs.has(resolve(previous.baseDir))) continue;
    if (previous.manifestHash !== refreshed.manifestHash) continue;
    if (previous.openAiMetadataHash !== refreshed.openAiMetadataHash) continue;
    retained.add(resolve(refreshed.baseDir));
  }
  return retained;
}

function workspaceToSessionSnapshot(workspace: Workspace): WorkspaceSession {
  const lastUsedAt = new Date(workspace.lastUsedAt).toISOString();
  return {
    id: workspace.id,
    connectionPrincipalId: workspace.connectionPrincipalId,
    alias: workspace.alias,
    root: workspace.root,
    status: "active",
    mode: workspace.mode,
    sourceRoot: workspace.sourceRoot,
    baseRef: workspace.worktree?.baseRef,
    baseSha: workspace.worktree?.baseSha,
    dirtySource: workspace.worktree?.dirtySource ?? false,
    managed: workspace.worktree?.managed ?? false,
    writeAccess: workspace.writeAccess,
    stateGeneration: workspace.stateGeneration,
    createdAt: lastUsedAt,
    lastUsedAt,
  };
}

function computeSkillRevision(canonicalWorkspaceRoot: string, skills: readonly Skill[]): string {
  const hash = createHash("sha256");
  hash.update("devspace-skills-v1\0", "utf8");
  updateRevisionHash(hash, canonicalWorkspaceRoot);
  for (const skill of skills) {
    updateRevisionHash(hash, skill.skillId);
    updateRevisionHash(hash, skill.manifestHash);
    updateRevisionHash(hash, skill.openAiMetadataHash ?? "");
    updateRevisionHash(hash, skill.allowImplicitInvocation ? "implicit" : "explicit");
    updateRevisionHash(hash, skill.source);
    updateRevisionHash(hash, skill.scope);
    updateRevisionHash(hash, skill.sourceRoot);
  }
  return `sha256-v1:${hash.digest("base64url")}`;
}

function updateRevisionHash(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  hash.update(`${bytes.byteLength}:`, "utf8");
  hash.update(bytes);
}

function assertInstructionFitsBudget(
  path: string,
  consumedBytes: number,
  fileBytes: number,
  context: string,
): void {
  const totalBytes = consumedBytes + fileBytes;
  if (totalBytes <= MAX_PROJECT_INSTRUCTION_BYTES) return;
  throw new InstructionBudgetError(
    `Project ${context} exceeds the ${MAX_PROJECT_INSTRUCTION_BYTES}-byte UTF-8 limit: ` +
    `${path} requires ${fileBytes} bytes after ${consumedBytes} bytes of earlier instructions ` +
    `(total ${totalBytes} bytes). Empty or shorten this file before retrying.`,
  );
}

function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  trimMap(map, limit);
}

function refreshMapEntry<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
}

function trimMap<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

function isMissingPathError(error: unknown): boolean {
  return isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
