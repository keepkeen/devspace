import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";

export interface StateDirectorySingletonOptions {
  stateDir: string;
}

export interface StateDirectorySingletonLease {
  release(): void;
}

export class StateDirectoryAlreadyInUseError extends Error {
  readonly code = "state_directory_in_use";
  readonly publicText =
    "Another DevSpace server process is already using this state directory.";

  constructor(stateDir: string) {
    super(`Another DevSpace process is using the state directory: ${resolve(stateDir)}`);
    this.name = "StateDirectoryAlreadyInUseError";
  }
}

/**
 * Acquires an OS-backed process-lifetime lock before any canonical database is
 * opened. SQLite's exclusive transaction is released by the kernel when a
 * process exits, so startup never needs a racy read/unlink stale-marker path.
 */
export function acquireStateDirectorySingleton(
  options: StateDirectorySingletonOptions,
): StateDirectorySingletonLease {
  if (!options.stateDir) throw new TypeError("State directory is required.");
  const stateDir = resolve(options.stateDir);
  const locksDirectory = join(stateDir, "locks");
  const databasePath = join(locksDirectory, "state-directory-singleton.sqlite");

  ensureSecureDirectory(stateDir);
  ensureSecureDirectory(locksDirectory);
  assertSafeLockFile(databasePath);

  const sqlite = new Database(databasePath, { timeout: 0 });
  let acquired = false;
  try {
    chmodSync(databasePath, 0o600);
    sqlite.pragma("busy_timeout = 0");
    sqlite.pragma("journal_mode = DELETE");
    sqlite.exec("BEGIN EXCLUSIVE");
    acquired = true;
  } catch (error) {
    sqlite.close();
    if (isLockContention(error)) throw new StateDirectoryAlreadyInUseError(stateDir);
    throw error;
  }

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      try {
        if (acquired && sqlite.inTransaction) sqlite.exec("ROLLBACK");
      } finally {
        sqlite.close();
      }
    },
  };
}

function isLockContention(error: unknown): boolean {
  const code = error && typeof error === "object"
    ? (error as { code?: unknown }).code
    : undefined;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

function assertSafeLockFile(path: string): void {
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`State singleton lock is not a regular file: ${path}`);
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new Error(`State singleton lock is owned by another OS user: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function ensureSecureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  let metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`State singleton path is not a secure directory: ${path}`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`State singleton directory is owned by another OS user: ${path}`);
  }
  if (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o700) {
    chmodSync(path, 0o700);
    metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700) {
      throw new Error(`State singleton directory permissions are not 0700: ${path}`);
    }
  }
  if (dirname(path) === path) throw new Error("State directory cannot be a filesystem root.");
}
