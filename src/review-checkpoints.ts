import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, getGitEligibility, safeWorkspaceRefSegment } from "./git.js";

export type ReviewSince = "last_shown" | "last_review" | "workspace_open";

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

export class ReviewRevisionChangedError extends Error {
  constructor() {
    super("Workspace changes changed after the reviewed diff was generated.");
    this.name = "ReviewRevisionChangedError";
  }
}

/**
 * A page sequence asked to continue a diff that is no longer retained.
 *
 * Reported distinctly rather than recomputing, because the recomputed diff is a
 * different revision: continuing silently would either succeed or report the
 * workspace as changed depending on retention state the caller cannot observe.
 */
export class ReviewPagingExpiredError extends Error {
  constructor() {
    super("The reviewed diff is no longer retained for paging.");
    this.name = "ReviewPagingExpiredError";
  }
}

interface RetainedReviewPatch {
  key: string;
  workspaceId: string;
  pagingScope: ReviewPagingScope;
  since: ReviewSince;
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
  schemaVersion: 1;
  key: string;
  workspaceId: string;
  pagingScope: ReviewPagingScope;
  since: ReviewSince;
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
  openRef: string;
  baselineRef: string;
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
    since?: ReviewSince;
    markReviewed?: boolean;
    expectedRevision?: string;
    pagingScope?: ReviewPagingScope;
    /**
     * Continue an established paging session: serve the retained diff for this
     * exact revision instead of snapshotting the worktree again. Ignored when
     * the revision is not retained, and never honored while advancing.
     */
    continueRevision?: string;
  }): Promise<ReviewChangesResult>;
  cleanupWorkspace(input: { workspaceId: string; root?: string }): Promise<void>;
  cleanupStaleRefs(input: {
    gitRoot: string;
    activeWorkspaceIds?: Iterable<string>;
    olderThanMs?: number;
    maxWorkspaces?: number;
    now?: number;
  }): Promise<number>;
}

const REVIEW_REF_PREFIX = "refs/devspace/review";
const DEFAULT_REVIEW_REF_RETENTION_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_MAX_REVIEW_WORKSPACES = 512;
// Small diffs stay in memory for fast paging; every persistent deployment also
// writes a private spool so page sequences survive manager/server recreation.
const MAX_RETAINED_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_RETAINED_PATCHES = 16;
const MAX_RETAINED_SPOOL_BYTES = 256 * 1024 * 1024;
const MAX_RETAINED_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_RETAINED_PATCH_FILE_BYTES = 50 * 1024 * 1024;
const RETAINED_PATCH_TTL_MS = 10 * 60_000;
const RETAINED_KEY_PATTERN = /^[a-f0-9]{64}$/u;

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
      if (state.root !== root) throw new Error(`Workspace ${workspaceId} is already initialized for a different root.`);
      if (state.closing) throw new Error(`Review checkpoints for workspace ${workspaceId} are being cleaned up.`);
      if (spoolRoot) await ensureSpoolRoot();
      if (state.initialization) return state.initialization;
    } else {
      state = {
        root,
        ...reviewRefs(workspaceId),
        operationTail: Promise.resolve(),
        closing: false,
      };
      states.set(workspaceId, state);
    }

    const initializing = (async () => {
      try {
        const eligibility = await getGitEligibility(root);
        if (!eligibility.ok || !eligibility.gitRoot) {
          state.diagnostic = eligibility.message ?? "show_changes requires a Git workspace in this version.";
          return;
        }

        state.gitRoot = eligibility.gitRoot;
        const refStatuses = await Promise.all([
          reviewRefStatus(eligibility.gitRoot, state.openRef),
          reviewRefStatus(eligibility.gitRoot, state.baselineRef),
        ]);
        if (refStatuses.every((status) => status === "valid")) return;
        if (!refStatuses.every((status) => status === "missing")) {
          throw new Error(
            `Internal review checkpoint error for workspace ${workspaceId}: `
            + `open ref is ${refStatuses[0]} and baseline ref is ${refStatuses[1]}. `
            + "Refusing to reset review history.",
          );
        }

        const commit = await createWorkingTreeSnapshot(eligibility.gitRoot);
        await git(eligibility.gitRoot, ["update-ref", state.openRef, commit]);
        await git(eligibility.gitRoot, ["update-ref", state.baselineRef, commit]);
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
    since: ReviewSince,
    revision: string,
  ): string => createHash("sha256")
    .update(workspaceId, "utf8")
    .update("\0", "utf8")
    .update(pagingScope.principalRef, "utf8")
    .update("\0", "utf8")
    .update(String(pagingScope.workspaceGeneration), "utf8")
    .update("\0", "utf8")
    .update(since, "utf8")
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
    since: ReviewSince,
    review: ReviewChangesResult,
  ): Promise<void> {
    const key = pagingKey(workspaceId, pagingScope, since, review.revision);
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
      since,
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
        schemaVersion: 1,
        key,
        workspaceId,
        pagingScope: { ...pagingScope },
        since,
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
    since: ReviewSince,
    revision: string,
  ): Promise<ReviewChangesResult | undefined> {
    if (spoolRoot) await ensureSpoolRoot();
    const key = pagingKey(workspaceId, pagingScope, since, revision);
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
          metadata.since !== since ||
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
      since = "last_shown",
      markReviewed = true,
      expectedRevision,
      continueRevision,
      pagingScope = { principalRef: "local", workspaceGeneration: 0 },
    }) {
      await initializeWorkspace(workspaceId, root);
      const state = states.get(workspaceId);

      if (state?.diagnostic) throw new Error(state.diagnostic);
      if (!state?.gitRoot) {
        throw new Error("show_changes requires a Git workspace in this version.");
      }
      if (state.closing) throw new Error(`Review checkpoints for workspace ${workspaceId} are being cleaned up.`);

      return serialize(state, async () => {
        // Continuing a page sequence reads the diff that was materialized for
        // the first page. Recomputing here would make every page a fresh
        // worktree snapshot, and any edit landing between pages would restart
        // the sequence from byte zero. Advancing never takes this path: it has
        // to observe the worktree as it is now to detect drift.
        if (!markReviewed && continueRevision !== undefined) {
          const retained = await loadRetainedReview(
            workspaceId,
            pagingScope,
            since,
            continueRevision,
          );
          if (!retained) throw new ReviewPagingExpiredError();
          return retained;
        }

        const gitRoot = state.gitRoot!;
        const baselineRef = since === "workspace_open" ? state.openRef : state.baselineRef;
        const baseline = (await git(gitRoot, ["rev-parse", "--verify", `${baselineRef}^{commit}`])).stdout.trim();
        const current = await createWorkingTreeSnapshot(gitRoot);
        const patch = (await git(gitRoot, ["diff", "--binary", "--no-color", baseline, current], {
          maxBuffer: 50 * 1024 * 1024,
        })).stdout;
        const numstat = (await git(gitRoot, ["diff", "--numstat", "-z", baseline, current], {
          maxBuffer: 50 * 1024 * 1024,
        })).stdout;
        const files = parseNumstat(numstat);
        const summary = summarizeFiles(files);
        const revision = `review_${createHash("sha256")
          .update(baseline, "utf8")
          .update("\0", "utf8")
          .update(patch, "utf8")
          .digest("base64url")}`;

        if (markReviewed) {
          if (expectedRevision !== undefined && expectedRevision !== revision) {
            throw new ReviewRevisionChangedError();
          }
          await git(gitRoot, ["update-ref", state.baselineRef, current]);
          try {
            await discardWorkspaceRetained(workspaceId);
          } catch (error) {
            // The checkpoint has committed. Sidecar cleanup cannot turn a known
            // successful mutation into an outcome-unknown operation.
            onSpoolError(error);
          }
        }

        const reviewResult = {
          result:
            summary.files === 0
              ? `No changes since ${since === "workspace_open" ? "workspace open" : "last shown changes"}.`
              : `Changed ${summary.files} ${summary.files === 1 ? "file" : "files"} (+${summary.additions} -${summary.removals}).`,
          summary,
          files,
          patch,
          revision,
        };

        if (!markReviewed) {
          await retainReview(workspaceId, pagingScope, since, reviewResult);
        }

        return reviewResult;
      });
    },

    async cleanupWorkspace({ workspaceId, root }) {
      let state = states.get(workspaceId);
      if (!state) {
        if (root === undefined) return;
        const eligibility = await getGitEligibility(root);
        if (!eligibility.ok || !eligibility.gitRoot) return;
        state = {
          root,
          gitRoot: eligibility.gitRoot,
          ...reviewRefs(workspaceId),
          operationTail: Promise.resolve(),
          closing: false,
        };
        states.set(workspaceId, state);
      } else if (root !== undefined && state.root !== root) {
        throw new Error(`Workspace ${workspaceId} is already initialized for a different root.`);
      }
      state.closing = true;
      try {
        await state.initialization;
        await serialize(state, async () => {
          if (state.gitRoot) {
            await Promise.all([
              git(state.gitRoot, ["update-ref", "-d", state.openRef]),
              git(state.gitRoot, ["update-ref", "-d", state.baselineRef]),
            ]);
          }
        });
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

    async cleanupStaleRefs({
      gitRoot,
      activeWorkspaceIds = [],
      olderThanMs = DEFAULT_REVIEW_REF_RETENTION_MS,
      maxWorkspaces = DEFAULT_MAX_REVIEW_WORKSPACES,
      now = Date.now(),
    }) {
      const activeSegments = new Set(Array.from(activeWorkspaceIds, safeWorkspaceRefSegment));
      const output = (await git(gitRoot, [
        "for-each-ref",
        "--format=%(refname)%00%(creatordate:unix)",
        REVIEW_REF_PREFIX,
      ])).stdout;
      const refs = parseReviewRefs(output).filter((entry) => !activeSegments.has(entry.segment));
      const newestBySegment = new Map<string, number>();
      for (const entry of refs) {
        newestBySegment.set(entry.segment, Math.max(newestBySegment.get(entry.segment) ?? 0, entry.createdAt));
      }
      const inactive = Array.from(newestBySegment, ([segment, createdAt]) => ({ segment, createdAt }))
        .sort((left, right) => right.createdAt - left.createdAt);
      const expired = new Set(inactive
        .filter((entry, index) => now - entry.createdAt > olderThanMs || index >= maxWorkspaces)
        .map((entry) => entry.segment));
      const deleting = refs.filter((entry) => expired.has(entry.segment));
      await Promise.all(deleting.map((entry) => git(gitRoot, ["update-ref", "-d", entry.ref])));
      return deleting.length;
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
  const since = record?.since;
  const patchBytes = safeNonNegativeInteger(record?.patchBytes);
  const retainedAt = safeNonNegativeInteger(record?.retainedAt);
  const workspaceGeneration = safeNonNegativeInteger(pagingScope?.workspaceGeneration);
  const summaryFiles = safeNonNegativeInteger(summary?.files);
  const additions = safeNonNegativeInteger(summary?.additions);
  const removals = safeNonNegativeInteger(summary?.removals);
  if (
    record?.schemaVersion !== 1 ||
    record.key !== expectedKey ||
    !RETAINED_KEY_PATTERN.test(expectedKey) ||
    typeof record.workspaceId !== "string" || !record.workspaceId ||
    typeof pagingScope?.principalRef !== "string" || !pagingScope.principalRef ||
    workspaceGeneration === undefined ||
    (since !== "last_shown" && since !== "last_review" && since !== "workspace_open") ||
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
    schemaVersion: 1,
    key: expectedKey,
    workspaceId: record.workspaceId,
    pagingScope: {
      principalRef: pagingScope.principalRef,
      workspaceGeneration,
    },
    since,
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

type ReviewRefStatus = "missing" | "valid" | "invalid";

async function reviewRefStatus(gitRoot: string, ref: string): Promise<ReviewRefStatus> {
  try {
    await git(gitRoot, ["show-ref", "--verify", "--quiet", ref]);
  } catch (error) {
    return commandExitCode(error) === 1 ? "missing" : "invalid";
  }

  try {
    await git(gitRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return "valid";
  } catch {
    return "invalid";
  }
}

function commandExitCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "number" ? error.code : undefined;
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

function parseReviewRefs(output: string): Array<{ ref: string; segment: string; createdAt: number }> {
  const entries: Array<{ ref: string; segment: string; createdAt: number }> = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [ref, timestamp] = line.split("\0");
    const suffix = ref?.slice(`${REVIEW_REF_PREFIX}/`.length);
    const segment = suffix?.split("/")[0];
    const createdAt = Number(timestamp) * 1_000;
    if (!ref?.startsWith(`${REVIEW_REF_PREFIX}/`) || !segment || !Number.isFinite(createdAt)) continue;
    entries.push({ ref, segment, createdAt });
  }
  return entries;
}

function reviewRefs(workspaceId: string): Pick<WorkspaceReviewState, "openRef" | "baselineRef"> {
  const segment = safeWorkspaceRefSegment(workspaceId);
  return {
    openRef: `${REVIEW_REF_PREFIX}/${segment}/open`,
    baselineRef: `${REVIEW_REF_PREFIX}/${segment}/baseline`,
  };
}

async function createWorkingTreeSnapshot(gitRoot: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "devspace-review-index-"));
  const indexPath = join(tempDir, "index");
  const env = checkpointEnv(indexPath);

  try {
    await git(gitRoot, ["read-tree", "HEAD"], { env });
    await git(gitRoot, ["add", "-A", "--", "."], { env });
    const tree = (await git(gitRoot, ["write-tree"], { env })).stdout.trim();
    const parent = (await git(gitRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    return (await git(gitRoot, ["commit-tree", tree, "-p", parent, "-m", "DevSpace review snapshot"], { env })).stdout.trim();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function checkpointEnv(indexPath: string): NodeJS.ProcessEnv {
  return {
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: "DevSpace",
    GIT_AUTHOR_EMAIL: "devspace@users.noreply.local",
    GIT_COMMITTER_NAME: "DevSpace",
    GIT_COMMITTER_EMAIL: "devspace@users.noreply.local",
  };
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
