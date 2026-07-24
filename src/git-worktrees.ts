import { randomBytes } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync, statSync } from "node:fs";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { ServerConfig } from "./config.js";
import { assertAllowedPath, isPathInsideRoot } from "./roots.js";

const execFileAsync = promisify(execFile);

export class GitWorktreeError extends Error {
  constructor(
    readonly code:
      | "GIT_NOT_AVAILABLE"
      | "GIT_REPOSITORY_NOT_FOUND"
      | "GIT_REPOSITORY_HAS_NO_COMMITS"
      | "GIT_INVALID_BASE_REF"
      | "GIT_WORKTREE_CREATE_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "GitWorktreeError";
  }
}

export interface ManagedWorktree {
  sourceRoot: string;
  path: string;
  baseRef: string;
  baseSha: string;
  dirtySource: boolean;
  detached: boolean;
  managed: boolean;
}

export interface ManagedWorktreeBase {
  sourceRoot: string;
  baseRef: string;
  baseSha: string;
  dirtySource: boolean;
}

export interface ManagedWorktreeRemovalResult {
  removed: boolean;
  reason?: "dirty" | "missing";
}

export async function removeManagedWorktree(input: {
  sourceRoot: string;
  worktreePath: string;
  config: ServerConfig;
}): Promise<ManagedWorktreeRemovalResult> {
  const sourceRoot = await assertGitRootAllowed(input.sourceRoot, input.config.allowedRoots);
  const worktreePath = assertAllowedPath(input.worktreePath, [input.config.worktreeRoot]);
  try {
    const worktreeStats = await stat(worktreePath);
    if (!worktreeStats.isDirectory()) return { removed: false, reason: "missing" };
  } catch {
    await git(["worktree", "prune"], sourceRoot).catch(() => undefined);
    return { removed: false, reason: "missing" };
  }

  const dirty = (await git(["status", "--porcelain=v1"], worktreePath)).trim().length > 0;
  if (dirty) return { removed: false, reason: "dirty" };

  await git(["worktree", "remove", worktreePath], sourceRoot);
  await git(["worktree", "prune"], sourceRoot);
  return { removed: true };
}

export function removeManagedWorktreeSync(input: {
  sourceRoot: string;
  worktreePath: string;
  config: ServerConfig;
}): ManagedWorktreeRemovalResult {
  const sourceRoot = assertGitRootAllowedSync(input.sourceRoot, input.config.allowedRoots);
  const worktreePath = assertAllowedPath(input.worktreePath, [input.config.worktreeRoot]);
  try {
    if (!statSync(worktreePath).isDirectory()) return { removed: false, reason: "missing" };
  } catch {
    gitSync(["worktree", "prune"], sourceRoot, true);
    return { removed: false, reason: "missing" };
  }

  if (gitSync(["status", "--porcelain=v1"], worktreePath).trim().length > 0) {
    return { removed: false, reason: "dirty" };
  }

  gitSync(["worktree", "remove", worktreePath], sourceRoot);
  gitSync(["worktree", "prune"], sourceRoot);
  return { removed: true };
}

export async function resolveManagedWorktreeBase(input: {
  sourcePath: string;
  baseRef?: string;
  config: ServerConfig;
}): Promise<ManagedWorktreeBase> {
  const sourcePath = assertAllowedPath(input.sourcePath, input.config.allowedRoots);

  try {
    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isDirectory()) {
      throw new GitWorktreeError(
        "GIT_REPOSITORY_NOT_FOUND",
        `Cannot open workspace in worktree mode because the source path is not a directory: ${input.sourcePath}`,
      );
    }
  } catch (error) {
    if (error instanceof GitWorktreeError) throw error;
    throw new GitWorktreeError(
      "GIT_REPOSITORY_NOT_FOUND",
      `Cannot open workspace in worktree mode because the source path does not exist: ${input.sourcePath}`,
    );
  }

  const logicalSourceRoot = await resolveGitRoot(sourcePath, input.config.allowedRoots);
  const sourceRoot = await realpath(logicalSourceRoot);
  const baseRef = input.baseRef ?? "HEAD";
  const baseSha = await resolveBaseCommit(sourceRoot, baseRef);
  const dirtySource = (await git(["status", "--porcelain=v1"], sourceRoot)).trim().length > 0;
  return { sourceRoot, baseRef, baseSha, dirtySource };
}

export async function createManagedWorktree(input: {
  sourcePath: string;
  baseRef?: string;
  config: ServerConfig;
  resolvedBase?: ManagedWorktreeBase;
}): Promise<ManagedWorktree> {
  const { sourceRoot, baseRef, baseSha, dirtySource } = input.resolvedBase
    ?? await resolveManagedWorktreeBase(input);
  const worktreePath = managedWorktreePath({
    worktreeRoot: input.config.worktreeRoot,
    repoRoot: sourceRoot,
  });

  await mkdir(input.config.worktreeRoot, { recursive: true });
  assertAllowedPath(worktreePath, [input.config.worktreeRoot]);

  try {
    await git(["worktree", "add", "--detach", worktreePath, baseSha], sourceRoot);
  } catch (error) {
    await rm(worktreePath, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new GitWorktreeError(
      "GIT_WORKTREE_CREATE_FAILED",
      `Git failed to create the managed worktree. ${message}`,
    );
  }

  return {
    sourceRoot,
    path: worktreePath,
    baseRef,
    baseSha,
    dirtySource,
    detached: true,
    managed: true,
  };
}

export async function restoreManagedWorktree(input: {
  sourceRoot: string;
  worktreePath: string;
  baseRef: string;
  baseSha: string;
  dirtySource: boolean;
  config: ServerConfig;
}): Promise<ManagedWorktree> {
  const sourceRoot = await assertGitRootAllowed(input.sourceRoot, input.config.allowedRoots);
  const worktreePath = assertAllowedPath(input.worktreePath, [input.config.worktreeRoot]);
  const registeredHead = await managedWorktreeHead(sourceRoot, worktreePath).catch(() => undefined);
  const recoverySha = registeredHead ?? input.baseSha;
  await mkdir(dirname(worktreePath), { recursive: true });
  await git(["worktree", "prune"], sourceRoot).catch(() => undefined);
  try {
    await git(["worktree", "add", "--detach", worktreePath, recoverySha], sourceRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GitWorktreeError(
      "GIT_WORKTREE_CREATE_FAILED",
      `Git failed to restore the managed worktree. ${message}`,
    );
  }
  return {
    sourceRoot,
    path: worktreePath,
    baseRef: input.baseRef,
    baseSha: recoverySha,
    dirtySource: input.dirtySource,
    detached: true,
    managed: true,
  };
}

export async function managedWorktreeHead(
  sourceRoot: string,
  worktreePath: string,
): Promise<string | undefined> {
  const output = await git(["worktree", "list", "--porcelain"], sourceRoot);
  const expected = await canonicalMissingPath(worktreePath);
  for (const block of output.split(/\n\s*\n/gu)) {
    let listedPath: string | undefined;
    let head: string | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) {
        listedPath = await canonicalMissingPath(line.slice("worktree ".length));
      }
      else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length).trim();
    }
    if (listedPath === expected && /^[0-9a-f]{40,64}$/u.test(head ?? "")) return head;
  }
  return undefined;
}

export async function validatedManagedWorktreeHead(
  sourceRoot: string,
  worktreePath: string,
): Promise<string | undefined> {
  try {
    const registeredHead = await managedWorktreeHead(sourceRoot, worktreePath);
    if (!registeredHead) return undefined;
    const [actualHead, sourceCommonDir, worktreeCommonDir] = await Promise.all([
      git(["rev-parse", "HEAD"], worktreePath),
      git(["rev-parse", "--git-common-dir"], sourceRoot),
      git(["rev-parse", "--git-common-dir"], worktreePath),
    ]);
    const canonicalSourceCommonDir = await realpath(resolve(sourceRoot, sourceCommonDir.trim()));
    const canonicalWorktreeCommonDir = await realpath(resolve(worktreePath, worktreeCommonDir.trim()));
    return actualHead.trim() === registeredHead &&
        canonicalSourceCommonDir === canonicalWorktreeCommonDir
      ? registeredHead
      : undefined;
  } catch {
    return undefined;
  }
}

async function canonicalMissingPath(path: string): Promise<string> {
  const absolute = resolve(path);
  const suffix: string[] = [basename(absolute)];
  let ancestor = dirname(absolute);
  for (;;) {
    try {
      return join(await realpath(ancestor), ...suffix);
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) return absolute;
      suffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

async function resolveGitRoot(path: string, allowedRoots: string[]): Promise<string> {
  try {
    const output = await git(["rev-parse", "--show-toplevel"], path);
    return await assertGitRootAllowed(output.trim(), allowedRoots);
  } catch (error) {
    if (isGitUnavailable(error)) {
      throw new GitWorktreeError(
        "GIT_NOT_AVAILABLE",
        "Cannot open workspace in worktree mode because Git is not available on this machine.",
      );
    }

    throw new GitWorktreeError(
      "GIT_REPOSITORY_NOT_FOUND",
      `Cannot open workspace in worktree mode because this path is not inside a Git repository: ${path}. Use mode=\"checkout\" to work directly in this directory, or initialize Git and create an initial commit first.`,
    );
  }
}

async function assertGitRootAllowed(gitRoot: string, allowedRoots: string[]): Promise<string> {
  try {
    return assertAllowedPath(gitRoot, allowedRoots);
  } catch {
    const canonicalGitRoot = await realpath(gitRoot);
    for (const allowedRoot of allowedRoots) {
      const canonicalAllowedRoot = await realpath(allowedRoot).catch(() => undefined);
      if (!canonicalAllowedRoot || !isPathInsideRoot(canonicalGitRoot, canonicalAllowedRoot)) {
        continue;
      }

      const logicalGitRoot = resolve(allowedRoot, relative(canonicalAllowedRoot, canonicalGitRoot));
      return assertAllowedPath(logicalGitRoot, allowedRoots);
    }

    return assertAllowedPath(canonicalGitRoot, allowedRoots);
  }
}

function assertGitRootAllowedSync(gitRoot: string, allowedRoots: string[]): string {
  try {
    return assertAllowedPath(gitRoot, allowedRoots);
  } catch {
    const canonicalGitRoot = realpathSync(gitRoot);
    for (const allowedRoot of allowedRoots) {
      let canonicalAllowedRoot: string;
      try {
        canonicalAllowedRoot = realpathSync(allowedRoot);
      } catch {
        continue;
      }
      if (!isPathInsideRoot(canonicalGitRoot, canonicalAllowedRoot)) continue;
      const logicalGitRoot = resolve(allowedRoot, relative(canonicalAllowedRoot, canonicalGitRoot));
      return assertAllowedPath(logicalGitRoot, allowedRoots);
    }
    return assertAllowedPath(canonicalGitRoot, allowedRoots);
  }
}

async function resolveBaseCommit(sourceRoot: string, baseRef: string): Promise<string> {
  try {
    return (await git(["rev-parse", "--verify", `${baseRef}^{commit}`], sourceRoot)).trim();
  } catch (error) {
    if (baseRef === "HEAD") {
      throw new GitWorktreeError(
        "GIT_REPOSITORY_HAS_NO_COMMITS",
        "Cannot open workspace in worktree mode because the repository has no commits yet. Create an initial commit first, or use mode=\"checkout\".",
      );
    }

    throw new GitWorktreeError(
      "GIT_INVALID_BASE_REF",
      `Cannot open workspace in worktree mode because baseRef ${JSON.stringify(baseRef)} does not resolve to a commit.`,
    );
  }
}

function managedWorktreePath(input: { worktreeRoot: string; repoRoot: string }): string {
  const repoName = sanitizePathSegment(basename(input.repoRoot)) || "repo";
  const worktreeId = randomBytes(4).toString("hex");
  return join(input.worktreeRoot, `${repoName}-${worktreeId}`);
}

function sanitizePathSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (isGitUnavailable(error)) throw error;

    const stderr = typeof error === "object" && error && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "").trim()
      : "";
    const stdout = typeof error === "object" && error && "stdout" in error
      ? String((error as { stdout?: unknown }).stdout ?? "").trim()
      : "";
    const details = stderr || stdout || (error instanceof Error ? error.message : String(error));
    throw new Error(details);
  }
}

function gitSync(args: string[], cwd: string, ignoreFailure = false): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (ignoreFailure) return "";
    throw error;
  }
}

function isGitUnavailable(error: unknown): boolean {
  return Boolean(
    typeof error === "object" &&
      error &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT",
  );
}
