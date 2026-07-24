import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  ProcessOutputIntegrityError,
  ProcessOutputNotFoundError,
  ProcessOutputStore,
} from "./process-output-store.js";

const root = mkdtempSync(join(tmpdir(), "devspace-process-output-test-"));

assert.equal(
  new ProcessOutputNotFoundError().message,
  "The retained process output is no longer available.",
);
assert.equal(new ProcessOutputNotFoundError().code, "process_output_not_found");

try {
  testPermissionsAndOwnership(join(root, "permissions"));
  testVersionTwoOwnershipMigration(join(root, "version-two-migration"));
  testWriterLock(join(root, "writer-lock"));
  testPagingReplayAndUtf8(join(root, "paging"));
  testFileQuotaAndDrops(join(root, "file-quota"));
  testUtf8QuotaBoundary(join(root, "utf8-quota"));
  testTotalQuota(join(root, "total-quota"));
  testExpiredQuotaReclamation(join(root, "quota-reclamation"));
  testRecordQuota(join(root, "record-quota"));
  testTtlAndBoundedCleanup(join(root, "ttl"));
  testRestartRecovery(join(root, "restart"));
  testCleanupIntentRecovery(join(root, "cleanup-restart"));
  testWorkspaceRetirement(join(root, "workspace-retirement"));
  testLiveCleanupIntentRecovery(join(root, "cleanup-live"));
  testAppendMetadataRollback(join(root, "append-rollback"));
  testOrphanCleanup(join(root, "orphan-cleanup"));
  testSymlinkMissingAndTamperDefense(join(root, "tamper"));
  testClose(join(root, "close"));
  testCloseFailures(join(root, "close-failures"));
} finally {
  rmSync(root, { recursive: true, force: true });
}

function testVersionTwoOwnershipMigration(stateDir: string): void {
  const outputDir = join(stateDir, "process-output");
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const outputId = "00000000-0000-4000-8000-000000000001";
  writeFileSync(logPath(stateDir, outputId), "legacy output", { mode: 0o600 });
  const fileStats = lstatSync(logPath(stateDir, outputId), { bigint: true });
  const database = new Database(join(outputDir, "metadata.sqlite"));
  try {
    database.exec(`
      create table process_outputs (
        output_id text primary key,
        owner_client_id text not null,
        workspace_id text not null,
        status text not null,
        created_at integer not null,
        updated_at integer not null,
        completed_at integer,
        total_bytes integer not null,
        stored_bytes integer not null,
        dropped_bytes integer not null,
        file_dev text not null,
        file_ino text not null
      ) without rowid;
      create table process_output_usage (
        id integer primary key,
        outputs integer not null,
        active_outputs integer not null,
        completed_outputs integer not null,
        total_bytes integer not null,
        stored_bytes integer not null,
        dropped_bytes integer not null
      );
      create table process_output_deletions (
        output_id text primary key references process_outputs(output_id) on delete cascade
      ) without rowid;
      pragma user_version = 2;
    `);
    database.prepare(`
      insert into process_outputs values (?, ?, ?, 'completed', 1, 2, 2, 13, 13, 0, ?, ?)
    `).run(outputId, "legacy-owner", "legacy-workspace", fileStats.dev.toString(), fileStats.ino.toString());
    database.prepare("insert into process_output_usage values (1, 1, 0, 1, 13, 13, 0)").run();
  } finally {
    database.close();
  }

  const migrated = createStore(stateDir, { now: () => 2 });
  try {
    assert.equal(
      migrated.read("legacy-owner", "legacy-workspace", outputId, { offset: 0, limit: 100 }).content,
      "legacy output",
    );
  } finally {
    migrated.close();
  }
  const migratedDatabase = new Database(join(outputDir, "metadata.sqlite"), { readonly: true });
  try {
    assert.equal(migratedDatabase.pragma("user_version", { simple: true }), 3);
    const columns = migratedDatabase.prepare("pragma table_info(process_outputs)").all() as Array<{ name: string }>;
    assert.equal(columns.some((column) => column.name === "connection_principal_id"), true);
    assert.equal(columns.some((column) => column.name === "owner_client_id"), false);
  } finally {
    migratedDatabase.close();
  }
}

function testPermissionsAndOwnership(stateDir: string): void {
  const store = createStore(stateDir);
  try {
    const outputId = store.create({ connectionPrincipalId: "owner-a", workspaceId: "workspace-a" });
    store.append(outputId, "private output");

    assert.equal(store.read("owner-a", "workspace-a", outputId, { offset: 0, limit: 100 }).content, "private output");
    assert.throws(
      () => store.read("owner-b", "workspace-a", outputId, { offset: 0, limit: 100 }),
      ProcessOutputNotFoundError,
    );
    assert.throws(
      () => store.metadata("owner-a", "workspace-b", outputId),
      ProcessOutputNotFoundError,
    );
    assert.throws(
      () => store.read("owner-a", "workspace-a", "../../etc/passwd", { offset: 0, limit: 100 }),
      ProcessOutputNotFoundError,
    );

    if (process.platform !== "win32") {
      assert.equal(lstatSync(stateDir).mode & 0o777, 0o700);
      assert.equal(lstatSync(join(stateDir, "process-output")).mode & 0o777, 0o700);
      assert.equal(lstatSync(join(stateDir, "process-output", "metadata.sqlite")).mode & 0o777, 0o600);
      assert.equal(lstatSync(logPath(stateDir, outputId)).mode & 0o777, 0o600);
    }
  } finally {
    store.close();
  }
}

function testWriterLock(stateDir: string): void {
  const first = createStore(stateDir);
  try {
    assert.throws(() => createStore(stateDir), /Another DevSpace process/);
  } finally {
    first.close();
  }
  const reopened = createStore(stateDir);
  reopened.close();

  const lockPath = join(stateDir, "process-output", "writer.lock");
  writeFileSync(lockPath, "", { mode: 0o600 });
  assert.throws(() => createStore(stateDir), /writer lock/);
  const staleTime = new Date(Date.now() - 2_000);
  utimesSync(lockPath, staleTime, staleTime);
  const afterPartialLock = createStore(stateDir);
  afterPartialLock.close();

  writeFileSync(lockPath, "{", { mode: 0o600 });
  assert.throws(() => createStore(stateDir), /writer lock/);
  utimesSync(lockPath, staleTime, staleTime);
  const afterMalformedLock = createStore(stateDir);
  afterMalformedLock.close();

  if (process.platform === "darwin" || process.platform === "linux" || process.platform === "freebsd") {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, processIdentity: "reused-pid" }), { mode: 0o600 });
    assert.throws(() => createStore(stateDir), /writer lock/);
    utimesSync(lockPath, staleTime, staleTime);
    const afterReusedPid = createStore(stateDir);
    afterReusedPid.close();
  }
}

function testPagingReplayAndUtf8(stateDir: string): void {
  const store = createStore(stateDir);
  try {
    const outputId = store.create({ connectionPrincipalId: "owner", workspaceId: "workspace" });
    store.append(outputId, "A€中B");
    store.append(outputId, Buffer.from([0xff, 0x43]));

    const first = store.read("owner", "workspace", outputId, { offset: 0, limit: 2 });
    assert.equal(first.content, "A€");
    assert.equal(first.offset, 0);
    assert.equal(first.nextOffset, 4);
    assert.equal(first.eof, false);
    assert.equal(first.status, "active");
    assert.deepEqual(store.read("owner", "workspace", outputId, { offset: 0, limit: 2 }), first);
    assert.throws(
      () => store.read("owner", "workspace", outputId, { offset: 2, limit: 2 }),
      /inside a UTF-8 character/,
    );

    const pages = [first];
    while (!pages.at(-1)!.eof) {
      pages.push(store.read("owner", "workspace", outputId, { offset: pages.at(-1)!.nextOffset, limit: 2 }));
    }
    assert.equal(pages.map((page) => page.content).join(""), "A€中B�C");
    assert.equal(pages.at(-1)!.nextOffset, Buffer.byteLength("A€中B") + 2);
    assert.throws(
      () => store.read("owner", "workspace", outputId, { offset: 0, limit: 1024 * 1024 + 1 }),
      /limit/,
    );
  } finally {
    store.close();
  }
}

function testFileQuotaAndDrops(stateDir: string): void {
  const store = createStore(stateDir, { maxFileBytes: 5, maxStorageBytes: 100 });
  try {
    const outputId = store.create({ connectionPrincipalId: "owner", workspaceId: "workspace" });
    store.append(outputId, "abc");
    store.append(outputId, "defg");
    store.append(outputId, Buffer.from([1, 2]));
    assert.deepEqual(store.metadata("owner", "workspace", outputId), {
      outputId,
      status: "active",
      createdAt: 0,
      updatedAt: 0,
      totalBytes: 9,
      storedBytes: 5,
      droppedBytes: 4,
    });
    assert.equal(readFileSync(logPath(stateDir, outputId), "utf8"), "abcde");
    assert.deepEqual(store.usageSnapshot(), {
      outputs: 1,
      activeOutputs: 1,
      completedOutputs: 0,
      totalBytes: 9,
      storedBytes: 5,
      droppedBytes: 4,
      maxStorageBytes: 100,
      availableBytes: 95,
    });
  } finally {
    store.close();
  }
}

function testUtf8QuotaBoundary(stateDir: string): void {
  const store = createStore(stateDir, { maxFileBytes: 2, maxStorageBytes: 100 });
  try {
    const outputId = store.create({ connectionPrincipalId: "owner", workspaceId: "workspace" });
    store.append(outputId, "€");
    store.append(outputId, "A");
    assert.deepEqual(store.metadata("owner", "workspace", outputId), {
      outputId,
      status: "active",
      createdAt: 0,
      updatedAt: 0,
      totalBytes: 4,
      storedBytes: 0,
      droppedBytes: 4,
    });
    assert.equal(store.read("owner", "workspace", outputId, { offset: 0, limit: 2 }).content, "");
  } finally {
    store.close();
  }
}

function testTotalQuota(stateDir: string): void {
  const store = createStore(stateDir, { maxFileBytes: 10, maxStorageBytes: 6 });
  try {
    const first = store.create({ connectionPrincipalId: "owner", workspaceId: "workspace" });
    const second = store.create({ connectionPrincipalId: "owner", workspaceId: "workspace" });
    store.append(first, "abcd");
    store.append(second, "wxyz");
    assert.equal(store.metadata("owner", "workspace", first).storedBytes, 4);
    assert.deepEqual(store.metadata("owner", "workspace", second), {
      outputId: second,
      status: "active",
      createdAt: 0,
      updatedAt: 0,
      totalBytes: 4,
      storedBytes: 2,
      droppedBytes: 2,
    });
    assert.equal(readFileSync(logPath(stateDir, second), "utf8"), "wx");
    assert.equal(store.usageSnapshot().storedBytes, 6);
    assert.equal(store.usageSnapshot().availableBytes, 0);
  } finally {
    store.close();
  }
}

function testExpiredQuotaReclamation(stateDir: string): void {
  let now = 0;
  const store = createStore(stateDir, {
    maxFileBytes: 10,
    maxStorageBytes: 6,
    completedTtlMs: 100,
    now: () => now,
  });
  try {
    const expired = store.create({ connectionPrincipalId: "owner", workspaceId: "workspace" });
    store.append(expired, "abcd");
    store.complete(expired);
    now = 101;
    const current = store.create({ connectionPrincipalId: "owner", workspaceId: "workspace" });
    store.append(current, "wxyz");
    assert.deepEqual(store.metadata("owner", "workspace", current), {
      outputId: current,
      status: "active",
      createdAt: 101,
      updatedAt: 101,
      totalBytes: 4,
      storedBytes: 4,
      droppedBytes: 0,
    });
    assert.equal(store.usageSnapshot().outputs, 1);
  } finally {
    store.close();
  }
}

function testRecordQuota(stateDir: string): void {
  const store = createStore(stateDir, { maxOutputs: 1 });
  try {
    store.create({ connectionPrincipalId: "owner", workspaceId: "workspace" });
    assert.throws(
      () => store.create({ connectionPrincipalId: "owner", workspaceId: "workspace" }),
      /record limit reached/,
    );
  } finally {
    store.close();
  }
}

function testTtlAndBoundedCleanup(stateDir: string): void {
  let now = 10;
  const store = createStore(stateDir, { completedTtlMs: 100, now: () => now });
  try {
    const first = store.create({ connectionPrincipalId: "owner", workspaceId: "workspace" });
    store.append(first, "a");
    store.complete(first);
    now = 20;
    const second = store.create({ connectionPrincipalId: "owner", workspaceId: "workspace" });
    store.append(second, "bb");
    store.complete(second);

    now = 50;
    assert.equal(store.read("owner", "workspace", first, { offset: 0, limit: 1 }).content, "a");
    now = 111;
    assert.throws(() => store.metadata("owner", "workspace", first), ProcessOutputNotFoundError);
    assert.equal(store.metadata("owner", "workspace", second).storedBytes, 2);
    assert.deepEqual(store.cleanupExpired(1), { deleted: 1, bytesReclaimed: 1 });
    assert.equal(store.usageSnapshot().outputs, 1);

    now = 121;
    assert.deepEqual(store.cleanupExpired(1), { deleted: 1, bytesReclaimed: 2 });
    assert.deepEqual(store.cleanupExpired(1), { deleted: 0, bytesReclaimed: 0 });

    now = 200;
    for (let index = 0; index < 3; index += 1) {
      const outputId = store.create({ connectionPrincipalId: "owner", workspaceId: "workspace" });
      store.complete(outputId);
    }
    now = 301;
    assert.equal(store.cleanupExpired(2).deleted, 2);
    assert.equal(store.usageSnapshot().outputs, 1);
    assert.equal(store.cleanupExpired(2).deleted, 1);
  } finally {
    store.close();
  }
}

function testRestartRecovery(stateDir: string): void {
  let now = 1_000;
  const firstStore = createStore(stateDir, { completedTtlMs: 50, now: () => now });
  const outputId = firstStore.create({ connectionPrincipalId: "owner", workspaceId: "workspace" });
  firstStore.append(outputId, "survives restart");
  firstStore.close();
  appendFileSync(logPath(stateDir, outputId), "uncommitted trailing bytes");

  now = 2_000;
  const restoredStore = createStore(stateDir, { completedTtlMs: 50, now: () => now });
  try {
    const metadata = restoredStore.metadata("owner", "workspace", outputId);
    assert.equal(metadata.status, "unknown");
    assert.equal(metadata.completedAt, 2_000);
    const restoredPage = restoredStore.read("owner", "workspace", outputId, { offset: 0, limit: 100 });
    assert.equal(restoredPage.content, "survives restart");
    assert.equal(restoredPage.status, "unknown");
    assert.equal(readFileSync(logPath(stateDir, outputId), "utf8"), "survives restart");
    assert.throws(() => restoredStore.append(outputId, "more"), /completed/);
    assert.deepEqual(restoredStore.usageSnapshot(), {
      outputs: 1,
      activeOutputs: 0,
      completedOutputs: 1,
      totalBytes: 16,
      storedBytes: 16,
      droppedBytes: 0,
      maxStorageBytes: 10_000,
      availableBytes: 9_984,
    });
    now = 2_051;
    assert.equal(restoredStore.cleanupExpired().deleted, 1);
  } finally {
    restoredStore.close();
  }
}

function testCleanupIntentRecovery(stateDir: string): void {
  const firstStore = createStore(stateDir);
  const outputId = firstStore.create({ connectionPrincipalId: "owner", workspaceId: "workspace" });
  firstStore.append(outputId, "pending deletion");
  firstStore.complete(outputId);
  firstStore.close();

  const database = new Database(join(stateDir, "process-output", "metadata.sqlite"));
  try {
    database.pragma("foreign_keys = ON");
    database.prepare("insert into process_output_deletions (output_id) values (?)").run(outputId);
  } finally {
    database.close();
  }
  unlinkSync(logPath(stateDir, outputId));

  const restoredStore = createStore(stateDir);
  try {
    assert.equal(restoredStore.usageSnapshot().outputs, 0);
    assert.throws(() => restoredStore.metadata("owner", "workspace", outputId), ProcessOutputNotFoundError);
  } finally {
    restoredStore.close();
  }
}

function testWorkspaceRetirement(stateDir: string): void {
  const firstStore = createStore(stateDir);
  const active = firstStore.create({ connectionPrincipalId: "owner", workspaceId: "retired" });
  firstStore.append(active, "active output");
  const completed = firstStore.create({ connectionPrincipalId: "owner", workspaceId: "retired" });
  firstStore.append(completed, "completed output");
  firstStore.complete(completed);
  const retained = firstStore.create({ connectionPrincipalId: "owner", workspaceId: "other" });
  firstStore.append(retained, "keep");
  firstStore.close();

  const restarted = createStore(stateDir);
  try {
    assert.deepEqual(restarted.retireWorkspace("owner", "retired"), {
      deleted: 2,
      bytesReclaimed: Buffer.byteLength("active outputcompleted output"),
    });
    assert.deepEqual(restarted.retireWorkspace("owner", "retired"), {
      deleted: 0,
      bytesReclaimed: 0,
    });
    assert.equal(existsSync(logPath(stateDir, active)), false);
    assert.equal(existsSync(logPath(stateDir, completed)), false);
    assert.equal(restarted.read("owner", "other", retained, { offset: 0, limit: 10 }).content, "keep");
    assert.deepEqual(restarted.usageSnapshot(), {
      outputs: 1,
      activeOutputs: 0,
      completedOutputs: 1,
      totalBytes: 4,
      storedBytes: 4,
      droppedBytes: 0,
      maxStorageBytes: 10_000,
      availableBytes: 9_996,
    });
  } finally {
    restarted.close();
  }
}

function testLiveCleanupIntentRecovery(stateDir: string): void {
  let now = 0;
  const store = createStore(stateDir, { completedTtlMs: 10, maxOutputs: 1, now: () => now });
  try {
    const outputId = store.create({ connectionPrincipalId: "owner", workspaceId: "workspace" });
    store.append(outputId, "pending deletion");
    store.complete(outputId);
    const database = (store as unknown as { database: Database.Database }).database;
    database.prepare("insert into process_output_deletions (output_id) values (?)").run(outputId);
    unlinkSync(logPath(stateDir, outputId));
    now = 11;
    const replacement = store.create({ connectionPrincipalId: "owner", workspaceId: "workspace" });
    assert.equal(store.usageSnapshot().outputs, 1);
    assert.equal(store.metadata("owner", "workspace", replacement).storedBytes, 0);
  } finally {
    store.close();
  }
}

function testAppendMetadataRollback(stateDir: string): void {
  const store = createStore(stateDir);
  try {
    const outputId = store.create({ connectionPrincipalId: "owner", workspaceId: "workspace" });
    store.append(outputId, "committed");
    const database = (store as unknown as { database: Database.Database }).database;
    database.exec(`
      create trigger reject_process_output_update
      before update on process_outputs
      begin
        select raise(abort, 'injected metadata failure');
      end;
    `);
    assert.throws(() => store.append(outputId, "uncommitted"), /injected metadata failure/);
    assert.equal(readFileSync(logPath(stateDir, outputId), "utf8"), "committed");
    assert.equal(store.metadata("owner", "workspace", outputId).storedBytes, 9);
    database.exec("drop trigger reject_process_output_update");
    store.append(outputId, "-ok");
    assert.equal(readFileSync(logPath(stateDir, outputId), "utf8"), "committed-ok");
  } finally {
    store.close();
  }
}

function testOrphanCleanup(stateDir: string): void {
  const first = createStore(stateDir);
  first.close();
  const orphanId = "00000000-0000-4000-8000-000000000000";
  const orphanPath = logPath(stateDir, orphanId);
  writeFileSync(orphanPath, "orphan", { mode: 0o600 });
  const restored = createStore(stateDir);
  try {
    assert.equal(existsSync(orphanPath), false);
  } finally {
    restored.close();
  }
}

function testSymlinkMissingAndTamperDefense(stateDir: string): void {
  const store = createStore(stateDir);
  try {
    const symlinked = store.create({ connectionPrincipalId: "owner", workspaceId: "workspace" });
    store.append(symlinked, "secret");
    const original = `${logPath(stateDir, symlinked)}.original`;
    const outside = join(stateDir, "outside.log");
    writeFileSync(outside, "secret", { mode: 0o600 });
    renameSync(logPath(stateDir, symlinked), original);
    symlinkSync(outside, logPath(stateDir, symlinked));
    assert.throws(
      () => store.read("owner", "workspace", symlinked, { offset: 0, limit: 100 }),
      ProcessOutputIntegrityError,
    );
    assert.equal(readFileSync(outside, "utf8"), "secret");

    const missing = store.create({ connectionPrincipalId: "owner", workspaceId: "workspace" });
    unlinkSync(logPath(stateDir, missing));
    assert.throws(() => store.metadata("owner", "workspace", missing), ProcessOutputIntegrityError);

    const replaced = store.create({ connectionPrincipalId: "owner", workspaceId: "workspace" });
    store.append(replaced, "same");
    unlinkSync(logPath(stateDir, replaced));
    writeFileSync(logPath(stateDir, replaced), "same", { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(logPath(stateDir, replaced), 0o600);
    assert.throws(
      () => store.read("owner", "workspace", replaced, { offset: 0, limit: 100 }),
      ProcessOutputIntegrityError,
    );
  } finally {
    store.close();
  }
}

function testClose(stateDir: string): void {
  const store = createStore(stateDir);
  const outputId = store.create({ connectionPrincipalId: "owner", workspaceId: "workspace" });
  store.close();
  store.close();
  assert.throws(() => store.append(outputId, "closed"), /closed/);
  assert.throws(() => store.usageSnapshot(), /closed/);
}

function testCloseFailures(stateDir: string): void {
  const store = createStore(stateDir);
  const internals = store as unknown as {
    database: Database.Database;
    releaseWriterLock(): void;
  };
  const database = internals.database;
  const closeDatabase = database.close.bind(database);
  const releaseWriterLock = internals.releaseWriterLock.bind(store);
  const databaseCloseError = new Error("injected database close failure");
  const lockReleaseError = new Error("injected writer lock release failure");

  database.close = () => {
    throw databaseCloseError;
  };
  internals.releaseWriterLock = () => {
    throw lockReleaseError;
  };

  try {
    assert.throws(
      () => store.close(),
      (error: unknown) => {
        assert(error instanceof AggregateError);
        assert.match(error.message, /database and release its writer lock/);
        assert.deepEqual(error.errors, [databaseCloseError, lockReleaseError]);
        return true;
      },
    );
    assert.throws(() => store.usageSnapshot(), /closed/);
    assert.doesNotThrow(() => store.close());
  } finally {
    database.close = closeDatabase;
    closeDatabase();
    releaseWriterLock();
  }
}

function createStore(
  stateDir: string,
  overrides: Partial<ConstructorParameters<typeof ProcessOutputStore>[0]> = {},
): ProcessOutputStore {
  return new ProcessOutputStore({
    stateDir,
    maxFileBytes: 10_000,
    maxStorageBytes: 10_000,
    completedTtlMs: 1_000,
    now: () => 0,
    ...overrides,
  });
}

function logPath(stateDir: string, outputId: string): string {
  return join(stateDir, "process-output", `${outputId}.log`);
}
