import { createHash, createHmac, randomUUID } from "node:crypto";
import { constants, realpathSync, statSync, type Stats } from "node:fs";
import type {
  ActiveWorkspaceSummary,
  WorkspaceSession,
  WorkspaceSessionCursor,
  WorkspaceStatus,
  WorkspaceStore,
  WorkspaceWriteAccess,
} from "./workspace-store.js";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { ServerConfig } from "./config.js";

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
import { pathAllowedByAuthorizationRoots } from "./authorization-roots.js";
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
  defaultWorkspaceRootLockDirectory,
  WorkspaceRootLockManager,
  type WorkspaceRootLease,
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

export interface Workspace {
  id: string;
  connectionPrincipalId: string;
  alias: string;
  root: string;
  writeAccess: WorkspaceWriteAccess;
  stateGeneration: number;
  skills: LoadedSkills["skills"];
  skillDiagnostics: LoadedSkills["diagnostics"];
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
  alias?: string;
  writeAccess?: WorkspaceWriteAccess;
}

export interface WorkspaceSummary {
  workspaceRef: string;
  alias: string;
  projectFingerprint: string;
  displayPath: string;
  status: WorkspaceStatus;
  writeAccess: WorkspaceWriteAccess;
  workspaceGeneration: number;
  hydrationStatus: "ready" | "requires_resume";
  createdAt: string;
  lastUsedAt: string;
}

export interface WorkspaceListOptions {
  statuses?: WorkspaceStatus[];
  aliasPrefix?: string;
  projectFingerprint?: string;
  recentFirst?: boolean;
}

export interface WorkspaceCloseLease {
  workspace: Workspace;
  commit(options?: { delete?: boolean; revoke?: boolean }): boolean;
  abort(): void;
}

export interface WorkspaceOperationLease {
  /**
   * Transfers the already-held physical-root lease to a longer-lived owner.
   * The returned release function is idempotent. Call at most once.
   */
  retain(): WorkspaceRootLease;
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
  readonly code = "project_runtime_conflict";

  constructor(readonly currentAlias: string) {
    super(`An equivalent Project runtime already uses internal alias ${currentAlias}.`);
    this.name = "WorkspaceAliasConflictError";
  }
}

export class WorkspaceSelectionRequiredError extends Error {
  readonly code = "project_selection_required";

  constructor(readonly aliases: string[]) {
    super("Multiple internal runtimes match this Project.");
    this.name = "WorkspaceSelectionRequiredError";
  }
}

export class WorkspaceRecoveryRequiredError extends Error {
  readonly code = "project_recovery_required";

  constructor(readonly alias: string, readonly reason: string) {
    super(`Project runtime could not be recovered: ${reason}`);
    this.name = "WorkspaceRecoveryRequiredError";
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
  readonly code = "project_execution_required";

  constructor(readonly workspaceId: string) {
    super("The Project execution runtime is no longer available.");
    this.name = "UnknownWorkspaceError";
  }
}

export class SkillNotLoadedError extends Error {
  readonly code = "skill_not_loaded";
  readonly publicText = "Call skills with the selected skillId for the Project, then retry.";

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
  readonly code = "project_execution_required";

  constructor() {
    super("The Project execution runtime must be loaded again.");
    this.name = "WorkspaceResumeRequiredError";
  }
}

export class UnknownWorkspaceAliasError extends Error {
  readonly code = "project_execution_required";

  constructor() {
    super("The Project execution runtime is unavailable.");
    this.name = "UnknownWorkspaceAliasError";
  }
}

export class WorkspaceReadOnlyError extends Error {
  readonly code = "project_read_only";

  constructor() {
    super("The selected Project is read-only.");
    this.name = "WorkspaceReadOnlyError";
  }
}

export class StaleWorkspaceGenerationError extends Error {
  readonly code = "project_execution_required";

  constructor() {
    super("The Project execution runtime is stale.");
    this.name = "StaleWorkspaceGenerationError";
  }
}

export class InstructionContextError extends Error {
  readonly code = "project_execution_required";

  constructor() {
    super("The Project execution instruction context is no longer available.");
    this.name = "InstructionContextError";
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
const MAX_INSTRUCTION_CONTEXTS_PER_WORKSPACE = 128;
const MAX_EXPIRED_SESSION_CANDIDATE_SCAN = 1_024;
const INSTRUCTION_CONTEXT_TTL_MS = 6 * 60 * 60_000;
const CLOSED_WORKSPACE_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_EMPTY_INSTRUCTION_SCAN_BYTES = 1024 * 1024;
const MAX_INSTRUCTION_DELTA_BYTES = 12 * 1024;

type InstructionIoHooks = {
  beforeDirectoryRead?: (path: string) => void | Promise<void>;
  beforeFileOpen?: (path: string) => void | Promise<void>;
};
type ServerConfigWithInstructionIoTestHooks = ServerConfig & {
  instructionIoHooksForTests?: InstructionIoHooks;
};

const READ_ONLY_NOFOLLOW_FLAGS =
  constants.O_RDONLY |
  (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
const READ_ONLY_DIRECTORY_NOFOLLOW_FLAGS =
  READ_ONLY_NOFOLLOW_FLAGS |
  (typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0);

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly checkoutWorkspaceIds = new Map<string, string>();
  private readonly pendingCheckoutWorkspaces = new Map<string, Promise<WorkspaceContext>>();
  private readonly pendingHydrations = new Map<string, Promise<WorkspaceContext>>();
  private readonly lifecycleStates = new Map<string, WorkspaceLifecycleState>();
  private readonly rootLocks: WorkspaceRootLockManager;
  private readonly instructionDirectoryCache = new Map<string, {
    fingerprint: string;
    files: string[];
  }>();
  private readonly instructionFileCache = new Map<string, {
    fingerprint: string;
    content: string;
  }>();
  private readonly pendingSessionClosures = new Map<string, WorkspaceSession>();
  private readonly instructionIoHooks: InstructionIoHooks;
  private expiredSessionScanCursor: WorkspaceSessionCursor | undefined;

  constructor(
    private readonly config: ServerConfig,
    private readonly store?: WorkspaceStore,
  ) {
    this.instructionIoHooks =
      (config as ServerConfigWithInstructionIoTestHooks).instructionIoHooksForTests ?? {};
    this.rootLocks = new WorkspaceRootLockManager({
      crossProcessLockRoot: defaultWorkspaceRootLockDirectory(config.stateDir),
      trustedStateRoot: config.stateDir,
    });
  }

  async openWorkspace(
    connectionPrincipalId: string,
    input: string | OpenWorkspaceInput,
    authorizedRoots: readonly string[] = this.config.allowedRoots,
  ): Promise<WorkspaceContext> {
    const options = typeof input === "string" ? { path: input } : input;
    if ("mode" in options) {
      throw new Error("Project mode selection is not supported; Projects always use shared directories.");
    }
    if (
      authorizationRootsRestrictGlobal(authorizedRoots, this.config.allowedRoots) &&
      !pathAllowedByAuthorizationRoots(options.path, authorizedRoots)
    ) {
      throw new AccessDeniedError("Path is outside this OAuth grant's authorized roots");
    }
    const alias = options.alias === undefined ? undefined : validateWorkspaceAlias(options.alias);
    const writeAccess = options.writeAccess ?? "read_only";

    try {
      return await this.openCheckoutWorkspace(
        connectionPrincipalId,
        options.path,
        alias,
        writeAccess,
        options.writeAccess !== undefined,
        authorizedRoots,
      );
    } catch (error) {
      if (!(error instanceof AccessDeniedError)) throw error;
      throw new AccessDeniedError(
        `${error.message}. Open the original approved project path. If this is a different project, ask the user to add its project root.`,
      );
    }
  }

  /**
   * Opens a logical Project execution against the approved shared directory.
   * The execution alias keeps process, idempotency, instruction, and audit
   * state separate without creating a branch or worktree.
   */
  async openSharedProjectExecution(
    connectionPrincipalId: string,
    input: {
      executionId: string;
      path: string;
      writeAccess: WorkspaceWriteAccess;
    },
    authorizedRoots: readonly string[] = this.config.allowedRoots,
  ): Promise<WorkspaceContext> {
    return this.openWorkspace(connectionPrincipalId, {
      path: input.path,
      alias: projectExecutionAlias(input.executionId),
      writeAccess: input.writeAccess,
    }, authorizedRoots);
  }

  /**
   * Opens a server-managed worktree while retaining authorization against the
   * original approved Project root. This method is intentionally not exposed
   * through the generic Workspace API.
   */
  async openManagedProjectExecution(
    connectionPrincipalId: string,
    input: {
      executionId: string;
      sourceRoot: string;
      worktreeRoot: string;
      writeAccess: WorkspaceWriteAccess;
    },
    authorizedRoots: readonly string[] = this.config.allowedRoots,
  ): Promise<WorkspaceContext> {
    const sourceRoot = assertAllowedPath(input.sourceRoot, this.config.allowedRoots);
    if (!pathAllowedByAuthorizationRoots(sourceRoot, authorizedRoots)) {
      throw new AccessDeniedError("Project source is outside this OAuth grant's authorized roots");
    }
    const trustedRoot = resolve(this.config.stateDir, "worktrees");
    const canonicalWorktreeRoot = await realpath(input.worktreeRoot);
    if (!isPathInsideRoot(canonicalWorktreeRoot, trustedRoot)) {
      throw new AccessDeniedError("Managed worktree is outside the trusted state root");
    }
    const rootStats = await stat(canonicalWorktreeRoot);
    if (!rootStats.isDirectory()) throw new Error("Managed worktree root must be a directory.");
    return this.createWorkspaceContext({
      connectionPrincipalId,
      alias: projectExecutionAlias(input.executionId),
      root: canonicalWorktreeRoot,
      canonicalRoot: canonicalWorktreeRoot,
      writeAccess: input.writeAccess,
      replaceWriteAccess: true,
    });
  }

  getWorkspace(
    connectionPrincipalId: string,
    workspaceId: string,
    expectedGeneration?: number,
  ): Workspace {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace?.connectionPrincipalId === connectionPrincipalId) {
      if (!this.workspaceRootAllowed(workspace.root)) {
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

  listWorkspaces(
    connectionPrincipalId: string,
    authorizedRoots: readonly string[] = this.config.allowedRoots,
    options: WorkspaceListOptions = {},
  ): WorkspaceSummary[] {
    const statuses = options.statuses?.length ? [...new Set(options.statuses)] : ["active" as const];
    const sessions = this.store?.listSessions?.(connectionPrincipalId, statuses)
      ?? Array.from(this.workspaces.values())
        .filter((workspace) =>
          workspace.connectionPrincipalId === connectionPrincipalId && statuses.includes("active")
        )
        .map(workspaceToSessionSnapshot);
    const summaries = sessions.flatMap((session): WorkspaceSummary[] => {
      const resident = this.workspaces.get(session.id);
      const available = resident
        ? this.workspaceRootAllowed(resident.root)
        : this.workspaceRootAllowed(session.root);
      const identityRoot = resident?.root ?? session.root;
      if (!pathAllowedByAuthorizationRoots(identityRoot, authorizedRoots)) return [];
      const projectFingerprint = this.projectFingerprintForRoot(identityRoot);
      if (options.aliasPrefix && !session.alias.startsWith(options.aliasPrefix)) return [];
      if (options.projectFingerprint && projectFingerprint !== options.projectFingerprint) return [];
      return [{
        workspaceRef: session.id,
        alias: session.alias,
        projectFingerprint,
        displayPath: formatWorkspaceDisplayPath(
          identityRoot,
        ),
        status: session.status,
        writeAccess: session.writeAccess,
        workspaceGeneration: session.stateGeneration,
        hydrationStatus: resident && session.status === "active"
          ? "ready"
          : "requires_resume",
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
      }];
    });
    return summaries.sort((left, right) => {
      // Pagination must not reorder when ordinary tool calls update lastUsedAt.
      // Creation time plus the immutable Workspace ID is a stable keyset.
      const ordering = left.createdAt.localeCompare(right.createdAt) ||
        left.workspaceRef.localeCompare(right.workspaceRef);
      return options.recentFirst === false ? ordering : -ordering;
    });
  }

  workspaceAuthorized(
    connectionPrincipalId: string,
    workspaceId: string,
    authorizedRoots: readonly string[],
  ): boolean {
    const resident = this.workspaces.get(workspaceId);
    if (resident?.connectionPrincipalId === connectionPrincipalId) {
      return pathAllowedByAuthorizationRoots(
        resident.root,
        authorizedRoots,
      );
    }
    const session = this.store?.getSession(workspaceId, connectionPrincipalId);
    return Boolean(
      session !== undefined && pathAllowedByAuthorizationRoots(
        session.root,
        authorizedRoots,
      ),
    );
  }

  workspaceSummary(connectionPrincipalId: string, alias: string): WorkspaceSummary {
    const normalizedAlias = validateWorkspaceAlias(alias);
    const summary = this.listWorkspaces(connectionPrincipalId)
      .find((candidate) => candidate.alias === normalizedAlias);
    if (!summary) throw new UnknownWorkspaceAliasError();
    return summary;
  }

  projectFingerprint(workspace: Workspace): string {
    return this.projectFingerprintForRoot(workspace.root);
  }

  async resumeWorkspaceByReference(
    connectionPrincipalId: string,
    workspaceRef: string,
    authorizedRoots: readonly string[] = this.config.allowedRoots,
  ): Promise<WorkspaceContext> {
    const resident = this.workspaces.get(workspaceRef);
    const alias = resident?.connectionPrincipalId === connectionPrincipalId
      ? resident.alias
      : this.store?.getSession(workspaceRef, connectionPrincipalId)?.alias;
    if (!alias) throw new UnknownWorkspaceAliasError();
    return this.resumeWorkspace(connectionPrincipalId, alias, authorizedRoots);
  }

  activeSessionsSnapshot(): WorkspaceSession[] {
    const sessions = this.store?.listActiveSessions?.()
      ?? Array.from(this.workspaces.values()).map(workspaceToSessionSnapshot);
    return sessions.map((session) => ({ ...session }));
  }

  workspaceBusy(connectionPrincipalId: string, workspaceId: string): boolean {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace?.connectionPrincipalId !== connectionPrincipalId) return false;
    const lifecycle = this.lifecycleStates.get(workspaceId);
    return Boolean(
      lifecycle &&
      (lifecycle.phase === "closing" || lifecycle.activeOperations > 0)
    );
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

  async resumeWorkspace(
    connectionPrincipalId: string,
    alias: string,
    authorizedRoots: readonly string[] = this.config.allowedRoots,
  ): Promise<WorkspaceContext> {
    const normalizedAlias = validateWorkspaceAlias(alias);
    const resident = Array.from(this.workspaces.values()).find(
      (workspace) =>
        workspace.connectionPrincipalId === connectionPrincipalId &&
        workspace.alias === normalizedAlias,
    );
    if (resident) {
      if (
        authorizationRootsRestrictGlobal(authorizedRoots, this.config.allowedRoots) &&
        !pathAllowedByAuthorizationRoots(resident.root, authorizedRoots)
      ) {
        throw new AccessDeniedError("Project is outside this OAuth grant's authorized roots");
      }
      if (this.workspaceRootAllowed(resident.root)) {
        return this.contextForWorkspace(resident, true);
      }
      const lifecycle = this.lifecycleStates.get(resident.id);
      if (lifecycle && (lifecycle.phase === "closing" || lifecycle.activeOperations > 0)) {
        throw new WorkspaceRecoveryRequiredError(
          normalizedAlias,
          "an active process or operation must finish before the Project can be reopened",
        );
      }
      this.evictWorkspace(resident.id, resident.root);
    }

    let session = this.store?.getActiveSessionByAlias?.(connectionPrincipalId, normalizedAlias);
    if (!session) {
      const retained = this.store?.getSessionByAlias?.(connectionPrincipalId, normalizedAlias);
      if (retained?.status === "closed") {
        const generation = this.store?.reactivateClosedSession?.(
          retained.id,
          connectionPrincipalId,
        );
        if (generation !== undefined) {
          session = this.store?.getSession(retained.id, connectionPrincipalId);
        }
      }
    }
    if (!session) throw new UnknownWorkspaceAliasError();
    if (
      authorizationRootsRestrictGlobal(authorizedRoots, this.config.allowedRoots) &&
      !pathAllowedByAuthorizationRoots(session.root, authorizedRoots)
    ) {
      throw new AccessDeniedError("Project is outside this OAuth grant's authorized roots");
    }
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
        alias: workspace.alias,
        root: workspace.root,
        status: "active",
        writeAccess: workspace.writeAccess,
        stateGeneration: workspace.stateGeneration,
        createdAt: new Date(workspace.lastUsedAt).toISOString(),
        lastUsedAt: new Date(workspace.lastUsedAt).toISOString(),
      }),
    );
    const revoked = sessions.filter(
      (session) => !this.workspaceRootAllowed(session.root),
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
      throw new Error(`Path is outside the selected Project: ${inputPath}`);
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
    throw new Error(`Path cannot be confined to the selected Project: ${inputPath}`);
  }

  async loadSkill(
    connectionPrincipalId: string,
    workspaceId: string,
    skillId: string,
  ): Promise<LoadedWorkspaceSkill> {
    const workspace = this.getWorkspace(connectionPrincipalId, workspaceId);
    const skill = workspace.skills.find((candidate) => candidate.skillId === skillId);
    if (!skill) {
      throw new SkillLoadError("skill_not_found", "The requested Skill is not available in this Project.");
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
    options: { instructionContextId?: string; requireAcknowledged?: boolean } = {},
  ): Promise<ApplicableAgentsFile[]> {
    const instructionContext = options.instructionContextId === undefined
      ? undefined
      : this.instructionContext(workspace, options.instructionContextId);
    if (options.requireAcknowledged && !instructionContext) {
      throw new InstructionContextError();
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
        assertInstructionFitsBudget(
          path,
          loadedBytes,
          fileBytes,
          "instruction response",
          MAX_INSTRUCTION_DELTA_BYTES,
        );
        loaded.push(file);
        loadedPaths.add(path);
        loadedBytes += fileBytes;
      }
    }
    return loaded;
  }

  createInstructionContext(
    workspace: Workspace,
    instructionContextId = `ictx_${randomUUID()}`,
  ): string {
    const id = validateInstructionContextId(instructionContextId);
    const existing = workspace.instructionContexts.get(id);
    if (existing) {
      if (
        existing.connectionPrincipalId !== workspace.connectionPrincipalId ||
        existing.workspaceId !== workspace.id ||
        existing.workspaceGeneration !== workspace.stateGeneration
      ) {
        throw new InstructionContextError();
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
    instructionContextId: string,
    files: ApplicableAgentsFile[],
  ): Promise<void> {
    const instructionContext = this.instructionContext(workspace, instructionContextId);
    let deliveredBytes = 0;
    for (const file of files) {
      const current = await this.readCachedInstruction(
        file.path,
        isPathInsideRoot(file.path, workspace.root) ? workspace.root : undefined,
      );
      if (current.fingerprint !== file.fingerprint) {
        throw new Error("Applicable project instructions changed while marking them delivered. Retry the tool.");
      }
      const fileBytes = Buffer.byteLength(file.content, "utf8");
      assertInstructionFitsBudget(
        file.path,
        deliveredBytes,
        fileBytes,
        "instruction response",
        MAX_INSTRUCTION_DELTA_BYTES,
      );
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
    instructionContextId: string,
    files: ApplicableAgentsFile[],
  ): Promise<void> {
    const instructionContext = this.instructionContext(workspace, instructionContextId);
    let acknowledgementBytes = 0;
    let changed = false;
    for (const file of files) {
      const current = await this.readCachedInstruction(
        file.path,
        isPathInsideRoot(file.path, workspace.root) ? workspace.root : undefined,
      );
      if (current.fingerprint !== file.fingerprint) {
        throw new Error("Applicable project instructions changed while acknowledging context. Retry the tool.");
      }
      const fileBytes = Buffer.byteLength(file.content, "utf8");
      assertInstructionFitsBudget(
        file.path,
        acknowledgementBytes,
        fileBytes,
        "instruction acknowledgement",
        MAX_INSTRUCTION_DELTA_BYTES,
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

  async markRootAgentsFilesAcknowledged(
    workspace: Workspace,
    instructionContextId: string,
    files: ApplicableAgentsFile[],
  ): Promise<void> {
    const instructionContext = this.instructionContext(workspace, instructionContextId);
    let changed = false;
    for (const file of files) {
      const current = await this.readCachedInstruction(
        file.path,
        isPathInsideRoot(file.path, workspace.root) ? workspace.root : undefined,
      );
      if (current.fingerprint !== file.fingerprint) {
        throw new Error("Root Project instructions changed during delivery. Restart project_control hydration.");
      }
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

  rootAgentsFilesAcknowledged(
    workspace: Workspace,
    instructionContextId: string,
    files: ApplicableAgentsFile[],
  ): boolean {
    const instructionContext = this.instructionContext(workspace, instructionContextId);
    return files.every(
      (file) =>
        instructionContext.acknowledgedInstructionVersions.get(file.path) === file.fingerprint,
    );
  }

  resetRootAgentsFilesAcknowledgement(
    workspace: Workspace,
    instructionContextId: string,
    files: ApplicableAgentsFile[],
  ): void {
    const instructionContext = this.instructionContext(workspace, instructionContextId);
    let changed = false;
    for (const file of files) {
      changed = instructionContext.deliveredInstructionVersions.delete(file.path) || changed;
      changed = instructionContext.acknowledgedInstructionVersions.delete(file.path) || changed;
    }
    if (changed) instructionContext.acknowledgementGeneration += 1;
  }

  instructionAcknowledgementGeneration(
    workspace: Workspace,
    instructionContextId: string,
  ): number {
    return this.instructionContext(workspace, instructionContextId).acknowledgementGeneration;
  }

  private instructionContext(
    workspace: Workspace,
    instructionContextId: string,
  ): WorkspaceInstructionContext {
    const id = validateInstructionContextId(instructionContextId);
    const instructionContext = workspace.instructionContexts.get(id);
    if (
      !instructionContext ||
      instructionContext.connectionPrincipalId !== workspace.connectionPrincipalId ||
      instructionContext.workspaceId !== workspace.id ||
      instructionContext.workspaceGeneration !== workspace.stateGeneration
    ) {
      throw new InstructionContextError();
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
    callback: (
      workspace: Workspace,
      operationLease: WorkspaceOperationLease,
    ) => T | Promise<T>,
    lockMode: WorkspaceRootLockMode = "read",
  ): Promise<T> {
    const initialWorkspace = this.getWorkspace(
      connectionPrincipalId,
      workspaceId,
      workspaceGeneration,
    );
    const lockKey = this.workspaceRootLockKey(initialWorkspace);
    const releaseRoot = await this.rootLocks.acquire(lockKey, lockMode, {
      workspaceGeneration,
    });
    let retained = false;
    let lifecycle: WorkspaceLifecycleState | undefined;
    try {
      const existingLifecycle = this.lifecycleStates.get(workspaceId);
      if (
        existingLifecycle?.connectionPrincipalId === connectionPrincipalId &&
        existingLifecycle.phase === "closing"
      ) {
        throw new Error("The Project execution runtime is closing and cannot accept new operations.");
      }
      // Revalidate after waiting for the root lock. A close, revoke, allowed-root
      // edit, or generation bump may have invalidated the original handle.
      const workspace = this.getWorkspace(connectionPrincipalId, workspaceId, workspaceGeneration);
      lifecycle = this.ensureLifecycleState(workspace);
      if (lifecycle.phase === "closing") {
        throw new Error("The Project execution runtime is closing and cannot accept new operations.");
      }
      lifecycle.activeOperations += 1;
      try {
        return await callback(workspace, {
          retain: () => {
            if (retained) {
              throw new Error("Project root operation lease was already retained.");
            }
            retained = true;
            return releaseRoot;
          },
        });
      } finally {
        lifecycle.activeOperations -= 1;
        if (lifecycle.activeOperations < 0) {
          throw new Error("Project operation count underflow.");
        }
        if (lifecycle.activeOperations === 0) lifecycle.resolveDrained?.();
        this.evictResidentWorkspaces();
      }
    } finally {
      if (!retained) releaseRoot();
    }
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
    }, { workspaceGeneration });
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
    deletedClosedWorkspaceSessions: number;
  } {
    for (const workspace of this.workspaces.values()) {
      for (const [instructionContextId, instructionContext] of workspace.instructionContexts) {
        if (now - instructionContext.lastUsedAt > INSTRUCTION_CONTEXT_TTL_MS) {
          workspace.instructionContexts.delete(instructionContextId);
          continue;
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
    return { deletedClosedWorkspaceSessions };
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
    if (!workspace && !this.store?.getSession(workspaceId, connectionPrincipalId)) {
      return false;
    }
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
    authorizedRoots: readonly string[],
  ): Promise<WorkspaceContext> {
    const root = assertAllowedPath(path, this.config.allowedRoots);
    const rootStats = await stat(root);
    if (!rootStats.isDirectory()) {
      throw new Error(`Project root must be a directory: ${path}`);
    }

    const canonicalRoot = await realpath(root);
    const canonicalAllowedRoots = (await Promise.all(
      this.config.allowedRoots.map((allowedRoot) => tryRealpath(allowedRoot)),
    )).filter((allowedRoot): allowedRoot is string => allowedRoot !== undefined);
    const canonicalAuthorizationRoots = (await Promise.all(
      authorizedRoots.map((allowedRoot) => tryRealpath(allowedRoot)),
    )).filter((allowedRoot): allowedRoot is string => allowedRoot !== undefined);
    const validatedRoot = assertAllowedPath(
      assertAllowedPath(canonicalRoot, canonicalAllowedRoots),
      canonicalAuthorizationRoots,
    );
    const bindingAlias = alias ?? this.defaultWorkspaceAlias(
      connectionPrincipalId,
      canonicalRoot,
    );
    const checkoutKey = checkoutWorkspaceKey(
      connectionPrincipalId,
      canonicalRoot,
      bindingAlias,
    );
    const previous = this.pendingCheckoutWorkspaces.get(checkoutKey);
    const opening = (async () => {
      if (previous) await previous.catch(() => undefined);
      return this.createWorkspaceContext({
        connectionPrincipalId,
        alias: bindingAlias,
        root: validatedRoot,
        canonicalRoot,
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

  private async createWorkspaceContext(input: {
    connectionPrincipalId: string;
    alias?: string;
    root: string;
    canonicalRoot: string;
    writeAccess: WorkspaceWriteAccess;
    replaceWriteAccess?: boolean;
  }): Promise<WorkspaceContext> {
    const workspaceAlias = input.alias ?? this.defaultWorkspaceAlias(
      input.connectionPrincipalId,
      input.canonicalRoot,
    );
    const checkoutKey = checkoutWorkspaceKey(
      input.connectionPrincipalId,
      input.canonicalRoot,
      workspaceAlias,
    );
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
      alias: workspaceAlias,
      root: input.root,
      writeAccess: input.writeAccess,
      stateGeneration: 1,
      ...this.loadSkillsForWorkspace(input.root),
      activatedSkillDirs: new Set(),
      instructionContexts: new Map(),
      lastUsedAt: Date.now(),
    };
    let reused = Boolean(residentCheckoutId);

    const agentsFiles = await this.loadInitialAgentsFiles(workspace.root);
    workspace.root = this.assertWorkspaceRootAllowed(workspace.root);
    const availableAgentsFiles: AvailableAgentsFile[] = [];
    const instructionScan = lazyInstructionScan();
    if (this.store?.createOrReuseCheckoutSession) {
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
      });
      if (this.lifecycleStates.get(session.id)?.phase === "closing") {
        throw new Error(`Workspace ${session.id} is closing and cannot be reopened yet.`);
      }
      reused = session.id !== workspace.id;
      if (input.alias && session.alias !== input.alias) {
        throw new WorkspaceAliasConflictError(session.alias);
      }
      const resident = this.workspaces.get(session.id);
      if (resident?.connectionPrincipalId === session.connectionPrincipalId) {
        resident.root = session.root;
        resident.writeAccess = session.writeAccess;
        resident.stateGeneration = session.stateGeneration;
        return this.contextForWorkspace(resident, true);
      }
      workspace.id = session.id;
      workspace.alias = session.alias;
      workspace.root = session.root;
      workspace.writeAccess = session.writeAccess;
      workspace.stateGeneration = session.stateGeneration;
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
    } else {
      this.store?.createSession({
        id: workspace.id,
        connectionPrincipalId: workspace.connectionPrincipalId,
        alias: workspace.alias,
        root: workspace.root,
        writeAccess: workspace.writeAccess,
        stateGeneration: workspace.stateGeneration,
      });
    }
    this.checkoutWorkspaceIds.set(checkoutKey, workspace.id);
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
      const alias = session.alias;
      let root: string;
      try {
        root = this.assertWorkspaceRootAllowed(session.root);
      } catch {
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
        writeAccess: session.writeAccess ?? "read_write",
        stateGeneration,
        ...this.loadSkillsForWorkspace(root),
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
      this.checkoutWorkspaceIds.set(
        checkoutWorkspaceKey(
          workspace.connectionPrincipalId,
          realpathSync(workspace.root),
          workspace.alias,
        ),
        workspace.id,
      );
      this.ensureLifecycleState(workspace);
      published = true;
      this.evictResidentWorkspaces();
      return context;
    } finally {
      lifecycle.activeOperations -= 1;
      if (lifecycle.activeOperations === 0) lifecycle.resolveDrained?.();
      if (!published && lifecycle.activeOperations === 0 && this.lifecycleStates.get(session.id) === lifecycle) {
        this.lifecycleStates.delete(session.id);
      }
      this.evictResidentWorkspaces();
    }
  }

  private defaultWorkspaceAlias(
    connectionPrincipalId: string,
    path: string,
  ): string {
    const canonicalPath = tryRealpathSync(path) ?? resolve(path);
    const reusableResident = Array.from(this.workspaces.values()).find((workspace) =>
      workspace.connectionPrincipalId === connectionPrincipalId &&
      !workspace.alias.startsWith("execution-") &&
      (tryRealpathSync(workspace.root) ?? resolve(workspace.root)) === canonicalPath
    );
    if (reusableResident) return reusableResident.alias;
    const activeSessions = this.store?.listActiveSessions?.() ?? [];
    const reusablePersisted = activeSessions.find((session) =>
      session.connectionPrincipalId === connectionPrincipalId &&
      !session.alias.startsWith("execution-") &&
      (session.canonicalRoot ?? resolve(session.root)) === canonicalPath
    );
    if (reusablePersisted) return reusablePersisted.alias;

    const normalized = basename(resolve(path))
      .replace(/[^A-Za-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 48) || "project";
    const occupied = new Set<string>();
    for (const session of activeSessions) {
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
    workspace.skills = refreshedSkills.skills;
    workspace.skillDiagnostics = refreshedSkills.skillDiagnostics;
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

  private projectFingerprintForRoot(root: string): string {
    const digest = createHmac("sha256", this.config.oauth.keys.projectFingerprint)
      .update("devspace:project-fingerprint:v1\0", "utf8")
      .update(root, "utf8")
      .digest("base64url")
      .slice(0, 22);
    return `proj_${digest}`;
  }

  private assertWorkspaceRootAllowed(root: string): string {
    const canonicalAllowedRoots = this.config.allowedRoots
      .map(tryRealpathSync)
      .filter((path): path is string => Boolean(path));
    const canonicalRoot = realpathSync(root);
    const managedRoot = resolve(this.config.stateDir, "worktrees");
    if (isPathInsideRoot(canonicalRoot, managedRoot)) return canonicalRoot;
    return assertAllowedPath(canonicalRoot, canonicalAllowedRoots);
  }

  private workspaceRootAllowed(root: string): boolean {
    try {
      this.assertWorkspaceRootAllowed(root);
      return true;
    } catch {
      return false;
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
    const userFile = await this.loadUserInstructionsFile();
    if (userFile) {
      loadedFiles.push(userFile);
    }

    for (const directory of ancestorDirectories(root, targetDirectory)) {
      const file = await this.instructionFileForDirectory(root, directory);
      if (!file) continue;
      loadedFiles.push(file);
    }
    return loadedFiles;
  }

  private async instructionFileForDirectory(root: string, directory: string): Promise<ApplicableAgentsFile | undefined> {
    const resolvedRoot = await realpath(root);
    const resolvedDirectory = await realpath(directory);
    if (!isPathInsideRoot(resolvedDirectory, resolvedRoot)) return undefined;
    const { fingerprintParts, discoveredFile } = await this.readStableInstructionDirectory(
      resolvedRoot,
      resolvedDirectory,
      async (directoryStats) => {
        const stableFingerprintParts = [statsFingerprint(directoryStats)];
        let stableDiscoveredFile: ApplicableAgentsFile | undefined;
        for (const name of projectInstructionFilenames(this.config.projectDocFallbackFilenames)) {
          const candidate = join(resolvedDirectory, name);
          try {
            const candidateStats = await lstat(candidate);
            if (!candidateStats.isFile()) continue;
            const resolvedPath = await realpath(candidate);
            if (!isPathInsideRoot(resolvedPath, resolvedRoot)) continue;
            const file = await this.readCachedInstruction(resolvedPath, resolvedRoot);
            stableFingerprintParts.push(`${name}:${resolvedPath}:${file.fingerprint}`);
            if (!hasProjectInstructionContent(file.content)) continue;
            stableDiscoveredFile = {
              path: resolvedPath,
              content: file.content,
              fingerprint: file.fingerprint,
            };
            break;
          } catch (error) {
            if (!isMissingPathError(error)) throw error;
          }
        }
        return {
          fingerprintParts: stableFingerprintParts,
          discoveredFile: stableDiscoveredFile,
        };
      }
    );
    const files = discoveredFile ? [discoveredFile.path] : [];
    const fingerprint = fingerprintParts.join("\0");
    const cached = this.instructionDirectoryCache.get(resolvedDirectory);
    if (cached?.fingerprint === fingerprint) {
      refreshMapEntry(this.instructionDirectoryCache, resolvedDirectory, cached);
    } else {
      this.instructionDirectoryCache.set(resolvedDirectory, { fingerprint, files });
      this.trimInstructionCaches();
    }
    return discoveredFile;
  }

  private async readCachedInstruction(path: string, allowedRoot?: string): Promise<{
    fingerprint: string;
    content: string;
  }> {
    const canonicalRoot = allowedRoot === undefined ? undefined : await realpath(allowedRoot);
    const rootBefore = canonicalRoot === undefined ? undefined : await lstat(canonicalRoot);
    if (rootBefore && !rootBefore.isDirectory()) {
      throw new Error(`Instruction root must be a directory: ${allowedRoot}`);
    }
    const canonicalPathBefore = await realpath(path);
    if (canonicalPathBefore !== path) {
      throw new Error(`Instruction file path changed before read: ${path}`);
    }
    if (canonicalRoot && !isPathInsideRoot(canonicalPathBefore, canonicalRoot)) {
      throw new AccessDeniedError(`Instruction file is outside the Project root: ${path}`);
    }
    const pathBefore = await lstat(path);
    if (!pathBefore.isFile()) throw new Error(`Instruction path must be a file: ${path}`);

    await this.instructionIoHooks.beforeFileOpen?.(path);
    const handle = await open(path, READ_ONLY_NOFOLLOW_FLAGS);
    let entry: { fingerprint: string; content: string };
    try {
      const descriptorBefore = await handle.stat();
      if (!descriptorBefore.isFile()) throw new Error(`Instruction path must be a file: ${path}`);
      assertSamePathIdentity(pathBefore, descriptorBefore, path, "Instruction file");
      const fingerprint = statsFingerprint(descriptorBefore);
      const cached = this.instructionFileCache.get(path);
      let content: string;
      if (cached?.fingerprint === fingerprint) {
        content = cached.content;
      } else if (descriptorBefore.size > MAX_EMPTY_INSTRUCTION_SCAN_BYTES) {
        assertInstructionFitsBudget(
          path,
          0,
          descriptorBefore.size,
          "instruction file",
          MAX_EMPTY_INSTRUCTION_SCAN_BYTES,
        );
        content = "";
      } else {
        content = await handle.readFile({ encoding: "utf8" });
      }
      const descriptorAfter = await handle.stat();
      if (!sameStatsSnapshot(descriptorBefore, descriptorAfter)) {
        throw new Error(`Instruction file changed during read: ${path}`);
      }
      entry = { fingerprint: statsFingerprint(descriptorAfter), content };
    } finally {
      await handle.close();
    }

    const pathAfter = await lstat(path);
    if (!pathAfter.isFile() || entry.fingerprint !== statsFingerprint(pathAfter)) {
      throw new Error(`Instruction file changed during read: ${path}`);
    }
    const canonicalPathAfter = await realpath(path);
    if (canonicalPathAfter !== canonicalPathBefore) {
      throw new Error(`Instruction file changed during read: ${path}`);
    }
    if (canonicalRoot) {
      const canonicalRootAfter = await realpath(allowedRoot!);
      const rootAfter = await lstat(canonicalRoot);
      if (
        canonicalRootAfter !== canonicalRoot ||
        !rootAfter.isDirectory() ||
        !sameStatsSnapshot(rootBefore!, rootAfter) ||
        !isPathInsideRoot(canonicalPathAfter, canonicalRoot)
      ) {
        throw new Error(`Instruction root changed during read: ${allowedRoot}`);
      }
    }

    this.instructionFileCache.set(path, entry);
    this.trimInstructionCaches();
    return entry;
  }

  private async readStableInstructionDirectory<T>(
    resolvedRoot: string,
    resolvedDirectory: string,
    read: (metadata: Stats) => Promise<T>,
  ): Promise<T> {
    const rootBefore = await lstat(resolvedRoot);
    const pathBefore = await lstat(resolvedDirectory);
    if (!rootBefore.isDirectory() || !pathBefore.isDirectory()) {
      throw new Error(`Instruction path must be a directory: ${resolvedDirectory}`);
    }
    const handle = await open(resolvedDirectory, READ_ONLY_DIRECTORY_NOFOLLOW_FLAGS);
    let result: T;
    let descriptorAfter: Stats;
    try {
      const descriptorBefore = await handle.stat();
      if (!descriptorBefore.isDirectory()) {
        throw new Error(`Instruction path must be a directory: ${resolvedDirectory}`);
      }
      assertSamePathIdentity(pathBefore, descriptorBefore, resolvedDirectory, "Instruction directory");
      await this.instructionIoHooks.beforeDirectoryRead?.(resolvedDirectory);
      result = await read(descriptorBefore);
      descriptorAfter = await handle.stat();
      if (!sameStatsSnapshot(descriptorBefore, descriptorAfter)) {
        throw new Error(`Instruction directory changed during read: ${resolvedDirectory}`);
      }
    } finally {
      await handle.close();
    }

    const rootAfterPath = await realpath(resolvedRoot);
    const rootAfter = await lstat(resolvedRoot);
    const directoryAfterPath = await realpath(resolvedDirectory);
    const directoryAfter = await lstat(resolvedDirectory);
    if (
      rootAfterPath !== resolvedRoot ||
      !rootAfter.isDirectory() ||
      !sameStatsSnapshot(rootBefore, rootAfter) ||
      directoryAfterPath !== resolvedDirectory ||
      !directoryAfter.isDirectory() ||
      !sameStatsSnapshot(descriptorAfter, directoryAfter) ||
      !isPathInsideRoot(directoryAfterPath, rootAfterPath)
    ) {
      throw new Error(`Instruction directory changed during read: ${resolvedDirectory}`);
    }
    return result;
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
  alias: string,
): string {
  return JSON.stringify([connectionPrincipalId, canonicalRoot, alias]);
}

function projectExecutionAlias(executionId: string): string {
  const digest = createHash("sha256").update(executionId, "utf8").digest("hex").slice(0, 24);
  return `execution-${digest}`;
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

function authorizationRootsRestrictGlobal(
  authorizedRoots: readonly string[],
  globalRoots: readonly string[],
): boolean {
  if (authorizedRoots.length !== globalRoots.length) return true;
  return !globalRoots.every((globalRoot) =>
    authorizedRoots.some((authorizedRoot) =>
      pathAllowedByAuthorizationRoots(globalRoot, [authorizedRoot]) &&
      pathAllowedByAuthorizationRoots(authorizedRoot, [globalRoot])
    )
  );
}

function validateInstructionContextId(instructionContextId: string): string {
  if (!/^ictx_[A-Za-z0-9-]{1,128}$/u.test(instructionContextId)) {
    throw new InstructionContextError();
  }
  return instructionContextId;
}

function formatWorkspaceDisplayPath(path: string | undefined): string {
  if (!path) return "project";
  const resolvedPath = resolve(path);
  return `…/${basename(resolvedPath)}`;
}

function workspaceIdentity(workspaceId: string, connectionPrincipalId: string): string {
  return `${connectionPrincipalId}\0${workspaceId}`;
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

function assertSamePathIdentity(
  left: Stats,
  right: Stats,
  path: string,
  kind: string,
): void {
  if (left.dev !== right.dev || left.ino !== right.ino) {
    throw new Error(`${kind} changed during read: ${path}`);
  }
}

function sameStatsSnapshot(left: Stats, right: Stats): boolean {
  return statsFingerprint(left) === statsFingerprint(right);
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
  maximumBytes = MAX_PROJECT_INSTRUCTION_BYTES,
): void {
  const totalBytes = consumedBytes + fileBytes;
  if (totalBytes <= maximumBytes) return;
  throw new InstructionBudgetError(
    `Project ${context} exceeds the ${maximumBytes}-byte UTF-8 limit: ` +
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
