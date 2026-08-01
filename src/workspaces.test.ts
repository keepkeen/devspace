import {
  mkdtemp,
  mkdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { basename, join } from "node:path";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { loadConfig } from "./config.js";
import { databasePath, openDatabase } from "./db/client.js";
import { MAX_PROJECT_INSTRUCTION_BYTES } from "./project-instructions.js";
import { SqliteWorkspaceStore, type WorkspaceStore } from "./workspace-store.js";
import {
  InstructionBudgetError,
  UnknownWorkspaceError,
  WorkspaceRegistry,
} from "./workspaces.js";
import { formatPathForPrompt } from "./skills.js";

const root = await mkdtemp(join(tmpdir(), "devspace-workspace-test-"));
const outsideRoot = await mkdtemp(join(tmpdir(), "devspace-workspace-outside-test-"));
const canonicalRoot = await realpath(root);
const connectionPrincipalId = "owner";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

assert.equal(
  new UnknownWorkspaceError("ws_old").message,
  "The Project execution runtime is no longer available.",
);
assert.equal(new InstructionBudgetError("internal path details").publicText.includes("path"), false);

try {
  process.env.HOME = canonicalRoot;
  process.env.USERPROFILE = canonicalRoot;
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
  const userInstructionsPath = join(agentDir, "AGENTS.override.md");
  await writeFile(join(root, "AGENTS.md"), "root instructions\n");
  await mkdir(join(agentDir, "skills", "workspace-skill"), { recursive: true });
  await writeFile(
    join(agentDir, "skills", "workspace-skill", "SKILL.md"),
    "---\nname: workspace-skill\ndescription: Workspace test skill.\n---\n\n# Skill\n",
  );
  await writeFile(join(agentDir, "skills", "workspace-skill", "reference.md"), "reference\n");
  const mutableSkillManifest = join(agentDir, "skills", "mutable-skill", "SKILL.md");
  await mkdir(join(agentDir, "skills", "mutable-skill"), { recursive: true });
  await writeFile(
    mutableSkillManifest,
    "---\nname: mutable-skill\ndescription: Must remain stable while loading.\n---\n",
  );
  const mutableMetadataSkillDir = join(agentDir, "skills", "mutable-metadata-skill");
  await mkdir(join(mutableMetadataSkillDir, "agents"), { recursive: true });
  await writeFile(
    join(mutableMetadataSkillDir, "SKILL.md"),
    "---\nname: mutable-metadata-skill\ndescription: Policy must remain stable while loading.\n---\n",
  );
  const mutableOpenAiMetadata = join(mutableMetadataSkillDir, "agents", "openai.yaml");
  await writeFile(
    mutableOpenAiMetadata,
    "interface:\n  display_name: Before discovery\npolicy:\n  allow_implicit_invocation: false\n",
  );
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "AGENTS.md"), "nested instructions\n");
  await writeFile(join(root, "nested", "file.txt"), "hello\n");

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".devspace-home"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_SKILL_PATHS: join(agentDir, "skills"),
    DEVSPACE_USER_INSTRUCTIONS_PATH: userInstructionsPath,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const pendingRegistry = new WorkspaceRegistry(config);
  const [pendingCreator, pendingWaiter] = await Promise.all([
    pendingRegistry.openWorkspace(connectionPrincipalId, root),
    pendingRegistry.openWorkspace(connectionPrincipalId, root),
  ]);
  assert.equal(pendingCreator.workspace.id, pendingWaiter.workspace.id);
  assert.deepEqual(
    [pendingCreator.reused, pendingWaiter.reused].sort(),
    [false, true],
  );

  const managedWorktreeRoot = join(
    config.stateDir,
    "worktrees",
    "project-test",
    "thread-test",
  );
  await mkdir(managedWorktreeRoot, { recursive: true });
  await writeFile(join(managedWorktreeRoot, "AGENTS.md"), "managed worktree instructions\n");
  const managedRegistry = new WorkspaceRegistry(config);
  const managedContext = await managedRegistry.openManagedProjectExecution(
    connectionPrincipalId,
    {
      executionId: "managed-execution",
      sourceRoot: root,
      worktreeRoot: managedWorktreeRoot,
      writeAccess: "read_write",
    },
    [root],
  );
  assert.equal(managedContext.workspace.root, await realpath(managedWorktreeRoot));
  assert.equal(managedContext.workspace.writeAccess, "read_write");
  assert.deepEqual(
    managedContext.agentsFiles.map((file) => file.content),
    ["global override instructions\n", "managed worktree instructions\n"],
  );
  await assert.rejects(
    managedRegistry.openManagedProjectExecution(
      connectionPrincipalId,
      {
        executionId: "escaped-managed-execution",
        sourceRoot: root,
        worktreeRoot: outsideRoot,
        writeAccess: "read_write",
      },
      [root],
    ),
    /outside the trusted state root/,
  );

  const pendingAliasStore = createTestWorkspaceStore(join(root, ".pending-alias-state"));
  const pendingAliasRegistry = new WorkspaceRegistry(config, pendingAliasStore);
  const pendingAliasResults = await Promise.allSettled([
    pendingAliasRegistry.openWorkspace(connectionPrincipalId, {
      path: root,
      alias: "pending-alpha",
      writeAccess: "read_only",
    }),
    pendingAliasRegistry.openWorkspace(connectionPrincipalId, {
      path: root,
      alias: "pending-beta",
      writeAccess: "read_write",
    }),
  ]);
  assert.equal(
    pendingAliasResults.filter((result) => result.status === "fulfilled").length,
    2,
  );
  const pendingAliasContexts = pendingAliasResults.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : []
  );
  assert.notEqual(
    pendingAliasContexts[0]?.workspace.id,
    pendingAliasContexts[1]?.workspace.id,
  );
  assert.equal(
    pendingAliasContexts[0]?.workspace.root,
    pendingAliasContexts[1]?.workspace.root,
  );
  pendingAliasStore.close();

  const pendingAccessStore = createTestWorkspaceStore(join(root, ".pending-access-state"));
  const pendingAccessRegistry = new WorkspaceRegistry(config, pendingAccessStore);
  const [pendingReadOnly, pendingReadWrite] = await Promise.all([
    pendingAccessRegistry.openWorkspace(connectionPrincipalId, {
      path: root,
      alias: "pending-access",
      writeAccess: "read_only",
    }),
    pendingAccessRegistry.openWorkspace(connectionPrincipalId, {
      path: root,
      alias: "pending-access",
      writeAccess: "read_write",
    }),
  ]);
  assert.equal(pendingReadOnly.workspace.id, pendingReadWrite.workspace.id);
  assert.ok(["read_only", "read_write"].includes(pendingReadWrite.workspace.writeAccess));
  assert.equal(pendingReadWrite.workspace.stateGeneration, 2);
  pendingAccessStore.close();

  const registry = new WorkspaceRegistry(config);
  const {
    workspace,
    agentsFiles,
    instructionRevision,
    skillRevision,
    availableAgentsFiles,
    instructionScan,
    reused,
  } = await registry.openWorkspace(connectionPrincipalId, root);
  assert.equal(reused, false);
  assert.match(instructionRevision, /^sha256-v1:[A-Za-z0-9_-]{43}$/);
  assert.match(skillRevision, /^sha256-v1:[A-Za-z0-9_-]{43}$/);
  const instructionContextId = registry.createInstructionContext(workspace);
  await registry.markAgentsFilesDelivered(workspace, instructionContextId, agentsFiles);
  const sequentialCheckout = await registry.openWorkspace(connectionPrincipalId, root);
  assert.equal(sequentialCheckout.reused, true);
  assert.equal(sequentialCheckout.instructionRevision, instructionRevision);
  assert.equal(sequentialCheckout.skillRevision, skillRevision);
  assert.equal(sequentialCheckout.workspace.id, workspace.id);
  const [concurrentCheckoutA, concurrentCheckoutB] = await Promise.all([
    registry.openWorkspace(connectionPrincipalId, root),
    registry.openWorkspace(connectionPrincipalId, root),
  ]);
  assert.equal(concurrentCheckoutA.workspace.id, workspace.id);
  assert.equal(concurrentCheckoutB.workspace.id, workspace.id);
  assert.equal(concurrentCheckoutA.reused, true);
  assert.equal(concurrentCheckoutB.reused, true);
  const generationRegistry = new WorkspaceRegistry({ ...config, allowedRoots: [root] });
  const generationWorkspace = (await generationRegistry.openWorkspace(connectionPrincipalId, root)).workspace;
  const generationBeforeRootChange = generationWorkspace.stateGeneration;
  generationRegistry.applyAllowedRoots([root, outsideRoot]);
  assert.equal(generationWorkspace.stateGeneration, generationBeforeRootChange + 1);
  assert.throws(
    () => generationRegistry.getWorkspace(
      connectionPrincipalId,
      generationWorkspace.id,
      generationBeforeRootChange,
    ),
    /Project execution runtime is stale/,
  );

  const rediscoveredSkills = await new WorkspaceRegistry(config).openWorkspace(connectionPrincipalId, root);
  assert.equal(rediscoveredSkills.skillRevision, skillRevision);

  const emptySkillsProject = join(root, "empty-skills-project");
  const otherEmptySkillsProject = join(root, "other-empty-skills-project");
  await mkdir(emptySkillsProject);
  await mkdir(otherEmptySkillsProject);
  const emptySkillsConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".empty-skills-config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_SKILLS: "0",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const emptySkillsOpen = await new WorkspaceRegistry(emptySkillsConfig)
    .openWorkspace(connectionPrincipalId, emptySkillsProject);
  const repeatedEmptySkillsOpen = await new WorkspaceRegistry(emptySkillsConfig)
    .openWorkspace(connectionPrincipalId, emptySkillsProject);
  const otherEmptySkillsOpen = await new WorkspaceRegistry(emptySkillsConfig)
    .openWorkspace(connectionPrincipalId, otherEmptySkillsProject);
  assert.deepEqual(emptySkillsOpen.workspace.skills, []);
  assert.equal(repeatedEmptySkillsOpen.skillRevision, emptySkillsOpen.skillRevision);
  assert.notEqual(otherEmptySkillsOpen.skillRevision, emptySkillsOpen.skillRevision);

  const revisionSkillDir = join(root, "revision-skill");
  const revisionSkillManifest = join(revisionSkillDir, "SKILL.md");
  await mkdir(join(revisionSkillDir, "agents"), { recursive: true });
  await writeFile(
    revisionSkillManifest,
    "---\nname: revision-skill\ndescription: First description.\n---\n",
  );
  const revisionSkillMetadata = join(revisionSkillDir, "agents", "openai.yaml");
  await writeFile(revisionSkillMetadata, "policy:\n  allow_implicit_invocation: true\n");
  const skillRevisionConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".skill-revision-config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_SKILL_PATHS: revisionSkillDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const initialSkillRevision = await new WorkspaceRegistry(skillRevisionConfig)
    .openWorkspace(connectionPrincipalId, emptySkillsProject);
  await writeFile(
    revisionSkillManifest,
    "---\nname: revision-skill\ndescription: Changed description.\n---\n",
  );
  const manifestChangedSkillRevision = await new WorkspaceRegistry(skillRevisionConfig)
    .openWorkspace(connectionPrincipalId, emptySkillsProject);
  assert.notEqual(manifestChangedSkillRevision.skillRevision, initialSkillRevision.skillRevision);
  await writeFile(revisionSkillMetadata, "policy:\n  allow_implicit_invocation: false\n");
  const policyChangedSkillRevision = await new WorkspaceRegistry(skillRevisionConfig)
    .openWorkspace(connectionPrincipalId, emptySkillsProject);
  assert.notEqual(policyChangedSkillRevision.skillRevision, manifestChangedSkillRevision.skillRevision);

  const residentSkillRegistry = new WorkspaceRegistry(skillRevisionConfig);
  const residentSkillContext = await residentSkillRegistry.openWorkspace(connectionPrincipalId, emptySkillsProject);
  const residentRevisionSkill = residentSkillContext.workspace.skills.find(
    (skill) => skill.name === "revision-skill",
  )!;
  await residentSkillRegistry.loadSkill(
    connectionPrincipalId,
    residentSkillContext.workspace.id,
    residentRevisionSkill.skillId,
  );
  const originalDateNow = Date.now;
  const unchangedResidentContext = await (async () => {
    try {
      Date.now = () => 4_242_424_242;
      return await residentSkillRegistry.resumeWorkspace(
        connectionPrincipalId,
        residentSkillContext.workspace.alias,
      );
    } finally {
      Date.now = originalDateNow;
    }
  })();
  assert.equal(unchangedResidentContext.workspace.lastUsedAt, 4_242_424_242);
  assert.equal(
    unchangedResidentContext.workspace.activatedSkillDirs.has(residentRevisionSkill.baseDir),
    true,
  );
  await writeFile(
    revisionSkillManifest,
    "---\nname: revision-skill\ndescription: Resident refresh description.\n---\n",
  );
  const refreshedResidentContext = await residentSkillRegistry.resumeWorkspace(
    connectionPrincipalId,
    residentSkillContext.workspace.alias,
  );
  assert.notEqual(refreshedResidentContext.skillRevision, residentSkillContext.skillRevision);
  assert.equal(
    refreshedResidentContext.workspace.skills.find((skill) => skill.name === "revision-skill")?.description,
    "Resident refresh description.",
  );
  assert.equal(
    refreshedResidentContext.workspace.activatedSkillDirs.has(residentRevisionSkill.baseDir),
    false,
  );

  const revisionProject = join(root, "revision-project");
  const revisionInstructionsPath = join(root, "user-revision.md");
  await mkdir(revisionProject);
  await writeFile(revisionInstructionsPath, "revision one\n");
  const revisionConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".revision-config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_USER_INSTRUCTIONS_PATH: revisionInstructionsPath,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const revisionRegistry = new WorkspaceRegistry(revisionConfig);
  const firstRevisionOpen = await revisionRegistry.openWorkspace(connectionPrincipalId, revisionProject);
  await writeFile(revisionInstructionsPath, "revision two is different\n");
  const secondRevisionOpen = await revisionRegistry.openWorkspace(connectionPrincipalId, revisionProject);
  assert.notEqual(secondRevisionOpen.instructionRevision, firstRevisionOpen.instructionRevision);
  assert.deepEqual(secondRevisionOpen.agentsFiles.map((file) => file.content), ["revision two is different\n"]);
  const alternateRevisionInstructionsPath = join(root, "alternate-user-revision.md");
  await writeFile(alternateRevisionInstructionsPath, "revision two is different\n");
  const alternateRevisionConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".alternate-revision-config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_USER_INSTRUCTIONS_PATH: alternateRevisionInstructionsPath,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const alternateRevisionOpen = await new WorkspaceRegistry(alternateRevisionConfig)
    .openWorkspace(connectionPrincipalId, revisionProject);
  assert.notEqual(alternateRevisionOpen.instructionRevision, secondRevisionOpen.instructionRevision);

  const hotReloadConfig = { ...config, allowedRoots: [root] };
  const hotReloadStore = createTestWorkspaceStore(join(root, ".hot-reload-state"));
  const hotReloadRegistry = new WorkspaceRegistry(hotReloadConfig, hotReloadStore);
  const revokedWorkspace = (await hotReloadRegistry.openWorkspace(connectionPrincipalId, root)).workspace;
  assert.throws(() => hotReloadRegistry.applyAllowedRoots([]), /At least one allowed root/);
  assert.equal(hotReloadRegistry.getWorkspace(connectionPrincipalId, revokedWorkspace.id).id, revokedWorkspace.id);
  const hotReloadResult = hotReloadRegistry.applyAllowedRoots([outsideRoot]);
  assert.equal(hotReloadResult.changed, true);
  assert.equal(hotReloadResult.added, 1);
  assert.equal(hotReloadResult.removed, 1);
  assert.deepEqual(hotReloadResult.invalidated, [{
    workspaceId: revokedWorkspace.id,
    connectionPrincipalId: connectionPrincipalId,
  }]);
  assert.equal(hotReloadStore.getSession(revokedWorkspace.id, connectionPrincipalId), undefined);
  assert.throws(
    () => hotReloadRegistry.getWorkspace(connectionPrincipalId, revokedWorkspace.id),
    /Project execution runtime is no longer available/,
  );
  await assert.rejects(
    hotReloadRegistry.openWorkspace(connectionPrincipalId, root),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /outside allowed roots/);
      assert.match(message, /original approved project path/);
      assert.match(message, /add its project root/);
      assert.doesNotMatch(message, /worktree/);
      return true;
    },
  );
  const addedWorkspace = await hotReloadRegistry.openWorkspace(connectionPrincipalId, await realpath(outsideRoot));
  assert.equal(addedWorkspace.workspace.root, await realpath(outsideRoot));
  assert.equal(hotReloadRegistry.applyAllowedRoots([outsideRoot]).changed, false);
  hotReloadStore.close();

  const historicalMissingRoot = join(root, "previously-allowed-but-missing");
  const historicalConfig = { ...config, allowedRoots: [root, historicalMissingRoot] };
  const historicalRegistry = new WorkspaceRegistry(historicalConfig);
  const historicalUpdate = historicalRegistry.applyAllowedRoots([
    root,
    historicalMissingRoot,
    outsideRoot,
  ]);
  assert.equal(historicalUpdate.changed, true);
  assert(historicalConfig.allowedRoots.includes(historicalMissingRoot));
  assert.throws(
    () => historicalRegistry.applyAllowedRoots([
      ...historicalConfig.allowedRoots,
      join(outsideRoot, "new-missing-root"),
    ]),
    /ENOENT/,
  );

  const retryStore = createTestWorkspaceStore(join(root, ".hot-reload-retry-state"));
  const retryRegistry = new WorkspaceRegistry({ ...config, allowedRoots: [root] }, retryStore);
  const retryWorkspace = (await retryRegistry.openWorkspace(connectionPrincipalId, root)).workspace;
  const closeSessions = retryStore.closeSessions.bind(retryStore);
  let failCloseOnce = true;
  retryStore.closeSessions = (sessions) => {
    if (failCloseOnce) {
      failCloseOnce = false;
      throw new Error("injected close failure");
    }
    return closeSessions(sessions);
  };
  const failedRetry = retryRegistry.applyAllowedRoots([outsideRoot]);
  assert.equal(failedRetry.persistenceFailures, 1);
  assert.deepEqual(failedRetry.invalidated, [{
    workspaceId: retryWorkspace.id,
    connectionPrincipalId: connectionPrincipalId,
  }]);
  // Re-authorizing the root must not resurrect an ID whose revocation failed
  // to persist on the first attempt.
  const reconciledRetry = retryRegistry.applyAllowedRoots([root]);
  assert.equal(reconciledRetry.changed, true);
  assert.equal(reconciledRetry.persistenceFailures, 0);
  assert.deepEqual(reconciledRetry.invalidated, [{
    workspaceId: retryWorkspace.id,
    connectionPrincipalId: connectionPrincipalId,
  }]);
  assert.equal(retryStore.getSession(retryWorkspace.id, connectionPrincipalId), undefined);
  assert.throws(
    () => retryRegistry.getWorkspace(connectionPrincipalId, retryWorkspace.id),
    /Project execution runtime is no longer available/,
  );
  retryStore.close();

  const leasedHotReloadConfig = { ...config, allowedRoots: [root] };
  const leasedHotReloadRegistry = new WorkspaceRegistry(leasedHotReloadConfig);
  const leasedHotReloadWorkspace = (
    await leasedHotReloadRegistry.openWorkspace(connectionPrincipalId, root)
  ).workspace;
  let releaseHotReloadOperation!: () => void;
  let markHotReloadOperationStarted!: () => void;
  const hotReloadOperationStarted = new Promise<void>((resolveStarted) => {
    markHotReloadOperationStarted = resolveStarted;
  });
  const hotReloadOperationBarrier = new Promise<void>((resolveOperation) => {
    releaseHotReloadOperation = resolveOperation;
  });
  const leasedHotReloadOperation = leasedHotReloadRegistry.withWorkspaceOperation(
    connectionPrincipalId,
    leasedHotReloadWorkspace.id,
    leasedHotReloadWorkspace.stateGeneration,
    async () => {
      markHotReloadOperationStarted();
      await hotReloadOperationBarrier;
      return "finished";
    },
  );
  await hotReloadOperationStarted;
  leasedHotReloadRegistry.applyAllowedRoots([outsideRoot]);
  assert.throws(
    () => leasedHotReloadRegistry.getWorkspace(connectionPrincipalId, leasedHotReloadWorkspace.id),
    /Project execution runtime is no longer available/,
  );
  releaseHotReloadOperation();
  assert.equal(await leasedHotReloadOperation, "finished");

  const lifecycleRegistry = new WorkspaceRegistry(config);
  const lifecycleWorkspace = (await lifecycleRegistry.openWorkspace(connectionPrincipalId, root)).workspace;
  assert.equal(
    lifecycleRegistry.workspaceBusy(connectionPrincipalId, lifecycleWorkspace.id),
    false,
  );
  let releaseOperation!: () => void;
  let operationStarted!: () => void;
  const operationStartedPromise = new Promise<void>((resolve) => {
    operationStarted = resolve;
  });
  const operationBarrier = new Promise<void>((resolve) => {
    releaseOperation = resolve;
  });
  const activeOperation = lifecycleRegistry.withWorkspaceOperation(
    connectionPrincipalId,
    lifecycleWorkspace.id,
    lifecycleWorkspace.stateGeneration,
    async (leasedWorkspace) => {
      operationStarted();
      await operationBarrier;
      return leasedWorkspace.id;
    },
  );
  await operationStartedPromise;
  assert.equal(
    lifecycleRegistry.workspaceBusy(connectionPrincipalId, lifecycleWorkspace.id),
    true,
  );
  const exclusiveClosePromise = lifecycleRegistry.acquireExclusiveClose(connectionPrincipalId, lifecycleWorkspace.id);
  await assert.rejects(
    lifecycleRegistry.withWorkspaceOperation(
      connectionPrincipalId,
      lifecycleWorkspace.id,
      lifecycleWorkspace.stateGeneration,
      () => undefined,
    ),
    /is closing/,
  );
  await assert.rejects(
    lifecycleRegistry.openWorkspace(connectionPrincipalId, root),
    /is closing/,
  );
  assert.deepEqual(lifecycleRegistry.usageSnapshot(connectionPrincipalId), {
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
    await lifecycleRegistry.withWorkspaceOperation(
      connectionPrincipalId,
      lifecycleWorkspace.id,
      lifecycleWorkspace.stateGeneration,
      (current) => current.id,
    ),
    lifecycleWorkspace.id,
  );
  const committedClose = await lifecycleRegistry.acquireExclusiveClose(connectionPrincipalId, lifecycleWorkspace.id);
  assert.equal(committedClose.commit(), true);
  assert.throws(
    () => lifecycleRegistry.getWorkspace(connectionPrincipalId, lifecycleWorkspace.id),
    /Project execution runtime is no longer available/,
  );
  const leaseDeleteStore = createTestWorkspaceStore(join(root, ".lease-delete-state"));
  const leaseDeleteRegistry = new WorkspaceRegistry(config, leaseDeleteStore);
  const leaseDeleteWorkspace = (await leaseDeleteRegistry.openWorkspace(connectionPrincipalId, root)).workspace;
  const deleteLease = await leaseDeleteRegistry.acquireExclusiveClose(connectionPrincipalId, leaseDeleteWorkspace.id);
  await assert.rejects(
    leaseDeleteRegistry.openWorkspace(connectionPrincipalId, root),
    /is closing/,
  );
  assert.equal(deleteLease.commit({ delete: true }), true);
  assert.equal(leaseDeleteStore.deleteSession(leaseDeleteWorkspace.id, connectionPrincipalId), false);
  leaseDeleteStore.close();

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
  assert.throws(
    () => registry.resolveReadPath(workspace, promptedSkillPath),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "skill_not_loaded" &&
      "publicText" in error &&
      error.publicText === "Call skills with action=load for the selected Project, then retry.",
  );
  const workspaceSkillReference = join(workspaceSkill.baseDir, "reference.md");
  const workspaceSkillUri = `skill://${workspaceSkill.skillId}/reference.md`;
  assert.throws(
    () => registry.resolveReadPath(workspace, workspaceSkillUri),
    /must be loaded before its files can be read/i,
  );
  const loadedWorkspaceSkill = await registry.loadSkill(
    connectionPrincipalId,
    workspace.id,
    workspaceSkill.skillId,
  );
  assert.equal(loadedWorkspaceSkill.skill.skillId, workspaceSkill.skillId);
  assert.match(loadedWorkspaceSkill.content, /workspace-skill/);
  const skillActivatedWorkspace = registry.getWorkspace(connectionPrincipalId, workspace.id);
  const workspaceSkillRead = registry.resolveReadPath(skillActivatedWorkspace, promptedSkillPath);
  assert.equal(workspaceSkillRead.skillRead?.isSkillFile, true);
  assert.equal(workspaceSkillRead.absolutePath, workspaceSkill.filePath);
  assert.equal(
    registry.resolveReadPath(skillActivatedWorkspace, workspaceSkillReference).absolutePath,
    workspaceSkillReference,
  );
  assert.equal(
    registry.resolveReadPath(skillActivatedWorkspace, workspaceSkillUri).absolutePath,
    workspaceSkillReference,
  );
  const skillLeak = join(workspaceSkill.baseDir, "leak.txt");
  await writeFile(join(outsideRoot, "secret.txt"), "outside secret\n");
  await symlink(join(outsideRoot, "secret.txt"), skillLeak);
  assert.throws(
    () => registry.confineReadPath(
      registry.resolveReadPath(
        skillActivatedWorkspace,
        `skill://${workspaceSkill.skillId}/leak.txt`,
      ),
    ),
    /outside allowed roots/,
  );
  const mutableSkill = skillActivatedWorkspace.skills.find((skill) => skill.name === "mutable-skill");
  assert(mutableSkill);
  await writeFile(
    mutableSkillManifest,
    "---\nname: mutable-skill\ndescription: Changed after discovery.\n---\n",
  );
  await assert.rejects(
    registry.loadSkill(connectionPrincipalId, workspace.id, mutableSkill.skillId),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "skill_manifest_changed",
  );
  await writeFile(mutableSkillManifest, "x".repeat(70_000));
  await assert.rejects(
    registry.loadSkill(connectionPrincipalId, workspace.id, mutableSkill.skillId),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "skill_too_large",
  );
  assert.throws(
    () => registry.resolveReadPath(skillActivatedWorkspace, mutableSkill.filePath),
    /must be loaded before its files can be read/i,
  );
  const mutableMetadataSkill = skillActivatedWorkspace.skills.find(
    (skill) => skill.name === "mutable-metadata-skill",
  );
  assert(mutableMetadataSkill);
  await writeFile(
    mutableOpenAiMetadata,
    "interface:\n  display_name: After discovery\npolicy:\n  allow_implicit_invocation: true\n",
  );
  await assert.rejects(
    registry.loadSkill(connectionPrincipalId, workspace.id, mutableMetadataSkill.skillId),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "skill_metadata_changed",
  );
  assert.throws(
    () => registry.resolveReadPath(skillActivatedWorkspace, join(mutableMetadataSkill.baseDir, "reference.md")),
    /must be loaded before its files can be read/i,
  );

  const priorityDirectory = join(root, "instruction-priority");
  await mkdir(priorityDirectory);
  await writeFile(join(priorityDirectory, "AGENTS.md"), "ordinary instructions\n");
  await writeFile(join(priorityDirectory, "CLAUDE.md"), "claude instructions\n");
  await writeFile(join(priorityDirectory, "AGENTS.override.md"), "override instructions\n");
  const priorityInstructions = await registry.loadApplicableAgentsFiles(
    workspace,
    ["instruction-priority/file.txt"],
    { instructionContextId },
  );
  assert.deepEqual(
    priorityInstructions.map((file) => ({ path: file.path, content: file.content })),
    [{
      path: join(canonicalRoot, "instruction-priority", "AGENTS.override.md"),
      content: "override instructions\n",
    }],
  );
  await writeFile(join(priorityDirectory, "AGENTS.override.md"), " \n\t");
  const priorityFallbackInstructions = await registry.loadApplicableAgentsFiles(
    workspace,
    ["instruction-priority/file.txt"],
    { instructionContextId },
  );
  assert.deepEqual(
    priorityFallbackInstructions.map((file) => ({ path: file.path, content: file.content })),
    [{
      path: join(canonicalRoot, "instruction-priority", "AGENTS.md"),
      content: "ordinary instructions\n",
    }],
  );
  const claudeOnlyDirectory = join(root, "claude-only-instructions");
  await mkdir(claudeOnlyDirectory);
  await writeFile(join(claudeOnlyDirectory, "CLAUDE.md"), "must remain ordinary repository data\n");
  assert.deepEqual(
    await registry.loadApplicableAgentsFiles(
      workspace,
      ["claude-only-instructions/file.txt"],
      { instructionContextId },
    ),
    [],
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
    DEVSPACE_PROJECT_DOC_FALLBACK_FILENAMES: "TEAM_GUIDE.md",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const fallbackRegistry = new WorkspaceRegistry(fallbackConfig);
  const fallbackOpen = await fallbackRegistry.openWorkspace(connectionPrincipalId, fallbackProject);
  const fallbackInstructionContextId = fallbackRegistry.createInstructionContext(
    fallbackOpen.workspace,
  );
  assert.deepEqual(
    fallbackOpen.agentsFiles
      .filter((file) => file.path.startsWith(canonicalFallbackProject))
      .map((file) => ({ path: file.path, content: file.content })),
    [{
      path: join(canonicalFallbackProject, "AGENTS.override.md"),
      content: "root override instructions\n",
    }],
  );
  await fallbackRegistry.markAgentsFilesDelivered(
    fallbackOpen.workspace,
    fallbackInstructionContextId,
    fallbackOpen.agentsFiles,
  );
  const nestedFallback = await fallbackRegistry.loadApplicableAgentsFiles(
    fallbackOpen.workspace,
    ["nested/file.txt"],
    { instructionContextId: fallbackInstructionContextId },
  );
  assert.deepEqual(
    nestedFallback.map((file) => ({ path: file.path, content: file.content })),
    [{
      path: join(canonicalFallbackProject, "nested", "TEAM_GUIDE.md"),
      content: "nested fallback instructions\n",
    }],
  );
  await rm(join(fallbackProject, "AGENTS.override.md"));
  const fallbackWithoutOverride = await fallbackRegistry.openWorkspace(connectionPrincipalId, fallbackProject);
  assert.deepEqual(
    fallbackWithoutOverride.agentsFiles
      .filter((file) => file.path.startsWith(canonicalFallbackProject))
      .map((file) => file.content),
    ["root ordinary instructions\n"],
  );
  await rm(join(fallbackProject, "AGENTS.md"));
  const fallbackOnly = await fallbackRegistry.openWorkspace(connectionPrincipalId, fallbackProject);
  assert.deepEqual(
    fallbackOnly.agentsFiles
      .filter((file) => file.path.startsWith(canonicalFallbackProject))
      .map((file) => file.content),
    ["root fallback instructions\n"],
  );

  const emptyGlobalAgentDir = join(root, ".empty-global-agent");
  const emptyGlobalProject = join(root, "empty-global-project");
  await mkdir(emptyGlobalAgentDir, { recursive: true });
  await mkdir(emptyGlobalProject);
  await writeFile(
    join(emptyGlobalAgentDir, "AGENTS.override.md"),
    " ".repeat(MAX_PROJECT_INSTRUCTION_BYTES + 1),
  );
  await writeFile(join(emptyGlobalAgentDir, "AGENTS.md"), "global fallback instructions\n");
  const emptyGlobalConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".empty-global-config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_USER_INSTRUCTIONS_PATH: join(emptyGlobalAgentDir, "AGENTS.md"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const emptyGlobalOpen = await new WorkspaceRegistry(emptyGlobalConfig).openWorkspace(
    connectionPrincipalId,
    emptyGlobalProject,
  );
  const canonicalEmptyGlobalAgentDir = await realpath(emptyGlobalAgentDir);
  assert.deepEqual(
    emptyGlobalOpen.agentsFiles.map((file) => ({ path: file.path, content: file.content })),
    [{
      path: join(canonicalEmptyGlobalAgentDir, "AGENTS.md"),
      content: "global fallback instructions\n",
    }],
  );

  const budgetAgentDir = join(root, ".budget-agent");
  const exactBudgetProject = join(root, "exact-budget-project");
  const beyondBudgetProject = join(root, "beyond-budget-project");
  const nestedBudgetProject = join(root, "nested-budget-project");
  const globalBudgetContent = "g".repeat(16);
  await mkdir(budgetAgentDir, { recursive: true });
  await mkdir(exactBudgetProject);
  await mkdir(beyondBudgetProject);
  await mkdir(join(nestedBudgetProject, "nested"), { recursive: true });
  await writeFile(join(budgetAgentDir, "AGENTS.md"), globalBudgetContent);
  await writeFile(
    join(exactBudgetProject, "AGENTS.md"),
    "r".repeat(MAX_PROJECT_INSTRUCTION_BYTES - Buffer.byteLength(globalBudgetContent, "utf8")),
  );
  await writeFile(
    join(beyondBudgetProject, "AGENTS.md"),
    "r".repeat(MAX_PROJECT_INSTRUCTION_BYTES - Buffer.byteLength(globalBudgetContent, "utf8") + 1),
  );
  const budgetConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".budget-config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_USER_INSTRUCTIONS_PATH: join(budgetAgentDir, "AGENTS.md"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const budgetRegistry = new WorkspaceRegistry(budgetConfig);
  const exactBudgetOpen = await budgetRegistry.openWorkspace(connectionPrincipalId, exactBudgetProject);
  assert.equal(
    exactBudgetOpen.agentsFiles.reduce(
      (bytes, file) => bytes + Buffer.byteLength(file.content, "utf8"),
      0,
    ),
    MAX_PROJECT_INSTRUCTION_BYTES,
  );
  const beyondBudgetOpen = await budgetRegistry.openWorkspace(
    connectionPrincipalId,
    beyondBudgetProject,
  );
  assert.equal(
    beyondBudgetOpen.agentsFiles.reduce(
      (bytes, file) => bytes + Buffer.byteLength(file.content, "utf8"),
      0,
    ),
    MAX_PROJECT_INSTRUCTION_BYTES + 1,
  );

  const nestedRootContent = "p".repeat(17);
  const instructionDeltaBytes = 12 * 1024;
  const nestedContent = "n".repeat(instructionDeltaBytes);
  await writeFile(join(nestedBudgetProject, "AGENTS.md"), nestedRootContent);
  await writeFile(join(nestedBudgetProject, "nested", "AGENTS.md"), nestedContent);
  const nestedBudgetOpen = await budgetRegistry.openWorkspace(connectionPrincipalId, nestedBudgetProject);
  const nestedBudgetContextId = budgetRegistry.createInstructionContext(
    nestedBudgetOpen.workspace,
  );
  await budgetRegistry.markRootAgentsFilesAcknowledged(
    nestedBudgetOpen.workspace,
    nestedBudgetContextId,
    nestedBudgetOpen.agentsFiles,
  );
  const exactNestedInstructions = await budgetRegistry.loadApplicableAgentsFiles(
    nestedBudgetOpen.workspace,
    ["nested/file.txt"],
    { instructionContextId: nestedBudgetContextId },
  );
  assert.deepEqual(exactNestedInstructions.map((file) => file.content), [nestedContent]);
  await budgetRegistry.markAgentsFilesDelivered(
    nestedBudgetOpen.workspace,
    nestedBudgetContextId,
    exactNestedInstructions,
  );
  const exactNestedAcknowledgement = await budgetRegistry.loadApplicableAgentsFiles(
    nestedBudgetOpen.workspace,
    ["nested/file.txt"],
    { instructionContextId: nestedBudgetContextId, requireAcknowledged: true },
  );
  await budgetRegistry.markAgentsFilesAcknowledged(
    nestedBudgetOpen.workspace,
    nestedBudgetContextId,
    exactNestedAcknowledgement,
  );
  await writeFile(join(nestedBudgetProject, "nested", "AGENTS.md"), `${nestedContent}x`);
  await assert.rejects(
    budgetRegistry.loadApplicableAgentsFiles(
      nestedBudgetOpen.workspace,
      ["nested/file.txt"],
      { instructionContextId: nestedBudgetContextId },
    ),
    new RegExp(`instruction response exceeds the ${instructionDeltaBytes}-byte UTF-8 limit`),
  );
  await assert.rejects(
    budgetRegistry.loadApplicableAgentsFiles(
      nestedBudgetOpen.workspace,
      ["nested/file.txt"],
      { instructionContextId: nestedBudgetContextId, requireAcknowledged: true },
    ),
    new RegExp(`instruction response exceeds the ${instructionDeltaBytes}-byte UTF-8 limit`),
  );

  const nestedInstructions = await registry.loadApplicableAgentsFiles(
    workspace,
    ["nested/file.txt"],
    { instructionContextId },
  );
  assert.deepEqual(nestedInstructions.map(({ path, content }) => ({ path, content })), [{
    path: join(canonicalRoot, "nested", "AGENTS.md"),
    content: "nested instructions\n",
  }]);
  await registry.markAgentsFilesDelivered(workspace, instructionContextId, nestedInstructions);
  assert.deepEqual(
    await registry.loadApplicableAgentsFiles(
      workspace,
      ["nested/file.txt"],
      { instructionContextId },
    ),
    [],
  );
  await writeFile(join(root, "nested", "AGENTS.md"), "updated nested instructions\n");
  const updatedNestedInstructions = await registry.loadApplicableAgentsFiles(
    workspace,
    ["nested/file.txt"],
    { instructionContextId },
  );
  assert.deepEqual(
    updatedNestedInstructions.map((file) => file.content),
    ["updated nested instructions\n"],
  );
  await registry.markAgentsFilesDelivered(
    workspace,
    instructionContextId,
    updatedNestedInstructions,
  );
  const mutationInstructions = await registry.loadApplicableAgentsFiles(
    workspace,
    ["nested/file.txt"],
    { instructionContextId, requireAcknowledged: true },
  );
  assert.equal(mutationInstructions.length, 3);
  const generationBeforeAcknowledgement = registry.instructionAcknowledgementGeneration(
    workspace,
    instructionContextId,
  );
  await registry.markAgentsFilesAcknowledged(
    workspace,
    instructionContextId,
    mutationInstructions,
  );
  assert.equal(
    registry.instructionAcknowledgementGeneration(workspace, instructionContextId),
    generationBeforeAcknowledgement + 1,
  );
  assert.deepEqual(
    await registry.loadApplicableAgentsFiles(
      workspace,
      ["nested/file.txt"],
      { instructionContextId, requireAcknowledged: true },
    ),
    [],
  );
  assert.deepEqual(registry.cleanupLifecycleState(), {
    deletedClosedWorkspaceSessions: 0,
  });

  const lateInstructionDir = join(root, "late-instructions");
  await mkdir(lateInstructionDir);
  assert.deepEqual(
    await registry.loadApplicableAgentsFiles(
      workspace,
      ["late-instructions/new.txt"],
      { instructionContextId },
    ),
    [],
  );
  await writeFile(join(lateInstructionDir, "AGENTS.md"), "late instructions\n");
  const lateInstructions = await registry.loadApplicableAgentsFiles(
    workspace,
    ["late-instructions/new.txt"],
    { instructionContextId },
  );
  assert.deepEqual(lateInstructions.map(({ path, content }) => ({ path, content })), [
    { path: join(canonicalRoot, "late-instructions", "AGENTS.md"), content: "late instructions\n" },
  ]);
  await registry.markAgentsFilesDelivered(workspace, instructionContextId, lateInstructions);
  const lateMutationInstructions = await registry.loadApplicableAgentsFiles(
    workspace,
    ["late-instructions/new.txt"],
    { instructionContextId, requireAcknowledged: true },
  );
  await writeFile(join(lateInstructionDir, "AGENTS.md"), "changed before token\n");
  await assert.rejects(
    registry.markAgentsFilesAcknowledged(
      workspace,
      instructionContextId,
      lateMutationInstructions,
    ),
    /changed while acknowledging context/,
  );
  assert.throws(() => registry.getWorkspace("not-owner", workspace.id), /Project execution runtime is no longer available/);

  if (platform() !== "win32") {
    const canonicalScope = join(root, "canonical-scope");
    await mkdir(join(canonicalScope, "deep"), { recursive: true });
    await writeFile(join(canonicalScope, "AGENTS.md"), "canonical parent instructions\n");
    await writeFile(join(canonicalScope, "deep", "AGENTS.md"), "canonical deep instructions\n");
    await writeFile(join(canonicalScope, "deep", "file.txt"), "inside\n");
    await symlink(join(canonicalScope, "deep"), join(root, "scope-link"));
    const symlinkInstructions = await registry.loadApplicableAgentsFiles(
      workspace,
      ["scope-link/file.txt"],
      { instructionContextId },
    );
    assert.deepEqual(
      symlinkInstructions.map(({ path, content }) => ({ path, content })),
      [
        { path: join(canonicalRoot, "canonical-scope", "AGENTS.md"), content: "canonical parent instructions\n" },
        { path: join(canonicalRoot, "canonical-scope", "deep", "AGENTS.md"), content: "canonical deep instructions\n" },
      ],
    );

    const instructionFileRaceDirectory = join(root, "instruction-file-race");
    const instructionFileRacePath = join(instructionFileRaceDirectory, "AGENTS.md");
    const instructionFileRaceOriginal = join(instructionFileRaceDirectory, "AGENTS.original.md");
    await mkdir(instructionFileRaceDirectory);
    await writeFile(instructionFileRacePath, "safe file-race instructions\n");
    await writeFile(join(instructionFileRaceDirectory, "file.txt"), "inside\n");
    const canonicalInstructionFileRacePath = await realpath(instructionFileRacePath);
    let instructionFileRaceArmed = false;
    let instructionFileRaceTriggered = false;
    const instructionFileRaceConfig = {
      ...config,
      instructionIoHooksForTests: {
        beforeFileOpen: async (path: string) => {
          if (
            !instructionFileRaceArmed ||
            instructionFileRaceTriggered ||
            path !== canonicalInstructionFileRacePath
          ) return;
          instructionFileRaceTriggered = true;
          await rename(instructionFileRacePath, instructionFileRaceOriginal);
          await symlink(join(outsideRoot, "secret.txt"), instructionFileRacePath);
        },
      },
    };
    const instructionFileRaceRegistry = new WorkspaceRegistry(instructionFileRaceConfig);
    const instructionFileRaceWorkspace = (
      await instructionFileRaceRegistry.openWorkspace(connectionPrincipalId, root)
    ).workspace;
    instructionFileRaceArmed = true;
    const instructionFileRaceError = await instructionFileRaceRegistry.loadApplicableAgentsFiles(
      instructionFileRaceWorkspace,
      ["instruction-file-race/file.txt"],
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.equal(instructionFileRaceTriggered, true);
    assert.ok(instructionFileRaceError instanceof Error);
    assert.doesNotMatch(String(instructionFileRaceError), /outside secret/u);
    await unlink(instructionFileRacePath);
    await rename(instructionFileRaceOriginal, instructionFileRacePath);

    const instructionDirectoryRacePath = join(root, "instruction-directory-race");
    const instructionDirectoryRaceOriginal = join(root, "instruction-directory-race-original");
    await mkdir(instructionDirectoryRacePath);
    await writeFile(join(instructionDirectoryRacePath, "AGENTS.md"), "safe directory-race instructions\n");
    await writeFile(join(instructionDirectoryRacePath, "file.txt"), "inside\n");
    const canonicalInstructionDirectoryRacePath = await realpath(instructionDirectoryRacePath);
    let instructionDirectoryRaceArmed = false;
    let instructionDirectoryRaceTriggered = false;
    const instructionDirectoryRaceConfig = {
      ...config,
      instructionIoHooksForTests: {
        beforeDirectoryRead: async (path: string) => {
          if (
            !instructionDirectoryRaceArmed ||
            instructionDirectoryRaceTriggered ||
            path !== canonicalInstructionDirectoryRacePath
          ) return;
          instructionDirectoryRaceTriggered = true;
          await rename(instructionDirectoryRacePath, instructionDirectoryRaceOriginal);
          await symlink(outsideRoot, instructionDirectoryRacePath);
        },
      },
    };
    const instructionDirectoryRaceRegistry = new WorkspaceRegistry(instructionDirectoryRaceConfig);
    const instructionDirectoryRaceWorkspace = (
      await instructionDirectoryRaceRegistry.openWorkspace(connectionPrincipalId, root)
    ).workspace;
    instructionDirectoryRaceArmed = true;
    const instructionDirectoryRaceError =
      await instructionDirectoryRaceRegistry.loadApplicableAgentsFiles(
        instructionDirectoryRaceWorkspace,
        ["instruction-directory-race/file.txt"],
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
    assert.equal(instructionDirectoryRaceTriggered, true);
    assert.ok(instructionDirectoryRaceError instanceof Error);
    assert.doesNotMatch(String(instructionDirectoryRaceError), /outside secret/u);
    await unlink(instructionDirectoryRacePath);
    await rename(instructionDirectoryRaceOriginal, instructionDirectoryRacePath);

    const missingInstructionsConfig = loadConfig({
      DEVSPACE_CONFIG_DIR: join(root, ".missing-user-instructions-home"),
      DEVSPACE_ALLOWED_ROOTS: root,
      DEVSPACE_USER_INSTRUCTIONS_PATH: join(root, "missing-user-instructions.md"),
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });
    await assert.rejects(
      new WorkspaceRegistry(missingInstructionsConfig).openWorkspace(connectionPrincipalId, root),
      /ENOENT/,
    );
    const directoryInstructionsConfig = loadConfig({
      DEVSPACE_CONFIG_DIR: join(root, ".directory-user-instructions-home"),
      DEVSPACE_ALLOWED_ROOTS: root,
      DEVSPACE_USER_INSTRUCTIONS_PATH: agentDir,
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });
    await assert.rejects(
      new WorkspaceRegistry(directoryInstructionsConfig).openWorkspace(connectionPrincipalId, root),
      /must be a file/,
    );

    const workspaceLeak = join(root, "workspace-leak.txt");
    await symlink(join(outsideRoot, "secret.txt"), workspaceLeak);
    assert.throws(
      () => registry.confineReadPath(registry.resolveReadPath(workspace, workspaceLeak)),
      /outside allowed roots/,
    );
  }

  const missingWorkspaceRoot = join(root, "missing", "workspace");
  await assert.rejects(
    registry.openWorkspace(connectionPrincipalId, missingWorkspaceRoot),
    /ENOENT/,
  );
  await assert.rejects(stat(missingWorkspaceRoot), /ENOENT/);

  await assert.rejects(
    () => registry.openWorkspace(
      connectionPrincipalId,
      { path: root, mode: "worktree" } as never,
    ),
    /Project mode selection is not supported/,
  );

  const hydrationSession = {
    id: "ws-hydration-race",
    connectionPrincipalId,
    alias: "hydration-race",
    root: canonicalRoot,
    status: "active" as const,
    writeAccess: "read_only" as const,
    stateGeneration: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
  };
  let hydrationActive = true;
  let hydrationTouches = 0;
  const hydrationStore: WorkspaceStore = {
    createSession: () => hydrationSession,
    getActiveSessionByAlias: (_owner, alias) => hydrationActive && alias === hydrationSession.alias
      ? { ...hydrationSession }
      : undefined,
    getSession: (id, owner) => hydrationActive && id === hydrationSession.id && owner === connectionPrincipalId
      ? { ...hydrationSession }
      : undefined,
    bumpStateGeneration: () => {
      hydrationSession.stateGeneration += 1;
      return hydrationSession.stateGeneration;
    },
    touchSession: () => {
      hydrationTouches += 1;
    },
    closeSession: () => {
      hydrationActive = false;
      return true;
    },
    deleteSession: () => false,
    listExpiredSessions: () => [{ ...hydrationSession }],
    isReady: () => true,
  };
  const hydrationRegistry = new WorkspaceRegistry(config, hydrationStore);
  const reservedHydration = hydrationRegistry.resumeWorkspace(connectionPrincipalId, hydrationSession.alias);
  assert.equal(hydrationRegistry.usageSnapshot(connectionPrincipalId).leased, 1);
  assert.deepEqual(hydrationRegistry.closeExpiredSessions(-1, () => false), []);
  const hydratedContext = await reservedHydration;
  assert.equal(hydratedContext.workspace.id, hydrationSession.id);
  assert.equal(hydrationTouches >= 2, true);

  const disappearingSession = {
    ...hydrationSession,
    id: "ws-hydration-disappearing",
    alias: "hydration-disappearing",
    stateGeneration: 1,
  };
  let disappearingActive = true;
  const disappearingStore: WorkspaceStore = {
    ...hydrationStore,
    getActiveSessionByAlias: (_owner, alias) => disappearingActive && alias === disappearingSession.alias
      ? { ...disappearingSession }
      : undefined,
    getSession: (id, owner) => disappearingActive && id === disappearingSession.id && owner === connectionPrincipalId
      ? { ...disappearingSession }
      : undefined,
    bumpStateGeneration: () => {
      disappearingSession.stateGeneration += 1;
      return disappearingSession.stateGeneration;
    },
    touchSession: () => undefined,
    listExpiredSessions: () => [],
  };
  const disappearingRegistry = new WorkspaceRegistry(config, disappearingStore);
  const disappearingHydration = disappearingRegistry.resumeWorkspace(
    connectionPrincipalId,
    disappearingSession.alias,
  );
  disappearingActive = false;
  await assert.rejects(disappearingHydration, /Project execution runtime is unavailable/);
  assert.equal(disappearingRegistry.usageSnapshot(connectionPrincipalId).resident, 0);
  assert.equal(disappearingRegistry.usageSnapshot(connectionPrincipalId).leased, 0);

  const stateDir = join(root, ".state");
  const firstStore = createTestWorkspaceStore(stateDir);
  const persistentRegistry = new WorkspaceRegistry(config, firstStore);
  const persistentWorkspace = await persistentRegistry.openWorkspace(connectionPrincipalId, root);
  const repeatedPersistentWorkspace = await persistentRegistry.openWorkspace(connectionPrincipalId, root);
  assert.equal(repeatedPersistentWorkspace.workspace.id, persistentWorkspace.workspace.id);
  assert.equal(persistentWorkspace.workspace.writeAccess, "read_only");
  const readOnlyGeneration = persistentWorkspace.workspace.stateGeneration;
  const writablePersistentWorkspace = await persistentRegistry.openWorkspace(connectionPrincipalId, {
    path: root,
    writeAccess: "read_write",
  });
  assert.equal(writablePersistentWorkspace.workspace, persistentWorkspace.workspace);
  assert.equal(writablePersistentWorkspace.workspace.writeAccess, "read_write");
  assert.equal(writablePersistentWorkspace.workspace.stateGeneration, readOnlyGeneration + 1);
  assert.throws(
    () => persistentRegistry.getWorkspace(connectionPrincipalId, persistentWorkspace.workspace.id, readOnlyGeneration),
    /Project execution runtime is stale/,
  );
  const preservedWritableWorkspace = await persistentRegistry.openWorkspace(connectionPrincipalId, root);
  assert.equal(preservedWritableWorkspace.workspace.writeAccess, "read_write");
  assert.equal(preservedWritableWorkspace.workspace.stateGeneration, readOnlyGeneration + 1);
  const downgradedPersistentWorkspace = await persistentRegistry.openWorkspace(connectionPrincipalId, {
    path: root,
    writeAccess: "read_only",
  });
  assert.equal(downgradedPersistentWorkspace.workspace.writeAccess, "read_only");
  assert.equal(downgradedPersistentWorkspace.workspace.stateGeneration, readOnlyGeneration + 2);

  const persistentSummary = persistentRegistry.listWorkspaces(connectionPrincipalId)
    .find((summary) => summary.alias === persistentWorkspace.workspace.alias);
  assert.equal(persistentSummary?.workspaceRef, persistentWorkspace.workspace.id);
  assert.match(
    persistentSummary?.projectFingerprint ?? "",
    /^proj_[A-Za-z0-9_-]{22}$/u,
  );
  const activeSnapshot = persistentRegistry.activeSessionsSnapshot();
  assert.equal(activeSnapshot.some((session) => session.id === persistentWorkspace.workspace.id), true);
  const snapshottedCheckout = activeSnapshot.find((session) => session.id === persistentWorkspace.workspace.id)!;
  snapshottedCheckout.alias = "mutated-snapshot";
  assert.notEqual(
    persistentRegistry.activeSessionsSnapshot().find(
      (session) => session.id === persistentWorkspace.workspace.id,
    )?.alias,
    "mutated-snapshot",
  );
  firstStore.close();

  const secondStore = createTestWorkspaceStore(stateDir);
  const restoredRegistry = new WorkspaceRegistry(config, secondStore);
  assert.throws(
    () => restoredRegistry.getWorkspace("not-owner", persistentWorkspace.workspace.id),
    /Project execution runtime is no longer available/,
  );
  assert.throws(
    () => restoredRegistry.getWorkspace(connectionPrincipalId, persistentWorkspace.workspace.id),
    /Project execution runtime must be loaded again/,
  );
  const coldSummary = restoredRegistry.listWorkspaces(connectionPrincipalId).find(
    (summary) => summary.alias === persistentWorkspace.workspace.alias,
  );
  assert.equal(coldSummary?.hydrationStatus, "requires_resume");
  assert.equal(coldSummary?.workspaceRef, persistentWorkspace.workspace.id);
  assert.equal(
    coldSummary?.projectFingerprint,
    persistentSummary?.projectFingerprint,
    "project fingerprints must remain stable across server restarts",
  );
  assert.equal(coldSummary?.displayPath, `…/${basename(root)}`);
  assert.equal(coldSummary?.displayPath.includes("~"), false);
  await assert.rejects(
    restoredRegistry.resumeWorkspaceByReference("not-owner", coldSummary!.workspaceRef),
    /Project execution runtime is unavailable/,
  );
  const resumedCheckout = await restoredRegistry.resumeWorkspaceByReference(
    connectionPrincipalId,
    coldSummary!.workspaceRef,
  );
  const restoredWorkspace = resumedCheckout.workspace;
  assert.equal(restoredWorkspace.root, canonicalRoot);
  assert.equal(restoredWorkspace.stateGeneration, persistentWorkspace.workspace.stateGeneration + 1);
  assert.equal(restoredRegistry.closeWorkspace("not-owner", persistentWorkspace.workspace.id), false);
  assert.equal(restoredRegistry.closeWorkspace(connectionPrincipalId, persistentWorkspace.workspace.id), true);
  assert.deepEqual(restoredRegistry.cleanupLifecycleState(Date.now() + 31 * 24 * 60 * 60_000), {
    deletedClosedWorkspaceSessions: 1,
  });
  assert.throws(
    () => restoredRegistry.getWorkspace(connectionPrincipalId, persistentWorkspace.workspace.id),
    /Project execution runtime is no longer available/,
  );
  const expired = restoredRegistry.closeExpiredSessions(-1, () => false);
  assert.deepEqual(expired, []);
  secondStore.close();

  const expiryConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".expiry-home"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_MAX_RESIDENT_WORKSPACES: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });

  const rotationStateDir = join(root, ".expiry-rotation-state");
  const rotationStore = createTestWorkspaceStore(rotationStateDir);
  const rotationRegistry = new WorkspaceRegistry(expiryConfig, rotationStore);
  for (let index = 0; index < 1_024; index += 1) {
    const id = `blocked-${String(index).padStart(4, "0")}`;
    rotationStore.createSession({
      id,
      connectionPrincipalId,
      alias: id,
      root: join(root, "rotation", id),
    });
  }
  rotationStore.createSession({
    id: "zz-clean",
    connectionPrincipalId,
    alias: "zz-clean",
    root: join(root, "rotation", "zz-clean"),
  });
  const rotationDatabase = new Database(databasePath(rotationStateDir));
  rotationDatabase.prepare("update workspace_sessions set last_used_at = ?")
    .run("2026-01-01T00:00:00.000Z");
  rotationDatabase.close();
  assert.deepEqual(
    rotationRegistry.closeExpiredSessions(-1, (_owner, workspaceId) => workspaceId.startsWith("blocked-")),
    [],
  );
  assert.deepEqual(
    rotationRegistry.closeExpiredSessions(-1, (_owner, workspaceId) => workspaceId.startsWith("blocked-")),
    ["zz-clean"],
  );
  rotationStore.close();

  const reopenStateDir = join(root, ".reopen-state");
  const reopenStore = createTestWorkspaceStore(reopenStateDir);
  const reopenRegistry = new WorkspaceRegistry(config, reopenStore);
  const beforeClose = (await reopenRegistry.openWorkspace(connectionPrincipalId, root)).workspace;
  assert.equal(reopenRegistry.closeWorkspace(connectionPrincipalId, beforeClose.id), true);
  const afterReopen = (await reopenRegistry.openWorkspace(connectionPrincipalId, root)).workspace;
  assert.equal(afterReopen.id, beforeClose.id);
  assert.equal(afterReopen.stateGeneration, beforeClose.stateGeneration + 2);
  reopenStore.close();

  const concurrentStateDir = join(root, ".concurrent-state");
  const concurrentStoreA = createTestWorkspaceStore(concurrentStateDir);
  const concurrentStoreB = createTestWorkspaceStore(concurrentStateDir);
  const concurrentRegistryA = new WorkspaceRegistry(config, concurrentStoreA);
  const concurrentRegistryB = new WorkspaceRegistry(config, concurrentStoreB);
  const [storedConcurrentA, storedConcurrentB] = await Promise.all([
    concurrentRegistryA.openWorkspace(connectionPrincipalId, root),
    concurrentRegistryB.openWorkspace(connectionPrincipalId, root),
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
      (3, 'legacy-v3', '2026-01-01T00:00:00.000Z'),
      (4, 'workspace-oauth-ownership', '2026-01-01T00:00:00.000Z');
    create table oauth_clients (
      client_id text primary key,
      client_json text not null,
      issued_at integer not null
    );
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
      `select id, status, canonical_root as canonicalRoot, alias, write_access as writeAccess
       from workspace_sessions`,
    ).get(),
    {
      id: "ws_legacy",
      status: "closed",
      canonicalRoot,
      alias: basename(canonicalRoot),
      writeAccess: "read_write",
    },
  );
  assert.equal(
    migratedLegacyDatabase.prepare(
      "select count(*) from sqlite_master where type = 'index' and name = 'workspace_sessions_active_principal_canonical_root_uq'",
    ).pluck().get(),
    0,
  );
  migratedLegacyDatabase.close();
  const migratedLegacyStore = new SqliteWorkspaceStore(legacyStateDir);
  const migratedWorkspace = await new WorkspaceRegistry(config, migratedLegacyStore).openWorkspace(
    connectionPrincipalId,
    root,
  );
  assert.equal(migratedWorkspace.workspace.id, "ws_legacy");
  assert.equal(migratedWorkspace.reused, true);
  migratedLegacyStore.close();

  if (platform() !== "win32") {
    const escapedCheckoutRoot = join(root, "escaped-checkout-root");
    await symlink(outsideRoot, escapedCheckoutRoot, "dir");
    await assert.rejects(
      registry.openWorkspace(connectionPrincipalId, escapedCheckoutRoot),
      /Path is outside allowed roots/,
    );
    const escapedStateDir = join(root, ".escaped-checkout-state");
    const escapedStore = createTestWorkspaceStore(escapedStateDir);
    const escapedSession = escapedStore.createSession({
      id: "ws_escaped_checkout",
      connectionPrincipalId,
      root: escapedCheckoutRoot,
    });
    assert.throws(
      () => new WorkspaceRegistry(config, escapedStore).getWorkspace(
        connectionPrincipalId,
        "ws_escaped_checkout",
      ),
      /Project execution runtime must be loaded again/,
    );
    await assert.rejects(
      new WorkspaceRegistry(config, escapedStore).resumeWorkspace(
        connectionPrincipalId,
        escapedSession.alias,
      ),
      /Project execution runtime is unavailable/,
    );
    escapedStore.close();

    const aliasRoot = join(root, "alias-root");
    await symlink(root, aliasRoot, "dir");
    const aliasConfig = loadConfig({
      DEVSPACE_ALLOWED_ROOTS: aliasRoot,
      DEVSPACE_USER_INSTRUCTIONS_PATH: userInstructionsPath,
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });
    const aliasCheckout = await new WorkspaceRegistry(aliasConfig).openWorkspace(connectionPrincipalId, aliasRoot);
    assert.deepEqual(
      aliasCheckout.agentsFiles.map((file) => file.content),
      ["global override instructions\n", "root instructions\n"],
    );

    const aliasReuseStore = createTestWorkspaceStore(join(root, ".alias-reuse-state"));
    const aliasReuseRegistry = new WorkspaceRegistry(config, aliasReuseStore);
    const realCheckout = await aliasReuseRegistry.openWorkspace(connectionPrincipalId, root);
    const aliasedCheckout = await aliasReuseRegistry.openWorkspace(connectionPrincipalId, aliasRoot);
    assert.equal(aliasedCheckout.workspace.id, realCheckout.workspace.id);
    assert.equal(aliasedCheckout.skillRevision, realCheckout.skillRevision);
    aliasReuseStore.close();
    const restoredAliasStore = createTestWorkspaceStore(join(root, ".alias-reuse-state"));
    const restoredAliasRegistry = new WorkspaceRegistry(aliasConfig, restoredAliasStore);
    assert.throws(
      () => restoredAliasRegistry.getWorkspace(connectionPrincipalId, realCheckout.workspace.id),
      /Project execution runtime must be loaded again/,
    );
    const restoredAlias = (
      await restoredAliasRegistry.resumeWorkspace(connectionPrincipalId, realCheckout.workspace.alias)
    ).workspace;
    assert.equal(restoredAlias.root, canonicalRoot);
    restoredAliasStore.close();
  }
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  await rm(root, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
}

function seedConnectionPrincipal(stateDir: string, principalId: string): void {
  const database = openDatabase(stateDir);
  try {
    const now = new Date(0).toISOString();
    database.sqlite.prepare(`
      insert into connection_principals (principal_id, created_at, last_used_at, revoked_at)
      values (?, ?, ?, null)
      on conflict(principal_id) do nothing
    `).run(principalId, now, now);
  } finally {
    database.close();
  }
}

function createTestWorkspaceStore(stateDir: string): SqliteWorkspaceStore {
  seedConnectionPrincipal(stateDir, connectionPrincipalId);
  return new SqliteWorkspaceStore(stateDir);
}
