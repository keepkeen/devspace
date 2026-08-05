import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { git, type GitCommandResult } from "./git.js";

export interface ReviewSummary {
  files: number;
  additions: number;
  removals: number;
}

export interface ReviewFile {
  path: string;
  previousPath?: string;
  type: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
  additions: number;
  removals: number;
}

export interface ReviewChangesResult {
  result: string;
  summary: ReviewSummary;
  files: ReviewFile[];
  patch: string;
  revision: string;
}

export type ReviewSource = "repository" | "apply_patch_history";

/**
 * A page sequence asked to continue a diff that is no longer retained.
 *
 * Reported distinctly rather than recomputing, because the recomputed diff is a
 * different revision: continuing silently would either succeed or report the
 * workspace as changed depending on retention state the caller cannot observe.
 */
export class ReviewPagingExpiredError extends Error {
  constructor(readonly source: ReviewSource) {
    super("The reviewed diff is no longer retained for paging.");
    this.name = "ReviewPagingExpiredError";
  }
}

export class RepositoryReviewUnavailableError extends Error {
  readonly code = "repository_review_unavailable";

  constructor() {
    super("Repository review requires the Project root to be an exact Git top level.");
    this.name = "RepositoryReviewUnavailableError";
  }
}

export class UnsafeGitReviewConfigurationError extends Error {
  readonly code = "git_review_unsafe_configuration";
  readonly filterDrivers: readonly string[];

  constructor(filterDrivers: readonly string[]) {
    super(
      "Repository review is disabled because executable Git clean/process filters are active.",
    );
    this.name = "UnsafeGitReviewConfigurationError";
    this.filterDrivers = filterDrivers
      .slice(0, 8)
      .map((driver) => driver.length <= 128 ? driver : "(oversized driver name)");
  }
}

interface RetainedReviewPatch {
  key: string;
  workspaceId: string;
  pagingScope: ReviewPagingScope;
  revision: string;
  result: Omit<ReviewChangesResult, "patch">;
  patch?: string;
  spoolPath?: string;
  metadataPath?: string;
  patchBytes: number;
  patchHash: string;
  retainedAt: number;
}

interface RetainedReviewMetadata {
  schemaVersion: 2;
  key: string;
  workspaceId: string;
  pagingScope: ReviewPagingScope;
  revision: string;
  result: Omit<ReviewChangesResult, "patch">;
  patchBytes: number;
  patchHash: string;
  retainedAt: number;
}

export interface ReviewPagingScope {
  principalRef: string;
  workspaceGeneration: number;
}

export interface ReviewCheckpointManagerOptions {
  stateDir?: string;
  now?: () => number;
  retainedPatchTtlMs?: number;
  maxRetainedPatches?: number;
  maxRetainedSpoolBytes?: number;
  onSpoolError?: (error: unknown) => void;
}

interface WorkspaceReviewState {
  root: string;
  gitRoot?: string;
  diagnostic?: string;
  initialization?: Promise<void>;
  operationTail: Promise<void>;
  closing: boolean;
}

export interface ReviewCheckpointManager {
  activeWorkspaceIds(): string[];
  initializeWorkspace(input: { workspaceId: string; root: string }): Promise<void>;
  reviewChanges(input: {
    workspaceId: string;
    root: string;
    source: ReviewSource;
    pagingScope?: ReviewPagingScope;
    /**
     * Continue an established paging session: serve the retained diff for this
     * exact revision instead of snapshotting the repository again. Ignored when
     * the revision is not retained.
     */
    continueRevision?: string;
    /** Successful DevSpace apply_patch history for the selected execution. */
    observedChanges?: ReviewChangesResult;
  }): Promise<ReviewChangesResult>;
  cleanupWorkspace(input: { workspaceId: string; root?: string }): Promise<void>;
}

// Small diffs stay in memory for fast paging; every persistent deployment also
// writes a private spool so page sequences survive manager/server recreation.
const MAX_RETAINED_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_RETAINED_PATCHES = 16;
const MAX_RETAINED_SPOOL_BYTES = 256 * 1024 * 1024;
const MAX_RETAINED_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_RETAINED_PATCH_FILE_BYTES = 50 * 1024 * 1024;
const RETAINED_PATCH_TTL_MS = 10 * 60_000;
const RETAINED_KEY_PATTERN = /^[a-f0-9]{64}$/u;
const READ_ONLY_GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  PAGER: "cat",
  LC_ALL: "C",
  LANG: "C",
};
const READ_ONLY_GIT_UNSET_ENV = [
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_EXTERNAL_DIFF",
  "GIT_DIFF_OPTS",
  "GIT_INDEX_FILE",
  "GIT_WORK_TREE",
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_ATTR_SOURCE",
  "GIT_EXEC_PATH",
] as const;
const READ_ONLY_GIT_PREFIX = [
  "--no-pager",
  "-c",
  "core.fsmonitor=false",
] as const;
const GIT_ATTRIBUTE_ARGUMENT_BYTES = 64 * 1024;
const GIT_ATTRIBUTE_ARGUMENT_COUNT = 256;

export function createReviewCheckpointManager(
  options: ReviewCheckpointManagerOptions = {},
): ReviewCheckpointManager {
  const states = new Map<string, WorkspaceReviewState>();
  const retainedPatches = new Map<string, RetainedReviewPatch>();
  const spoolRoot = options.stateDir ? join(options.stateDir, "review-diffs") : undefined;
  const now = options.now ?? Date.now;
  const retainedPatchTtlMs = options.retainedPatchTtlMs ?? RETAINED_PATCH_TTL_MS;
  const maxRetainedPatches = options.maxRetainedPatches ?? MAX_RETAINED_PATCHES;
  const maxRetainedSpoolBytes = options.maxRetainedSpoolBytes ?? MAX_RETAINED_SPOOL_BYTES;
  const onSpoolError = options.onSpoolError ?? (() => undefined);
  let spoolInitialization: Promise<void> | undefined;

  async function initializeWorkspace(workspaceId: string, root: string): Promise<void> {
    let state = states.get(workspaceId);
    if (state) {
      if (state.root !== root) throw new Error(`Project runtime ${workspaceId} is already initialized for a different root.`);
      if (state.closing) throw new Error(`Review state for Project runtime ${workspaceId} is being cleaned up.`);
      if (spoolRoot) await ensureSpoolRoot();
      if (state.initialization) return state.initialization;
    } else {
      state = {
        root,
        operationTail: Promise.resolve(),
        closing: false,
      };
      states.set(workspaceId, state);
    }

    const initializing = (async () => {
      try {
        state.gitRoot = await exactProjectGitRoot(root);
      } catch (error) {
        state.diagnostic = error instanceof Error ? error.message : String(error);
      }
    })();
    state.initialization = initializing;
    return initializing;
  }

  const pagingKey = (
    workspaceId: string,
    pagingScope: ReviewPagingScope,
    revision: string,
  ): string => createHash("sha256")
    .update(workspaceId, "utf8")
    .update("\0", "utf8")
    .update(pagingScope.principalRef, "utf8")
    .update("\0", "utf8")
    .update(String(pagingScope.workspaceGeneration), "utf8")
    .update("\0", "utf8")
    .update(revision, "utf8")
    .digest("hex");

  const spoolPaths = (key: string) => spoolRoot
    ? {
        patch: join(spoolRoot, `${key}.patch`),
        metadata: join(spoolRoot, `${key}.json`),
      }
    : undefined;

  async function ensureSpoolRoot(): Promise<void> {
    if (!spoolRoot) return;
    spoolInitialization ??= initializeSpoolRoot();
    await spoolInitialization;
  }

  async function initializeSpoolRoot(): Promise<void> {
    if (!spoolRoot) return;
    await mkdir(spoolRoot, { recursive: true, mode: 0o700 });
    const stats = await lstat(spoolRoot);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("Review diff spool is not a private directory.");
    }
    await chmod(spoolRoot, 0o700);
    await scanSpoolRoot();
  }

  async function scanSpoolRoot(): Promise<void> {
    if (!spoolRoot) return;
    const candidates = new Map<string, { patch?: string; metadata?: string }>();
    for (const entry of await readdir(spoolRoot, { withFileTypes: true })) {
      const path = join(spoolRoot, entry.name);
      const match = /^([a-f0-9]{64})\.(patch|json)$/u.exec(entry.name);
      if (!match || !entry.isFile() || entry.isSymbolicLink()) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      const key = match[1]!;
      const candidate = candidates.get(key) ?? {};
      if (match[2] === "patch") candidate.patch = path;
      else candidate.metadata = path;
      candidates.set(key, candidate);
    }

    const timestamp = now();
    for (const [key, candidate] of candidates) {
      if (!candidate.patch || !candidate.metadata) {
        await Promise.all([
          candidate.patch ? rm(candidate.patch, { force: true }) : undefined,
          candidate.metadata ? rm(candidate.metadata, { force: true }) : undefined,
        ]);
        continue;
      }
      try {
        const [patchStats, metadataStats] = await Promise.all([
          lstat(candidate.patch),
          lstat(candidate.metadata),
        ]);
        if (
          !patchStats.isFile() || patchStats.isSymbolicLink() ||
          !metadataStats.isFile() || metadataStats.isSymbolicLink() ||
          patchStats.size > MAX_RETAINED_PATCH_FILE_BYTES ||
          metadataStats.size > MAX_RETAINED_METADATA_BYTES
        ) {
          throw new Error("Invalid retained review spool file.");
        }
        const parsed = parseRetainedReviewMetadata(
          JSON.parse(await readFile(candidate.metadata, "utf8")),
          key,
        );
        if (
          !parsed ||
          parsed.patchBytes !== patchStats.size ||
          timestamp - parsed.retainedAt > retainedPatchTtlMs ||
          parsed.retainedAt > timestamp + retainedPatchTtlMs
        ) {
          throw new Error("Expired or invalid retained review metadata.");
        }
        await Promise.all([chmod(candidate.patch, 0o600), chmod(candidate.metadata, 0o600)]);
        retainedPatches.set(key, {
          ...parsed,
          spoolPath: candidate.patch,
          metadataPath: candidate.metadata,
        });
      } catch {
        await Promise.all([
          rm(candidate.patch, { force: true }),
          rm(candidate.metadata, { force: true }),
        ]);
      }
    }
    await evictRetained("");
  }

  async function writePrivateAtomic(path: string, content: string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rm(path, { force: true });
      await rename(temporary, path);
      await chmod(path, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async function discardRetained(entry: RetainedReviewPatch): Promise<void> {
    retainedPatches.delete(entry.key);
    await Promise.all(
      [entry.spoolPath, entry.metadataPath]
        .filter((path): path is string => Boolean(path))
        .map(async (path) => {
          try {
            await unlink(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }),
    );
  }

  async function discardWorkspaceRetained(workspaceId: string): Promise<void> {
    if (spoolRoot) await ensureSpoolRoot();
    const matches = Array.from(retainedPatches.values())
      .filter((entry) => entry.workspaceId === workspaceId);
    await Promise.all(matches.map(discardRetained));
  }

  async function evictRetained(keepKey: string): Promise<void> {
    const timestamp = now();
    for (const entry of Array.from(retainedPatches.values())) {
      if (timestamp - entry.retainedAt > retainedPatchTtlMs) await discardRetained(entry);
    }
    const ordered = Array.from(retainedPatches.values())
      .filter((entry) => entry.key !== keepKey)
      .sort((left, right) => left.retainedAt - right.retainedAt);
    let retainedBytes = Array.from(retainedPatches.values())
      .reduce((total, entry) => total + entry.patchBytes, 0);
    while (
      (
        retainedPatches.size > Math.max(1, maxRetainedPatches) ||
        retainedBytes > Math.max(1, maxRetainedSpoolBytes)
      ) &&
      ordered.length > 0
    ) {
      const removing = ordered.shift()!;
      retainedBytes -= removing.patchBytes;
      await discardRetained(removing);
    }
  }

  async function retainReview(
    workspaceId: string,
    pagingScope: ReviewPagingScope,
    review: ReviewChangesResult,
  ): Promise<void> {
    const key = pagingKey(workspaceId, pagingScope, review.revision);
    const patchBytes = Buffer.byteLength(review.patch, "utf8");
    const patchHash = createHash("sha256").update(review.patch, "utf8").digest("hex");
    const retainedAt = now();
    const result = {
      result: review.result,
      summary: { ...review.summary },
      files: review.files.map((file) => ({ ...file })),
      revision: review.revision,
    };
    const paths = spoolPaths(key);
    const retained: RetainedReviewPatch = {
      key,
      workspaceId,
      pagingScope: { ...pagingScope },
      revision: review.revision,
      result,
      patchBytes,
      patchHash,
      retainedAt,
      ...(patchBytes <= MAX_RETAINED_PATCH_BYTES || !paths ? { patch: review.patch } : {}),
      ...(paths ? { spoolPath: paths.patch, metadataPath: paths.metadata } : {}),
    };

    if (paths) {
      await ensureSpoolRoot();
      const metadata: RetainedReviewMetadata = {
        schemaVersion: 2,
        key,
        workspaceId,
        pagingScope: { ...pagingScope },
        revision: review.revision,
        result,
        patchBytes,
        patchHash,
        retainedAt,
      };
      await writePrivateAtomic(paths.patch, review.patch);
      await writePrivateAtomic(paths.metadata, JSON.stringify(metadata));
    }
    retainedPatches.set(key, retained);
    await evictRetained(key);
  }

  async function loadRetainedReview(
    workspaceId: string,
    pagingScope: ReviewPagingScope,
    revision: string,
  ): Promise<ReviewChangesResult | undefined> {
    if (spoolRoot) await ensureSpoolRoot();
    const key = pagingKey(workspaceId, pagingScope, revision);
    let retained = retainedPatches.get(key);
    if (!retained && spoolRoot) {
      const paths = spoolPaths(key)!;
      try {
        const metadata = parseRetainedReviewMetadata(
          JSON.parse(await readFile(paths.metadata, "utf8")),
          key,
        );
        if (
          !metadata ||
          metadata.workspaceId !== workspaceId ||
          metadata.pagingScope.principalRef !== pagingScope.principalRef ||
          metadata.pagingScope.workspaceGeneration !== pagingScope.workspaceGeneration ||
          metadata.revision !== revision
        ) return undefined;
        retained = {
          ...metadata,
          spoolPath: paths.patch,
          metadataPath: paths.metadata,
        };
        retainedPatches.set(key, retained);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) {
          throw error;
        }
        return undefined;
      }
    }
    if (!retained) return undefined;
    if (now() - retained.retainedAt > retainedPatchTtlMs) {
      await discardRetained(retained);
      return undefined;
    }
    const patch = retained.patch ?? (retained.spoolPath
      ? await readFile(retained.spoolPath, "utf8")
      : undefined);
    if (
      patch === undefined ||
      Buffer.byteLength(patch, "utf8") !== retained.patchBytes ||
      createHash("sha256").update(patch, "utf8").digest("hex") !== retained.patchHash
    ) {
      await discardRetained(retained);
      return undefined;
    }
    return {
      ...retained.result,
      summary: { ...retained.result.summary },
      files: retained.result.files.map((file) => ({ ...file })),
      patch,
    };
  }

  return {
    activeWorkspaceIds() {
      return Array.from(states.keys());
    },
    initializeWorkspace({ workspaceId, root }) {
      return initializeWorkspace(workspaceId, root);
    },
    async reviewChanges({
      workspaceId,
      root,
      source,
      continueRevision,
      observedChanges,
      pagingScope = { principalRef: "local", workspaceGeneration: 0 },
    }) {
      await initializeWorkspace(workspaceId, root);
      const state = states.get(workspaceId);

      if (state?.diagnostic) throw new Error(state.diagnostic);
      if (!state) throw new Error(`Review state for Project runtime ${workspaceId} is unavailable.`);
      if (state.closing) throw new Error(`Review state for Project runtime ${workspaceId} is being cleaned up.`);

      return serialize(state, async () => {
        // Continuing a page sequence reads the diff that was materialized for
        // the first page. Recomputing here would make every page a fresh
        // repository snapshot, and any edit landing between pages would restart
        // the sequence from byte zero.
        if (continueRevision !== undefined) {
          const retained = await loadRetainedReview(
            workspaceId,
            pagingScope,
            continueRevision,
          );
          if (!retained) throw new ReviewPagingExpiredError(source);
          return retained;
        }

        if (source === "apply_patch_history") {
          if (!observedChanges) {
            throw new Error(
              "show_changes requires server-observed apply_patch history when that source is selected.",
            );
          }
          await retainReview(workspaceId, pagingScope, observedChanges);
          return observedChanges;
        }

        if (!state.gitRoot) throw new RepositoryReviewUnavailableError();

        const { head, patch, files } = await currentRepositoryChanges(state.gitRoot);
        const summary = summarizeFiles(files);
        const revision = `review_${createHash("sha256")
          .update(head, "utf8")
          .update("\0", "utf8")
          .update(patch, "utf8")
          .digest("base64url")}`;

        const reviewResult = {
          result:
            summary.files === 0
              ? "No repository changes."
              : `Changed ${summary.files} ${summary.files === 1 ? "file" : "files"} (+${summary.additions} -${summary.removals}).`,
          summary,
          files,
          patch,
          revision,
        };

        await retainReview(workspaceId, pagingScope, reviewResult);

        return reviewResult;
      });
    },

    async cleanupWorkspace({ workspaceId, root }) {
      const state = states.get(workspaceId);
      if (!state) {
        await discardWorkspaceRetained(workspaceId);
        return;
      } else if (root !== undefined && state.root !== root) {
        throw new Error(`Project runtime ${workspaceId} is already initialized for a different root.`);
      }
      state.closing = true;
      try {
        await state.initialization;
        await serialize(state, async () => undefined);
      } finally {
        try {
          await discardWorkspaceRetained(workspaceId);
        } catch (error) {
          onSpoolError(error);
        } finally {
          if (states.get(workspaceId) === state) states.delete(workspaceId);
        }
      }
    },
  };
}

function parseRetainedReviewMetadata(
  value: unknown,
  expectedKey: string,
): RetainedReviewMetadata | undefined {
  const record = objectRecord(value);
  const pagingScope = objectRecord(record?.pagingScope);
  const result = objectRecord(record?.result);
  const summary = objectRecord(result?.summary);
  const files = Array.isArray(result?.files)
    ? result.files.map(parseRetainedReviewFile)
    : undefined;
  const patchBytes = safeNonNegativeInteger(record?.patchBytes);
  const retainedAt = safeNonNegativeInteger(record?.retainedAt);
  const workspaceGeneration = safeNonNegativeInteger(pagingScope?.workspaceGeneration);
  const summaryFiles = safeNonNegativeInteger(summary?.files);
  const additions = safeNonNegativeInteger(summary?.additions);
  const removals = safeNonNegativeInteger(summary?.removals);
  if (
    record?.schemaVersion !== 2 ||
    record.key !== expectedKey ||
    !RETAINED_KEY_PATTERN.test(expectedKey) ||
    typeof record.workspaceId !== "string" || !record.workspaceId ||
    typeof pagingScope?.principalRef !== "string" || !pagingScope.principalRef ||
    workspaceGeneration === undefined ||
    typeof record.revision !== "string" || !record.revision.startsWith("review_") ||
    typeof result?.result !== "string" ||
    typeof result.revision !== "string" || result.revision !== record.revision ||
    summaryFiles === undefined || additions === undefined || removals === undefined ||
    !files || files.some((file) => file === undefined) ||
    patchBytes === undefined || patchBytes > MAX_RETAINED_PATCH_FILE_BYTES ||
    typeof record.patchHash !== "string" || !/^[a-f0-9]{64}$/u.test(record.patchHash) ||
    retainedAt === undefined
  ) return undefined;

  return {
    schemaVersion: 2,
    key: expectedKey,
    workspaceId: record.workspaceId,
    pagingScope: {
      principalRef: pagingScope.principalRef,
      workspaceGeneration,
    },
    revision: record.revision,
    result: {
      result: result.result,
      summary: { files: summaryFiles, additions, removals },
      files: files as ReviewFile[],
      revision: result.revision,
    },
    patchBytes,
    patchHash: record.patchHash,
    retainedAt,
  };
}

function parseRetainedReviewFile(value: unknown): ReviewFile | undefined {
  const record = objectRecord(value);
  const additions = safeNonNegativeInteger(record?.additions);
  const removals = safeNonNegativeInteger(record?.removals);
  const type = record?.type;
  if (
    typeof record?.path !== "string" || !record.path ||
    additions === undefined || removals === undefined ||
    (
      type !== "change" &&
      type !== "rename-pure" &&
      type !== "rename-changed" &&
      type !== "new" &&
      type !== "deleted"
    ) ||
    (record.previousPath !== undefined && typeof record.previousPath !== "string")
  ) return undefined;
  return {
    path: record.path,
    ...(typeof record.previousPath === "string" ? { previousPath: record.previousPath } : {}),
    type,
    additions,
    removals,
  };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

async function serialize<T>(state: WorkspaceReviewState, operation: () => Promise<T>): Promise<T> {
  const previous = state.operationTail;
  let release!: () => void;
  state.operationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function exactProjectGitRoot(root: string): Promise<string | undefined> {
  let gitRoot: string;
  try {
    gitRoot = (await readOnlyGit(root, ["rev-parse", "--show-toplevel"])).stdout.trim();
  } catch (error) {
    if (isMissingGitExecutable(error) || isNotWorkTree(error)) return undefined;
    throw error;
  }
  if (!gitRoot) return undefined;
  const [canonicalProjectRoot, canonicalGitRoot] = await Promise.all([
    realpath(root),
    realpath(gitRoot),
  ]);
  return canonicalProjectRoot === canonicalGitRoot ? canonicalProjectRoot : undefined;
}

async function currentRepositoryChanges(
  gitRoot: string,
): Promise<{ head: string; patch: string; files: ReviewFile[] }> {
  const { untrackedPaths } = await safeReviewPathInventory(gitRoot);
  const head = await currentHead(gitRoot);
  const tracked = head
    ? await diffAgainstHead(gitRoot)
    : await diffUnbornRepository(gitRoot);
  let patch = tracked.patch;
  const files = [...tracked.files];
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  for (const path of untrackedPaths) {
    const [untrackedPatch, untrackedNumstat] = await Promise.all([
      gitNoIndexDiff(gitRoot, [
        "--binary",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--",
        nullDevice,
        path,
      ]),
      gitNoIndexDiff(gitRoot, [
        "--numstat",
        "-z",
        "--no-ext-diff",
        "--no-textconv",
        "--",
        nullDevice,
        path,
      ]),
    ]);
    patch += untrackedPatch.stdout;
    if (Buffer.byteLength(patch, "utf8") > MAX_RETAINED_PATCH_FILE_BYTES) {
      throw new Error("Repository diff exceeds the review output limit.");
    }
    const numstatTerminator = untrackedNumstat.stdout.indexOf("\0");
    const numstatHeader = numstatTerminator === -1
      ? untrackedNumstat.stdout
      : untrackedNumstat.stdout.slice(0, numstatTerminator);
    const [additions, removals] = numstatHeader
      .split("\t")
      .map(parseStatNumber);
    files.push({
      path,
      type: "new",
      additions: additions ?? 0,
      removals: removals ?? 0,
    });
  }

  return {
    head: head ?? "unborn",
    patch,
    files,
  };
}

async function diffAgainstHead(
  gitRoot: string,
): Promise<{ patch: string; files: ReviewFile[] }> {
  const [patch, numstat] = await Promise.all([
    readOnlyGit(gitRoot, [
      "diff",
      "--binary",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "HEAD",
      "--",
      ".",
    ]),
    readOnlyGit(gitRoot, [
      "diff",
      "--numstat",
      "-z",
      "--no-ext-diff",
      "--no-textconv",
      "HEAD",
      "--",
      ".",
    ]),
  ]);
  return { patch: patch.stdout, files: parseNumstat(numstat.stdout) };
}

async function diffUnbornRepository(
  gitRoot: string,
): Promise<{ patch: string; files: ReviewFile[] }> {
  const patchArguments = [
    "--binary",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--",
    ".",
  ];
  const numstatArguments = [
    "--numstat",
    "-z",
    "--no-ext-diff",
    "--no-textconv",
    "--",
    ".",
  ];
  const [stagedPatch, unstagedPatch, stagedNumstat, unstagedNumstat] = await Promise.all([
    readOnlyGit(gitRoot, ["diff", "--cached", ...patchArguments]),
    readOnlyGit(gitRoot, ["diff", ...patchArguments]),
    readOnlyGit(gitRoot, ["diff", "--cached", ...numstatArguments]),
    readOnlyGit(gitRoot, ["diff", ...numstatArguments]),
  ]);
  return {
    patch: joinPatchSegments(stagedPatch.stdout, unstagedPatch.stdout),
    files: coalesceSequentialFiles([
      ...parseNumstat(stagedNumstat.stdout),
      ...parseNumstat(unstagedNumstat.stdout),
    ]),
  };
}

async function currentHead(gitRoot: string): Promise<string | undefined> {
  try {
    const result = await readOnlyGit(gitRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      "HEAD^{commit}",
    ]);
    return result.stdout.trim() || undefined;
  } catch (error) {
    if (gitExitCode(error) === 1 || gitExitCode(error) === 128) return undefined;
    throw error;
  }
}

async function safeReviewPathInventory(
  gitRoot: string,
): Promise<{ untrackedPaths: string[] }> {
  const [allResult, untrackedResult] = await Promise.all([
    readOnlyGit(gitRoot, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ".",
    ]),
    readOnlyGit(gitRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ".",
    ]),
  ]);
  const allPaths = allResult.stdout.split("\0").filter(Boolean);
  await assertNoExecutableFilters(gitRoot, allPaths);
  return {
    untrackedPaths: untrackedResult.stdout.split("\0").filter(Boolean),
  };
}

async function assertNoExecutableFilters(
  gitRoot: string,
  paths: readonly string[],
): Promise<void> {
  const filterDrivers = new Set<string>();
  for (const batch of gitPathBatches(paths)) {
    const result = await readOnlyGit(gitRoot, [
      "check-attr",
      "-z",
      "filter",
      "--",
      ...batch,
    ]);
    const fields = result.stdout.split("\0");
    for (let index = 0; index + 2 < fields.length; index += 3) {
      const value = fields[index + 2];
      if (
        value &&
        value !== "unspecified" &&
        value !== "unset" &&
        value !== "set"
      ) {
        filterDrivers.add(value);
        if (filterDrivers.size > 128) {
          throw new UnsafeGitReviewConfigurationError(["(too many filter drivers)"]);
        }
      }
    }
  }

  const executableDrivers: string[] = [];
  for (const driver of [...filterDrivers].sort()) {
    if (
      driver.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(driver)
    ) {
      executableDrivers.push("(invalid driver name)");
      continue;
    }
    const commands = await Promise.all([
      readOnlyGitAllowExit(gitRoot, ["config", "--get-all", `filter.${driver}.clean`], [1]),
      readOnlyGitAllowExit(gitRoot, ["config", "--get-all", `filter.${driver}.process`], [1]),
    ]);
    if (commands.some((command) => command.stdout.trim().length > 0)) {
      executableDrivers.push(driver);
    }
  }
  if (executableDrivers.length > 0) {
    throw new UnsafeGitReviewConfigurationError(executableDrivers);
  }
}

function gitPathBatches(paths: readonly string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const pathBytes = Buffer.byteLength(path, "utf8") + 1;
    if (
      batch.length > 0 &&
      (
        batch.length >= GIT_ATTRIBUTE_ARGUMENT_COUNT ||
        bytes + pathBytes > GIT_ATTRIBUTE_ARGUMENT_BYTES
      )
    ) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(path);
    bytes += pathBytes;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function joinPatchSegments(...segments: string[]): string {
  return segments
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.endsWith("\n") ? segment : `${segment}\n`)
    .join("");
}

async function gitNoIndexDiff(gitRoot: string, args: string[]): Promise<GitCommandResult> {
  return readOnlyGitAllowExit(gitRoot, ["diff", "--no-index", ...args], [1]);
}

async function readOnlyGit(
  gitRoot: string,
  args: string[],
): Promise<GitCommandResult> {
  return git(gitRoot, [...READ_ONLY_GIT_PREFIX, ...args], {
    env: READ_ONLY_GIT_ENV,
    unsetEnv: READ_ONLY_GIT_UNSET_ENV,
    maxBuffer: MAX_RETAINED_PATCH_FILE_BYTES,
  });
}

async function readOnlyGitAllowExit(
  gitRoot: string,
  args: string[],
  allowedExitCodes: readonly number[],
): Promise<GitCommandResult> {
  try {
    return await readOnlyGit(gitRoot, args);
  } catch (error) {
    const commandError = error as {
      code?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    if (
      typeof commandError.code !== "number" ||
      !allowedExitCodes.includes(commandError.code)
    ) throw error;
    return {
      stdout: commandOutput(commandError.stdout),
      stderr: commandOutput(commandError.stderr),
    };
  }
}

function gitExitCode(error: unknown): number | string | undefined {
  return error && typeof error === "object" && "code" in error
    ? (error as { code?: number | string }).code
    : undefined;
}

function isMissingGitExecutable(error: unknown): boolean {
  return gitExitCode(error) === "ENOENT";
}

function isNotWorkTree(error: unknown): boolean {
  if (gitExitCode(error) !== 128) return false;
  const stderr = error && typeof error === "object" && "stderr" in error
    ? commandOutput((error as { stderr?: string | Buffer }).stderr)
    : "";
  return stderr.includes("not a git repository") ||
    stderr.includes("must be run in a work tree");
}

function commandOutput(output: string | Buffer | undefined): string {
  if (typeof output === "string") return output;
  return output?.toString("utf8") ?? "";
}

function parseNumstat(output: string): ReviewFile[] {
  const fields = output.split("\0").filter((field) => field.length > 0);
  const files: ReviewFile[] = [];

  for (let index = 0; index < fields.length;) {
    const header = fields[index++] ?? "";
    const parts = header.split("\t");
    const additions = parseStatNumber(parts[0]);
    const removals = parseStatNumber(parts[1]);

    if (parts.length >= 3) {
      const path = parts[2] ?? "";
      if (path) files.push({ path, type: fileType(path, undefined, additions, removals), additions, removals });
      continue;
    }

    const previousPath = fields[index++];
    const path = fields[index++];
    if (!path) continue;

    files.push({
      path,
      previousPath,
      type: fileType(path, previousPath, additions, removals),
      additions,
      removals,
    });
  }

  return files;
}

function coalesceSequentialFiles(files: readonly ReviewFile[]): ReviewFile[] {
  const coalesced = new Map<string, ReviewFile>();
  for (const file of files) {
    const key = `${file.previousPath ?? ""}\0${file.path}`;
    const existing = coalesced.get(key);
    if (!existing) {
      coalesced.set(key, { ...file });
      continue;
    }
    if (existing.type === "new" && file.type === "deleted") {
      coalesced.delete(key);
      continue;
    }
    coalesced.set(key, {
      ...existing,
      type: existing.type === "new" ? "new" : file.type,
      additions: existing.additions + file.additions,
      removals: existing.removals + file.removals,
    });
  }
  return [...coalesced.values()];
}

function parseStatNumber(value: string | undefined): number {
  if (!value || value === "-") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fileType(
  path: string,
  previousPath: string | undefined,
  additions: number,
  removals: number,
): ReviewFile["type"] {
  if (previousPath) return additions === 0 && removals === 0 ? "rename-pure" : "rename-changed";
  if (additions > 0 && removals === 0) return "new";
  if (additions === 0 && removals > 0) return "deleted";
  return "change";
}

function summarizeFiles(files: ReviewFile[]): ReviewSummary {
  return files.reduce<ReviewSummary>(
    (summary, file) => ({
      files: summary.files + 1,
      additions: summary.additions + file.additions,
      removals: summary.removals + file.removals,
    }),
    { files: 0, additions: 0, removals: 0 },
  );
}
