import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);

export interface ManagedProjectWorktree {
  worktreeId: string;
  threadId: string;
  projectRoot: string;
  worktreeRoot: string;
  branchRef: string;
  baseRef: string;
  baseSha: string;
}

export interface ProjectWorktreeStatus {
  dirty: boolean;
  branchRef: string;
  headSha: string;
  porcelain: string;
}

export interface ProjectWorktreeManagerOptions {
  rootDir: string;
  createWorktreeId?: () => string;
  runGit?: (cwd: string, args: string[]) => Promise<string>;
}

export class ProjectWorktreeError extends Error {
  constructor(
    readonly code:
      | "not_git_repository"
      | "worktree_exists"
      | "worktree_not_found"
      | "worktree_dirty"
      | "git_failed",
    message: string,
  ) {
    super(message);
    this.name = "ProjectWorktreeError";
  }
}

export class ProjectWorktreeManager {
  private readonly rootDir: string;
  private readonly createWorktreeId: () => string;
  private readonly runGit: (cwd: string, args: string[]) => Promise<string>;

  constructor(options: ProjectWorktreeManagerOptions) {
    this.rootDir = resolve(options.rootDir);
    this.createWorktreeId = options.createWorktreeId ?? randomUUID;
    this.runGit = options.runGit ?? defaultRunGit;
  }

  async create(input: {
    threadId: string;
    projectRoot: string;
    baseRef?: string;
  }): Promise<ManagedProjectWorktree> {
    const projectRoot = await realpath(input.projectRoot);
    const gitTopLevel = await this.gitTopLevel(projectRoot);
    if (gitTopLevel !== projectRoot) {
      throw new ProjectWorktreeError(
        "not_git_repository",
        "A managed thread worktree requires the Project root to equal the Git top level.",
      );
    }
    const baseRef = input.baseRef ?? "HEAD";
    const baseSha = (await this.git(projectRoot, ["rev-parse", "--verify", `${baseRef}^{commit}`])).trim();
    const worktreeId = boundedId(this.createWorktreeId(), "worktreeId");
    const threadId = boundedId(input.threadId, "threadId");
    const projectBucket = createHash("sha256")
      .update(projectRoot, "utf8")
      .digest("hex")
      .slice(0, 20);
    const worktreeRoot = join(this.rootDir, projectBucket, worktreeId);
    const branchRef = `refs/heads/devspace/thread-${safeRefComponent(threadId)}-${worktreeId.slice(0, 8)}`;
    try {
      await stat(worktreeRoot);
      throw new ProjectWorktreeError("worktree_exists", "Managed worktree path already exists.");
    } catch (error) {
      if (error instanceof ProjectWorktreeError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(dirname(worktreeRoot), { recursive: true, mode: 0o700 });
    try {
      await this.git(projectRoot, [
        "worktree",
        "add",
        "-b",
        branchRef.replace(/^refs\/heads\//u, ""),
        "--",
        worktreeRoot,
        baseSha,
      ]);
    } catch (error) {
      await rm(worktreeRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return {
      worktreeId,
      threadId,
      projectRoot,
      worktreeRoot,
      branchRef,
      baseRef,
      baseSha,
    };
  }

  async status(worktreeRoot: string): Promise<ProjectWorktreeStatus> {
    const root = await this.assertManagedWorktree(worktreeRoot);
    const [porcelain, branchRef, headSha] = await Promise.all([
      this.git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
      this.git(root, ["symbolic-ref", "-q", "HEAD"]).catch(() => ""),
      this.git(root, ["rev-parse", "HEAD"]),
    ]);
    return {
      dirty: porcelain.length > 0,
      branchRef: branchRef.trim(),
      headSha: headSha.trim(),
      porcelain,
    };
  }

  async diff(worktreeRoot: string, baseRef: string): Promise<string> {
    const root = await this.assertManagedWorktree(worktreeRoot);
    return this.git(root, ["diff", "--binary", "--find-renames", `${baseRef}...HEAD`]);
  }

  async handoff(input: {
    worktreeRoot: string;
    targetRoot: string;
    strategy: "patch" | "cherry-pick";
    baseRef: string;
  }): Promise<{ strategy: "patch" | "cherry-pick"; patch?: string; commits?: string[] }> {
    const worktreeRoot = await this.assertManagedWorktree(input.worktreeRoot);
    const targetRoot = await realpath(input.targetRoot);
    if (input.strategy === "patch") {
      return {
        strategy: "patch",
        patch: await this.diff(worktreeRoot, input.baseRef),
      };
    }
    const commits = (await this.git(worktreeRoot, [
      "rev-list",
      "--reverse",
      `${input.baseRef}..HEAD`,
    ])).split(/\r?\n/u).filter(Boolean);
    for (const commit of commits) {
      await this.git(targetRoot, ["cherry-pick", commit]);
    }
    return { strategy: "cherry-pick", commits };
  }

  async remove(input: {
    projectRoot: string;
    worktreeRoot: string;
    branchRef?: string;
    force?: boolean;
  }): Promise<{ removed: boolean; dirty: boolean }> {
    const projectRoot = await realpath(input.projectRoot);
    const worktreeRoot = await this.assertManagedWorktree(input.worktreeRoot);
    const status = await this.status(worktreeRoot);
    if (status.dirty && input.force !== true) {
      throw new ProjectWorktreeError(
        "worktree_dirty",
        "Dirty managed worktrees are never removed automatically.",
      );
    }
    await this.git(projectRoot, [
      "worktree",
      "remove",
      ...(input.force === true ? ["--force"] : []),
      "--",
      worktreeRoot,
    ]);
    if (input.branchRef) {
      const branch = input.branchRef.replace(/^refs\/heads\//u, "");
      await this.git(projectRoot, ["branch", "-D", "--", branch]).catch(() => undefined);
    }
    return { removed: true, dirty: status.dirty };
  }

  private async assertManagedWorktree(worktreeRoot: string): Promise<string> {
    let root: string;
    try {
      root = await realpath(worktreeRoot);
    } catch {
      throw new ProjectWorktreeError("worktree_not_found", "Managed worktree does not exist.");
    }
    let managedRoot: string;
    try {
      managedRoot = await realpath(this.rootDir);
    } catch {
      throw new ProjectWorktreeError("worktree_not_found", "Managed worktree root does not exist.");
    }
    const relativeRoot = relative(managedRoot, root);
    if (
      relativeRoot === ".." ||
      relativeRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(relativeRoot)
    ) {
      throw new ProjectWorktreeError("worktree_not_found", "Path is not a managed worktree.");
    }
    const topLevel = await this.gitTopLevel(root);
    if (topLevel !== root) {
      throw new ProjectWorktreeError("worktree_not_found", "Managed worktree root is invalid.");
    }
    return root;
  }

  private async gitTopLevel(cwd: string): Promise<string> {
    try {
      return await realpath((await this.git(cwd, ["rev-parse", "--show-toplevel"])).trim());
    } catch (error) {
      if (error instanceof ProjectWorktreeError) throw error;
      throw new ProjectWorktreeError("not_git_repository", "Project is not a Git repository.");
    }
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    try {
      return await this.runGit(cwd, args);
    } catch (error) {
      if (error instanceof ProjectWorktreeError) throw error;
      throw new ProjectWorktreeError(
        "git_failed",
        error instanceof Error ? error.message : "Git command failed.",
      );
    }
  }
}

async function defaultRunGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return result.stdout;
}

function safeRefComponent(value: string): string {
  const slug = basename(value)
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
  return slug || "thread";
}

function boundedId(value: string, name: string): string {
  if (!value || value.includes("\0") || Buffer.byteLength(value, "utf8") > 1_024) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}
