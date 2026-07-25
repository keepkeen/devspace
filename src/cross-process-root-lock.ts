import { createHash, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { link, mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceRootLockMode } from "./workspace-root-locks.js";

const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 25;

interface LockMarker {
  pid: number;
  token: string;
  createdAt: number;
}

export interface CrossProcessWorkspaceRootLockOptions {
  root: string;
  acquireTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  pid?: number;
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
 * Filesystem-backed reader/writer lease shared by every DevSpace process owned
 * by the same OS user. Paths are SHA-256 keyed so the lock directory does not
 * disclose workspace names. Writer intent blocks new readers before waiting
 * for existing readers, preventing cross-process writer starvation.
 */
export class CrossProcessWorkspaceRootLock {
  private readonly root: string;
  private readonly acquireTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly pid: number;

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
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
  }

  async acquire(key: string, mode: WorkspaceRootLockMode): Promise<() => void> {
    if (!key) throw new TypeError("Workspace root lock key is required.");
    if (mode !== "read" && mode !== "write") {
      throw new TypeError("Workspace root lock mode must be read or write.");
    }
    const paths = this.paths(key);
    await this.ensureDirectories(paths);
    const deadline = this.now() + this.acquireTimeoutMs;
    return mode === "read"
      ? this.acquireReader(paths, deadline)
      : this.acquireWriter(paths, deadline);
  }

  private async acquireReader(
    paths: ReturnType<CrossProcessWorkspaceRootLock["paths"]>,
    deadline: number,
  ): Promise<() => void> {
    const marker = join(paths.readers, `${this.pid}-${randomToken()}.json`);
    for (;;) {
      await this.cleanupStale(paths);
      if (await exists(paths.intent) || await exists(paths.writer)) {
        await this.wait(deadline);
        continue;
      }
      if (!await this.createMarker(marker)) {
        await this.wait(deadline);
        continue;
      }
      if (await exists(paths.intent) || await exists(paths.writer)) {
        await rm(marker, { force: true });
        await this.wait(deadline);
        continue;
      }
      return releaseFileMarker(marker);
    }
  }

  private async acquireWriter(
    paths: ReturnType<CrossProcessWorkspaceRootLock["paths"]>,
    deadline: number,
  ): Promise<() => void> {
    for (;;) {
      await this.cleanupStale(paths);
      if (!await this.createMarker(paths.intent)) {
        await this.wait(deadline);
        continue;
      }
      try {
        for (;;) {
          await this.cleanupStale(paths);
          const readers = await readerMarkers(paths.readers);
          if (readers.length === 0 && !await exists(paths.writer)) {
            if (await this.createMarker(paths.writer)) {
              await rm(paths.intent, { force: true });
              return releaseFileMarker(paths.writer);
            }
          }
          await this.wait(deadline);
        }
      } catch (error) {
        await rm(paths.intent, { force: true });
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
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    await mkdir(paths.readers, { recursive: true, mode: 0o700 });
  }

  private async createMarker(path: string): Promise<boolean> {
    const temporaryPath = `${path}.${this.pid}-${randomToken()}.tmp`;
    let handle;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      const marker: LockMarker = {
        pid: this.pid,
        token: randomToken(),
        createdAt: this.now(),
      };
      await handle.writeFile(JSON.stringify(marker), "utf8");
      await handle.sync();
    } finally {
      await handle?.close();
    }
    try {
      await link(temporaryPath, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally {
      await rm(temporaryPath, { force: true });
    }
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
    let marker: LockMarker | undefined;
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<LockMarker>;
      if (
        Number.isSafeInteger(parsed.pid) &&
        (parsed.pid ?? 0) > 0 &&
        typeof parsed.token === "string" &&
        Number.isFinite(parsed.createdAt)
      ) {
        marker = parsed as LockMarker;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      // Malformed markers are not valid leases and are removed below.
    }
    if (
      marker &&
      processAlive(marker.pid)
    ) {
      return;
    }
    await rm(path, { force: true });
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
      const pid = await temporaryMarkerPid(path, name);
      if (pid !== undefined && processAlive(pid)) return;
      await rm(path, { force: true });
    }));
  }

  private async wait(deadline: number): Promise<void> {
    if (this.now() >= deadline) throw new WorkspaceRootLockTimeoutError();
    await new Promise<void>((resolve) => setTimeout(resolve, this.pollIntervalMs));
  }
}

export function defaultWorkspaceRootLockDirectory(): string {
  const owner = typeof process.getuid === "function"
    ? String(process.getuid())
    : createHash("sha256").update(homedir(), "utf8").digest("hex").slice(0, 16);
  return join(tmpdir(), `devspace-root-locks-${owner}`);
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function temporaryMarkerPid(path: string, name: string): Promise<number | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<LockMarker>;
    if (Number.isSafeInteger(parsed.pid) && (parsed.pid ?? 0) > 0) return parsed.pid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  }
  const value = name.match(/\.(\d+)-[A-Za-z0-9_-]+\.tmp$/u)?.[1];
  if (!value) return undefined;
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function releaseFileMarker(path: string): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    rmSync(path, { force: true });
  };
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
