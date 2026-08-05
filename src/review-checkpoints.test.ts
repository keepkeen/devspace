import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import {
  createReviewCheckpointManager,
  RepositoryReviewUnavailableError,
  UnsafeGitReviewConfigurationError,
  type ReviewChangesResult,
} from "./review-checkpoints.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-review-checkpoints-test-"));
const stateDir = await mkdtemp(join(tmpdir(), "devspace-review-state-test-"));
const parentRoot = await mkdtemp(join(tmpdir(), "devspace-review-parent-test-"));
const executableConfigRoot = await mkdtemp(join(tmpdir(), "devspace-review-executable-test-"));
const unbornRoot = await mkdtemp(join(tmpdir(), "devspace-review-unborn-test-"));

try {
  await initializeRepository(root);
  await writeFile(join(root, "README.md"), "hello\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "Initial commit"]);

  // Preserve an old DevSpace ref to prove the new manager never creates,
  // updates, or deletes repository refs, including through the compatibility
  // cleanup entry point.
  await git(root, ["update-ref", "refs/devspace/review/legacy", "HEAD"]);

  await writeFile(join(root, "README.md"), "hello\nunstaged\n");
  await writeFile(join(root, "staged.txt"), "staged\n");
  await git(root, ["add", "staged.txt"]);
  await writeFile(join(root, "untracked.txt"), "untracked\n");

  const gitStateBeforeReview = await gitStateSnapshot(root);
  const statusBeforeReview = await gitOutput(root, ["status", "--porcelain=v1", "-z"]);
  const manager = createReviewCheckpointManager({ stateDir });
  await Promise.all([
    manager.initializeWorkspace({ workspaceId: "ws_review", root }),
    manager.initializeWorkspace({ workspaceId: "ws_review", root }),
  ]);
  assert.deepEqual(
    await gitStateSnapshot(root),
    gitStateBeforeReview,
    "initialization must not write refs, the index, objects, or reflogs",
  );

  const firstReview = await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    source: "repository",
    pagingScope: { principalRef: "principal", workspaceGeneration: 1 },
  });
  assert.deepEqual(
    firstReview.files.map((file) => file.path).sort(),
    ["README.md", "staged.txt", "untracked.txt"],
    "the repository view includes staged, unstaged, and untracked files",
  );
  assert.equal(firstReview.summary.files, 3);
  assert.match(firstReview.patch, /unstaged/u);
  assert.match(firstReview.patch, /staged/u);
  assert.match(firstReview.patch, /untracked/u);
  assert.match(firstReview.revision, /^review_[A-Za-z0-9_-]+$/u);
  assert.equal(
    await gitOutput(root, ["status", "--porcelain=v1", "-z"]),
    statusBeforeReview,
    "showing changes must preserve the user's dirty worktree and staging area",
  );
  assert.deepEqual(
    await gitStateSnapshot(root),
    gitStateBeforeReview,
    "showing changes must not write Git state",
  );

  // Retained paging remains pinned even if the live repository changes.
  await writeFile(join(root, "untracked.txt"), "untracked\nlater\n");
  const continued = await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    source: "repository",
    continueRevision: firstReview.revision,
    pagingScope: { principalRef: "principal", workspaceGeneration: 1 },
  });
  assert.equal(continued.revision, firstReview.revision);
  assert.equal(continued.patch, firstReview.patch);
  assert.doesNotMatch(continued.patch, /later/u);

  const restartedManager = createReviewCheckpointManager({ stateDir });
  const continuedAfterRestart = await restartedManager.reviewChanges({
    workspaceId: "ws_review",
    root,
    source: "repository",
    continueRevision: firstReview.revision,
    pagingScope: { principalRef: "principal", workspaceGeneration: 1 },
  });
  assert.equal(continuedAfterRestart.patch, firstReview.patch);

  const currentReview = await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    source: "repository",
    pagingScope: { principalRef: "principal", workspaceGeneration: 1 },
  });
  assert.notEqual(currentReview.revision, firstReview.revision);
  assert.match(currentReview.patch, /later/u);
  const stillCurrent = await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    source: "repository",
  });
  assert.equal(
    stillCurrent.revision,
    currentReview.revision,
    "reviewing a diff must not hide still-present repository changes",
  );

  const statusAfterEdit = await gitOutput(root, ["status", "--porcelain=v1", "-z"]);
  assert.deepEqual(
    await gitStateSnapshot(root),
    gitStateBeforeReview,
    "previewing changes must remain Git-state read-only",
  );

  await manager.cleanupWorkspace({ workspaceId: "ws_review", root });
  assert.deepEqual(
    await gitStateSnapshot(root),
    gitStateBeforeReview,
    "cleanup must not delete refs or mutate any other Git state",
  );
  assert.equal(
    await gitOutput(root, ["status", "--porcelain=v1", "-z"]),
    statusAfterEdit,
    "cleanup must preserve dirty user files",
  );
  assert.deepEqual(
    await readdir(join(stateDir, "review-diffs")),
    [],
    "cleanup removes only the private retained-review files",
  );
  assert.deepEqual(
    await reviewRefNames(root),
    ["refs/devspace/review/legacy"],
    "pre-existing DevSpace refs are left untouched",
  );

  // A Project nested inside a larger repository is not authorized to expose
  // the parent repository. It uses only the server-observed apply_patch view.
  await initializeRepository(parentRoot);
  await mkdir(join(parentRoot, "approved-project"));
  await writeFile(join(parentRoot, "outside.txt"), "outside\n");
  await writeFile(join(parentRoot, "approved-project", "inside.txt"), "inside\n");
  await git(parentRoot, ["add", "-A"]);
  await git(parentRoot, ["commit", "-m", "Initial parent commit"]);
  await writeFile(join(parentRoot, "outside.txt"), "outside\nsecret parent change\n");
  await writeFile(
    join(parentRoot, "approved-project", "inside.txt"),
    "inside\napproved change\n",
  );

  const projectRoot = join(parentRoot, "approved-project");
  const parentGitState = await gitStateSnapshot(parentRoot);
  const nestedManager = createReviewCheckpointManager();
  await assert.rejects(
    nestedManager.reviewChanges({
      workspaceId: "ws_nested",
      root: projectRoot,
      source: "repository",
    }),
    RepositoryReviewUnavailableError,
  );

  const observed = observedReview();
  const nestedReview = await nestedManager.reviewChanges({
    workspaceId: "ws_nested",
    root: projectRoot,
    source: "apply_patch_history",
    observedChanges: observed,
  });
  assert.deepEqual(nestedReview.files.map((file) => file.path), ["inside.txt"]);
  assert.equal(nestedReview.patch, observed.patch);
  assert.doesNotMatch(nestedReview.patch, /outside|secret parent/iu);
  await nestedManager.cleanupWorkspace({
    workspaceId: "ws_nested",
    root: projectRoot,
  });
  assert.deepEqual(
    await gitStateSnapshot(parentRoot),
    parentGitState,
    "nested-Project review and cleanup must not touch the parent repository",
  );

  // Read-only review must not execute repository-configured fsmonitor or
  // clean/process filter programs.
  await initializeRepository(executableConfigRoot);
  await writeFile(join(executableConfigRoot, ".gitattributes"), "filtered.txt filter=evil\n");
  await writeFile(join(executableConfigRoot, "filtered.txt"), "committed\n");
  await git(executableConfigRoot, ["add", "-A"]);
  await git(executableConfigRoot, ["commit", "-m", "Executable config fixture"]);
  const executableMarker = join(stateDir, "git-program-invoked");
  const executableScript = join(executableConfigRoot, "git-program.cjs");
  await writeFile(
    executableScript,
    "const fs = require('node:fs');\n" +
      `fs.writeFileSync(${JSON.stringify(executableMarker)}, 'invoked\\n');\n` +
      "process.stdin.pipe(process.stdout);\n",
  );
  await chmod(executableScript, 0o700);
  const executableCommand =
    `${JSON.stringify(process.execPath)} ${JSON.stringify(executableScript)}`;
  await git(executableConfigRoot, ["config", "core.fsmonitor", executableCommand]);
  await writeFile(join(executableConfigRoot, "filtered.txt"), "modified\n");

  const safeGitManager = createReviewCheckpointManager();
  const fsmonitorSafeReview = await safeGitManager.reviewChanges({
    workspaceId: "ws_executable",
    root: executableConfigRoot,
    source: "repository",
  });
  assert.match(fsmonitorSafeReview.patch, /modified/u);
  assert.equal(await pathExists(executableMarker), false, "core.fsmonitor was not executed");

  await git(executableConfigRoot, ["config", "filter.evil.clean", executableCommand]);
  await git(executableConfigRoot, ["config", "filter.evil.process", executableCommand]);
  await assert.rejects(
    safeGitManager.reviewChanges({
      workspaceId: "ws_executable",
      root: executableConfigRoot,
      source: "repository",
    }),
    (error: unknown) =>
      error instanceof UnsafeGitReviewConfigurationError &&
      error.filterDrivers.includes("evil"),
  );
  assert.equal(
    await pathExists(executableMarker),
    false,
    "executable clean/process filters were rejected before Git diff",
  );

  // A top-level repository with no HEAD is still a Git Project. Its staged,
  // unstaged, and untracked state is reviewed without creating an empty-tree
  // object or any other Git state.
  await initializeRepository(unbornRoot);
  await writeFile(join(unbornRoot, "staged.txt"), "staged version\n");
  await git(unbornRoot, ["add", "staged.txt"]);
  await writeFile(join(unbornRoot, "staged.txt"), "staged version\nunstaged version\n");
  await writeFile(join(unbornRoot, "untracked.txt"), "untracked version\n");
  const unbornStateBefore = await gitStateSnapshot(unbornRoot);
  const unbornManager = createReviewCheckpointManager();
  const unbornReview = await unbornManager.reviewChanges({
    workspaceId: "ws_unborn",
    root: unbornRoot,
    source: "repository",
  });
  assert.deepEqual(
    new Set(unbornReview.files.map((file) => file.path)),
    new Set(["staged.txt", "untracked.txt"]),
  );
  assert.equal(unbornReview.summary.files, 2);
  assert.match(unbornReview.patch, /staged version/u);
  assert.match(unbornReview.patch, /unstaged version/u);
  assert.match(unbornReview.patch, /untracked version/u);
  assert.deepEqual(
    await gitStateSnapshot(unbornRoot),
    unbornStateBefore,
    "unborn repository review must not write Git state",
  );

  const explicitHistory = observedReview();
  const gitProjectHistory = await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    source: "apply_patch_history",
    observedChanges: explicitHistory,
  });
  assert.equal(gitProjectHistory.patch, explicitHistory.patch);
} finally {
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(stateDir, { recursive: true, force: true }),
    rm(parentRoot, { recursive: true, force: true }),
    rm(executableConfigRoot, { recursive: true, force: true }),
    rm(unbornRoot, { recursive: true, force: true }),
  ]);
}

function observedReview(): ReviewChangesResult {
  return {
    result: "Recorded one successful DevSpace apply_patch operation.",
    summary: { files: 1, additions: 1, removals: 0 },
    files: [{
      path: "inside.txt",
      type: "change",
      additions: 1,
      removals: 0,
    }],
    patch: "--- a/inside.txt\n+++ b/inside.txt\n@@ -1 +1,2 @@\n inside\n+approved change\n",
    revision: "review_observed",
  };
}

async function initializeRepository(cwd: string): Promise<void> {
  await git(cwd, ["init"]);
  await git(cwd, ["config", "user.email", "devspace@example.com"]);
  await git(cwd, ["config", "user.name", "DevSpace Test"]);
}

async function reviewRefNames(cwd: string): Promise<string[]> {
  const output = await gitOutput(cwd, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/devspace/review",
  ]);
  return output.trim().split("\n").filter(Boolean).sort();
}

async function gitStateSnapshot(cwd: string): Promise<unknown> {
  const gitDirOutput = (await gitOutput(cwd, ["rev-parse", "--git-dir"])).trim();
  const gitDir = isAbsolute(gitDirOutput) ? gitDirOutput : join(cwd, gitDirOutput);
  const indexPath = join(gitDir, "index");
  const indexStats = await stat(indexPath, { bigint: true });
  return {
    refs: await gitOutput(cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)"]),
    index: (await readFile(indexPath)).toString("base64"),
    indexMtimeNs: indexStats.mtimeNs,
    objects: await snapshotTree(join(gitDir, "objects")),
    logs: await snapshotTree(join(gitDir, "logs")),
  };
}

async function snapshotTree(root: string): Promise<Array<[string, string]>> {
  let entries: string[];
  try {
    entries = (await readdir(root, { recursive: true })).map(String).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const snapshot: Array<[string, string]> = [];
  for (const entry of entries) {
    const path = join(root, entry);
    const stats = await lstat(path);
    if (stats.isDirectory()) {
      snapshot.push([entry, "directory"]);
    } else if (stats.isFile()) {
      snapshot.push([entry, (await readFile(path)).toString("base64")]);
    }
  }
  return snapshot;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  })).stdout;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
