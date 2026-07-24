import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { DEVSPACE_CAPABILITY_SCOPES } from "../oauth-scopes.js";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "./canonical-schema.js";
import { prepareDatabaseFile } from "./migrations.js";

const root = mkdtempSync(join(tmpdir(), "devspace-v14-migrations-"));

try {
  for (const version of [1, 4, 5, 7, 8, 10, 11, 13]) {
    testHistoricalVersion(version);
  }
  testAmbiguousOwnershipIsAtomic();
} finally {
  rmSync(root, { recursive: true, force: true });
}

function testHistoricalVersion(version: number): void {
  const directory = join(root, `v${version}`);
  const project = join(directory, "project");
  const databasePath = join(directory, "devspace.sqlite");
  mkdirSync(project, { recursive: true });
  createHistoricalDatabase(databasePath, version, project);

  const preparation = prepareDatabaseFile(databasePath);
  assert.equal(preparation.migrated, true);
  assert.equal(preparation.sourceVersion, version);
  assert.ok(preparation.backupPath);
  assert.equal(existsSync(preparation.backupPath), true);

  const database = new Database(databasePath, { readonly: true });
  try {
    assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    assert.deepEqual(
      database.prepare("select version, name from devspace_schema_migrations").all(),
      [{ version: CURRENT_DATABASE_SCHEMA_VERSION, name: "canonical-state-v14" }],
    );
    const columns = database.prepare("pragma table_info(workspace_sessions)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    assert.equal(columns.some((column) => column.name === "connection_principal_id"), true);
    assert.equal(columns.some((column) => column.name === "owner_client_id"), false);
    assert.equal(columns.find((column) => column.name === "alias")?.notnull, 1);

    const workspace = database.prepare(`
      select
        id,
        connection_principal_id as principalId,
        alias,
        canonical_root as canonicalRoot,
        status,
        write_access as writeAccess,
        state_generation as stateGeneration
      from workspace_sessions
    `).get() as {
      id: string;
      principalId: string;
      alias: string;
      canonicalRoot: string | null;
      status: string;
      writeAccess: string;
      stateGeneration: number;
    };
    assert.equal(workspace.id, `workspace-v${version}`);
    assert.equal(workspace.principalId, version >= 11 ? "principal-a" : "client-a");
    assert.match(workspace.alias, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
    assert.equal(workspace.canonicalRoot, realpathSync(project));
    assert.equal(workspace.status, "active");
    assert.equal(workspace.writeAccess, "read_write");
    assert.equal(workspace.stateGeneration, version >= 7 ? 7 : 1);

    if (version === 7) {
      const result = JSON.parse(database.prepare(
        "select result_json from mutation_operations where operation_id = 'operation-v7'",
      ).pluck().get() as string) as { structuredContent?: Record<string, unknown> };
      assert.deepEqual(result.structuredContent, { value: 1 });
    }

    if (version === 10) {
      assert.deepEqual(
        database.prepare(`
          select status, claim_token as claimToken, lease_expires_at as leaseExpiresAt
          from oauth_revocation_cleanup_jobs
        `).get(),
        { status: "pending", claimToken: null, leaseExpiresAt: null },
      );
    }

    if (version === 11) {
      const scopes = JSON.parse(database.prepare(
        "select scopes_json from oauth_access_tokens where token_hash = 'legacy-full-token'",
      ).pluck().get() as string);
      assert.deepEqual(scopes, [...DEVSPACE_CAPABILITY_SCOPES]);
      assert.equal(
        database.prepare(
          "select count(*) from oauth_access_tokens where token_hash = 'invalid-token'",
        ).pluck().get(),
        0,
      );
    }
  } finally {
    database.close();
  }

  assert.deepEqual(prepareDatabaseFile(databasePath), {
    migrated: false,
    sourceVersion: CURRENT_DATABASE_SCHEMA_VERSION,
  });
}

function testAmbiguousOwnershipIsAtomic(): void {
  const directory = join(root, "ambiguous");
  const project = join(directory, "project");
  const databasePath = join(directory, "devspace.sqlite");
  mkdirSync(project, { recursive: true });
  createHistoricalDatabase(databasePath, 11, project, { ambiguous: true });
  const before = fileHash(databasePath);

  assert.throws(
    () => prepareDatabaseFile(databasePath),
    /legacy ownership is ambiguous across 2 active connection principals/,
  );
  assert.equal(fileHash(databasePath), before);
  assert.equal(
    readdirSync(directory).some((name) => name.includes("v14-migrating") || name.includes("pre-v14")),
    false,
  );
}

function createHistoricalDatabase(
  path: string,
  version: number,
  project: string,
  options: { ambiguous?: boolean } = {},
): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const database = new Database(path);
  const ownerColumn = version >= 4 ? "owner_client_id text," : "";
  const canonicalColumn = version >= 5 ? "canonical_root text," : "";
  const resumeColumns = version >= 7
    ? "alias text, write_access text, state_generation integer,"
    : "";
  const principalColumn = version >= 11 ? "principal_id text," : "";
  try {
    database.exec(`
      create table devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
      insert into devspace_schema_migrations values (${version}, 'historical-v${version}', '2026-01-01T00:00:00.000Z');

      create table oauth_clients (
        client_id text primary key,
        ${principalColumn}
        client_json text not null,
        issued_at integer not null
      );

      create table workspace_sessions (
        id text primary key,
        ${ownerColumn}
        ${canonicalColumn}
        ${resumeColumns}
        root text not null,
        status text,
        mode text,
        source_root text,
        base_ref text,
        base_sha text,
        dirty_source text,
        managed text,
        created_at text,
        last_used_at text
      );
    `);

    if (version >= 11) {
      database.exec(`
        create table connection_principals (
          principal_id text primary key,
          created_at text not null,
          last_used_at text not null,
          revoked_at text
        );
      `);
      database.prepare("insert into connection_principals values (?, ?, ?, null)")
        .run("principal-a", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
      if (options.ambiguous) {
        database.prepare("insert into connection_principals values (?, ?, ?, null)")
          .run("principal-b", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
      }
      database.prepare("insert into oauth_clients values (?, ?, ?, ?)")
        .run("client-a", "principal-a", JSON.stringify({ redirect_uris: ["https://chatgpt.com/callback"] }), 1);
    } else {
      database.prepare("insert into oauth_clients values (?, ?, ?)")
        .run("client-a", JSON.stringify({ redirect_uris: ["https://chatgpt.com/callback"] }), 1);
    }

    const columns = database.prepare("pragma table_info(workspace_sessions)").all() as Array<{ name: string }>;
    const values: Record<string, unknown> = {
      id: `workspace-v${version}`,
      owner_client_id: options.ambiguous
        ? "__legacy_unowned__"
        : version >= 11
          ? "principal-a"
          : "client-a",
      canonical_root: version >= 5 ? project : null,
      alias: version >= 7 ? "bad alias" : null,
      write_access: version >= 7 ? "read_write" : null,
      state_generation: version >= 7 ? 7 : null,
      root: project,
      status: "active",
      mode: "checkout",
      source_root: null,
      base_ref: null,
      base_sha: null,
      dirty_source: "false",
      managed: "false",
      created_at: "2026-01-01T00:00:00.000Z",
      last_used_at: "2026-01-01T00:00:00.000Z",
    };
    const names = columns.map((column) => column.name);
    database.prepare(`
      insert into workspace_sessions (${names.join(", ")})
      values (${names.map((name) => `@${name}`).join(", ")})
    `).run(Object.fromEntries(names.map((name) => [name, values[name]])));

    if (version === 7) createVersionSevenOperation(database);
    if (version === 10) createVersionTenCleanup(database);
    if (version === 11) createVersionElevenTokens(database);
  } finally {
    database.close();
  }
}

function createVersionSevenOperation(database: Database.Database): void {
  database.exec(`
    create table mutation_operations (
      owner_client_id text not null,
      workspace_id text not null,
      tool text not null,
      operation_id text not null,
      request_hash text not null,
      state text not null,
      result_json text,
      created_at text not null,
      updated_at text not null,
      expires_at text not null
    );
  `);
  database.prepare("insert into mutation_operations values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "client-a",
    "workspace-v7",
    "apply_patch",
    "operation-v7",
    "request-hash",
    "settled",
    JSON.stringify({
      structuredContent: {
        receipt: "wctx3.expired",
        continuation: { receipt: "wctx3.expired" },
        workspaceGeneration: 7,
        safeToRetry: false,
        value: 1,
      },
    }),
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:01.000Z",
    "2099-01-01T00:00:00.000Z",
  );
}

function createVersionTenCleanup(database: Database.Database): void {
  database.exec(`
    create table oauth_revocation_cleanup_jobs (
      id integer primary key,
      owner_client_id text not null,
      workspace_id text not null,
      workspace_root text not null,
      workspace_mode text not null,
      source_root text,
      managed text not null,
      dirty_source text not null,
      status text not null,
      claim_token text,
      lease_expires_at text,
      attempts integer not null,
      last_error text,
      created_at text not null,
      updated_at text not null,
      completed_at text
    );
    insert into oauth_revocation_cleanup_jobs values (
      1, 'client-a', 'workspace-v10', '/workspace', 'checkout', null,
      'false', 'false', 'claimed', 'old-claim', '2099-01-01T00:00:00.000Z',
      2, null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z', null
    );
  `);
}

function createVersionElevenTokens(database: Database.Database): void {
  database.exec(`
    create table oauth_access_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text
    );
    create table oauth_refresh_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text
    );
  `);
  const insert = database.prepare("insert into oauth_access_tokens values (?, 'client-a', ?, 4102444800, null)");
  insert.run("legacy-full-token", JSON.stringify(["devspace"]));
  insert.run("invalid-token", JSON.stringify(["admin"]));
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

console.log("canonical v14 migration matrix passed");
