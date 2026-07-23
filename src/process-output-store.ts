import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export type ProcessOutputStatus = "active" | "completed" | "unknown";

export interface ProcessOutputStoreOptions {
  stateDir: string;
  maxFileBytes: number;
  maxStorageBytes: number;
  completedTtlMs: number;
  maxOutputs?: number;
  now?: () => number;
}

export interface CreateProcessOutputInput {
  ownerClientId: string;
  workspaceId: string;
}

export interface ProcessOutputMetadata {
  outputId: string;
  status: ProcessOutputStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  totalBytes: number;
  storedBytes: number;
  droppedBytes: number;
}

export interface ProcessOutputReadOptions {
  offset: number;
  limit: number;
}

export interface ProcessOutputReadResult {
  content: string;
  offset: number;
  nextOffset: number;
  eof: boolean;
  totalBytes: number;
  storedBytes: number;
  droppedBytes: number;
  status: ProcessOutputStatus;
}

export interface ProcessOutputCleanupResult {
  deleted: number;
  bytesReclaimed: number;
}

export interface ProcessOutputUsageSnapshot {
  outputs: number;
  activeOutputs: number;
  completedOutputs: number;
  totalBytes: number;
  storedBytes: number;
  droppedBytes: number;
  maxStorageBytes: number;
  availableBytes: number;
}

export class ProcessOutputNotFoundError extends Error {
  readonly code = "process_output_not_found";

  constructor() {
    super("The retained process output is no longer available.");
    this.name = "ProcessOutputNotFoundError";
  }
}

export class ProcessOutputIntegrityError extends Error {
  constructor(message = "Process output storage failed an integrity check") {
    super(message);
    this.name = "ProcessOutputIntegrityError";
  }
}

export class ProcessOutputQuotaError extends Error {
  constructor(message = "Process output storage quota was reached") {
    super(message);
    this.name = "ProcessOutputQuotaError";
  }
}

interface ProcessOutputRow {
  output_id: string;
  owner_client_id: string;
  workspace_id: string;
  status: ProcessOutputStatus;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  total_bytes: number;
  stored_bytes: number;
  dropped_bytes: number;
  file_dev: string;
  file_ino: string;
}

interface UsageRow {
  outputs: number;
  active_outputs: number;
  completed_outputs: number;
  total_bytes: number;
  stored_bytes: number;
  dropped_bytes: number;
}

const OUTPUT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEFAULT_CLEANUP_LIMIT = 100;
const MAX_CLEANUP_LIMIT = 1_000;
const MAX_READ_BYTES = 1024 * 1024;
const RECOVERY_BATCH_SIZE = 100;
const UTF8_LOOKAHEAD_BYTES = 3;
const DEFAULT_MAX_OUTPUTS = 10_000;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const WRITER_LOCK_MIN_STALE_AGE_MS = 1_000;
const WRITER_LOCK_RETRY_DELAY_MS = 25;
const WRITER_LOCK_ACQUIRE_ATTEMPTS = 4;

export class ProcessOutputStore {
  private readonly database: Database.Database;
  private readonly outputDir: string;
  private readonly databaseFile: string;
  private readonly lockFile: string;
  private lockDescriptor: number | undefined;
  private lockDev = "";
  private lockIno = "";
  private readonly maxFileBytes: number;
  private readonly maxStorageBytes: number;
  private readonly completedTtlMs: number;
  private readonly maxOutputs: number;
  private readonly clock: () => number;
  private readonly outputDirDev: string;
  private readonly outputDirIno: string;
  private closed = false;

  constructor(options: ProcessOutputStoreOptions) {
    this.maxFileBytes = nonNegativeSafeInteger(options.maxFileBytes, "maxFileBytes");
    this.maxStorageBytes = nonNegativeSafeInteger(options.maxStorageBytes, "maxStorageBytes");
    this.completedTtlMs = nonNegativeSafeInteger(options.completedTtlMs, "completedTtlMs");
    this.maxOutputs = positiveBoundedInteger(options.maxOutputs ?? DEFAULT_MAX_OUTPUTS, "maxOutputs", 1_000_000);
    this.clock = options.now ?? Date.now;

    ensurePrivateDirectory(options.stateDir);
    this.outputDir = join(options.stateDir, "process-output");
    ensurePrivateDirectory(this.outputDir);
    const outputDirectoryStats = secureDirectoryStats(this.outputDir);
    this.outputDirDev = outputDirectoryStats.dev.toString();
    this.outputDirIno = outputDirectoryStats.ino.toString();
    this.lockFile = join(this.outputDir, "writer.lock");
    this.acquireWriterLock();

    this.databaseFile = join(this.outputDir, "metadata.sqlite");
    let database: Database.Database | undefined;
    try {
      rejectExistingNonRegularFile(this.databaseFile);
      database = new Database(this.databaseFile);
      this.database = database;
      chmodSync(this.databaseFile, 0o600);
      this.database.pragma("journal_mode = DELETE");
      this.database.pragma("synchronous = FULL");
      this.database.pragma("busy_timeout = 5000");
      this.database.pragma("foreign_keys = ON");
      this.initializeSchema();
      this.recoverPendingDeletions();
      this.removeOrphanOutputFiles();
      this.reconcileOutputFiles();
      this.recoverInterruptedOutputs();
    } catch (error) {
      database?.close();
      this.releaseWriterLock();
      this.closed = true;
      throw error;
    }
  }

  create(input: CreateProcessOutputInput): string {
    this.assertOpenAndStorageDirectory();
    const ownerClientId = boundedNonEmptyString(input.ownerClientId, "ownerClientId");
    const workspaceId = boundedNonEmptyString(input.workspaceId, "workspaceId");
    let usage = this.getUsageRow();
    while (usage.outputs >= this.maxOutputs || usage.stored_bytes >= this.maxStorageBytes) {
      const cleanup = this.cleanupExpired(MAX_CLEANUP_LIMIT);
      usage = this.getUsageRow();
      if (cleanup.deleted === 0) break;
    }
    if (usage.outputs >= this.maxOutputs) {
      throw new ProcessOutputQuotaError(`Process output record limit reached (${this.maxOutputs})`);
    }
    if (usage.stored_bytes >= this.maxStorageBytes) {
      throw new ProcessOutputQuotaError(`Process output storage limit reached (${this.maxStorageBytes} bytes)`);
    }
    const outputId = randomUUID();
    const filePath = this.filePath(outputId);
    const now = this.currentTime();

    let descriptor: number | undefined;
    let createdFile = false;
    let fileStats: BigIntStats;
    try {
      descriptor = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600);
      createdFile = true;
      fchmodSync(descriptor, 0o600);
      fileStats = fstatSync(descriptor, { bigint: true });
      assertSecureRegularStats(fileStats, 0);
    } catch (error) {
      if (createdFile) {
        try {
          unlinkSync(filePath);
        } catch {
          // Preserve the original setup failure. Startup orphan cleanup will
          // remove a file left behind by an interrupted unlink.
        }
      }
      throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }

    try {
      const createRecord = this.database.transaction(() => {
        this.database
          .prepare(
            `insert into process_outputs (
              output_id, owner_client_id, workspace_id, status, created_at, updated_at,
              completed_at, total_bytes, stored_bytes, dropped_bytes, file_dev, file_ino
            ) values (?, ?, ?, 'active', ?, ?, null, 0, 0, 0, ?, ?)`,
          )
          .run(outputId, ownerClientId, workspaceId, now, now, fileStats.dev.toString(), fileStats.ino.toString());
        this.database
          .prepare(
            `update process_output_usage
             set outputs = outputs + 1, active_outputs = active_outputs + 1
             where id = 1`,
          )
          .run();
      });
      createRecord.immediate();
    } catch (error) {
      unlinkSync(filePath);
      throw error;
    }

    return outputId;
  }

  append(outputId: string, data: string | Buffer): void {
    this.assertOpenAndStorageDirectory();
    validateOutputId(outputId);
    if (typeof data !== "string" && !Buffer.isBuffer(data)) {
      throw new TypeError("data must be a string or Buffer");
    }
    const utf8Text = typeof data === "string";
    const bytes = utf8Text ? Buffer.from(data, "utf8") : Buffer.from(data);
    const now = this.currentTime();
    let touchedFile = false;

    let usageBeforeAppend = this.getUsageRow();
    while (usageBeforeAppend.stored_bytes + bytes.length > this.maxStorageBytes) {
      const cleanup = this.cleanupExpired(MAX_CLEANUP_LIMIT);
      usageBeforeAppend = this.getUsageRow();
      if (cleanup.deleted === 0) break;
    }

    const appendRecord = this.database.transaction(() => {
      const row = this.getRowById(outputId);
      if (!row) throw new ProcessOutputNotFoundError();
      if (row.status !== "active") throw new Error("Cannot append to completed process output");
      assertSafeAddition(row.total_bytes, bytes.length, "totalBytes");

      const usage = this.getUsageRow();
      const fileAllowance = Math.max(0, this.maxFileBytes - row.stored_bytes);
      const storageAllowance = Math.max(0, this.maxStorageBytes - usage.stored_bytes);
      const rawAllowance = row.dropped_bytes > 0
        ? 0
        : Math.min(bytes.length, fileAllowance, storageAllowance);
      // Durable output is always a contiguous prefix. Once a quota has dropped
      // bytes, later appends must not create a misleading stream with a gap.
      const bytesToStore = utf8Text
        ? completeUtf8PrefixLength(bytes, rawAllowance)
        : rawAllowance;
      const bytesToDrop = bytes.length - bytesToStore;
      assertSafeAddition(usage.total_bytes, bytes.length, "global totalBytes");
      assertSafeAddition(row.dropped_bytes, bytesToDrop, "droppedBytes");
      assertSafeAddition(usage.dropped_bytes, bytesToDrop, "global droppedBytes");

      if (bytesToStore > 0) {
        this.appendFile(row, bytes.subarray(0, bytesToStore));
        touchedFile = true;
      }
      this.database
        .prepare(
          `update process_outputs set
             updated_at = ?,
             total_bytes = total_bytes + ?,
             stored_bytes = stored_bytes + ?,
             dropped_bytes = dropped_bytes + ?
           where output_id = ?`,
        )
        .run(now, bytes.length, bytesToStore, bytesToDrop, outputId);
      this.database
        .prepare(
          `update process_output_usage set
             total_bytes = total_bytes + ?,
             stored_bytes = stored_bytes + ?,
             dropped_bytes = dropped_bytes + ?
           where id = 1`,
        )
        .run(bytes.length, bytesToStore, bytesToDrop);
    });
    try {
      appendRecord.immediate();
    } catch (error) {
      if (touchedFile) {
        try {
          const committedRow = this.getRowById(outputId);
          if (committedRow) this.recoverFile(committedRow);
        } catch (recoveryError) {
          throw new AggregateError(
            [error, recoveryError],
            "Process output append failed and its file could not be restored to committed metadata",
          );
        }
      }
      throw error;
    }
  }

  complete(outputId: string): void {
    this.assertOpenAndStorageDirectory();
    validateOutputId(outputId);
    const now = this.currentTime();
    const markComplete = this.database.transaction(() => {
      const result = this.database
        .prepare(
          `update process_outputs
           set status = 'completed', updated_at = ?, completed_at = ?
           where output_id = ? and status = 'active'`,
        )
        .run(now, now, outputId);
      if (result.changes === 1) {
        this.database
          .prepare(
            `update process_output_usage
             set active_outputs = active_outputs - 1, completed_outputs = completed_outputs + 1
             where id = 1`,
          )
          .run();
        return;
      }
      if (!this.getRowById(outputId)) throw new ProcessOutputNotFoundError();
    });
    markComplete.immediate();
  }

  read(
    ownerClientId: string,
    workspaceId: string,
    outputId: string,
    options: ProcessOutputReadOptions,
  ): ProcessOutputReadResult {
    this.assertOpenAndStorageDirectory();
    validateOutputId(outputId);
    boundedNonEmptyString(ownerClientId, "ownerClientId");
    boundedNonEmptyString(workspaceId, "workspaceId");
    const offset = nonNegativeSafeInteger(options.offset, "offset");
    const limit = positiveBoundedInteger(options.limit, "limit", MAX_READ_BYTES);
    const row = this.getOwnedReadableRow(ownerClientId, workspaceId, outputId);
    if (offset > row.stored_bytes) throw new RangeError("offset exceeds stored process output bytes");
    if (offset > 0 && offset < row.stored_bytes) {
      const descriptor = this.openVerifiedFile(row, constants.O_RDONLY | NO_FOLLOW);
      try {
        const byte = Buffer.allocUnsafe(1);
        if (readSync(descriptor, byte, 0, 1, offset) !== 1) {
          throw new ProcessOutputIntegrityError("Process output file changed during read");
        }
        if (isUtf8ContinuationByte(byte[0]!)) {
          throw new RangeError("offset is inside a UTF-8 character; use a nextOffset returned by this tool");
        }
      } finally {
        closeSync(descriptor);
      }
    }

    const available = row.stored_bytes - offset;
    const desiredBytes = Math.min(available, limit);
    let content = "";
    let consumedBytes = 0;
    if (desiredBytes > 0) {
      const readLength = Math.min(available, desiredBytes + UTF8_LOOKAHEAD_BYTES);
      const buffer = Buffer.allocUnsafe(readLength);
      const descriptor = this.openVerifiedFile(row, constants.O_RDONLY | NO_FOLLOW);
      try {
        const bytesRead = readSync(descriptor, buffer, 0, readLength, offset);
        if (bytesRead !== readLength) throw new ProcessOutputIntegrityError("Process output file changed during read");
      } finally {
        closeSync(descriptor);
      }
      consumedBytes = safeUtf8PageEnd(buffer, desiredBytes, available === readLength);
      content = new TextDecoder("utf-8", { fatal: false }).decode(buffer.subarray(0, consumedBytes));
    }

    const nextOffset = offset + consumedBytes;
    return {
      content,
      offset,
      nextOffset,
      eof: nextOffset >= row.stored_bytes,
      totalBytes: row.total_bytes,
      storedBytes: row.stored_bytes,
      droppedBytes: row.dropped_bytes,
      status: row.status,
    };
  }

  metadata(ownerClientId: string, workspaceId: string, outputId: string): ProcessOutputMetadata {
    this.assertOpenAndStorageDirectory();
    validateOutputId(outputId);
    boundedNonEmptyString(ownerClientId, "ownerClientId");
    boundedNonEmptyString(workspaceId, "workspaceId");
    const row = this.getOwnedReadableRow(ownerClientId, workspaceId, outputId);
    this.assertFile(row);
    return rowToMetadata(row);
  }

  cleanupExpired(limit = DEFAULT_CLEANUP_LIMIT): ProcessOutputCleanupResult {
    this.assertOpenAndStorageDirectory();
    this.recoverPendingDeletions();
    const boundedLimit = positiveBoundedInteger(limit, "limit", MAX_CLEANUP_LIMIT);
    const expiredAt = this.currentTime() - this.completedTtlMs;
    const rows = this.database
      .prepare(
        `select * from process_outputs
         where status in ('completed', 'unknown') and completed_at <= ?
         order by completed_at asc, output_id asc
         limit ?`,
      )
      .all(expiredAt, boundedLimit) as ProcessOutputRow[];

    let deleted = 0;
    let bytesReclaimed = 0;
    for (const row of rows) {
      this.assertFile(row);
      this.database
        .prepare("insert or ignore into process_output_deletions (output_id) values (?)")
        .run(row.output_id);
      unlinkSync(this.filePath(row.output_id));
      this.finalizeDeletion(row);
      deleted += 1;
      bytesReclaimed += row.stored_bytes;
    }
    return { deleted, bytesReclaimed };
  }

  retireWorkspace(ownerClientId: string, workspaceId: string): ProcessOutputCleanupResult {
    this.assertOpenAndStorageDirectory();
    const owner = boundedNonEmptyString(ownerClientId, "ownerClientId");
    const workspace = boundedNonEmptyString(workspaceId, "workspaceId");
    this.recoverPendingDeletions();
    const now = this.currentTime();
    const retireActive = this.database.transaction(() => {
      const result = this.database.prepare(`
        update process_outputs
        set status = 'unknown', updated_at = ?, completed_at = ?
        where owner_client_id = ? and workspace_id = ? and status = 'active'
      `).run(now, now, owner, workspace);
      if (result.changes > 0) {
        this.database.prepare(`
          update process_output_usage
          set active_outputs = active_outputs - ?, completed_outputs = completed_outputs + ?
          where id = 1
        `).run(result.changes, result.changes);
      }
    });
    retireActive.immediate();

    const rows = this.database.prepare(`
      select *
      from process_outputs
      where owner_client_id = ? and workspace_id = ?
      order by output_id
    `).all(owner, workspace) as ProcessOutputRow[];
    let deleted = 0;
    let bytesReclaimed = 0;
    for (const row of rows) {
      this.assertFile(row);
      this.database
        .prepare("insert or ignore into process_output_deletions (output_id) values (?)")
        .run(row.output_id);
      unlinkSync(this.filePath(row.output_id));
      this.finalizeDeletion(row);
      deleted += 1;
      bytesReclaimed += row.stored_bytes;
    }
    return { deleted, bytesReclaimed };
  }

  usageSnapshot(): ProcessOutputUsageSnapshot {
    this.assertOpenAndStorageDirectory();
    const usage = this.getUsageRow();
    return {
      outputs: usage.outputs,
      activeOutputs: usage.active_outputs,
      completedOutputs: usage.completed_outputs,
      totalBytes: usage.total_bytes,
      storedBytes: usage.stored_bytes,
      droppedBytes: usage.dropped_bytes,
      maxStorageBytes: this.maxStorageBytes,
      availableBytes: Math.max(0, this.maxStorageBytes - usage.stored_bytes),
    };
  }

  close(): void {
    if (this.closed) return;
    const closeErrors: unknown[] = [];
    try {
      try {
        this.database.close();
      } catch (error) {
        closeErrors.push(error);
      }
      try {
        this.releaseWriterLock();
      } catch (error) {
        closeErrors.push(error);
      }
    } finally {
      this.closed = true;
    }
    if (closeErrors.length > 1) {
      throw new AggregateError(
        closeErrors,
        "Failed to close the process-output database and release its writer lock",
      );
    }
    if (closeErrors.length === 1) throw closeErrors[0];
  }

  private acquireWriterLock(): void {
    let previousStaleLockSignature: string | undefined;
    for (let attempt = 0; attempt < WRITER_LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
      let candidateDescriptor: number | undefined;
      try {
        candidateDescriptor = openSync(
          this.lockFile,
          constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
          0o600,
        );
        fchmodSync(candidateDescriptor, 0o600);
        const identity = processIdentity(process.pid);
        if (identity === undefined) {
          throw new Error("Unable to establish a stable process identity for the process-output writer lock");
        }
        const payload = Buffer.from(JSON.stringify({
          pid: process.pid,
          processIdentity: identity,
          createdAt: Date.now(),
        }), "utf8");
        writeSync(candidateDescriptor, payload, 0, payload.length, 0);
        fsyncSync(candidateDescriptor);
        const stats = fstatSync(candidateDescriptor, { bigint: true });
        assertSecureRegularStats(stats, payload.length);
        this.lockDescriptor = candidateDescriptor;
        candidateDescriptor = undefined;
        this.lockDev = stats.dev.toString();
        this.lockIno = stats.ino.toString();
        return;
      } catch (error) {
        if (candidateDescriptor !== undefined) {
          closeSync(candidateDescriptor);
          try {
            unlinkSync(this.lockFile);
          } catch {
            // Preserve the lock acquisition error.
          }
        }
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      }

      let existing: ReturnType<typeof inspectWriterLock>;
      try {
        existing = inspectWriterLock(this.lockFile);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") continue;
        throw error;
      }
      if (existing.pid !== undefined && processOwnsLock(existing.pid, existing.processIdentity)) {
        throw new Error(`Another DevSpace process is using process-output storage (PID ${existing.pid})`);
      }
      const current = lstatSync(this.lockFile, { bigint: true });
      const signature = writerLockSignature(current);
      if (signature !== writerLockSignature(existing.stats)) {
        previousStaleLockSignature = undefined;
        retryWriterLockAcquisition(attempt);
        continue;
      }
      const ageMs = Date.now() - Number(current.mtimeMs);
      if (ageMs < WRITER_LOCK_MIN_STALE_AGE_MS || signature !== previousStaleLockSignature) {
        previousStaleLockSignature = ageMs >= WRITER_LOCK_MIN_STALE_AGE_MS ? signature : undefined;
        retryWriterLockAcquisition(attempt);
        continue;
      }
      unlinkSync(this.lockFile);
    }
    throw new Error("Unable to acquire the process-output writer lock");
  }

  private releaseWriterLock(): void {
    const descriptor = this.lockDescriptor;
    this.lockDescriptor = undefined;
    if (descriptor === undefined) return;
    try {
      const current = lstatSync(this.lockFile, { bigint: true });
      if (current.dev.toString() === this.lockDev && current.ino.toString() === this.lockIno) {
        unlinkSync(this.lockFile);
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    } finally {
      closeSync(descriptor);
    }
  }

  private initializeSchema(): void {
    const userVersion = this.database.pragma("user_version", { simple: true }) as number;
    if (userVersion > 2) throw new Error(`Unsupported process output database version: ${userVersion}`);
    this.database.exec(`
      create table if not exists process_outputs (
        output_id text primary key,
        owner_client_id text not null,
        workspace_id text not null,
        status text not null check (status in ('active', 'completed', 'unknown')),
        created_at integer not null,
        updated_at integer not null,
        completed_at integer,
        total_bytes integer not null check (total_bytes >= 0),
        stored_bytes integer not null check (stored_bytes >= 0),
        dropped_bytes integer not null check (dropped_bytes >= 0),
        file_dev text not null,
        file_ino text not null,
        check (total_bytes = stored_bytes + dropped_bytes),
        check ((status = 'active' and completed_at is null) or (status != 'active' and completed_at is not null))
      ) without rowid;
      create index if not exists process_outputs_expiration
        on process_outputs (completed_at, output_id)
        where status in ('completed', 'unknown');
      create table if not exists process_output_usage (
        id integer primary key check (id = 1),
        outputs integer not null check (outputs >= 0),
        active_outputs integer not null check (active_outputs >= 0),
        completed_outputs integer not null check (completed_outputs >= 0),
        total_bytes integer not null check (total_bytes >= 0),
        stored_bytes integer not null check (stored_bytes >= 0),
        dropped_bytes integer not null check (dropped_bytes >= 0),
        check (outputs = active_outputs + completed_outputs),
        check (total_bytes = stored_bytes + dropped_bytes)
      );
      create table if not exists process_output_deletions (
        output_id text primary key references process_outputs(output_id) on delete cascade
      ) without rowid;
      insert or ignore into process_output_usage (
        id, outputs, active_outputs, completed_outputs, total_bytes, stored_bytes, dropped_bytes
      ) values (1, 0, 0, 0, 0, 0, 0);
      pragma user_version = 2;
    `);
  }

  private recoverPendingDeletions(): void {
    while (true) {
      const rows = this.database
        .prepare(
          `select process_outputs.*
           from process_output_deletions
           join process_outputs using (output_id)
           order by output_id
           limit ?`,
        )
        .all(RECOVERY_BATCH_SIZE) as ProcessOutputRow[];
      if (rows.length === 0) return;
      for (const row of rows) {
        if (this.filePathExists(row.output_id)) {
          this.recoverFile(row);
          unlinkSync(this.filePath(row.output_id));
        }
        this.finalizeDeletion(row);
      }
    }
  }

  private removeOrphanOutputFiles(): void {
    for (const entry of readdirSync(this.outputDir, { withFileTypes: true })) {
      const match = /^([0-9a-f-]{36})\.log$/u.exec(entry.name);
      if (!match || !OUTPUT_ID_PATTERN.test(match[1]!)) continue;
      if (this.getRowById(match[1]!)) continue;
      unlinkSync(join(this.outputDir, entry.name));
    }
  }

  private reconcileOutputFiles(): void {
    let afterOutputId = "";
    while (true) {
      const rows = this.database
        .prepare(
          `select * from process_outputs
           where output_id > ?
           order by output_id
           limit ?`,
        )
        .all(afterOutputId, RECOVERY_BATCH_SIZE) as ProcessOutputRow[];
      if (rows.length === 0) return;
      for (const row of rows) this.recoverFile(row);
      afterOutputId = rows.at(-1)!.output_id;
    }
  }

  private recoverFile(row: ProcessOutputRow): void {
    validateOutputId(row.output_id);
    const path = this.filePath(row.output_id);
    let pathStats: BigIntStats;
    try {
      pathStats = lstatSync(path, { bigint: true });
      assertSecureRegularFile(pathStats);
      assertFileIdentity(pathStats, row);
    } catch (error) {
      if (error instanceof ProcessOutputIntegrityError) throw error;
      throw new ProcessOutputIntegrityError("Process output file is missing or inaccessible");
    }
    if (pathStats.size < BigInt(row.stored_bytes)) {
      throw new ProcessOutputIntegrityError("Process output file is shorter than committed metadata");
    }
    if (pathStats.size === BigInt(row.stored_bytes)) return;

    let descriptor: number;
    try {
      descriptor = openSync(path, constants.O_WRONLY | NO_FOLLOW);
    } catch {
      throw new ProcessOutputIntegrityError("Process output file is missing or inaccessible");
    }
    try {
      const descriptorStats = fstatSync(descriptor, { bigint: true });
      assertSecureRegularFile(descriptorStats);
      assertFileIdentity(descriptorStats, row);
      if (descriptorStats.size < BigInt(row.stored_bytes)) {
        throw new ProcessOutputIntegrityError("Process output file is shorter than committed metadata");
      }
      ftruncateSync(descriptor, row.stored_bytes);
      fsyncSync(descriptor);
      assertSecureRegularStats(fstatSync(descriptor, { bigint: true }), row.stored_bytes);
    } finally {
      closeSync(descriptor);
    }
  }

  private finalizeDeletion(row: ProcessOutputRow): void {
    const deleteRecord = this.database.transaction(() => {
      const result = this.database.prepare("delete from process_outputs where output_id = ?").run(row.output_id);
      if (result.changes !== 1) {
        throw new ProcessOutputIntegrityError("Process output metadata changed during cleanup");
      }
      this.database
        .prepare(
          `update process_output_usage set
             outputs = outputs - 1,
             completed_outputs = completed_outputs - 1,
             total_bytes = total_bytes - ?,
             stored_bytes = stored_bytes - ?,
             dropped_bytes = dropped_bytes - ?
           where id = 1`,
        )
        .run(row.total_bytes, row.stored_bytes, row.dropped_bytes);
    });
    deleteRecord.immediate();
  }

  private filePathExists(outputId: string): boolean {
    try {
      lstatSync(this.filePath(outputId));
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw new ProcessOutputIntegrityError("Process output file is inaccessible");
    }
  }

  private recoverInterruptedOutputs(): void {
    const now = this.currentTime();
    const recover = this.database.transaction(() => {
      const result = this.database
        .prepare(
          `update process_outputs
           set status = 'unknown', updated_at = ?, completed_at = ?
           where status = 'active'`,
        )
        .run(now, now);
      if (result.changes > 0) {
        this.database
          .prepare(
            `update process_output_usage
             set active_outputs = active_outputs - ?, completed_outputs = completed_outputs + ?
             where id = 1`,
          )
          .run(result.changes, result.changes);
      }
    });
    recover.immediate();
  }

  private appendFile(row: ProcessOutputRow, bytes: Buffer): void {
    const descriptor = this.openVerifiedFile(row, constants.O_WRONLY | constants.O_APPEND | NO_FOLLOW);
    try {
      let written = 0;
      try {
        while (written < bytes.length) {
          const count = writeSync(descriptor, bytes, written, bytes.length - written);
          if (count <= 0) throw new Error("Failed to append process output bytes");
          written += count;
        }
        fsyncSync(descriptor);
      } catch (error) {
        if (written > 0) {
          ftruncateSync(descriptor, row.stored_bytes);
          fsyncSync(descriptor);
        }
        throw error;
      }
      const finalStats = fstatSync(descriptor, { bigint: true });
      if (finalStats.size !== BigInt(row.stored_bytes + bytes.length)) {
        throw new ProcessOutputIntegrityError("Process output file size changed during append");
      }
    } finally {
      closeSync(descriptor);
    }
  }

  private assertFile(row: ProcessOutputRow): void {
    const descriptor = this.openVerifiedFile(row, constants.O_RDONLY | NO_FOLLOW);
    closeSync(descriptor);
  }

  private openVerifiedFile(row: ProcessOutputRow, flags: number): number {
    validateOutputId(row.output_id);
    const path = this.filePath(row.output_id);
    let descriptor: number;
    try {
      const pathStats = lstatSync(path, { bigint: true });
      assertSecureRegularStats(pathStats, row.stored_bytes);
      assertFileIdentity(pathStats, row);
      descriptor = openSync(path, flags);
    } catch (error) {
      if (error instanceof ProcessOutputIntegrityError) throw error;
      throw new ProcessOutputIntegrityError("Process output file is missing or inaccessible");
    }
    try {
      const descriptorStats = fstatSync(descriptor, { bigint: true });
      assertSecureRegularStats(descriptorStats, row.stored_bytes);
      assertFileIdentity(descriptorStats, row);
      return descriptor;
    } catch (error) {
      closeSync(descriptor);
      if (error instanceof ProcessOutputIntegrityError) throw error;
      throw new ProcessOutputIntegrityError();
    }
  }

  private getOwnedReadableRow(ownerClientId: string, workspaceId: string, outputId: string): ProcessOutputRow {
    const row = this.database
      .prepare(
        `select * from process_outputs
         where output_id = ? and owner_client_id = ? and workspace_id = ?`,
      )
      .get(outputId, ownerClientId, workspaceId) as ProcessOutputRow | undefined;
    if (!row || this.isExpired(row)) throw new ProcessOutputNotFoundError();
    return row;
  }

  private getRowById(outputId: string): ProcessOutputRow | undefined {
    return this.database.prepare("select * from process_outputs where output_id = ?").get(outputId) as
      | ProcessOutputRow
      | undefined;
  }

  private getUsageRow(): UsageRow {
    const row = this.database.prepare("select * from process_output_usage where id = 1").get() as UsageRow | undefined;
    if (!row) throw new ProcessOutputIntegrityError("Process output usage metadata is missing");
    return row;
  }

  private isExpired(row: ProcessOutputRow): boolean {
    return row.completed_at !== null && row.completed_at + this.completedTtlMs <= this.currentTime();
  }

  private filePath(outputId: string): string {
    validateOutputId(outputId);
    return join(this.outputDir, `${outputId}.log`);
  }

  private currentTime(): number {
    return nonNegativeSafeInteger(this.clock(), "now()");
  }

  private assertOpenAndStorageDirectory(): void {
    if (this.closed) throw new Error("ProcessOutputStore is closed");
    const stats = secureDirectoryStats(this.outputDir);
    if (stats.dev.toString() !== this.outputDirDev || stats.ino.toString() !== this.outputDirIno) {
      throw new ProcessOutputIntegrityError("Process output directory was replaced");
    }
  }
}

function rowToMetadata(row: ProcessOutputRow): ProcessOutputMetadata {
  return {
    outputId: row.output_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    totalBytes: row.total_bytes,
    storedBytes: row.stored_bytes,
    droppedBytes: row.dropped_bytes,
  };
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stats = lstatSync(path, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new ProcessOutputIntegrityError("Process output storage directory is not a regular directory");
  }
  chmodSync(path, 0o700);
}

function secureDirectoryStats(path: string): BigIntStats {
  let stats: BigIntStats;
  try {
    stats = lstatSync(path, { bigint: true });
  } catch {
    throw new ProcessOutputIntegrityError("Process output storage directory is missing");
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new ProcessOutputIntegrityError("Process output storage directory is not a regular directory");
  }
  if (process.platform !== "win32" && (stats.mode & 0o777n) !== 0o700n) {
    throw new ProcessOutputIntegrityError("Process output storage directory permissions changed");
  }
  return stats;
}

function rejectExistingNonRegularFile(path: string): void {
  try {
    const stats = lstatSync(path, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new ProcessOutputIntegrityError("Process output metadata path is not a regular file");
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

function assertSecureRegularStats(stats: BigIntStats, expectedSize: number): void {
  assertSecureRegularFile(stats);
  if (stats.size !== BigInt(expectedSize)) {
    throw new ProcessOutputIntegrityError("Process output file size does not match metadata");
  }
}

function assertSecureRegularFile(stats: BigIntStats): void {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new ProcessOutputIntegrityError("Process output path is not a regular file");
  }
  if (process.platform !== "win32" && (stats.mode & 0o777n) !== 0o600n) {
    throw new ProcessOutputIntegrityError("Process output file permissions changed");
  }
}

function assertFileIdentity(stats: BigIntStats, row: ProcessOutputRow): void {
  if (stats.dev.toString() !== row.file_dev || stats.ino.toString() !== row.file_ino) {
    throw new ProcessOutputIntegrityError("Process output file was replaced");
  }
}

function safeUtf8PageEnd(buffer: Buffer, desiredBytes: number, reachedEof: boolean): number {
  if (desiredBytes >= buffer.length) return buffer.length;
  let end = desiredBytes;
  while (end < buffer.length && isUtf8ContinuationByte(buffer[end]!)) end += 1;
  if (end < buffer.length || reachedEof) return end;
  return desiredBytes;
}

function completeUtf8PrefixLength(buffer: Buffer, maximum: number): number {
  if (maximum >= buffer.length) return buffer.length;
  if (maximum <= 0) return 0;
  let end = maximum;
  while (end > 0 && isUtf8ContinuationByte(buffer[end]!)) end -= 1;
  if (end === maximum) return maximum;
  const lead = buffer[end]!;
  const expectedLength = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return end + expectedLength <= maximum ? maximum : end;
}

function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function validateOutputId(outputId: string): void {
  if (typeof outputId !== "string" || !OUTPUT_ID_PATTERN.test(outputId)) {
    throw new ProcessOutputNotFoundError();
  }
}

function boundedNonEmptyString(value: string, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new TypeError(`${name} must be a non-empty string of at most 2048 characters`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  return value;
}

function positiveBoundedInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

function assertSafeAddition(left: number, right: number, name: string): void {
  if (!Number.isSafeInteger(left + right)) throw new RangeError(`${name} exceeds the safe integer range`);
}

function inspectWriterLock(path: string): { pid?: number; processIdentity?: string; stats: BigIntStats } {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    const stats = fstatSync(descriptor, { bigint: true });
    assertSecureRegularFile(stats);
    const size = Number(stats.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > 4_096) {
      throw new ProcessOutputIntegrityError("Process output writer lock is invalid");
    }
    const buffer = Buffer.alloc(size);
    if (readSync(descriptor, buffer, 0, size, 0) !== size) {
      throw new ProcessOutputIntegrityError("Process output writer lock changed during read");
    }
    let pid: number | undefined;
    let processIdentity: string | undefined;
    try {
      const parsed = JSON.parse(buffer.toString("utf8")) as { pid?: unknown; processIdentity?: unknown };
      if (Number.isSafeInteger(parsed.pid) && Number(parsed.pid) > 0) pid = Number(parsed.pid);
      if (typeof parsed.processIdentity === "string" && parsed.processIdentity.length <= 512) {
        processIdentity = parsed.processIdentity;
      }
    } catch {
      // An invalid payload is treated as stale only after file identity is
      // checked again by the caller.
    }
    return { pid, processIdentity, stats };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writerLockSignature(stats: BigIntStats): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(":");
}

function retryWriterLockAcquisition(attempt: number): void {
  if (attempt + 1 >= WRITER_LOCK_ACQUIRE_ATTEMPTS) return;
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    0,
    0,
    WRITER_LOCK_RETRY_DELAY_MS,
  );
}

function processOwnsLock(pid: number, expectedIdentity: string | undefined): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EPERM") return false;
  }
  if (expectedIdentity === undefined) return true;
  const actualIdentity = processIdentity(pid);
  return actualIdentity === undefined || actualIdentity === expectedIdentity;
}

function processIdentity(pid: number): string | undefined {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closingParen = stat.lastIndexOf(")");
      if (closingParen < 0) return undefined;
      const fieldsAfterCommand = stat.slice(closingParen + 2).trim().split(/\s+/u);
      const startTicks = fieldsAfterCommand[19];
      return startTicks ? `linux:${startTicks}` : undefined;
    }
    if (process.platform === "darwin" || process.platform === "freebsd") {
      const started = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1_000,
      }).trim();
      return started ? `${process.platform}:${started}` : undefined;
    }
    if (process.platform === "win32") {
      const started = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2_000,
          windowsHide: true,
        },
      ).trim();
      return /^\d+$/u.test(started) ? `win32:${started}` : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
