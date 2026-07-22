import { randomUUID } from "node:crypto";
import { realpathSync, type Stats } from "node:fs";
import type { WorkspaceMode, WorkspaceStore } from "./workspace-store.js";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ServerConfig } from "./config.js";
import { createManagedWorktree, removeManagedWorktree } from "./git-worktrees.js";
import { projectInstructionFilenames } from "./project-instructions.js";
import { assertAllowedPath, isPathInsideRoot, resolveAllowedPath } from "./roots.js";
import {
  loadWorkspaceSkills,
  markSkillActivated,
  resolveSkillReadPath,
  type LoadedSkills,
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
  availableAgentsFiles: AvailableAgentsFile[];
  instructionScan: InstructionScanResult;
  reused: boolean;
}

export interface WorkspaceReadPath {
  absolutePath: string;
  readRoots: string[];
  skillRead?: SkillReadResolution;
}

export interface OpenWorkspaceInput {
  path: string;
  mode?: WorkspaceMode;
  baseRef?: string;
}

type PathStats = Stats;
type DirectoryOps = {
  stat: (path: string) => Promise<PathStats>;
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
};

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly checkoutWorkspaceIds = new Map<string, string>();
  private readonly pendingCheckoutWorkspaces = new Map<string, Promise<WorkspaceContext>>();
  private readonly instructionDirectoryCache = new Map<string, {
    fingerprint: string;
    files: string[];
  }>();
  private readonly instructionFileCache = new Map<string, {
    fingerprint: string;
    content: string;
  }>();
  private pendingManagedWorktrees = 0;

  constructor(
    private readonly config: ServerConfig,
    private readonly store?: WorkspaceStore,
  ) {}

  async openWorkspace(ownerClientId: string, input: string | OpenWorkspaceInput): Promise<WorkspaceContext> {
    const options = typeof input === "string" ? { path: input } : input;
    const mode = options.mode ?? "checkout";

    if (mode === "worktree") {
      return this.openWorktreeWorkspace(ownerClientId, options.path, options.baseRef);
    }

    return this.openCheckoutWorkspace(ownerClientId, options.path);
  }

  getWorkspace(ownerClientId: string, workspaceId: string): Workspace {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace?.ownerClientId === ownerClientId) {
      workspace.lastUsedAt = Date.now();
      this.store?.touchSession(workspaceId, ownerClientId);
      return workspace;
    }

    const session = this.store?.getSession(workspaceId, ownerClientId);
    if (!session) {
      throw new Error(`Unknown workspaceId: ${workspaceId}. Call open_workspace first.`);
    }

    const root = this.assertWorkspaceRootAllowed(session.root, session.mode, session.sourceRoot);
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
    this.evictResidentWorkspaces();

    return restoredWorkspace;
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
    );
    if (skillRead) {
      return {
        absolutePath: skillRead.absolutePath,
        readRoots: [workspace.root, skillRead.skill.baseDir],
        skillRead,
      };
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

  markReadPathLoaded(
    workspace: Workspace,
    readPath: WorkspaceReadPath,
    complete: boolean,
  ): void {
    if (complete && readPath.skillRead?.isSkillFile) {
      markSkillActivated(workspace.activatedSkillDirs, readPath.skillRead.skill);
    }
  }

  async loadApplicableAgentsFiles(
    workspace: Workspace,
    inputPaths: string[],
    options: { requireAcknowledged?: boolean } = {},
  ): Promise<ApplicableAgentsFile[]> {
    const directories = new Set<string>();
    for (const inputPath of inputPaths) {
      const absolutePath = this.resolvePath(workspace, inputPath);
      const targetDirectory = await canonicalInstructionDirectory(absolutePath, workspace.root);
      for (const directory of ancestorDirectories(workspace.root, targetDirectory)) {
        directories.add(directory);
      }
    }

    const loaded: ApplicableAgentsFile[] = [];
    const knownVersions = options.requireAcknowledged
      ? workspace.acknowledgedInstructionVersions
      : workspace.deliveredInstructionVersions;
    for (const directory of directories) {
      const instructionPaths = await this.instructionPathsForDirectory(workspace.root, directory);
      for (const path of instructionPaths) {
        const file = await this.readCachedInstruction(path);
        if (knownVersions.get(path) === file.fingerprint) continue;
        loaded.push({ path, content: file.content, fingerprint: file.fingerprint });
      }
    }
    return loaded;
  }

  async markAgentsFilesDelivered(
    workspace: Workspace,
    files: ApplicableAgentsFile[],
  ): Promise<void> {
    for (const file of files) {
      workspace.deliveredInstructionVersions.set(file.path, file.fingerprint);
    }
  }

  instructionAcknowledgementGeneration(workspace: Workspace): number {
    return workspace.instructionAcknowledgementGeneration;
  }

  async createInstructionAcknowledgement(
    workspace: Workspace,
    files: ApplicableAgentsFile[],
  ): Promise<string> {
    const token = `instructions_${randomUUID()}`;
    const versionedFiles = [];
    for (const file of files) {
      const current = await this.readCachedInstruction(file.path);
      if (current.fingerprint !== file.fingerprint) {
        throw new Error("Applicable project instructions changed while preparing instructionToken. Retry the tool.");
      }
      versionedFiles.push({ path: file.path, fingerprint: file.fingerprint, content: file.content });
    }
    workspace.pendingInstructionAcknowledgements.set(token, {
      createdAt: Date.now(),
      files: versionedFiles,
    });
    while (workspace.pendingInstructionAcknowledgements.size > 32) {
      const oldest = workspace.pendingInstructionAcknowledgements.keys().next().value;
      if (!oldest) break;
      workspace.pendingInstructionAcknowledgements.delete(oldest);
    }
    return token;
  }

  async acknowledgeInstructions(workspace: Workspace, token: string): Promise<void> {
    const pending = workspace.pendingInstructionAcknowledgements.get(token);
    if (!pending) throw new Error("Unknown or expired instructionToken. Retry the tool without it to load current instructions.");
    if (Date.now() - pending.createdAt > 10 * 60_000) {
      workspace.pendingInstructionAcknowledgements.delete(token);
      throw new Error("Expired instructionToken. Retry the tool without it to load current instructions.");
    }
    for (const file of pending.files) {
      const current = await this.readCachedInstruction(file.path);
      if (current.fingerprint !== file.fingerprint) {
        workspace.pendingInstructionAcknowledgements.delete(token);
        throw new Error("Applicable project instructions changed. Retry the tool without instructionToken.");
      }
    }
    for (const file of pending.files) {
      workspace.deliveredInstructionVersions.set(file.path, file.fingerprint);
      workspace.acknowledgedInstructionVersions.set(file.path, file.fingerprint);
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

  closeWorkspace(ownerClientId: string, workspaceId: string): boolean {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace && workspace.ownerClientId !== ownerClientId) return false;
    const closed = this.store?.closeSession(workspaceId, ownerClientId) ?? Boolean(workspace);
    if (closed) {
      this.workspaces.delete(workspaceId);
      this.removeCheckoutWorkspaceId(workspaceId);
    }
    return closed;
  }

  deleteWorkspace(ownerClientId: string, workspaceId: string): boolean {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace && workspace.ownerClientId !== ownerClientId) return false;
    const deleted = this.store?.deleteSession(workspaceId, ownerClientId) ?? Boolean(workspace);
    if (deleted) {
      this.workspaces.delete(workspaceId);
      this.removeCheckoutWorkspaceId(workspaceId);
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
      if (!this.store.closeSession(session.id, session.ownerClientId)) continue;
      this.workspaces.delete(session.id);
      this.removeCheckoutWorkspaceId(session.id);
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
            config: this.config,
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
    const availableAgentsFiles: AvailableAgentsFile[] = [];
    const instructionScan = lazyInstructionScan();
    if (input.mode === "checkout" && input.canonicalRoot && this.store?.createOrReuseCheckoutSession) {
      const session = this.store.createOrReuseCheckoutSession({
        id: workspace.id,
        ownerClientId: workspace.ownerClientId,
        root: workspace.root,
        canonicalRoot: input.canonicalRoot,
      });
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
      });
    }
    if (checkoutKey) this.checkoutWorkspaceIds.set(checkoutKey, workspace.id);
    this.workspaces.set(workspace.id, workspace);
    this.evictResidentWorkspaces();

    return { workspace, agentsFiles, availableAgentsFiles, instructionScan, reused };
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

  private async loadInitialAgentsFiles(root: string): Promise<LoadedAgentsFile[]> {
    const agentDir = resolve(this.config.agentDir);
    const resolvedAgentDir = (await tryRealpath(agentDir)) ?? agentDir;
    const loadedFiles: LoadedAgentsFile[] = [];

    for (const name of projectInstructionFilenames([])) {
      const candidate = join(agentDir, name);
      try {
        const candidateStats = await lstat(candidate);
        if (!candidateStats.isFile() && !candidateStats.isSymbolicLink()) continue;
        const path = await realpath(candidate);
        if (!isPathInsideRoot(path, resolvedAgentDir)) continue;
        if (!(await stat(path)).isFile()) continue;
        loadedFiles.push({ path, content: await readFile(path, "utf8") });
        break;
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
    }

    for (const path of await this.instructionPathsForDirectory(root, root)) {
      const file = await this.readCachedInstruction(path);
      loadedFiles.push({ path, content: file.content });
    }

    return loadedFiles;
  }

  private async markInitialAgentsFilesLoaded(
    workspace: Workspace,
    files: LoadedAgentsFile[],
  ): Promise<void> {
    const canonicalRoot = await realpath(workspace.root);
    for (const file of files) {
      if (!isPathInsideRoot(file.path, canonicalRoot)) continue;
      try {
        const resolvedPath = await realpath(file.path);
        if (!isPathInsideRoot(resolvedPath, canonicalRoot)) continue;
        const metadata = await stat(resolvedPath);
        const fingerprint = statsFingerprint(metadata);
        workspace.deliveredInstructionVersions.set(resolvedPath, fingerprint);
        workspace.acknowledgedInstructionVersions.set(resolvedPath, fingerprint);
      } catch {
        // The initial loader already returned safe fallback content. A later
        // path-based check will retry if this file becomes readable.
      }
    }
  }

  private async instructionPathsForDirectory(root: string, directory: string): Promise<string[]> {
    const resolvedRoot = await realpath(root);
    const resolvedDirectory = await realpath(directory);
    if (!isPathInsideRoot(resolvedDirectory, resolvedRoot)) return [];
    const directoryStats = await stat(resolvedDirectory);
    const fingerprint = statsFingerprint(directoryStats);
    const cached = this.instructionDirectoryCache.get(resolvedDirectory);
    if (cached?.fingerprint === fingerprint) return cached.files;

    const discoveredFiles: string[] = [];
    for (const name of projectInstructionFilenames(this.config.projectDocFallbackFilenames)) {
      const candidate = join(resolvedDirectory, name);
      try {
        const candidateStats = await lstat(candidate);
        if (!candidateStats.isFile()) continue;
        const resolvedPath = await realpath(candidate);
        if (!isPathInsideRoot(resolvedPath, resolvedRoot)) continue;
        discoveredFiles.push(resolvedPath);
        break;
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
    }
    const files = discoveredFiles;
    this.instructionDirectoryCache.set(resolvedDirectory, { fingerprint, files });
    return files;
  }

  private async readCachedInstruction(path: string): Promise<{
    fingerprint: string;
    content: string;
  }> {
    const metadata = await stat(path);
    const fingerprint = statsFingerprint(metadata);
    const cached = this.instructionFileCache.get(path);
    if (cached?.fingerprint === fingerprint) return cached;
    const entry = { fingerprint, content: await readFile(path, "utf8") };
    this.instructionFileCache.set(path, entry);
    return entry;
  }

  private evictResidentWorkspaces(): void {
    while (this.workspaces.size > this.config.resources.maxResidentWorkspaces) {
      let oldest: Workspace | undefined;
      for (const workspace of this.workspaces.values()) {
        if (!oldest || workspace.lastUsedAt < oldest.lastUsedAt) oldest = workspace;
      }
      if (!oldest) return;
      this.workspaces.delete(oldest.id);
    }
  }

  private removeCheckoutWorkspaceId(workspaceId: string): void {
    for (const [key, indexedWorkspaceId] of this.checkoutWorkspaceIds) {
      if (indexedWorkspaceId === workspaceId) this.checkoutWorkspaceIds.delete(key);
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

function isMissingPathError(error: unknown): boolean {
  return isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
