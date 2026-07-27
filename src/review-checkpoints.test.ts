import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
  assert.match(firstReview.revision, /^review_[A-Za-z0-9_-]+$/u);

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
    expectedRevision: firstReview.revision,
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

  // Paging must survive an edit landing between pages. The retained diff is
  // what the cursor was issued against, so a sequence can always reach EOF;
  // recomputing per page would change the revision and restart it at byte zero.
  const pagingRoot = await mkdtemp(join(tmpdir(), "devspace-review-paging-"));
  try {
    await git(pagingRoot, ["init"]);
    await git(pagingRoot, ["config", "user.email", "devspace@example.com"]);
    await git(pagingRoot, ["config", "user.name", "DevSpace Test"]);
    await writeFile(join(pagingRoot, "seed.txt"), "seed\n");
    await git(pagingRoot, ["add", "-A"]);
    await git(pagingRoot, ["commit", "-m", "seed"]);

    const pagingManager = createReviewCheckpointManager();
    await pagingManager.initializeWorkspace({ workspaceId: "ws_paging", root: pagingRoot });
    await writeFile(join(pagingRoot, "reviewed.txt"), "under review\n");

    const page1 = await pagingManager.reviewChanges({
      workspaceId: "ws_paging",
      root: pagingRoot,
      markReviewed: false,
    });
    assert.match(page1.patch, /under review/u);

    // Someone edits the workspace mid-review.
    await writeFile(join(pagingRoot, "interfering.txt"), "written during paging\n");

    const page2 = await pagingManager.reviewChanges({
      workspaceId: "ws_paging",
      root: pagingRoot,
      markReviewed: false,
      continueRevision: page1.revision,
    });
    assert.equal(page2.revision, page1.revision, "continuation must keep the reviewed revision");
    assert.equal(page2.patch, page1.patch);
    assert.doesNotMatch(page2.patch, /written during paging/u);

    // A continuation for a revision that is not retained is reported as an
    // expired page sequence. Recomputing instead would return a different
    // revision, so the same caller behaviour would succeed or report the
    // workspace as changed depending on retention state it cannot observe.
    await assert.rejects(
      pagingManager.reviewChanges({
        workspaceId: "ws_paging",
        root: pagingRoot,
        markReviewed: false,
        continueRevision: "review_not-retained",
      }),
      /no longer retained/iu,
      "an unretained continuation must be reported, not silently recomputed",
    );

    // Serving from retention must hand out copies; a caller mutating the result
    // would otherwise corrupt every later page.
    const copy = await pagingManager.reviewChanges({
      workspaceId: "ws_paging",
      root: pagingRoot,
      markReviewed: false,
      continueRevision: page1.revision,
    });
    copy.summary.files = 999;
    copy.files.length = 0;
    const afterMutation = await pagingManager.reviewChanges({
      workspaceId: "ws_paging",
      root: pagingRoot,
      markReviewed: false,
      continueRevision: page1.revision,
    });
    assert.notEqual(afterMutation.summary.files, 999);

    const uncached = await pagingManager.reviewChanges({
      workspaceId: "ws_paging",
      root: pagingRoot,
      markReviewed: false,
    });
    assert.notEqual(uncached.revision, page1.revision);
    assert.match(uncached.patch, /written during paging/u);
    const oldSequenceStillRetained = await pagingManager.reviewChanges({
      workspaceId: "ws_paging",
      root: pagingRoot,
      markReviewed: false,
      continueRevision: page1.revision,
    });
    assert.equal(
      oldSequenceStillRetained.revision,
      page1.revision,
      "a newer preview must not overwrite an older conversation's page sequence",
    );

    // Advancing never reads the retained diff: it has to observe the worktree
    // as it is now, so reviewing one revision cannot advance a different one.
    await assert.rejects(
      pagingManager.reviewChanges({
        workspaceId: "ws_paging",
        root: pagingRoot,
        markReviewed: true,
        expectedRevision: page1.revision,
      }),
      /changed after the reviewed diff/iu,
      "advancing with a stale revision must be refused",
    );

    const advanced = await pagingManager.reviewChanges({
      workspaceId: "ws_paging",
      root: pagingRoot,
      markReviewed: true,
      expectedRevision: uncached.revision,
    });
    assert.equal(advanced.revision, uncached.revision);
    await assert.rejects(
      pagingManager.reviewChanges({
        workspaceId: "ws_paging",
        root: pagingRoot,
        markReviewed: false,
        continueRevision: uncached.revision,
      }),
      /no longer retained/iu,
      "advancing must discard the retained diff",
    );
    const afterAdvance = await pagingManager.reviewChanges({
      workspaceId: "ws_paging",
      root: pagingRoot,
      markReviewed: false,
    });
    assert.equal(afterAdvance.summary.files, 0, "the advanced checkpoint has no remaining changes");

    // Retention is bounded across workspaces. Once the bound is passed the
    // oldest sessions report an expired sequence rather than silently drifting.
    const largeStateDir = join(pagingRoot, "large-review-state");
    const largeManager = createReviewCheckpointManager({ stateDir: largeStateDir });
    const largeScope = { principalRef: "principal-large", workspaceGeneration: 7 };
    await largeManager.initializeWorkspace({ workspaceId: "ws_large", root: pagingRoot });
    await writeFile(
      join(pagingRoot, "large-diff.txt"),
      Array.from({ length: 28_000 }, (_unused, index) =>
        `${String(index).padStart(6, "0")}:${"x".repeat(90)}`).join("\n") + "\n",
    );
    const largeFirst = await largeManager.reviewChanges({
      workspaceId: "ws_large",
      root: pagingRoot,
      markReviewed: false,
      pagingScope: largeScope,
    });
    assert.equal(Buffer.byteLength(largeFirst.patch, "utf8") > 2 * 1024 * 1024, true);
    const largeContinuation = await largeManager.reviewChanges({
      workspaceId: "ws_large",
      root: pagingRoot,
      markReviewed: false,
      continueRevision: largeFirst.revision,
      pagingScope: largeScope,
    });
    assert.equal(largeContinuation.patch, largeFirst.patch);
    const spoolEntries = await readdir(join(largeStateDir, "review-diffs"));
    assert.equal(spoolEntries.some((entry) => entry.endsWith(".patch")), true);
    assert.equal(spoolEntries.some((entry) => entry.endsWith(".json")), true);

    const restartedLargeManager = createReviewCheckpointManager({ stateDir: largeStateDir });
    const afterManagerRestart = await restartedLargeManager.reviewChanges({
      workspaceId: "ws_large",
      root: pagingRoot,
      markReviewed: false,
      continueRevision: largeFirst.revision,
      pagingScope: largeScope,
    });
    assert.equal(afterManagerRestart.patch, largeFirst.patch);
    await assert.rejects(
      restartedLargeManager.reviewChanges({
        workspaceId: "ws_large",
        root: pagingRoot,
        markReviewed: false,
        continueRevision: largeFirst.revision,
        pagingScope: { ...largeScope, principalRef: "different-principal" },
      }),
      /no longer retained/iu,
      "a retained diff must remain bound to its principal and generation",
    );

    const cleanupStateDir = join(pagingRoot, "cleanup-review-state");
    let cleanupClock = 1_000;
    const cleanupScope = { principalRef: "principal-cleanup", workspaceGeneration: 9 };
    const cleanupManager = createReviewCheckpointManager({
      stateDir: cleanupStateDir,
      now: () => cleanupClock,
      retainedPatchTtlMs: 10,
    });
    await cleanupManager.initializeWorkspace({ workspaceId: "ws_cleanup", root: pagingRoot });
    await writeFile(join(pagingRoot, "cleanup-diff.txt"), "cleanup review\n");
    const cleanupFirst = await cleanupManager.reviewChanges({
      workspaceId: "ws_cleanup",
      root: pagingRoot,
      markReviewed: false,
      pagingScope: cleanupScope,
    });
    const cleanupSpool = join(cleanupStateDir, "review-diffs");
    await writeFile(join(cleanupSpool, ".abandoned.tmp"), "temporary");
    await writeFile(join(cleanupSpool, `${"f".repeat(64)}.patch`), "orphan");
    cleanupClock += 100;
    const cleanupAfterRestart = createReviewCheckpointManager({
      stateDir: cleanupStateDir,
      now: () => cleanupClock,
      retainedPatchTtlMs: 10,
    });
    await assert.rejects(
      cleanupAfterRestart.reviewChanges({
        workspaceId: "ws_cleanup",
        root: pagingRoot,
        markReviewed: false,
        continueRevision: cleanupFirst.revision,
        pagingScope: cleanupScope,
      }),
      /no longer retained/iu,
    );
    assert.deepEqual(
      await readdir(cleanupSpool),
      [],
      "startup scan removes expired pairs, temporary files, and orphan halves",
    );

    const boundedManager = createReviewCheckpointManager({ maxRetainedPatches: 4 });
    const sessions: Array<{ workspaceId: string; revision: string }> = [];
    for (let index = 0; index < 6; index += 1) {
      const workspaceId = `ws_bounded_${index}`;
      await boundedManager.initializeWorkspace({ workspaceId, root: pagingRoot });
      await writeFile(join(pagingRoot, `bounded-${index}.txt`), `change ${index}\n`);
      const preview = await boundedManager.reviewChanges({
        workspaceId,
        root: pagingRoot,
        markReviewed: false,
      });
      sessions.push({ workspaceId, revision: preview.revision });
    }
    const oldest = sessions[0]!;
    const newest = sessions.at(-1)!;
    await assert.rejects(
      boundedManager.reviewChanges({
        workspaceId: oldest.workspaceId,
        root: pagingRoot,
        markReviewed: false,
        continueRevision: oldest.revision,
      }),
      /no longer retained/iu,
      "the oldest retained diff must be evicted",
    );
    const stillRetained = await boundedManager.reviewChanges({
      workspaceId: newest.workspaceId,
      root: pagingRoot,
      markReviewed: false,
      continueRevision: newest.revision,
    });
    assert.equal(stillRetained.revision, newest.revision, "recent sessions keep their diff");
  } finally {
    await rm(pagingRoot, { recursive: true, force: true });
  }

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

  const cleanupAfterRestart = createReviewCheckpointManager();
  await cleanupAfterRestart.cleanupWorkspace({ workspaceId: "ws_review", root });
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
