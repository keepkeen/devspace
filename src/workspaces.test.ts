import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { loadConfig } from "./config.js";
import { databasePath } from "./db/client.js";
import { GitWorktreeError, removeManagedWorktree } from "./git-worktrees.js";
import { MAX_PROJECT_INSTRUCTION_BYTES } from "./project-instructions.js";
import { SqliteWorkspaceStore, type WorkspaceStore } from "./workspace-store.js";
import {
  ensureCheckoutWorkspaceRoot,
  InstructionBudgetError,
  UnknownWorkspaceError,
  WorkspaceQuotaError,
  WorkspaceRegistry,
} from "./workspaces.js";
import { formatPathForPrompt } from "./skills.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-workspace-test-"));
const outsideRoot = await mkdtemp(join(tmpdir(), "devspace-workspace-outside-test-"));
const canonicalRoot = await realpath(root);
const ownerClientId = "client-a";

assert.equal(
  new UnknownWorkspaceError("ws_old").message,
  "The workspace is no longer available.",
);
assert.equal(
  new WorkspaceQuotaError("managed_worktree_quota", "Safe quota message").code,
  "managed_worktree_quota",
);
assert.equal(new InstructionBudgetError("internal path details").publicText.includes("path"), false);

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
    DEVSPACE_USER_INSTRUCTIONS_PATH: userInstructionsPath,
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

  const pendingAliasStore = new SqliteWorkspaceStore(join(root, ".pending-alias-state"));
  const pendingAliasRegistry = new WorkspaceRegistry(config, pendingAliasStore);
  const pendingAliasResults = await Promise.allSettled([
    pendingAliasRegistry.openWorkspace(ownerClientId, {
      path: root,
      alias: "pending-alpha",
      writeAccess: "read_only",
    }),
    pendingAliasRegistry.openWorkspace(ownerClientId, {
      path: root,
      alias: "pending-beta",
      writeAccess: "read_write",
    }),
  ]);
  assert.equal(
    pendingAliasResults.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    pendingAliasResults.filter((result) => result.status === "rejected").length,
    1,
  );
  const pendingAliasRejection = pendingAliasResults.find((result) => result.status === "rejected");
  assert.match(String(
    pendingAliasRejection?.status === "rejected" ? pendingAliasRejection.reason : "",
  ), /alias/i);
  pendingAliasStore.close();

  const pendingAccessStore = new SqliteWorkspaceStore(join(root, ".pending-access-state"));
  const pendingAccessRegistry = new WorkspaceRegistry(config, pendingAccessStore);
  const [pendingReadOnly, pendingReadWrite] = await Promise.all([
    pendingAccessRegistry.openWorkspace(ownerClientId, {
      path: root,
      alias: "pending-access",
      writeAccess: "read_only",
    }),
    pendingAccessRegistry.openWorkspace(ownerClientId, {
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
  } = await registry.openWorkspace(ownerClientId, root);
  assert.equal(reused, false);
  assert.match(instructionRevision, /^sha256-v1:[A-Za-z0-9_-]{43}$/);
  assert.match(skillRevision, /^sha256-v1:[A-Za-z0-9_-]{43}$/);
  await registry.markAgentsFilesDelivered(workspace, agentsFiles);
  const sequentialCheckout = await registry.openWorkspace(ownerClientId, root);
  assert.equal(sequentialCheckout.reused, true);
  assert.equal(sequentialCheckout.instructionRevision, instructionRevision);
  assert.equal(sequentialCheckout.skillRevision, skillRevision);
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
  assert.equal(otherOwnerCheckout.skillRevision, skillRevision);

  const generationRegistry = new WorkspaceRegistry({ ...config, allowedRoots: [root] });
  const generationWorkspace = (await generationRegistry.openWorkspace(ownerClientId, root)).workspace;
  const generationBeforeRootChange = generationWorkspace.stateGeneration;
  generationRegistry.applyAllowedRoots([root, outsideRoot]);
  assert.equal(generationWorkspace.stateGeneration, generationBeforeRootChange + 1);
  assert.throws(
    () => generationRegistry.getWorkspace(
      ownerClientId,
      generationWorkspace.id,
      generationBeforeRootChange,
    ),
    /generation is stale/,
  );

  const rediscoveredSkills = await new WorkspaceRegistry(config).openWorkspace(ownerClientId, root);
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
    .openWorkspace(ownerClientId, emptySkillsProject);
  const repeatedEmptySkillsOpen = await new WorkspaceRegistry(emptySkillsConfig)
    .openWorkspace(ownerClientId, emptySkillsProject);
  const otherEmptySkillsOpen = await new WorkspaceRegistry(emptySkillsConfig)
    .openWorkspace(ownerClientId, otherEmptySkillsProject);
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
    DEVSPACE_AGENT_DIR: join(root, ".skill-revision-agent"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const initialSkillRevision = await new WorkspaceRegistry(skillRevisionConfig)
    .openWorkspace(ownerClientId, emptySkillsProject);
  await writeFile(
    revisionSkillManifest,
    "---\nname: revision-skill\ndescription: Changed description.\n---\n",
  );
  const manifestChangedSkillRevision = await new WorkspaceRegistry(skillRevisionConfig)
    .openWorkspace(ownerClientId, emptySkillsProject);
  assert.notEqual(manifestChangedSkillRevision.skillRevision, initialSkillRevision.skillRevision);
  await writeFile(revisionSkillMetadata, "policy:\n  allow_implicit_invocation: false\n");
  const policyChangedSkillRevision = await new WorkspaceRegistry(skillRevisionConfig)
    .openWorkspace(ownerClientId, emptySkillsProject);
  assert.notEqual(policyChangedSkillRevision.skillRevision, manifestChangedSkillRevision.skillRevision);

  const residentSkillRegistry = new WorkspaceRegistry(skillRevisionConfig);
  const residentSkillContext = await residentSkillRegistry.openWorkspace(ownerClientId, emptySkillsProject);
  const residentRevisionSkill = residentSkillContext.workspace.skills.find(
    (skill) => skill.name === "revision-skill",
  )!;
  await residentSkillRegistry.loadSkill(
    ownerClientId,
    residentSkillContext.workspace.id,
    residentRevisionSkill.skillId,
  );
  const originalDateNow = Date.now;
  const unchangedResidentContext = await (async () => {
    try {
      Date.now = () => 4_242_424_242;
      return await residentSkillRegistry.resumeWorkspace(
        ownerClientId,
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
    ownerClientId,
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
  const firstRevisionOpen = await revisionRegistry.openWorkspace(ownerClientId, revisionProject);
  await writeFile(revisionInstructionsPath, "revision two is different\n");
  const secondRevisionOpen = await revisionRegistry.openWorkspace(ownerClientId, revisionProject);
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
    .openWorkspace(ownerClientId, revisionProject);
  assert.notEqual(alternateRevisionOpen.instructionRevision, secondRevisionOpen.instructionRevision);

  const hotReloadConfig = { ...config, allowedRoots: [root] };
  const hotReloadStore = new SqliteWorkspaceStore(join(root, ".hot-reload-state"));
  const hotReloadRegistry = new WorkspaceRegistry(hotReloadConfig, hotReloadStore);
  const revokedWorkspace = (await hotReloadRegistry.openWorkspace(ownerClientId, root)).workspace;
  assert.throws(() => hotReloadRegistry.applyAllowedRoots([]), /At least one allowed root/);
  assert.equal(hotReloadRegistry.getWorkspace(ownerClientId, revokedWorkspace.id).id, revokedWorkspace.id);
  const hotReloadResult = hotReloadRegistry.applyAllowedRoots([outsideRoot]);
  assert.equal(hotReloadResult.changed, true);
  assert.equal(hotReloadResult.added, 1);
  assert.equal(hotReloadResult.removed, 1);
  assert.deepEqual(hotReloadResult.invalidated, [{
    workspaceId: revokedWorkspace.id,
    ownerClientId,
  }]);
  assert.equal(hotReloadStore.getSession(revokedWorkspace.id, ownerClientId), undefined);
  assert.throws(
    () => hotReloadRegistry.getWorkspace(ownerClientId, revokedWorkspace.id),
    /workspace is no longer available/,
  );
  await assert.rejects(
    hotReloadRegistry.openWorkspace(ownerClientId, root),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /outside allowed roots/);
      assert.match(message, /original approved project path/);
      assert.match(message, /mode="worktree"/);
      assert.match(message, /do not open DevSpace's internal worktree directory/);
      return true;
    },
  );
  const addedWorkspace = await hotReloadRegistry.openWorkspace(ownerClientId, await realpath(outsideRoot));
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

  const retryStore = new SqliteWorkspaceStore(join(root, ".hot-reload-retry-state"));
  const retryRegistry = new WorkspaceRegistry({ ...config, allowedRoots: [root] }, retryStore);
  const retryWorkspace = (await retryRegistry.openWorkspace(ownerClientId, root)).workspace;
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
    ownerClientId,
  }]);
  // Re-authorizing the root must not resurrect an ID whose revocation failed
  // to persist on the first attempt.
  const reconciledRetry = retryRegistry.applyAllowedRoots([root]);
  assert.equal(reconciledRetry.changed, true);
  assert.equal(reconciledRetry.persistenceFailures, 0);
  assert.deepEqual(reconciledRetry.invalidated, [{
    workspaceId: retryWorkspace.id,
    ownerClientId,
  }]);
  assert.equal(retryStore.getSession(retryWorkspace.id, ownerClientId), undefined);
  assert.throws(
    () => retryRegistry.getWorkspace(ownerClientId, retryWorkspace.id),
    /workspace is no longer available/,
  );
  retryStore.close();

  const leasedHotReloadConfig = { ...config, allowedRoots: [root] };
  const leasedHotReloadRegistry = new WorkspaceRegistry(leasedHotReloadConfig);
  const leasedHotReloadWorkspace = (
    await leasedHotReloadRegistry.openWorkspace(ownerClientId, root)
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
    ownerClientId,
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
    () => leasedHotReloadRegistry.getWorkspace(ownerClientId, leasedHotReloadWorkspace.id),
    /workspace is no longer available/,
  );
  releaseHotReloadOperation();
  assert.equal(await leasedHotReloadOperation, "finished");

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
    lifecycleWorkspace.stateGeneration,
    async (leasedWorkspace) => {
      operationStarted();
      await operationBarrier;
      return leasedWorkspace.id;
    },
  );
  await operationStartedPromise;
  const exclusiveClosePromise = lifecycleRegistry.acquireExclusiveClose(ownerClientId, lifecycleWorkspace.id);
  await assert.rejects(
    lifecycleRegistry.withWorkspaceOperation(
      ownerClientId,
      lifecycleWorkspace.id,
      lifecycleWorkspace.stateGeneration,
      () => undefined,
    ),
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
    await lifecycleRegistry.withWorkspaceOperation(
      ownerClientId,
      lifecycleWorkspace.id,
      lifecycleWorkspace.stateGeneration,
      (current) => current.id,
    ),
    lifecycleWorkspace.id,
  );
  const committedClose = await lifecycleRegistry.acquireExclusiveClose(ownerClientId, lifecycleWorkspace.id);
  assert.equal(committedClose.commit(), true);
  assert.throws(
    () => lifecycleRegistry.getWorkspace(ownerClientId, lifecycleWorkspace.id),
    /workspace is no longer available/,
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
  assert.throws(
    () => registry.resolveReadPath(workspace, promptedSkillPath),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "skill_not_loaded" &&
      "publicText" in error &&
      error.publicText === "Call load_skill for this workspace, then retry.",
  );
  const workspaceSkillReference = join(workspaceSkill.baseDir, "reference.md");
  const workspaceSkillUri = `skill://${workspaceSkill.skillId}/reference.md`;
  assert.throws(
    () => registry.resolveReadPath(workspace, workspaceSkillUri),
    /must be loaded before its files can be read/i,
  );
  const loadedWorkspaceSkill = await registry.loadSkill(
    ownerClientId,
    workspace.id,
    workspaceSkill.skillId,
  );
  assert.equal(loadedWorkspaceSkill.skill.skillId, workspaceSkill.skillId);
  assert.match(loadedWorkspaceSkill.content, /workspace-skill/);
  const skillActivatedWorkspace = registry.getWorkspace(ownerClientId, workspace.id);
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
    registry.loadSkill(ownerClientId, workspace.id, mutableSkill.skillId),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "skill_manifest_changed",
  );
  await writeFile(mutableSkillManifest, "x".repeat(70_000));
  await assert.rejects(
    registry.loadSkill(ownerClientId, workspace.id, mutableSkill.skillId),
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
    registry.loadSkill(ownerClientId, workspace.id, mutableMetadataSkill.skillId),
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
  );
  assert.deepEqual(
    priorityFallbackInstructions.map((file) => ({ path: file.path, content: file.content })),
    [{
      path: join(canonicalRoot, "instruction-priority", "AGENTS.md"),
      content: "ordinary instructions\n",
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
  await fallbackRegistry.markAgentsFilesDelivered(fallbackOpen.workspace, fallbackOpen.agentsFiles);
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
    DEVSPACE_AGENT_DIR: emptyGlobalAgentDir,
    DEVSPACE_USER_INSTRUCTIONS_PATH: join(emptyGlobalAgentDir, "AGENTS.md"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const emptyGlobalOpen = await new WorkspaceRegistry(emptyGlobalConfig).openWorkspace(
    ownerClientId,
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
    DEVSPACE_AGENT_DIR: budgetAgentDir,
    DEVSPACE_USER_INSTRUCTIONS_PATH: join(budgetAgentDir, "AGENTS.md"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const budgetRegistry = new WorkspaceRegistry(budgetConfig);
  const exactBudgetOpen = await budgetRegistry.openWorkspace(ownerClientId, exactBudgetProject);
  assert.equal(
    exactBudgetOpen.agentsFiles.reduce(
      (bytes, file) => bytes + Buffer.byteLength(file.content, "utf8"),
      0,
    ),
    MAX_PROJECT_INSTRUCTION_BYTES,
  );
  await assert.rejects(
    budgetRegistry.openWorkspace(ownerClientId, beyondBudgetProject),
    new RegExp(`instruction chain exceeds the ${MAX_PROJECT_INSTRUCTION_BYTES}-byte UTF-8 limit`),
  );

  const nestedRootContent = "p".repeat(17);
  const nestedContent = "n".repeat(
    MAX_PROJECT_INSTRUCTION_BYTES -
      Buffer.byteLength(globalBudgetContent, "utf8") -
      Buffer.byteLength(nestedRootContent, "utf8"),
  );
  await writeFile(join(nestedBudgetProject, "AGENTS.md"), nestedRootContent);
  await writeFile(join(nestedBudgetProject, "nested", "AGENTS.md"), nestedContent);
  const nestedBudgetOpen = await budgetRegistry.openWorkspace(ownerClientId, nestedBudgetProject);
  await budgetRegistry.markAgentsFilesDelivered(
    nestedBudgetOpen.workspace,
    nestedBudgetOpen.agentsFiles,
  );
  const exactNestedInstructions = await budgetRegistry.loadApplicableAgentsFiles(
    nestedBudgetOpen.workspace,
    ["nested/file.txt"],
  );
  assert.deepEqual(exactNestedInstructions.map((file) => file.content), [nestedContent]);
  await budgetRegistry.markAgentsFilesDelivered(nestedBudgetOpen.workspace, exactNestedInstructions);
  const exactNestedAcknowledgement = await budgetRegistry.loadApplicableAgentsFiles(
    nestedBudgetOpen.workspace,
    ["nested/file.txt"],
    { requireAcknowledged: true },
  );
  const exactNestedToken = await budgetRegistry.createInstructionAcknowledgement(
    nestedBudgetOpen.workspace,
    exactNestedAcknowledgement,
  );
  await budgetRegistry.acknowledgeInstructions(nestedBudgetOpen.workspace, exactNestedToken);
  await writeFile(join(nestedBudgetProject, "nested", "AGENTS.md"), `${nestedContent}x`);
  await assert.rejects(
    budgetRegistry.loadApplicableAgentsFiles(nestedBudgetOpen.workspace, ["nested/file.txt"]),
    new RegExp(`instruction chain exceeds the ${MAX_PROJECT_INSTRUCTION_BYTES}-byte UTF-8 limit`),
  );
  await assert.rejects(
    budgetRegistry.loadApplicableAgentsFiles(
      nestedBudgetOpen.workspace,
      ["nested/file.txt"],
      { requireAcknowledged: true },
    ),
    /nested[/\\]AGENTS\.md requires .*total 32769 bytes/,
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
  assert.equal(mutationInstructions.length, 3);
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
    /instruction token is no longer valid/,
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
    /instruction token is no longer valid/,
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
  assert.throws(() => registry.getWorkspace("client-b", workspace.id), /workspace is no longer available/);
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

    const skillOnlyAgentDirProject = join(root, "skill-only-agent-dir-project");
    await mkdir(skillOnlyAgentDirProject);
    const skillOnlyAgentDirConfig = loadConfig({
      DEVSPACE_CONFIG_DIR: join(root, ".skill-only-agent-dir-home"),
      DEVSPACE_ALLOWED_ROOTS: root,
      DEVSPACE_AGENT_DIR: agentDir,
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });
    const skillOnlyAgentDirOpen = await new WorkspaceRegistry(skillOnlyAgentDirConfig)
      .openWorkspace(ownerClientId, skillOnlyAgentDirProject);
    assert.deepEqual(skillOnlyAgentDirOpen.agentsFiles, []);

    const missingInstructionsConfig = loadConfig({
      DEVSPACE_CONFIG_DIR: join(root, ".missing-user-instructions-home"),
      DEVSPACE_ALLOWED_ROOTS: root,
      DEVSPACE_USER_INSTRUCTIONS_PATH: join(root, "missing-user-instructions.md"),
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });
    await assert.rejects(
      new WorkspaceRegistry(missingInstructionsConfig).openWorkspace(ownerClientId, root),
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
      new WorkspaceRegistry(directoryInstructionsConfig).openWorkspace(ownerClientId, root),
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
  assert.equal(worktreeWorkspace.workspace.sourceRoot, await realpath(gitRoot));
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
  assert.equal(concurrentWorktrees.filter((result) => result.status === "fulfilled").length, 2);
  const cappedContexts = concurrentWorktrees.map((result) => {
    assert.equal(result.status, "fulfilled");
    return result.value;
  });
  assert.equal(cappedContexts[0]!.workspace.id, cappedContexts[1]!.workspace.id);
  const cappedWorkspace = cappedContexts[0]!.workspace;
  await assert.rejects(
    cappedRegistry.openWorkspace(ownerClientId, { path: gitRoot, mode: "worktree", forceNew: true }),
    /Managed worktree limit reached/,
  );
  const cappedRemoval = await removeManagedWorktree({
    sourceRoot: gitRoot,
    worktreePath: cappedWorkspace.root,
    config: cappedConfig,
  });
  assert.equal(cappedRemoval.removed, true);
  assert.equal(
    cappedRegistry.listWorkspaces(ownerClientId).some((summary) => summary.alias === cappedWorkspace.alias),
    false,
  );
  assert.equal(cappedStore.countManagedWorktrees(), 0);
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

  const hydrationSession = {
    id: "ws-hydration-race",
    ownerClientId,
    alias: "hydration-race",
    root: canonicalRoot,
    status: "active" as const,
    mode: "checkout" as const,
    dirtySource: false,
    managed: false,
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
    getSession: (id, owner) => hydrationActive && id === hydrationSession.id && owner === ownerClientId
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
    countManagedWorktrees: () => 0,
    listExpiredSessions: () => [{ ...hydrationSession }],
    isReady: () => true,
  };
  const hydrationRegistry = new WorkspaceRegistry(config, hydrationStore);
  const reservedHydration = hydrationRegistry.resumeWorkspace(ownerClientId, hydrationSession.alias);
  assert.equal(hydrationRegistry.usageSnapshot(ownerClientId).leased, 1);
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
    getSession: (id, owner) => disappearingActive && id === disappearingSession.id && owner === ownerClientId
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
    ownerClientId,
    disappearingSession.alias,
  );
  disappearingActive = false;
  await assert.rejects(disappearingHydration, /workspace alias is unavailable/);
  assert.equal(disappearingRegistry.usageSnapshot(ownerClientId).resident, 0);
  assert.equal(disappearingRegistry.usageSnapshot(ownerClientId).leased, 0);

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
  const reusedPersistentWorktree = await persistentRegistry.openWorkspace(ownerClientId, {
    path: join(gitRoot, "."),
    mode: "worktree",
  });
  assert.equal(reusedPersistentWorktree.workspace.id, persistentWorktree.workspace.id);
  assert.equal(reusedPersistentWorktree.reused, true);
  const repeatedPersistentWorkspace = await persistentRegistry.openWorkspace(ownerClientId, root);
  assert.equal(repeatedPersistentWorkspace.workspace.id, persistentWorkspace.workspace.id);
  assert.equal(persistentWorkspace.workspace.writeAccess, "read_only");
  const readOnlyGeneration = persistentWorkspace.workspace.stateGeneration;
  const writablePersistentWorkspace = await persistentRegistry.openWorkspace(ownerClientId, {
    path: root,
    writeAccess: "read_write",
  });
  assert.equal(writablePersistentWorkspace.workspace, persistentWorkspace.workspace);
  assert.equal(writablePersistentWorkspace.workspace.writeAccess, "read_write");
  assert.equal(writablePersistentWorkspace.workspace.stateGeneration, readOnlyGeneration + 1);
  assert.throws(
    () => persistentRegistry.getWorkspace(ownerClientId, persistentWorkspace.workspace.id, readOnlyGeneration),
    /generation is stale/,
  );
  const preservedWritableWorkspace = await persistentRegistry.openWorkspace(ownerClientId, root);
  assert.equal(preservedWritableWorkspace.workspace.writeAccess, "read_write");
  assert.equal(preservedWritableWorkspace.workspace.stateGeneration, readOnlyGeneration + 1);
  const downgradedPersistentWorkspace = await persistentRegistry.openWorkspace(ownerClientId, {
    path: root,
    writeAccess: "read_only",
  });
  assert.equal(downgradedPersistentWorkspace.workspace.writeAccess, "read_only");
  assert.equal(downgradedPersistentWorkspace.workspace.stateGeneration, readOnlyGeneration + 2);

  const activityDatabase = new Database(databasePath(stateDir));
  activityDatabase.prepare("update workspace_sessions set last_used_at = ? where id = ?")
    .run("2026-01-01T00:00:00.000Z", persistentWorktree.workspace.id);
  persistentWorktree.workspace.lastUsedAt = 0;
  const activeManagedReuse = await persistentRegistry.openWorkspace(ownerClientId, {
    path: gitRoot,
    mode: "worktree",
  });
  assert.equal(activeManagedReuse.workspace, persistentWorktree.workspace);
  assert.equal(activeManagedReuse.workspace.lastUsedAt > 0, true);
  const refreshedManagedActivity = activityDatabase.prepare(
    "select last_used_at as lastUsedAt from workspace_sessions where id = ?",
  ).get(persistentWorktree.workspace.id) as { lastUsedAt: string };
  assert.equal(refreshedManagedActivity.lastUsedAt > "2026-01-01T00:00:00.000Z", true);
  activityDatabase.close();

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

  const secondStore = new SqliteWorkspaceStore(stateDir);
  const restoredRegistry = new WorkspaceRegistry(config, secondStore);
  const reopenedWorkspace = await restoredRegistry.openWorkspace(ownerClientId, root);
  assert.equal(reopenedWorkspace.workspace.id, persistentWorkspace.workspace.id);
  const restoredWorkspace = restoredRegistry.getWorkspace(ownerClientId, persistentWorkspace.workspace.id);
  assert.equal(restoredWorkspace.root, canonicalRoot);
  assert.equal(restoredWorkspace.mode, "checkout");
  assert.deepEqual(
    secondStore.listExpiredSessions(new Date(Date.now() + 1_000).toISOString(), 10)
      .filter((session) => !session.managed)
      .map((session) => session.id),
    [persistentWorkspace.workspace.id],
  );

  assert.throws(
    () => restoredRegistry.getWorkspace("client-b", persistentWorkspace.workspace.id),
    /workspace is no longer available/,
  );
  const persistedOtherOwner = await restoredRegistry.openWorkspace("client-b", root);
  assert.notEqual(persistedOtherOwner.workspace.id, persistentWorkspace.workspace.id);
  assert.equal(restoredRegistry.closeWorkspace("client-b", persistedOtherOwner.workspace.id), true);
  assert.throws(
    () => restoredRegistry.getWorkspace(ownerClientId, persistentWorktree.workspace.id),
    /must be resumed before use/,
  );
  const worktreeAlias = persistentWorktree.workspace.alias;
  const coldSummary = restoredRegistry.listWorkspaces(ownerClientId).find(
    (summary) => summary.alias === worktreeAlias,
  );
  assert.equal(coldSummary?.hydrationStatus, "requires_resume");
  assert.equal(coldSummary?.displayPath, `…/${basename(gitRoot)}`);
  assert.equal(coldSummary?.displayPath.includes("~"), false);
  const resumedWorktree = await restoredRegistry.resumeWorkspace(ownerClientId, worktreeAlias);
  const restoredWorktree = resumedWorktree.workspace;
  assert.equal(restoredWorktree.mode, "worktree");
  assert.equal(restoredWorktree.sourceRoot, await realpath(gitRoot));
  assert.equal(restoredWorktree.root, persistentWorktree.workspace.root);
  assert.equal(restoredWorktree.worktree?.managed, true);
  assert.equal(restoredWorktree.worktree?.dirtySource, true);
  assert.equal(restoredWorktree.stateGeneration, persistentWorktree.workspace.stateGeneration + 1);
  assert.deepEqual(
    restoredWorktree.agentProfiles.map((profile) => profile.name),
    persistentWorktree.workspace.agentProfiles.map((profile) => profile.name),
  );
  assert.equal(restoredRegistry.closeWorkspace("client-b", persistentWorkspace.workspace.id), false);
  assert.equal(restoredRegistry.closeWorkspace(ownerClientId, persistentWorkspace.workspace.id), true);
  assert.deepEqual(restoredRegistry.cleanupLifecycleState(Date.now() + 31 * 24 * 60 * 60_000), {
    expiredInstructionTokens: 0,
    deletedClosedWorkspaceSessions: 2,
  });
  assert.throws(
    () => restoredRegistry.getWorkspace(ownerClientId, persistentWorkspace.workspace.id),
    /workspace is no longer available/,
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

  const expiryStateDir = join(root, ".managed-expiry-state");
  const expiryConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".managed-expiry-home"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".devspace", "expiry-worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_MAX_RESIDENT_WORKSPACES: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const expiryStore = new SqliteWorkspaceStore(expiryStateDir);
  const expiryRegistry = new WorkspaceRegistry(expiryConfig, expiryStore);
  const dirtyExpiredWorktree = (await expiryRegistry.openWorkspace(ownerClientId, {
    path: gitRoot,
    mode: "worktree",
  })).workspace;
  await writeFile(join(dirtyExpiredWorktree.root, "dirty-local.txt"), "preserve me\n");
  const cleanExpiredWorktree = (await expiryRegistry.openWorkspace(ownerClientId, {
    path: gitRoot,
    mode: "worktree",
    forceNew: true,
  })).workspace;
  const expiryDatabase = new Database(databasePath(expiryStateDir));
  expiryDatabase.prepare("update workspace_sessions set last_used_at = ? where id = ?")
    .run("2026-01-01T00:00:00.000Z", dirtyExpiredWorktree.id);
  expiryDatabase.prepare("update workspace_sessions set last_used_at = ? where id = ?")
    .run("2026-01-01T00:00:01.000Z", cleanExpiredWorktree.id);
  expiryDatabase.close();
  assert.deepEqual(
    expiryRegistry.closeExpiredSessions(-1, () => false),
    [cleanExpiredWorktree.id],
  );
  await assert.rejects(stat(cleanExpiredWorktree.root));
  assert.equal((await stat(dirtyExpiredWorktree.root)).isDirectory(), true);
  assert.equal(expiryStore.countManagedWorktrees(), 1);
  const dirtyExpiryRemoval = await removeManagedWorktree({
    sourceRoot: gitRoot,
    worktreePath: dirtyExpiredWorktree.root,
    config: expiryConfig,
  });
  assert.equal(dirtyExpiryRemoval.reason, "dirty");
  await rm(join(dirtyExpiredWorktree.root, "dirty-local.txt"));
  assert.equal((await removeManagedWorktree({
    sourceRoot: gitRoot,
    worktreePath: dirtyExpiredWorktree.root,
    config: expiryConfig,
  })).removed, true);
  assert.equal(expiryRegistry.deleteWorkspace(ownerClientId, dirtyExpiredWorktree.id), true);
  expiryStore.close();

  const rotationStateDir = join(root, ".expiry-rotation-state");
  const rotationStore = new SqliteWorkspaceStore(rotationStateDir);
  const rotationRegistry = new WorkspaceRegistry(expiryConfig, rotationStore);
  for (let index = 0; index < 1_024; index += 1) {
    const id = `blocked-${String(index).padStart(4, "0")}`;
    rotationStore.createSession({ id, ownerClientId, alias: id, root });
  }
  rotationStore.createSession({ id: "zz-clean", ownerClientId, alias: "zz-clean", root });
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
  const reopenStore = new SqliteWorkspaceStore(reopenStateDir);
  const reopenRegistry = new WorkspaceRegistry(config, reopenStore);
  const beforeClose = (await reopenRegistry.openWorkspace(ownerClientId, root)).workspace;
  assert.equal(reopenRegistry.closeWorkspace(ownerClientId, beforeClose.id), true);
  const afterReopen = (await reopenRegistry.openWorkspace(ownerClientId, root)).workspace;
  assert.equal(afterReopen.id, beforeClose.id);
  assert.equal(afterReopen.stateGeneration, beforeClose.stateGeneration + 2);
  reopenStore.close();

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
    const escapedSession = escapedStore.createSession({
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
      /must be resumed before use/,
    );
    await assert.rejects(
      new WorkspaceRegistry(config, escapedStore).resumeWorkspace(
        ownerClientId,
        escapedSession.alias!,
      ),
      /workspace alias is unavailable/,
    );
    escapedStore.close();

    const aliasRoot = join(root, "alias-root");
    await symlink(root, aliasRoot, "dir");
    const aliasConfig = loadConfig({
      DEVSPACE_ALLOWED_ROOTS: aliasRoot,
      DEVSPACE_WORKTREE_ROOT: join(aliasRoot, ".devspace", "alias-worktrees"),
      DEVSPACE_AGENT_DIR: agentDir,
      DEVSPACE_USER_INSTRUCTIONS_PATH: userInstructionsPath,
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });
    const aliasWorkspace = await new WorkspaceRegistry(aliasConfig).openWorkspace(ownerClientId, {
      path: join(aliasRoot, "git-project"),
      mode: "worktree",
    });
    assert.equal(aliasWorkspace.workspace.sourceRoot, await realpath(gitRoot));

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
    assert.equal(aliasedCheckout.skillRevision, realCheckout.skillRevision);
    aliasReuseStore.close();
    const restoredAliasStore = new SqliteWorkspaceStore(join(root, ".alias-reuse-state"));
    const restoredAliasRegistry = new WorkspaceRegistry(aliasConfig, restoredAliasStore);
    assert.throws(
      () => restoredAliasRegistry.getWorkspace(ownerClientId, realCheckout.workspace.id),
      /must be resumed before use/,
    );
    const restoredAlias = (
      await restoredAliasRegistry.resumeWorkspace(ownerClientId, realCheckout.workspace.alias)
    ).workspace;
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
