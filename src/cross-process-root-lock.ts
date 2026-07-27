import { createHash, randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  defaultProcessIdentityRuntime,
  processIdentityAlive,
  readProcessIdentity,
  type ProcessIdentity,
  type ProcessIdentityRuntime,
} from "./process-identity.js";
import type { WorkspaceRootLockMode } from "./workspace-root-locks.js";

const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_HEARTBEAT_STALE_MS = 30_000;
const LOCK_MARKER_SCHEMA_VERSION = 2 as const;

interface LockMarker {
  schemaVersion: typeof LOCK_MARKER_SCHEMA_VERSION;
  serverPid: number;
  serverStartIdentity?: string;
  bootIdentity?: string;
  ownerPid?: number;
  ownerStartIdentity?: string;
  processGroupId?: number;
  workspaceGeneration?: number;
  token: string;
  createdAt: number;
  heartbeatAt: number;
}

interface LegacyLockMarker {
  pid: number;
  token: string;
  createdAt: number;
}

type AnyLockMarker = LockMarker | LegacyLockMarker;

export interface WorkspaceRootLeaseMetadata {
  workspaceGeneration?: number;
}

export interface WorkspaceRootProcessOwner {
  pid: number;
  processGroupId?: number;
}

/** Callable for compatibility with existing release callbacks. */
export interface WorkspaceRootLease {
  (): void;
  release(): void;
  heartbeat(): Promise<void>;
  attachProcess(owner: WorkspaceRootProcessOwner): Promise<void>;
}

export interface CrossProcessWorkspaceRootLockOptions {
  root: string;
  acquireTimeoutMs?: number;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatStaleMs?: number;
  now?: () => number;
  pid?: number;
  processIdentityRuntime?: ProcessIdentityRuntime;
  serverIdentity?: ProcessIdentity;
  /** Trusted state root containing the lock directory; every child is verified. */
  trustedStateRoot?: string;
}

export class WorkspaceRootLockTimeoutError extends Error {
  readonly code = "workspace_root_busy";
  readonly publicText =
    "Another DevSpace process or retained workspace process is using this physical workspace root. Retry after it finishes or use an isolated managed worktree.";

  constructor() {
    super("Timed out acquiring the cross-process workspace root lock.");
    this.name = "WorkspaceRootLockTimeoutError";
  }
}

/**
 * Filesystem-backed reader/writer leases shared by every DevSpace process owned
 * by the same OS user. Marker ownership includes boot and process-start identity
 * so PID reuse cannot keep stale locks alive. A retained command replaces the
 * marker owner with its PID/process group; after a server crash, descendants
 * therefore continue blocking writers until their complete process tree exits.
 */
export class CrossProcessWorkspaceRootLock {
  private readonly root: string;
  private readonly acquireTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatStaleMs: number;
  private readonly now: () => number;
  private readonly runtime: ProcessIdentityRuntime;
  private readonly serverIdentity: ProcessIdentity;
  private readonly trustedStateRoot?: string;

  constructor(options: CrossProcessWorkspaceRootLockOptions) {
    if (!options.root) throw new TypeError("Cross-process lock root is required.");
    this.root = options.root;
    this.acquireTimeoutMs = positiveInteger(
      options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS,
      "acquireTimeoutMs",
    );
    this.pollIntervalMs = positiveInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
    );
    this.heartbeatIntervalMs = positiveInteger(
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      "heartbeatIntervalMs",
    );
    this.heartbeatStaleMs = positiveInteger(
      options.heartbeatStaleMs ?? DEFAULT_HEARTBEAT_STALE_MS,
      "heartbeatStaleMs",
    );
    this.now = options.now ?? Date.now;
    this.runtime = options.processIdentityRuntime ?? defaultProcessIdentityRuntime;
    this.trustedStateRoot = options.trustedStateRoot === undefined
      ? undefined
      : resolve(options.trustedStateRoot);
    if (this.trustedStateRoot) {
      const relationship = relative(this.trustedStateRoot, resolve(this.root));
      if (relationship.startsWith("..") || isAbsolute(relationship)) {
        throw new Error("Cross-process lock root must be inside the trusted state root.");
      }
    }
    const pid = options.pid ?? this.runtime.currentPid;
    this.serverIdentity = options.serverIdentity ?? readProcessIdentity(pid, this.runtime);
  }

  async acquire(
    key: string,
    mode: WorkspaceRootLockMode,
    metadata: WorkspaceRootLeaseMetadata = {},
    deadlineOverride?: number,
  ): Promise<WorkspaceRootLease> {
    if (!key) throw new TypeError("Workspace root lock key is required.");
    if (mode !== "read" && mode !== "write") {
      throw new TypeError("Workspace root lock mode must be read or write.");
    }
    if (
      metadata.workspaceGeneration !== undefined &&
      (!Number.isSafeInteger(metadata.workspaceGeneration) || metadata.workspaceGeneration < 1)
    ) {
      throw new TypeError("Workspace generation must be a positive safe integer.");
    }
    const paths = this.paths(key);
    await this.ensureDirectories(paths);
    const deadline = deadlineOverride ?? this.now() + this.acquireTimeoutMs;
    if (!Number.isFinite(deadline) || deadline <= this.now()) {
      throw new WorkspaceRootLockTimeoutError();
    }
    return mode === "read"
      ? this.acquireReader(paths, deadline, metadata)
      : this.acquireWriter(paths, deadline, metadata);
  }

  private async acquireReader(
    paths: ReturnType<CrossProcessWorkspaceRootLock["paths"]>,
    deadline: number,
    metadata: WorkspaceRootLeaseMetadata,
  ): Promise<WorkspaceRootLease> {
    const markerPath = join(
      paths.readers,
      `${this.serverIdentity.pid}-${randomToken()}.json`,
    );
    for (;;) {
      await this.cleanupStale(paths);
      if (await exists(paths.intent) || await exists(paths.writer)) {
        await this.wait(deadline);
        continue;
      }
      const marker = await this.createMarker(markerPath, metadata);
      if (!marker) {
        await this.wait(deadline);
        continue;
      }
      if (await exists(paths.intent) || await exists(paths.writer)) {
        await removeOwnedMarker(markerPath, marker.token);
        await this.wait(deadline);
        continue;
      }
      return this.createLease(markerPath, marker);
    }
  }

  private async acquireWriter(
    paths: ReturnType<CrossProcessWorkspaceRootLock["paths"]>,
    deadline: number,
    metadata: WorkspaceRootLeaseMetadata,
  ): Promise<WorkspaceRootLease> {
    for (;;) {
      await this.cleanupStale(paths);
      const intent = await this.createMarker(paths.intent, metadata);
      if (!intent) {
        await this.wait(deadline);
        continue;
      }
      try {
        for (;;) {
          await this.cleanupStale(paths);
          const readers = await readerMarkers(paths.readers);
          if (readers.length === 0 && !await exists(paths.writer)) {
            const writer = await this.createMarker(paths.writer, metadata);
            if (writer) {
              await removeOwnedMarker(paths.intent, intent.token);
              return this.createLease(paths.writer, writer);
            }
          }
          await this.wait(deadline);
        }
      } catch (error) {
        await removeOwnedMarker(paths.intent, intent.token);
        throw error;
      }
    }
  }

  private paths(key: string) {
    const digest = createHash("sha256")
      .update("devspace-cross-process-root-lock-v1\0", "utf8")
      .update(key, "utf8")
      .digest("hex");
    const directory = join(this.root, digest);
    return {
      directory,
      readers: join(directory, "readers"),
      intent: join(directory, "writer-intent.json"),
      writer: join(directory, "writer.json"),
    };
  }

  private async ensureDirectories(
    paths: ReturnType<CrossProcessWorkspaceRootLock["paths"]>,
  ): Promise<void> {
    if (this.trustedStateRoot) {
      await ensureSecureDirectoryChain(this.trustedStateRoot, this.root);
    } else {
      await ensureSecureDirectory(this.root);
    }
    await ensureSecureDirectory(paths.directory);
    await ensureSecureDirectory(paths.readers);
  }

  private newMarker(metadata: WorkspaceRootLeaseMetadata): LockMarker {
    const now = this.now();
    return {
      schemaVersion: LOCK_MARKER_SCHEMA_VERSION,
      serverPid: this.serverIdentity.pid,
      ...(this.serverIdentity.startIdentity
        ? { serverStartIdentity: this.serverIdentity.startIdentity }
        : {}),
      ...(this.serverIdentity.bootIdentity
        ? { bootIdentity: this.serverIdentity.bootIdentity }
        : {}),
      ownerPid: this.serverIdentity.pid,
      ...(this.serverIdentity.startIdentity
        ? { ownerStartIdentity: this.serverIdentity.startIdentity }
        : {}),
      ...(this.serverIdentity.processGroupId
        ? { processGroupId: this.serverIdentity.processGroupId }
        : {}),
      ...(metadata.workspaceGeneration === undefined
        ? {}
        : { workspaceGeneration: metadata.workspaceGeneration }),
      token: randomToken(),
      createdAt: now,
      heartbeatAt: now,
    };
  }

  private async createMarker(
    path: string,
    metadata: WorkspaceRootLeaseMetadata,
  ): Promise<LockMarker | undefined> {
    const marker = this.newMarker(metadata);
    const temporaryPath = `${path}.${this.serverIdentity.pid}-${randomToken()}.tmp`;
    let handle;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify(marker), "utf8");
      await handle.sync();
    } finally {
      await handle?.close();
    }
    try {
      await link(temporaryPath, path);
      return marker;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
      throw error;
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private createLease(path: string, initialMarker: LockMarker): WorkspaceRootLease {
    let marker = initialMarker;
    let released = false;
    let pendingUpdates: Promise<void> = Promise.resolve();
    const updateMarker = (
      createNext: (current: LockMarker) => LockMarker,
    ): Promise<boolean> => {
      const operation = pendingUpdates.then(async () => {
        if (released) return false;
        const next = createNext(marker);
        if (!await updateOwnedMarker(path, next)) return false;
        marker = next;
        return true;
      });
      pendingUpdates = operation.then(() => undefined, () => undefined);
      return operation;
    };
    const heartbeat = async (): Promise<void> => {
      await updateMarker((current) => ({ ...current, heartbeatAt: this.now() }));
    };
    const timer = setInterval(() => {
      void heartbeat().catch(() => undefined);
    }, this.heartbeatIntervalMs);
    timer.unref();
    const release = (): void => {
      if (released) return;
      released = true;
      clearInterval(timer);
      const token = marker.token;
      // A heartbeat may already be inside its filesystem write. Make the
      // synchronous release best-effort, then retry after all queued updates
      // settle. A malformed transient marker must never terminate the server.
      releaseOwnedMarkerSync(path, token);
      void pendingUpdates
        .then(() => removeOwnedMarker(path, token))
        .catch(() => undefined);
    };
    const lease = (() => release()) as WorkspaceRootLease;
    lease.release = release;
    lease.heartbeat = heartbeat;
    lease.attachProcess = async (owner): Promise<void> => {
      if (released) throw new Error("Workspace root lease was already released.");
      const identity = readProcessIdentity(owner.pid, this.runtime);
      const updated = await updateMarker((current) => ({
        ...current,
        ownerPid: identity.pid,
        ...(identity.startIdentity
          ? { ownerStartIdentity: identity.startIdentity }
          : { ownerStartIdentity: undefined }),
        processGroupId: owner.processGroupId ?? identity.processGroupId,
        heartbeatAt: this.now(),
      }));
      if (!updated) {
        throw new Error("Workspace root lease marker is no longer owned by this process.");
      }
    };
    return lease;
  }

  private async cleanupStale(
    paths: ReturnType<CrossProcessWorkspaceRootLock["paths"]>,
  ): Promise<void> {
    await Promise.all([
      this.cleanupMarker(paths.intent),
      this.cleanupMarker(paths.writer),
      this.cleanupTemporaryMarkers(paths.directory),
      this.cleanupTemporaryMarkers(paths.readers),
    ]);
    for (const marker of await readerMarkers(paths.readers)) {
      await this.cleanupMarker(marker);
    }
  }

  private async cleanupMarker(path: string): Promise<void> {
    let marker: AnyLockMarker | undefined;
    try {
      marker = parseLockMarker(JSON.parse(await readFile(path, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // Marker heartbeats update in place. Another process may briefly observe
      // a partial JSON write; retain only recently modified malformed files.
      if (await recentlyModified(path, this.now(), this.heartbeatStaleMs)) return;
    }
    if (marker && this.markerAlive(marker)) return;
    await rm(path, { force: true });
  }

  private markerAlive(marker: AnyLockMarker): boolean {
    if ("pid" in marker) return this.runtime.processAlive(marker.pid);
    const serverIdentity: ProcessIdentity = {
      pid: marker.serverPid,
      ...(marker.serverStartIdentity
        ? { startIdentity: marker.serverStartIdentity }
        : {}),
      ...(marker.bootIdentity ? { bootIdentity: marker.bootIdentity } : {}),
    };
    if (processIdentityAlive(serverIdentity, this.runtime)) return true;
    if (marker.ownerPid) {
      const ownerIdentity: ProcessIdentity = {
        pid: marker.ownerPid,
        ...(marker.ownerStartIdentity
          ? { startIdentity: marker.ownerStartIdentity }
          : {}),
        ...(marker.bootIdentity ? { bootIdentity: marker.bootIdentity } : {}),
      };
      if (processIdentityAlive(ownerIdentity, this.runtime)) return true;
    }
    if (marker.processGroupId && this.runtime.processGroupAlive(marker.processGroupId)) return true;
    const strongIdentityAvailable = Boolean(
      marker.serverStartIdentity ||
      marker.ownerStartIdentity ||
      marker.processGroupId ||
      marker.bootIdentity
    );
    return !strongIdentityAvailable && this.now() - marker.heartbeatAt <= this.heartbeatStaleMs;
  }

  private async cleanupTemporaryMarkers(directory: string): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".tmp"))
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await Promise.all(names.map(async (name) => {
      const path = join(directory, name);
      let marker: AnyLockMarker | undefined;
      try {
        marker = parseLockMarker(JSON.parse(await readFile(path, "utf8")) as unknown);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        if (await recentlyModified(path, this.now(), this.heartbeatStaleMs)) return;
      }
      if (marker && this.markerAlive(marker)) return;
      const pid = temporaryMarkerPid(name);
      if (pid !== undefined && this.runtime.processAlive(pid)) return;
      await rm(path, { force: true });
    }));
  }

  private async wait(deadline: number): Promise<void> {
    if (this.now() >= deadline) throw new WorkspaceRootLockTimeoutError();
    await new Promise<void>((resolve) => setTimeout(resolve, this.pollIntervalMs));
  }
}

export function defaultWorkspaceRootLockDirectory(stateDir?: string): string {
  if (stateDir) return join(resolve(stateDir), "locks", "workspace-roots");
  const owner = typeof process.getuid === "function"
    ? String(process.getuid())
    : createHash("sha256").update(homedir(), "utf8").digest("hex").slice(0, 16);
  return join(tmpdir(), `devspace-root-locks-${owner}`);
}

async function ensureSecureDirectoryChain(trustedRoot: string, target: string): Promise<void> {
  const canonicalTrustedRoot = resolve(trustedRoot);
  const canonicalTarget = resolve(target);
  const relationship = relative(canonicalTrustedRoot, canonicalTarget);
  if (relationship.startsWith("..") || isAbsolute(relationship)) {
    throw new Error("Secure lock directory escapes the trusted state root.");
  }
  await ensureSecureDirectory(canonicalTrustedRoot);
  let current = canonicalTrustedRoot;
  for (const segment of relationship.split(/[\\/]+/u).filter(Boolean)) {
    current = join(current, segment);
    await ensureSecureDirectory(current);
  }
}

async function ensureSecureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  let metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Workspace lock path is not a secure directory: ${path}`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`Workspace lock directory is owned by another OS user: ${path}`);
  }
  if (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o700) {
    await chmod(path, 0o700);
    metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700) {
      throw new Error(`Workspace lock directory permissions are not 0700: ${path}`);
    }
  }
  const parent = dirname(path);
  if (parent === path) throw new Error("Workspace lock directory cannot be a filesystem root.");
}

async function readerMarkers(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(directory, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

async function recentlyModified(path: string, now: number, maximumAgeMs: number): Promise<boolean> {
  try {
    const metadata = await stat(path);
    return now - metadata.mtimeMs <= maximumAgeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function parseLockMarker(value: unknown): AnyLockMarker | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Partial<LockMarker & LegacyLockMarker>;
  if (
    record.schemaVersion === LOCK_MARKER_SCHEMA_VERSION &&
    positive(record.serverPid) &&
    typeof record.token === "string" && record.token.length > 0 &&
    finite(record.createdAt) && finite(record.heartbeatAt)
  ) {
    return record as LockMarker;
  }
  if (
    positive(record.pid) &&
    typeof record.token === "string" && record.token.length > 0 &&
    finite(record.createdAt)
  ) {
    return { pid: record.pid, token: record.token, createdAt: record.createdAt };
  }
  return undefined;
}

async function updateOwnedMarker(path: string, marker: LockMarker): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "r+");
    const current = parseLockMarker(JSON.parse(await handle.readFile("utf8")) as unknown);
    if (!current || current.token !== marker.token) return false;
    const bytes = Buffer.from(JSON.stringify(marker), "utf8");
    let written = 0;
    while (written < bytes.byteLength) {
      const result = await handle.write(
        bytes,
        written,
        bytes.byteLength - written,
        written,
      );
      if (result.bytesWritten < 1) {
        throw new Error("Workspace root lease marker write made no progress.");
      }
      written += result.bytesWritten;
    }
    await handle.truncate(bytes.byteLength);
    await handle.sync();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return false;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function removeOwnedMarker(path: string, token: string): Promise<void> {
  try {
    const marker = parseLockMarker(JSON.parse(await readFile(path, "utf8")) as unknown);
    if (marker?.token === token) await rm(path, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) {
      throw error;
    }
  }
}

function releaseOwnedMarkerSync(path: string, token: string): void {
  try {
    const marker = parseLockMarker(JSON.parse(readFileSync(path, "utf8")) as unknown);
    if (marker?.token === token) rmSync(path, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) {
      throw error;
    }
  }
}

function temporaryMarkerPid(name: string): number | undefined {
  const value = name.match(/\.(\d+)-[A-Za-z0-9_-]+\.tmp$/u)?.[1];
  if (!value) return undefined;
  const pid = Number(value);
  return positive(pid) ? pid : undefined;
}

function randomToken(): string {
  return randomBytes(12).toString("base64url");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
