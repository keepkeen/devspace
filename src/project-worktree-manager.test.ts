import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProjectWorktreeError,
  ProjectWorktreeManager,
} from "./project-worktree-manager.js";

const root = mkdtempSync(join(tmpdir(), "devspace-worktree-manager-"));
const projectRoot = join(root, "project");
const managedRoot = join(root, "managed");
mkdirSync(projectRoot, { recursive: true });
const calls: Array<{ cwd: string; args: string[] }> = [];
let dirty = false;
const manager = new ProjectWorktreeManager({
  rootDir: managedRoot,
  createWorktreeId: () => "worktree-a",
  runGit: async (cwd, args) => {
    calls.push({ cwd, args });
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${realpathSync(cwd)}\n`;
    if (args[0] === "rev-parse" && args[1] === "--verify") return "base-sha\n";
    if (args[0] === "worktree" && args[1] === "add") {
      mkdirSync(String(args.at(-2)), { recursive: true });
      return "";
    }
    if (args[0] === "status") return dirty ? " M changed.txt\n" : "";
    if (args[0] === "symbolic-ref") return "refs/heads/devspace/thread-thread-a-worktree\n";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "head-sha\n";
    return "";
  },
});

try {
  const worktree = await manager.create({ threadId: "thread-a", projectRoot });
  assert.equal(worktree.baseSha, "base-sha");
  assert.ok(calls.some(({ args }) => args[0] === "worktree" && args[1] === "add"));
  assert.equal((await manager.status(worktree.worktreeRoot)).dirty, false);

  dirty = true;
  await assert.rejects(
    manager.remove({
      projectRoot,
      worktreeRoot: worktree.worktreeRoot,
      branchRef: worktree.branchRef,
    }),
    (error: unknown) =>
      error instanceof ProjectWorktreeError && error.code === "worktree_dirty",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("project worktree manager tests passed");
