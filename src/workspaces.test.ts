import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { loadConfig } from "./config.js";
import { databasePath } from "./db/client.js";
import { GitWorktreeError, removeManagedWorktree } from "./git-worktrees.js";
import { SqliteWorkspaceStore, type WorkspaceStore } from "./workspace-store.js";
import { ensureCheckoutWorkspaceRoot, WorkspaceRegistry } from "./workspaces.js";
import { formatPathForPrompt } from "./skills.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-workspace-test-"));
const outsideRoot = await mkdtemp(join(tmpdir(), "devspace-workspace-outside-test-"));
const canonicalRoot = await realpath(root);
const ownerClientId = "client-a";

try {
  const agentDir = join(root, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  if (platform() === "win32") {
    await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  } else {
    await mkdir(join(agentDir, "skills"), { recursive: true });
    await writeFile(join(agentDir, "skills", "AGENTS.md"), "global instructions\n");
    await symlink("skills/AGENTS.md", join(agentDir, "AGENTS.md"));
  }
  await writeFile(join(agentDir, "AGENTS.override.md"), "global override instructions\n");
  await writeFile(join(root, "AGENTS.md"), "root instructions\n");
  await mkdir(join(agentDir, "skills", "workspace-skill"), { recursive: true });
  await writeFile(
    join(agentDir, "skills", "workspace-skill", "SKILL.md"),
    "---\nname: workspace-skill\ndescription: Workspace test skill.\n---\n\n# Skill\n",
  );
  await writeFile(join(agentDir, "skills", "workspace-skill", "reference.md"), "reference\n");
  await mkdir(join(root, ".devspace", "agents"), { recursive: true });
  await writeFile(
    join(root, ".devspace", "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Read-only project reviewer.",
      "provider: codex",
      "---",
      "",
      "Review only.",
      "",
    ].join("\n"),
  );
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "AGENTS.md"), "nested instructions\n");
  await writeFile(join(root, "nested", "file.txt"), "hello\n");

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".devspace-home"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".devspace", "worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const pendingRegistry = new WorkspaceRegistry(config);
  const [pendingCreator, pendingWaiter] = await Promise.all([
    pendingRegistry.openWorkspace(ownerClientId, root),
    pendingRegistry.openWorkspace(ownerClientId, root),
  ]);
  assert.equal(pendingCreator.workspace.id, pendingWaiter.workspace.id);
  assert.deepEqual(
    [pendingCreator.reused, pendingWaiter.reused].sort(),
    [false, true],
  );

  const registry = new WorkspaceRegistry(config);
  const { workspace, agentsFiles, availableAgentsFiles, instructionScan, reused } = await registry.openWorkspace(ownerClientId, root);
  assert.equal(reused, false);
  const sequentialCheckout = await registry.openWorkspace(ownerClientId, root);
  assert.equal(sequentialCheckout.reused, true);
  assert.equal(sequentialCheckout.workspace.id, workspace.id);
  const [concurrentCheckoutA, concurrentCheckoutB] = await Promise.all([
    registry.openWorkspace(ownerClientId, root),
    registry.openWorkspace(ownerClientId, root),
  ]);
  assert.equal(concurrentCheckoutA.workspace.id, workspace.id);
  assert.equal(concurrentCheckoutB.workspace.id, workspace.id);
  assert.equal(concurrentCheckoutA.reused, true);
  assert.equal(concurrentCheckoutB.reused, true);
  const otherOwnerCheckout = await registry.openWorkspace("client-b", root);
  assert.notEqual(otherOwnerCheckout.workspace.id, workspace.id);

  const lifecycleRegistry = new WorkspaceRegistry(config);
  const lifecycleWorkspace = (await lifecycleRegistry.openWorkspace(ownerClientId, root)).workspace;
  let releaseOperation!: () => void;
  let operationStarted!: () => void;
  const operationStartedPromise = new Promise<void>((resolve) => {
    operationStarted = resolve;
  });
  const operationBarrier = new Promise<void>((resolve) => {
    releaseOperation = resolve;
  });
  const activeOperation = lifecycleRegistry.withWorkspaceOperation(
    ownerClientId,
    lifecycleWorkspace.id,
    async (leasedWorkspace) => {
      operationStarted();
      await operationBarrier;
      return leasedWorkspace.id;
    },
  );
  await operationStartedPromise;
  const exclusiveClosePromise = lifecycleRegistry.acquireExclusiveClose(ownerClientId, lifecycleWorkspace.id);
  await assert.rejects(
    lifecycleRegistry.withWorkspaceOperation(ownerClientId, lifecycleWorkspace.id, () => undefined),
    /is closing/,
  );
  await assert.rejects(
    lifecycleRegistry.openWorkspace(ownerClientId, root),
    /is closing/,
  );
  assert.deepEqual(lifecycleRegistry.usageSnapshot(ownerClientId), {
    activePersisted: 1,
    resident: 1,
    closing: 1,
    leased: 1,
    maxResident: config.resources.maxResidentWorkspaces,
  });
  releaseOperation();
  assert.equal(await activeOperation, lifecycleWorkspace.id);
  const exclusiveClose = await exclusiveClosePromise;
  exclusiveClose.abort();
  assert.equal(
    await lifecycleRegistry.withWorkspaceOperation(ownerClientId, lifecycleWorkspace.id, (current) => current.id),
    lifecycleWorkspace.id,
  );
  const committedClose = await lifecycleRegistry.acquireExclusiveClose(ownerClientId, lifecycleWorkspace.id);
  assert.equal(committedClose.commit(), true);
  assert.throws(
    () => lifecycleRegistry.getWorkspace(ownerClientId, lifecycleWorkspace.id),
    /Unknown workspaceId/,
  );
  const leaseDeleteStore = new SqliteWorkspaceStore(join(root, ".lease-delete-state"));
  const leaseDeleteRegistry = new WorkspaceRegistry(config, leaseDeleteStore);
  const leaseDeleteWorkspace = (await leaseDeleteRegistry.openWorkspace(ownerClientId, root)).workspace;
  const deleteLease = await leaseDeleteRegistry.acquireExclusiveClose(ownerClientId, leaseDeleteWorkspace.id);
  await assert.rejects(
    leaseDeleteRegistry.openWorkspace(ownerClientId, root),
    /is closing/,
  );
  assert.equal(deleteLease.commit({ delete: true }), true);
  assert.equal(leaseDeleteStore.deleteSession(leaseDeleteWorkspace.id, ownerClientId), false);
  leaseDeleteStore.close();

  assert.equal(workspace.mode, "checkout");
  assert.deepEqual(
    agentsFiles.map((file) => file.content),
    ["global override instructions\n", "root instructions\n"],
  );
  assert.deepEqual(
    availableAgentsFiles.map((file) => file.path),
    [],
  );
  assert.equal(instructionScan.complete, true);
  assert.equal(instructionScan.lazy, true);
  assert.equal(instructionScan.directoriesScanned, 0);
  const workspaceSkill = workspace.skills.find((skill) => skill.name === "workspace-skill");
  assert(workspaceSkill);
  const promptedSkillPath = formatPathForPrompt(workspaceSkill.filePath);
  const workspaceSkillRead = registry.resolveReadPath(workspace, promptedSkillPath);
  assert.equal(workspaceSkillRead.skillRead?.isSkillFile, true);
  assert.equal(workspaceSkillRead.absolutePath, workspaceSkill.filePath);
  const workspaceSkillReference = join(workspaceSkill.baseDir, "reference.md");
  assert.throws(
    () => registry.resolveReadPath(workspace, workspaceSkillReference),
    /outside (workspace root|allowed roots)/i,
  );
  registry.markReadPathLoaded(workspace, workspaceSkillRead, false);
  assert.throws(
    () => registry.resolveReadPath(workspace, workspaceSkillReference),
    /outside (workspace root|allowed roots)/i,
  );
  registry.markReadPathLoaded(workspace, workspaceSkillRead, true);
  assert.equal(
    registry.resolveReadPath(workspace, workspaceSkillReference).absolutePath,
    workspaceSkillReference,
  );

  const priorityDirectory = join(root, "instruction-priority");
  await mkdir(priorityDirectory);
  await writeFile(join(priorityDirectory, "AGENTS.md"), "ordinary instructions\n");
  await writeFile(join(priorityDirectory, "CLAUDE.md"), "claude instructions\n");
  await writeFile(join(priorityDirectory, "AGENTS.override.md"), "override instructions\n");
  const priorityInstructions = await registry.loadApplicableAgentsFiles(
    workspace,
    ["instruction-priority/file.txt"],
  );
  assert.deepEqual(
    priorityInstructions.map((file) => ({ path: file.path, content: file.content })),
    [{
      path: join(canonicalRoot, "instruction-priority", "AGENTS.override.md"),
      content: "override instructions\n",
    }],
  );

  const fallbackProject = join(root, "fallback-project");
  await mkdir(join(fallbackProject, "nested"), { recursive: true });
  await writeFile(join(fallbackProject, "TEAM_GUIDE.md"), "root fallback instructions\n");
  await writeFile(join(fallbackProject, "AGENTS.md"), "root ordinary instructions\n");
  await writeFile(join(fallbackProject, "AGENTS.override.md"), "root override instructions\n");
  await writeFile(join(fallbackProject, "nested", "TEAM_GUIDE.md"), "nested fallback instructions\n");
  const canonicalFallbackProject = await realpath(fallbackProject);
  const fallbackConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".fallback-config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_PROJECT_DOC_FALLBACK_FILENAMES: "TEAM_GUIDE.md",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const fallbackRegistry = new WorkspaceRegistry(fallbackConfig);
  const fallbackOpen = await fallbackRegistry.openWorkspace(ownerClientId, fallbackProject);
  assert.deepEqual(
    fallbackOpen.agentsFiles
      .filter((file) => file.path.startsWith(canonicalFallbackProject))
      .map((file) => ({ path: file.path, content: file.content })),
    [{
      path: join(canonicalFallbackProject, "AGENTS.override.md"),
      content: "root override instructions\n",
    }],
  );
  const nestedFallback = await fallbackRegistry.loadApplicableAgentsFiles(
    fallbackOpen.workspace,
    ["nested/file.txt"],
  );
  assert.deepEqual(
    nestedFallback.map((file) => ({ path: file.path, content: file.content })),
    [{
      path: join(canonicalFallbackProject, "nested", "TEAM_GUIDE.md"),
      content: "nested fallback instructions\n",
    }],
  );
  await rm(join(fallbackProject, "AGENTS.override.md"));
  const fallbackWithoutOverride = await fallbackRegistry.openWorkspace(ownerClientId, fallbackProject);
  assert.deepEqual(
    fallbackWithoutOverride.agentsFiles
      .filter((file) => file.path.startsWith(canonicalFallbackProject))
      .map((file) => file.content),
    ["root ordinary instructions\n"],
  );
  await rm(join(fallbackProject, "AGENTS.md"));
  const fallbackOnly = await fallbackRegistry.openWorkspace(ownerClientId, fallbackProject);
  assert.deepEqual(
    fallbackOnly.agentsFiles
      .filter((file) => file.path.startsWith(canonicalFallbackProject))
      .map((file) => file.content),
    ["root fallback instructions\n"],
  );
  const nestedInstructions = await registry.loadApplicableAgentsFiles(workspace, ["nested/file.txt"]);
  assert.deepEqual(nestedInstructions.map(({ path, content }) => ({ path, content })), [{
    path: join(canonicalRoot, "nested", "AGENTS.md"),
    content: "nested instructions\n",
  }]);
  await registry.markAgentsFilesDelivered(workspace, nestedInstructions);
  assert.deepEqual(await registry.loadApplicableAgentsFiles(workspace, ["nested/file.txt"]), []);
  await writeFile(join(root, "nested", "AGENTS.md"), "updated nested instructions\n");
  const updatedNestedInstructions = await registry.loadApplicableAgentsFiles(workspace, ["nested/file.txt"]);
  assert.deepEqual(
    updatedNestedInstructions.map((file) => file.content),
    ["updated nested instructions\n"],
  );
  await registry.markAgentsFilesDelivered(workspace, updatedNestedInstructions);
  const mutationInstructions = await registry.loadApplicableAgentsFiles(
    workspace,
    ["nested/file.txt"],
    { requireAcknowledged: true },
  );
  assert.equal(mutationInstructions.length, 1);
  const generationBeforeAcknowledgement = registry.instructionAcknowledgementGeneration(workspace);
  const instructionToken = await registry.createInstructionAcknowledgement(workspace, mutationInstructions);
  await registry.acknowledgeInstructions(workspace, instructionToken);
  assert.equal(registry.instructionAcknowledgementGeneration(workspace), generationBeforeAcknowledgement + 1);
  assert.deepEqual(
    await registry.loadApplicableAgentsFiles(workspace, ["nested/file.txt"], { requireAcknowledged: true }),
    [],
  );
  await assert.rejects(
    registry.acknowledgeInstructions(workspace, instructionToken),
    /Unknown or expired instructionToken/,
  );
  const currentWorkspace = registry.getWorkspace(ownerClientId, workspace.id);
  const expiringToken = await registry.createInstructionAcknowledgement(currentWorkspace, []);
  currentWorkspace.pendingInstructionAcknowledgements.get(expiringToken)!.createdAt = 0;
  assert.deepEqual(registry.cleanupLifecycleState(), {
    expiredInstructionTokens: 1,
    deletedClosedWorkspaceSessions: 0,
  });
  await assert.rejects(
    registry.acknowledgeInstructions(currentWorkspace, expiringToken),
    /Unknown or expired instructionToken/,
  );

  const lateInstructionDir = join(root, "late-instructions");
  await mkdir(lateInstructionDir);
  assert.deepEqual(await registry.loadApplicableAgentsFiles(workspace, ["late-instructions/new.txt"]), []);
  await writeFile(join(lateInstructionDir, "AGENTS.md"), "late instructions\n");
  const lateInstructions = await registry.loadApplicableAgentsFiles(workspace, ["late-instructions/new.txt"]);
  assert.deepEqual(lateInstructions.map(({ path, content }) => ({ path, content })), [
    { path: join(canonicalRoot, "late-instructions", "AGENTS.md"), content: "late instructions\n" },
  ]);
  await registry.markAgentsFilesDelivered(workspace, lateInstructions);
  const lateMutationInstructions = await registry.loadApplicableAgentsFiles(
    workspace,
    ["late-instructions/new.txt"],
    { requireAcknowledged: true },
  );
  await writeFile(join(lateInstructionDir, "AGENTS.md"), "changed before token\n");
  await assert.rejects(
    registry.createInstructionAcknowledgement(workspace, lateMutationInstructions),
    /changed while preparing instructionToken/,
  );
  assert.throws(() => registry.getWorkspace("client-b", workspace.id), /Unknown workspaceId/);
  assert.deepEqual(
    workspace.agentProfiles.map((profile) => ({
      name: profile.name,
      description: profile.description,
      provider: profile.provider,
      body: profile.body,
    })),
    [
      {
        name: "reviewer",
        description: "Read-only project reviewer.",
        provider: "codex",
        body: "Review only.",
      },
    ],
  );

  if (platform() !== "win32") {
    const canonicalScope = join(root, "canonical-scope");
    await mkdir(join(canonicalScope, "deep"), { recursive: true });
    await writeFile(join(canonicalScope, "AGENTS.md"), "canonical parent instructions\n");
    await writeFile(join(canonicalScope, "deep", "AGENTS.md"), "canonical deep instructions\n");
    await writeFile(join(canonicalScope, "deep", "file.txt"), "inside\n");
    await symlink(join(canonicalScope, "deep"), join(root, "scope-link"));
    const symlinkInstructions = await registry.loadApplicableAgentsFiles(workspace, ["scope-link/file.txt"]);
    assert.deepEqual(
      symlinkInstructions.map(({ path, content }) => ({ path, content })),
      [
        { path: join(canonicalRoot, "canonical-scope", "AGENTS.md"), content: "canonical parent instructions\n" },
        { path: join(canonicalRoot, "canonical-scope", "deep", "AGENTS.md"), content: "canonical deep instructions\n" },
      ],
    );

    const unsafeAgentDir = join(root, ".pi", "unsafe-agent");
    await mkdir(unsafeAgentDir, { recursive: true });
    await writeFile(join(outsideRoot, "secret.txt"), "outside secret\n");
    await symlink(join(outsideRoot, "secret.txt"), join(unsafeAgentDir, "AGENTS.md"));
    const unsafeConfig = loadConfig({
      DEVSPACE_CONFIG_DIR: join(root, ".devspace-unsafe-home"),
      DEVSPACE_ALLOWED_ROOTS: root,
      DEVSPACE_WORKTREE_ROOT: join(root, ".devspace", "unsafe-worktrees"),
      DEVSPACE_AGENT_DIR: unsafeAgentDir,
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });
    const unsafeWorkspace = await new WorkspaceRegistry(unsafeConfig).openWorkspace(ownerClientId, root);
    assert.deepEqual(
      unsafeWorkspace.agentsFiles.map((file) => file.content),
      ["root instructions\n"],
    );

    const workspaceLeak = join(root, "workspace-leak.txt");
    await symlink(join(outsideRoot, "secret.txt"), workspaceLeak);
    assert.throws(
      () => registry.confineReadPath(registry.resolveReadPath(workspace, workspaceLeak)),
      /outside allowed roots/,
    );
  }

  const missingWorkspaceRoot = join(root, "missing", "workspace");
  const missingWorkspace = await registry.openWorkspace(ownerClientId, missingWorkspaceRoot);
  assert.equal(missingWorkspace.workspace.root, await realpath(missingWorkspaceRoot));
  assert.equal(missingWorkspace.workspace.mode, "checkout");
  assert.equal((await stat(missingWorkspaceRoot)).isDirectory(), true);

  {
    let mkdirCalls = 0;
    const existingStats = await ensureCheckoutWorkspaceRoot(root, {
      stat: async (path) => {
        assert.equal(path, root);
        return await stat(path);
      },
      mkdir: async () => {
        mkdirCalls += 1;
      },
    });
    assert.equal(existingStats.isDirectory(), true);
    assert.equal(mkdirCalls, 0);
  }

  await assert.rejects(
    () => registry.openWorkspace(ownerClientId, { path: root, mode: "worktree" }),
    (error: unknown) =>
      error instanceof GitWorktreeError && error.code === "GIT_REPOSITORY_NOT_FOUND",
  );

  const gitRoot = join(root, "git-project");
  await mkdir(gitRoot);
  await writeFile(join(gitRoot, "AGENTS.md"), "git root instructions\n");
  await writeFile(join(gitRoot, "README.md"), "hello\n");
  await git(gitRoot, ["init"]);
  await git(gitRoot, ["config", "user.email", "devspace@example.com"]);
  await git(gitRoot, ["config", "user.name", "DevSpace Test"]);
  await git(gitRoot, ["add", "."]);
  await git(gitRoot, ["commit", "-m", "Initial commit"]);
  await writeFile(join(gitRoot, "dirty.txt"), "not copied\n");

  const worktreeWorkspace = await registry.openWorkspace(ownerClientId, {
    path: gitRoot,
    mode: "worktree",
  });
  assert.equal(worktreeWorkspace.workspace.mode, "worktree");
  assert.notEqual(worktreeWorkspace.workspace.root, gitRoot);
  assert.match(worktreeWorkspace.workspace.root, /git-project-[a-f0-9]{8}$/);
  assert.equal(worktreeWorkspace.workspace.sourceRoot, gitRoot);
  assert.equal(worktreeWorkspace.workspace.worktree?.baseRef, "HEAD");
  assert.equal(worktreeWorkspace.workspace.worktree?.dirtySource, true);
  assert.equal(worktreeWorkspace.workspace.worktree?.managed, true);
  assert.equal((await stat(worktreeWorkspace.workspace.root)).isDirectory(), true);
  assert.match(worktreeWorkspace.agentsFiles.map((file) => file.content).join("\n"), /global override instructions/);
  assert.match(worktreeWorkspace.agentsFiles.map((file) => file.content).join("\n"), /git root instructions/);

  const cappedConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".devspace-capped-home"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".devspace", "capped-worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_MAX_MANAGED_WORKTREES: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const cappedStore = new SqliteWorkspaceStore(join(root, ".capped-state"));
  const cappedRegistry = new WorkspaceRegistry(cappedConfig, cappedStore);
  const concurrentWorktrees = await Promise.allSettled([
    cappedRegistry.openWorkspace(ownerClientId, { path: gitRoot, mode: "worktree" }),
    cappedRegistry.openWorkspace(ownerClientId, { path: gitRoot, mode: "worktree" }),
  ]);
  assert.equal(concurrentWorktrees.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrentWorktrees.filter((result) => result.status === "rejected").length, 1);
  const cappedWorkspace = concurrentWorktrees.find(
    (result): result is PromiseFulfilledResult<Awaited<ReturnType<WorkspaceRegistry["openWorkspace"]>>> =>
      result.status === "fulfilled",
  )!.value.workspace;
  const cappedRemoval = await removeManagedWorktree({
    sourceRoot: gitRoot,
    worktreePath: cappedWorkspace.root,
    config: cappedConfig,
  });
  assert.equal(cappedRemoval.removed, true);
  assert.equal(cappedRegistry.deleteWorkspace(ownerClientId, cappedWorkspace.id), true);
  cappedStore.close();

  const worktreesBeforeRollback = (await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: gitRoot })).stdout;
  const failingStore: WorkspaceStore = {
    createSession() {
      throw new Error("store failed");
    },
    getSession: () => undefined,
    touchSession: () => undefined,
    closeSession: () => false,
    deleteSession: () => false,
    countManagedWorktrees: () => 0,
    listExpiredSessions: () => [],
    isReady: () => true,
  };
  await assert.rejects(
    new WorkspaceRegistry(config, failingStore).openWorkspace(ownerClientId, {
      path: gitRoot,
      mode: "worktree",
    }),
    /store failed/,
  );
  const worktreesAfterRollback = (await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: gitRoot })).stdout;
  assert.equal(worktreesAfterRollback, worktreesBeforeRollback);

  const worktreeReadmePath = registry.resolvePath(worktreeWorkspace.workspace, "README.md");
  assert.equal(worktreeReadmePath.startsWith(worktreeWorkspace.workspace.root), true);

  const stateDir = join(root, ".state");
  const firstStore = new SqliteWorkspaceStore(stateDir);
  const persistentRegistry = new WorkspaceRegistry(config, firstStore);
  const persistentWorkspace = await persistentRegistry.openWorkspace(ownerClientId, root);
  const persistentWorktree = await persistentRegistry.openWorkspace(ownerClientId, {
    path: gitRoot,
    mode: "worktree",
  });
  assert.notEqual(persistentWorktree.workspace.id, worktreeWorkspace.workspace.id);
  const repeatedPersistentWorkspace = await persistentRegistry.openWorkspace(ownerClientId, root);
  assert.equal(repeatedPersistentWorkspace.workspace.id, persistentWorkspace.workspace.id);
  firstStore.close();

  const secondStore = new SqliteWorkspaceStore(stateDir);
  const restoredRegistry = new WorkspaceRegistry(config, secondStore);
  const reopenedWorkspace = await restoredRegistry.openWorkspace(ownerClientId, root);
  assert.equal(reopenedWorkspace.workspace.id, persistentWorkspace.workspace.id);
  const restoredWorkspace = restoredRegistry.getWorkspace(ownerClientId, persistentWorkspace.workspace.id);
  assert.equal(restoredWorkspace.root, canonicalRoot);
  assert.equal(restoredWorkspace.mode, "checkout");
  assert.deepEqual(
    secondStore.listExpiredSessions(new Date(Date.now() + 1_000).toISOString(), 1).map((session) => session.id),
    [persistentWorkspace.workspace.id],
  );

  assert.throws(
    () => restoredRegistry.getWorkspace("client-b", persistentWorkspace.workspace.id),
    /Unknown workspaceId/,
  );
  const persistedOtherOwner = await restoredRegistry.openWorkspace("client-b", root);
  assert.notEqual(persistedOtherOwner.workspace.id, persistentWorkspace.workspace.id);
  assert.equal(restoredRegistry.closeWorkspace("client-b", persistedOtherOwner.workspace.id), true);
  const restoredWorktree = restoredRegistry.getWorkspace(ownerClientId, persistentWorktree.workspace.id);
  assert.equal(restoredWorktree.mode, "worktree");
  assert.equal(restoredWorktree.sourceRoot, gitRoot);
  assert.equal(restoredWorktree.root, persistentWorktree.workspace.root);
  assert.equal(restoredWorktree.worktree?.managed, true);
  assert.equal(restoredRegistry.closeWorkspace("client-b", persistentWorkspace.workspace.id), false);
  assert.equal(restoredRegistry.closeWorkspace(ownerClientId, persistentWorkspace.workspace.id), true);
  assert.deepEqual(restoredRegistry.cleanupLifecycleState(Date.now() + 31 * 24 * 60 * 60_000), {
    expiredInstructionTokens: 0,
    deletedClosedWorkspaceSessions: 2,
  });
  assert.throws(
    () => restoredRegistry.getWorkspace(ownerClientId, persistentWorkspace.workspace.id),
    /Unknown workspaceId/,
  );
  const removal = await removeManagedWorktree({
    sourceRoot: gitRoot,
    worktreePath: restoredWorktree.root,
    config,
  });
  assert.equal(removal.removed, true);
  assert.equal(restoredRegistry.deleteWorkspace(ownerClientId, persistentWorktree.workspace.id), true);
  await assert.rejects(stat(restoredWorktree.root));
  const expired = restoredRegistry.closeExpiredSessions(-1, () => false);
  assert.deepEqual(expired, []);
  secondStore.close();

  const concurrentStateDir = join(root, ".concurrent-state");
  const concurrentStoreA = new SqliteWorkspaceStore(concurrentStateDir);
  const concurrentStoreB = new SqliteWorkspaceStore(concurrentStateDir);
  const concurrentRegistryA = new WorkspaceRegistry(config, concurrentStoreA);
  const concurrentRegistryB = new WorkspaceRegistry(config, concurrentStoreB);
  const [storedConcurrentA, storedConcurrentB] = await Promise.all([
    concurrentRegistryA.openWorkspace(ownerClientId, root),
    concurrentRegistryB.openWorkspace(ownerClientId, root),
  ]);
  assert.equal(storedConcurrentA.workspace.id, storedConcurrentB.workspace.id);
  concurrentStoreA.close();
  concurrentStoreB.close();

  const legacyStateDir = join(root, ".legacy-state");
  await mkdir(legacyStateDir, { recursive: true });
  const legacyDatabase = new Database(databasePath(legacyStateDir));
  legacyDatabase.exec(`
    create table devspace_schema_migrations (
      version integer primary key,
      name text not null,
      applied_at text not null
    );
    insert into devspace_schema_migrations values
      (1, 'workspace-state', '2026-01-01T00:00:00.000Z'),
      (2, 'oauth-state', '2026-01-01T00:00:00.000Z'),
      (3, 'local-agent-sessions', '2026-01-01T00:00:00.000Z'),
      (4, 'workspace-oauth-ownership', '2026-01-01T00:00:00.000Z');
    create table workspace_sessions (
      id text primary key,
      owner_client_id text not null default '__legacy_unowned__',
      root text not null,
      status text not null default 'active',
      mode text not null default 'checkout',
      source_root text,
      base_ref text,
      base_sha text,
      managed text not null default 'false',
      created_at text not null,
      last_used_at text not null
    );
  `);
  legacyDatabase.prepare(`
    insert into workspace_sessions (
      id, owner_client_id, root, status, mode, managed, created_at, last_used_at
    ) values (
      'ws_legacy', 'client-a', ?, 'active', 'checkout', 'false',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    )
  `).run(canonicalRoot);
  legacyDatabase.close();
  new SqliteWorkspaceStore(legacyStateDir).close();
  const migratedLegacyDatabase = new Database(databasePath(legacyStateDir), { readonly: true });
  assert.deepEqual(
    migratedLegacyDatabase.prepare(
      "select id, status, canonical_root as canonicalRoot from workspace_sessions",
    ).get(),
    { id: "ws_legacy", status: "active", canonicalRoot: null },
  );
  assert.equal(
    migratedLegacyDatabase.prepare(
      "select count(*) from sqlite_master where type = 'index' and name = 'workspace_sessions_active_checkout_owner_canonical_root_uq'",
    ).pluck().get(),
    1,
  );
  migratedLegacyDatabase.close();
  const migratedLegacyStore = new SqliteWorkspaceStore(legacyStateDir);
  const adoptedLegacy = await new WorkspaceRegistry(config, migratedLegacyStore).openWorkspace(
    ownerClientId,
    root,
  );
  assert.equal(adoptedLegacy.workspace.id, "ws_legacy");
  assert.equal(adoptedLegacy.reused, true);
  migratedLegacyStore.close();

  if (platform() !== "win32") {
    const escapedCheckoutRoot = join(root, "escaped-checkout-root");
    await symlink(outsideRoot, escapedCheckoutRoot, "dir");
    await assert.rejects(
      registry.openWorkspace(ownerClientId, escapedCheckoutRoot),
      /Path is outside allowed roots/,
    );
    const escapedStateDir = join(root, ".escaped-checkout-state");
    const escapedStore = new SqliteWorkspaceStore(escapedStateDir);
    escapedStore.createSession({
      id: "ws_escaped_checkout",
      ownerClientId,
      root: escapedCheckoutRoot,
      mode: "checkout",
    });
    assert.throws(
      () => new WorkspaceRegistry(config, escapedStore).getWorkspace(
        ownerClientId,
        "ws_escaped_checkout",
      ),
      /Path is outside allowed roots/,
    );
    escapedStore.close();

    const aliasRoot = join(root, "alias-root");
    await symlink(root, aliasRoot, "dir");
    const aliasConfig = loadConfig({
      DEVSPACE_ALLOWED_ROOTS: aliasRoot,
      DEVSPACE_WORKTREE_ROOT: join(aliasRoot, ".devspace", "alias-worktrees"),
      DEVSPACE_AGENT_DIR: agentDir,
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });
    const aliasWorkspace = await new WorkspaceRegistry(aliasConfig).openWorkspace(ownerClientId, {
      path: join(aliasRoot, "git-project"),
      mode: "worktree",
    });
    assert.equal(aliasWorkspace.workspace.sourceRoot, join(aliasRoot, "git-project"));

    const aliasCheckout = await new WorkspaceRegistry(aliasConfig).openWorkspace(ownerClientId, aliasRoot);
    assert.deepEqual(
      aliasCheckout.agentsFiles.map((file) => file.content),
      ["global override instructions\n", "root instructions\n"],
    );

    const aliasReuseStore = new SqliteWorkspaceStore(join(root, ".alias-reuse-state"));
    const aliasReuseRegistry = new WorkspaceRegistry(config, aliasReuseStore);
    const realCheckout = await aliasReuseRegistry.openWorkspace(ownerClientId, root);
    const aliasedCheckout = await aliasReuseRegistry.openWorkspace(ownerClientId, aliasRoot);
    assert.equal(aliasedCheckout.workspace.id, realCheckout.workspace.id);
    aliasReuseStore.close();
    const restoredAliasStore = new SqliteWorkspaceStore(join(root, ".alias-reuse-state"));
    const restoredAlias = new WorkspaceRegistry(aliasConfig, restoredAliasStore).getWorkspace(
      ownerClientId,
      realCheckout.workspace.id,
    );
    assert.equal(restoredAlias.root, canonicalRoot);
    restoredAliasStore.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
