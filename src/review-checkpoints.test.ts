import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { createReviewCheckpointManager } from "./review-checkpoints.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-review-checkpoints-test-"));

try {
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "devspace@example.com"]);
  await git(root, ["config", "user.name", "DevSpace Test"]);
  await writeFile(join(root, "README.md"), "hello\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "Initial commit"]);

  const manager = createReviewCheckpointManager();
  await Promise.all([
    manager.initializeWorkspace({ workspaceId: "ws_review", root }),
    manager.initializeWorkspace({ workspaceId: "ws_review", root }),
  ]);

  const clean = await manager.reviewChanges({ workspaceId: "ws_review", root });
  assert.equal(clean.summary.files, 0);
  assert.equal(clean.patch, "");
  assert.match(clean.result, /No changes/);

  await writeFile(join(root, "README.md"), "hello\nworld\n");
  await writeFile(join(root, "new.txt"), "new\n");

  const firstReview = await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    markReviewed: false,
  });
  assert.equal(firstReview.summary.files, 2);
  assert.equal(firstReview.summary.additions, 2);
  assert.equal(firstReview.summary.removals, 0);
  assert.equal(firstReview.files.some((file) => file.path === "README.md"), true);
  assert.equal(firstReview.files.some((file) => file.path === "new.txt"), true);
  assert.match(firstReview.patch, /world/);

  const restartedManager = createReviewCheckpointManager();
  const afterRestart = await restartedManager.reviewChanges({
    workspaceId: "ws_review",
    root,
    markReviewed: false,
  });
  assert.equal(afterRestart.summary.files, 2);
  assert.match(afterRestart.patch, /world/);

  const stillUnreviewed = await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    markReviewed: true,
  });
  assert.equal(stillUnreviewed.summary.files, 2);

  const afterReviewed = await manager.reviewChanges({ workspaceId: "ws_review", root });
  assert.equal(afterReviewed.summary.files, 0);

  await writeFile(join(root, "README.md"), "hello\nworld\nserialized\n");
  const serialized = await Promise.all([
    manager.reviewChanges({ workspaceId: "ws_review", root }),
    manager.reviewChanges({ workspaceId: "ws_review", root }),
  ]);
  assert.deepEqual(serialized.map((review) => review.summary.files), [1, 0]);

  await manager.initializeWorkspace({ workspaceId: "ws_missing_ref", root });
  await git(root, ["update-ref", "-d", "refs/devspace/review/ws_missing_ref/baseline"]);
  const missingRefManager = createReviewCheckpointManager();
  await assert.rejects(
    missingRefManager.reviewChanges({ workspaceId: "ws_missing_ref", root }),
    /Internal review checkpoint error.*open ref is valid and baseline ref is missing.*Refusing to reset review history/,
  );
  await missingRefManager.cleanupWorkspace({ workspaceId: "ws_missing_ref" });

  await manager.initializeWorkspace({ workspaceId: "ws_corrupt_ref", root });
  const tree = (await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root })).stdout.trim();
  await git(root, ["update-ref", "refs/devspace/review/ws_corrupt_ref/baseline", tree]);
  const corruptRefManager = createReviewCheckpointManager();
  await assert.rejects(
    corruptRefManager.reviewChanges({ workspaceId: "ws_corrupt_ref", root }),
    /Internal review checkpoint error.*open ref is valid and baseline ref is invalid.*Refusing to reset review history/,
  );
  await corruptRefManager.cleanupWorkspace({ workspaceId: "ws_corrupt_ref" });

  await manager.initializeWorkspace({ workspaceId: "ws_stale", root });
  const removed = await manager.cleanupStaleRefs({
    gitRoot: root,
    activeWorkspaceIds: ["ws_review"],
    olderThanMs: -1,
  });
  assert.equal(removed, 2);
  assert.deepEqual(await reviewRefNames(root), [
    "refs/devspace/review/ws_review/baseline",
    "refs/devspace/review/ws_review/open",
  ]);

  await manager.cleanupWorkspace({ workspaceId: "ws_review" });
  assert.deepEqual(await reviewRefNames(root), []);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function reviewRefNames(cwd: string): Promise<string[]> {
  const result = await execFileAsync("git", ["for-each-ref", "--format=%(refname)", "refs/devspace/review"], { cwd });
  return result.stdout.trim().split("\n").filter(Boolean).sort();
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
