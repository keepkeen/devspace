import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync, type Stats } from "node:fs";
import type { WorkspaceMode, WorkspaceSession, WorkspaceStore } from "./workspace-store.js";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ServerConfig } from "./config.js";
import { createManagedWorktree, removeManagedWorktree } from "./git-worktrees.js";
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
  ownerClientId: string;
  root: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  worktree?: WorkspaceWorktree;
  skills: LoadedSkills["skills"];
  skillDiagnostics: LoadedSkills["diagnostics"];
  agentProfiles: LocalAgentProfile[];
  activatedSkillDirs: Set<string>;
  deliveredInstructionVersions: Map<string, string>;
  acknowledgedInstructionVersions: Map<string, string>;
  instructionAcknowledgementGeneration: number;
  pendingInstructionAcknowledgements: Map<string, {
    createdAt: number;
    files: Array<{ path: string; fingerprint: string; content: string }>;
  }>;
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
  agentsFiles: LoadedAgentsFile[];
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
  mode?: WorkspaceMode;
  baseRef?: string;
}

export interface WorkspaceCloseLease {
  workspace: Workspace;
  commit(options?: { delete?: boolean }): boolean;
  abort(): void;
}

export interface WorkspaceUsageSnapshot {
  activePersisted: number;
  resident: number;
  closing: number;
  leased: number;
  maxResident: number;
}

export interface AllowedRootsUpdateResult {
  changed: boolean;
  added: number;
  removed: number;
  persistenceFailures: number;
  invalidated: Array<{ workspaceId: string; ownerClientId: string }>;
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

interface WorkspaceLifecycleState {
  ownerClientId: string;
  phase: "open" | "closing";
  activeOperations: number;
  drained?: Promise<void>;
  resolveDrained?: () => void;
}

const MAX_INSTRUCTION_VERSIONS_PER_WORKSPACE = 1_024;
const MAX_PENDING_INSTRUCTION_ACKNOWLEDGEMENTS = 32;
const INSTRUCTION_ACKNOWLEDGEMENT_TTL_MS = 10 * 60_000;
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
  private readonly lifecycleStates = new Map<string, WorkspaceLifecycleState>();
  private readonly instructionDirectoryCache = new Map<string, {
    fingerprint: string;
    files: string[];
  }>();
  private readonly instructionFileCache = new Map<string, {
    fingerprint: string;
    content: string;
  }>();
  private readonly pendingSessionClosures = new Map<string, WorkspaceSession>();
  private pendingManagedWorktrees = 0;

  constructor(
    private readonly config: ServerConfig,
    private readonly store?: WorkspaceStore,
  ) {}

  async openWorkspace(ownerClientId: string, input: string | OpenWorkspaceInput): Promise<WorkspaceContext> {
    const options = typeof input === "string" ? { path: input } : input;
    const mode = options.mode ?? "checkout";

    try {
      if (mode === "worktree") {
        return await this.openWorktreeWorkspace(ownerClientId, options.path, options.baseRef);
      }

      return await this.openCheckoutWorkspace(ownerClientId, options.path);
    } catch (error) {
      if (!(error instanceof AccessDeniedError)) throw error;
      throw new AccessDeniedError(
        `${error.message}. Open the original approved project path. For an isolated checkout, use mode="worktree" and reuse the returned workspaceId; do not open DevSpace's internal worktree directory. If this is a different project, ask the user to add its project root.`,
      );
    }
  }

  getWorkspace(ownerClientId: string, workspaceId: string): Workspace {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace?.ownerClientId === ownerClientId) {
      if (!this.workspaceRootAllowed(workspace.root, workspace.mode, workspace.sourceRoot)) {
        this.invalidateWorkspace(workspaceId, ownerClientId, workspace.root);
        throw new UnknownWorkspaceError(workspaceId);
      }
      workspace.lastUsedAt = Date.now();
      this.store?.touchSession(workspaceId, ownerClientId);
      return workspace;
    }

    const session = this.store?.getSession(workspaceId, ownerClientId);
    if (!session) {
      throw new UnknownWorkspaceError(workspaceId);
    }

    let root: string;
    try {
      root = this.assertWorkspaceRootAllowed(session.root, session.mode, session.sourceRoot);
    } catch {
      this.invalidateWorkspace(workspaceId, ownerClientId, session.root);
      throw new UnknownWorkspaceError(workspaceId);
    }
    const restoredWorkspace: Workspace = {
      id: session.id,
      ownerClientId: session.ownerClientId,
      root,
      mode: session.mode,
      sourceRoot: session.sourceRoot,
      worktree:
        session.mode === "worktree"
          ? {
              path: root,
              baseRef: session.baseRef ?? "HEAD",
              baseSha: session.baseSha ?? "",
              dirtySource: false,
              detached: true,
              managed: session.managed,
            }
          : undefined,
      ...this.loadSkillsForWorkspace(root),
      agentProfiles: [],
      activatedSkillDirs: new Set(),
      deliveredInstructionVersions: new Map(),
      acknowledgedInstructionVersions: new Map(),
      instructionAcknowledgementGeneration: 0,
      pendingInstructionAcknowledgements: new Map(),
      lastUsedAt: Date.now(),
    };
    this.store?.touchSession(workspaceId, ownerClientId);
    this.workspaces.set(restoredWorkspace.id, restoredWorkspace);
    this.ensureLifecycleState(restoredWorkspace);
    this.evictResidentWorkspaces();

    return restoredWorkspace;
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
        ownerClientId: workspace.ownerClientId,
        root: workspace.root,
        status: "active",
        mode: workspace.mode,
        sourceRoot: workspace.sourceRoot,
        baseRef: workspace.worktree?.baseRef,
        baseSha: workspace.worktree?.baseSha,
        managed: workspace.worktree?.managed ?? false,
        createdAt: new Date(workspace.lastUsedAt).toISOString(),
        lastUsedAt: new Date(workspace.lastUsedAt).toISOString(),
      }),
    );
    const revoked = sessions.filter(
      (session) => !this.workspaceRootAllowed(session.root, session.mode, session.sourceRoot),
    );
    for (const session of revoked) {
      this.pendingSessionClosures.set(workspaceIdentity(session.id, session.ownerClientId), session);
    }
    const pendingClosures = Array.from(this.pendingSessionClosures.values());
    const identities = pendingClosures.map(({ id, ownerClientId }) => ({ id, ownerClientId }));
    let persistenceFailures = 0;
    try {
      if (this.store?.closeSessions) {
        this.store.closeSessions(identities);
      } else {
        for (const session of pendingClosures) this.store?.closeSession(session.id, session.ownerClientId);
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

    const previousSet = new Set(previous);
    const nextSet = new Set(normalized);
    return {
      changed,
      added: normalized.filter((root) => !previousSet.has(root)).length,
      removed: previous.filter((root) => !nextSet.has(root)).length,
      persistenceFailures,
      invalidated: pendingClosures.map(({ id, ownerClientId }) => ({ workspaceId: id, ownerClientId })),
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
    ownerClientId: string,
    workspaceId: string,
    skillId: string,
  ): Promise<LoadedWorkspaceSkill> {
    const workspace = this.getWorkspace(ownerClientId, workspaceId);
    const skill = workspace.skills.find((candidate) => candidate.skillId === skillId);
    if (!skill) {
      throw new Error(`Unknown skillId for workspace ${workspaceId}: ${skillId}`);
    }

    const canonicalBaseDir = await realpath(skill.baseDir);
    const canonicalManifest = await realpath(skill.filePath);
    if (
      !isPathInsideRoot(canonicalManifest, canonicalBaseDir) ||
      canonicalManifest !== skill.filePath
    ) {
      throw new Error(`Skill manifest is no longer confined to its advertised directory: ${skillId}`);
    }

    const manifestStats = await stat(canonicalManifest);
    if (!manifestStats.isFile()) {
      throw new Error(`Skill manifest is no longer a regular file: ${skillId}`);
    }
    if (manifestStats.size > SKILL_DISCOVERY_LIMITS.maxSkillBytes) {
      throw new Error(`Skill manifest exceeds the ${SKILL_DISCOVERY_LIMITS.maxSkillBytes}-byte limit: ${skillId}`);
    }

    const content = await readFile(canonicalManifest, "utf8");
    if (Buffer.byteLength(content, "utf8") > SKILL_DISCOVERY_LIMITS.maxSkillBytes) {
      throw new Error(`Skill manifest exceeds the ${SKILL_DISCOVERY_LIMITS.maxSkillBytes}-byte limit: ${skillId}`);
    }
    const manifestHash = createHash("sha256").update(content).digest("hex");
    if (manifestHash !== skill.manifestHash) {
      throw new Error(`Skill manifest changed after open_workspace; reopen the workspace before loading it: ${skillId}`);
    }
    const openAiMetadataHash = computeSkillOpenAiMetadataHash(canonicalBaseDir);
    if (!skill.openAiMetadataHash || openAiMetadataHash !== skill.openAiMetadataHash) {
      throw new Error(
        `Skill OpenAI metadata changed after open_workspace; reopen the workspace before loading it: ${skillId}`,
      );
    }

    // Activation is intentionally last: support files only become readable after
    // one complete, successful manifest read.
    markSkillActivated(workspace.activatedSkillDirs, skill);
    return { skill, content };
  }

  async loadApplicableAgentsFiles(
    workspace: Workspace,
    inputPaths: string[],
    options: { requireAcknowledged?: boolean } = {},
  ): Promise<ApplicableAgentsFile[]> {
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
      ? workspace.acknowledgedInstructionVersions
      : workspace.deliveredInstructionVersions;
    for (const targetDirectory of [...targetDirectories].sort()) {
      const chain = await this.loadInstructionChain(workspace.root, targetDirectory);
      for (const file of chain) {
        const { path } = file;
        if (knownVersions.get(path) === file.fingerprint) continue;
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

  async markAgentsFilesDelivered(
    workspace: Workspace,
    files: ApplicableAgentsFile[],
  ): Promise<void> {
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
      setBoundedMap(workspace.deliveredInstructionVersions, file.path, file.fingerprint, MAX_INSTRUCTION_VERSIONS_PER_WORKSPACE);
    }
  }

  instructionAcknowledgementGeneration(workspace: Workspace): number {
    return workspace.instructionAcknowledgementGeneration;
  }

  async createInstructionAcknowledgement(
    workspace: Workspace,
    files: ApplicableAgentsFile[],
  ): Promise<string> {
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
    workspace.pendingInstructionAcknowledgements.set(token, {
      createdAt: Date.now(),
      files: versionedFiles,
    });
    while (workspace.pendingInstructionAcknowledgements.size > MAX_PENDING_INSTRUCTION_ACKNOWLEDGEMENTS) {
      const oldest = workspace.pendingInstructionAcknowledgements.keys().next().value;
      if (!oldest) break;
      workspace.pendingInstructionAcknowledgements.delete(oldest);
    }
    return token;
  }

  async acknowledgeInstructions(workspace: Workspace, token: string): Promise<void> {
    const pending = workspace.pendingInstructionAcknowledgements.get(token);
    if (!pending) throw new InstructionTokenError();
    if (Date.now() - pending.createdAt > INSTRUCTION_ACKNOWLEDGEMENT_TTL_MS) {
      workspace.pendingInstructionAcknowledgements.delete(token);
      throw new InstructionTokenError();
    }
    for (const file of pending.files) {
      const current = await this.readCachedInstruction(file.path);
      if (current.fingerprint !== file.fingerprint) {
        workspace.pendingInstructionAcknowledgements.delete(token);
        throw new InstructionTokenError();
      }
    }
    await this.assertCurrentInstructionChainsWithinBudget(workspace, pending.files);
    for (const file of pending.files) {
      setBoundedMap(workspace.deliveredInstructionVersions, file.path, file.fingerprint, MAX_INSTRUCTION_VERSIONS_PER_WORKSPACE);
      setBoundedMap(workspace.acknowledgedInstructionVersions, file.path, file.fingerprint, MAX_INSTRUCTION_VERSIONS_PER_WORKSPACE);
    }
    workspace.pendingInstructionAcknowledgements.delete(token);
    workspace.instructionAcknowledgementGeneration += 1;
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
    ownerClientId: string,
    workspaceId: string,
    callback: (workspace: Workspace) => T | Promise<T>,
  ): Promise<T> {
    const existingLifecycle = this.lifecycleStates.get(workspaceId);
    if (existingLifecycle?.ownerClientId === ownerClientId && existingLifecycle.phase === "closing") {
      throw new Error(`Workspace ${workspaceId} is closing and cannot accept new operations.`);
    }
    const workspace = this.getWorkspace(ownerClientId, workspaceId);
    const lifecycle = this.ensureLifecycleState(workspace);
    if (lifecycle.phase === "closing") {
      throw new Error(`Workspace ${workspaceId} is closing and cannot accept new operations.`);
    }
    lifecycle.activeOperations += 1;
    try {
      return await callback(workspace);
    } finally {
      lifecycle.activeOperations -= 1;
      if (lifecycle.activeOperations === 0) lifecycle.resolveDrained?.();
      this.evictResidentWorkspaces();
    }
  }

  async acquireExclusiveClose(ownerClientId: string, workspaceId: string): Promise<WorkspaceCloseLease> {
    const existingLifecycle = this.lifecycleStates.get(workspaceId);
    if (existingLifecycle?.ownerClientId === ownerClientId && existingLifecycle.phase === "closing") {
      throw new Error(`Workspace ${workspaceId} is already closing.`);
    }
    const workspace = this.getWorkspace(ownerClientId, workspaceId);
    const lifecycle = this.ensureLifecycleState(workspace);
    lifecycle.phase = "closing";
    if (lifecycle.activeOperations > 0) {
      lifecycle.drained = new Promise<void>((resolve) => {
        lifecycle.resolveDrained = resolve;
      });
      await lifecycle.drained;
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
          ? options.delete
            ? this.store.deleteSession(workspaceId, ownerClientId)
            : this.store.closeSession(workspaceId, ownerClientId)
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

  usageSnapshot(ownerClientId?: string): WorkspaceUsageSnapshot {
    const resident = Array.from(this.workspaces.values())
      .filter((workspace) => !ownerClientId || workspace.ownerClientId === ownerClientId)
      .length;
    const lifecycle = Array.from(this.lifecycleStates.values())
      .filter((state) => !ownerClientId || state.ownerClientId === ownerClientId);
    return {
      activePersisted: this.store?.countActiveSessions?.(ownerClientId) ?? resident,
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
      for (const [token, pending] of workspace.pendingInstructionAcknowledgements) {
        if (now - pending.createdAt <= INSTRUCTION_ACKNOWLEDGEMENT_TTL_MS) continue;
        workspace.pendingInstructionAcknowledgements.delete(token);
        expiredInstructionTokens += 1;
      }
      trimMap(workspace.deliveredInstructionVersions, MAX_INSTRUCTION_VERSIONS_PER_WORKSPACE);
      trimMap(workspace.acknowledgedInstructionVersions, MAX_INSTRUCTION_VERSIONS_PER_WORKSPACE);
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

  closeWorkspace(ownerClientId: string, workspaceId: string): boolean {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace && workspace.ownerClientId !== ownerClientId) return false;
    const lifecycle = this.lifecycleStates.get(workspaceId);
    if (lifecycle && (lifecycle.phase === "closing" || lifecycle.activeOperations > 0)) return false;
    const closed = this.store?.closeSession(workspaceId, ownerClientId) ?? Boolean(workspace);
    if (closed) {
      this.workspaces.delete(workspaceId);
      this.lifecycleStates.delete(workspaceId);
      this.removeCheckoutWorkspaceId(workspaceId);
      if (workspace) this.purgeInstructionCachesForUnusedRoot(workspace.root);
    }
    return closed;
  }

  deleteWorkspace(ownerClientId: string, workspaceId: string): boolean {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace && workspace.ownerClientId !== ownerClientId) return false;
    const lifecycle = this.lifecycleStates.get(workspaceId);
    if (lifecycle && (lifecycle.phase === "closing" || lifecycle.activeOperations > 0)) return false;
    const deleted = this.store?.deleteSession(workspaceId, ownerClientId) ?? Boolean(workspace);
    if (deleted) {
      this.workspaces.delete(workspaceId);
      this.lifecycleStates.delete(workspaceId);
      this.removeCheckoutWorkspaceId(workspaceId);
      if (workspace) this.purgeInstructionCachesForUnusedRoot(workspace.root);
    }
    return deleted;
  }

  closeExpiredSessions(
    idleTtlMs: number,
    hasActiveProcess: (ownerClientId: string, workspaceId: string) => boolean,
  ): string[] {
    if (!this.store) return [];
    const before = new Date(Date.now() - idleTtlMs).toISOString();
    const closed: string[] = [];
    for (const session of this.store.listExpiredSessions(before, this.config.resources.maxResidentWorkspaces)) {
      if (session.managed) continue;
      if (hasActiveProcess(session.ownerClientId, session.id)) continue;
      const lifecycle = this.lifecycleStates.get(session.id);
      if (lifecycle && (lifecycle.phase === "closing" || lifecycle.activeOperations > 0)) continue;
      if (!this.store.closeSession(session.id, session.ownerClientId)) continue;
      this.workspaces.delete(session.id);
      this.lifecycleStates.delete(session.id);
      this.removeCheckoutWorkspaceId(session.id);
      this.purgeInstructionCachesForUnusedRoot(session.root);
      closed.push(session.id);
    }
    return closed;
  }

  isReady(): boolean {
    return this.store?.isReady() ?? true;
  }

  private async openCheckoutWorkspace(ownerClientId: string, path: string): Promise<WorkspaceContext> {
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
    const checkoutKey = checkoutWorkspaceKey(ownerClientId, canonicalRoot);
    const pending = this.pendingCheckoutWorkspaces.get(checkoutKey);
    if (pending) {
      return pending.then((context) => ({ ...context, reused: true }));
    }

    const opening = this.createWorkspaceContext({
      ownerClientId,
      root: validatedRoot,
      canonicalRoot,
      mode: "checkout",
    });
    this.pendingCheckoutWorkspaces.set(checkoutKey, opening);
    try {
      return await opening;
    } finally {
      this.pendingCheckoutWorkspaces.delete(checkoutKey);
    }
  }

  private async openWorktreeWorkspace(ownerClientId: string, path: string, baseRef: string | undefined): Promise<WorkspaceContext> {
    const retainedManagedWorktrees = this.store?.countManagedWorktrees()
      ?? Array.from(this.workspaces.values()).filter((workspace) => workspace.worktree?.managed).length;
    if (retainedManagedWorktrees + this.pendingManagedWorktrees >= this.config.resources.maxManagedWorktrees) {
      throw new Error(
        `Managed worktree limit reached (${this.config.resources.maxManagedWorktrees}). Close and remove an unused managed worktree before opening another.`,
      );
    }
    this.pendingManagedWorktrees += 1;
    try {
      const worktree = await createManagedWorktree({
        sourcePath: path,
        baseRef,
        config: this.config,
      });
      try {
        return await this.createWorkspaceContext({
          ownerClientId,
          root: worktree.path,
          mode: "worktree",
          sourceRoot: worktree.sourceRoot,
          worktree,
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
        throw error;
      }
    } finally {
      this.pendingManagedWorktrees -= 1;
    }
  }

  private async createWorkspaceContext(input: {
    ownerClientId: string;
    root: string;
    canonicalRoot?: string;
    mode: WorkspaceMode;
    sourceRoot?: string;
    worktree?: WorkspaceWorktree;
  }): Promise<WorkspaceContext> {
    const checkoutKey = input.canonicalRoot
      ? checkoutWorkspaceKey(input.ownerClientId, input.canonicalRoot)
      : undefined;
    const indexedCheckoutId = !this.store && checkoutKey
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
      ownerClientId: input.ownerClientId,
      root: input.root,
      mode: input.mode,
      sourceRoot: input.sourceRoot,
      worktree: input.worktree,
      ...this.loadSkillsForWorkspace(input.root),
      agentProfiles: await loadLocalAgentProfiles(this.config, input.root),
      activatedSkillDirs: new Set(),
      deliveredInstructionVersions: new Map(),
      acknowledgedInstructionVersions: new Map(),
      instructionAcknowledgementGeneration: 0,
      pendingInstructionAcknowledgements: new Map(),
      lastUsedAt: Date.now(),
    };
    let reused = Boolean(residentCheckoutId);

    const agentsFiles = await this.loadInitialAgentsFiles(workspace.root);
    await this.markInitialAgentsFilesLoaded(workspace, agentsFiles);
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
        ownerClientId: workspace.ownerClientId,
        root: workspace.root,
        canonicalRoot: input.canonicalRoot,
        maxActiveSessionsPerClient: this.config.resources.maxActiveWorkspacesPerClient,
      });
      if (this.lifecycleStates.get(session.id)?.phase === "closing") {
        throw new Error(`Workspace ${session.id} is closing and cannot be reopened yet.`);
      }
      reused = session.id !== workspace.id;
      workspace.id = session.id;
      workspace.root = session.root;
    } else if (residentCheckoutId) {
      this.store?.touchSession(workspace.id, workspace.ownerClientId);
    } else {
      this.store?.createSession({
        id: workspace.id,
        ownerClientId: workspace.ownerClientId,
        root: workspace.root,
        mode: workspace.mode,
        sourceRoot: workspace.sourceRoot,
        baseRef: workspace.worktree?.baseRef,
        baseSha: workspace.worktree?.baseSha,
        managed: workspace.worktree?.managed,
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

  private invalidateWorkspace(workspaceId: string, ownerClientId: string, root: string): void {
    this.store?.closeSession(workspaceId, ownerClientId);
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

  private async markInitialAgentsFilesLoaded(
    workspace: Workspace,
    files: ApplicableAgentsFile[],
  ): Promise<void> {
    for (const file of files) {
      try {
        const resolvedPath = await realpath(file.path);
        const current = await this.readCachedInstruction(resolvedPath);
        if (current.fingerprint !== file.fingerprint) continue;
        setBoundedMap(workspace.deliveredInstructionVersions, resolvedPath, file.fingerprint, MAX_INSTRUCTION_VERSIONS_PER_WORKSPACE);
        setBoundedMap(workspace.acknowledgedInstructionVersions, resolvedPath, file.fingerprint, MAX_INSTRUCTION_VERSIONS_PER_WORKSPACE);
      } catch {
        // The initial loader already returned safe fallback content. A later
        // path-based check will retry if this file becomes readable.
      }
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
      ownerClientId: workspace.ownerClientId,
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

function checkoutWorkspaceKey(ownerClientId: string, canonicalRoot: string): string {
  return JSON.stringify([ownerClientId, canonicalRoot]);
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

function workspaceIdentity(workspaceId: string, ownerClientId: string): string {
  return `${ownerClientId}\0${workspaceId}`;
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
  throw new Error(
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
