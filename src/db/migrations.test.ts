import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import {
  CURRENT_DATABASE_SCHEMA_NAME,
  CURRENT_DATABASE_SCHEMA_VERSION,
  OWNER_PRINCIPAL_ID,
} from "./canonical-schema.js";
import { prepareDatabaseFile } from "./migrations.js";

const root = mkdtempSync(join(tmpdir(), "devspace-v25-migrations-"));

try {
  for (const version of [1, 4, 5, 7, 8, 10, 11, 13, 14]) {
    testHistoricalVersion(version);
  }
  testVersionFifteenFailsClosedAuthorization();
  testVersionSixteenDoesNotPromoteClientIdToPrincipal();
  testVersionTwentyPreservesAuthorizationAndClosesLegacyRuntime();
  testVersionTwentyOneQuarantinesIsolatedProjectExecutions();
  testVersionTwentyTwoPreservesMultipleActiveGrants();
  testVersionTwentyFourAddsProjectHandoffs();
  testExplicitLegacyOwnershipCollapses();
  testVersionEighteenCollapsesMultiplePrincipals();
  testVersionNineteenQuarantinesWorktreesWithoutTouchingFilesystem();
  for (const state of ["pending", "outcome_unknown"] as const) {
    testVersionNineteenRefusesUnresolvedWorktreeMutation(state);
  }
  testVersionNineteenQuarantinesExpiredUnresolvedWorktreeMutation();
} finally {
  rmSync(root, { recursive: true, force: true });
}

function testVersionTwentyOneQuarantinesIsolatedProjectExecutions(): void {
  const directory = join(root, "v21-project-inventory");
  const databasePath = join(directory, "devspace.sqlite");
  mkdirSync(directory, { recursive: true });
  const source = new Database(databasePath);
  try {
    source.pragma("foreign_keys = ON");
    source.exec(`
      create table devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
      insert into devspace_schema_migrations values (
        21, 'canonical-state-v21-project-worktrees', '2026-01-01T00:00:00.000Z'
      );
      create table connection_principals (
        principal_id text primary key,
        created_at text not null,
        last_used_at text not null,
        revoked_at text
      );
      insert into connection_principals values (
        'owner', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', null
      );
      create table oauth_clients (
        client_id text primary key,
        client_json text not null,
        issued_at integer not null
      );
      insert into oauth_clients values ('client-v21', '{}', 1);
      create table oauth_grants (
        grant_id text primary key,
        client_id text not null,
        principal_id text not null,
        granted_scopes_json text not null,
        allowed_root_ids_json text not null,
        authorization_epoch integer not null,
        absolute_expires_at integer,
        created_at text not null,
        last_used_at text not null,
        revoked_at text,
        foreign key (client_id) references oauth_clients(client_id) on delete cascade,
        unique (grant_id, principal_id, client_id)
      );
      insert into oauth_grants values (
        'grant-v21', 'client-v21', 'owner', '["project:read"]', '["*"]', 3, null,
        '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null
      );
      create table project_executions (
        execution_id text primary key,
        principal_id text not null,
        client_id text not null,
        grant_id text not null,
        authorization_epoch integer not null,
        project_ref text not null,
        project_fingerprint text not null,
        source_root text not null,
        canonical_source_root text not null,
        git_root text not null,
        worktree_root text,
        project_root text,
        base_sha text,
        branch_ref text,
        dirty_source text not null,
        workspace_id text,
        status text not null,
        state_generation integer not null,
        create_operation_id text not null,
        request_hash text not null,
        error text,
        created_at text not null,
        last_used_at text not null,
        updated_at text not null,
        foreign key (client_id) references oauth_clients(client_id) on delete cascade,
        foreign key (grant_id, principal_id, client_id)
          references oauth_grants(grant_id, principal_id, client_id) on delete cascade
      );
      insert into project_executions values (
        'execution-v21', 'owner', 'client-v21', 'grant-v21', 3,
        'project-v21', 'fingerprint-v21', '/tmp/source-v21', '/tmp/source-v21',
        '/tmp/source-v21', '/tmp/worktree-v21', '/tmp/worktree-v21',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'refs/heads/devspace/execution-v21', 'false', null, 'active', 2,
        'create-v21', 'request-v21', null,
        '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z'
      );
      insert into project_executions values (
        'execution-managed-branch-v21', 'owner', 'client-v21', 'grant-v21', 3,
        'project-managed-branch-v21', 'fingerprint-managed-branch-v21',
        '/tmp/source-v21', '/tmp/source-v21',
        '/tmp/managed-branch-v21', null, '/tmp/managed-branch-v21',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'refs/heads/devspace/execution-managed-branch-v21', 'false', null,
        'provisioning', 1, 'create-managed-branch-v21',
        'request-managed-branch-v21', null,
        '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z'
      );
      insert into project_executions values (
        'execution-git-root-v21', 'owner', 'client-v21', 'grant-v21', 3,
        'project-git-root-v21', 'fingerprint-git-root-v21',
        '/tmp/source-v21', '/tmp/source-v21',
        '/tmp/git-worktree-v21', null, '/tmp/git-worktree-v21',
        'cccccccccccccccccccccccccccccccccccccccc',
        null, 'false', null, 'active', 1, 'create-git-root-v21',
        'request-git-root-v21', null,
        '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z'
      );
      insert into project_executions values (
        'execution-direct-v21', 'owner', 'client-v21', 'grant-v21', 3,
        'project-direct-v21', 'fingerprint-direct-v21',
        '/tmp/source-v21/nested', '/tmp/source-v21/nested',
        '/tmp/source-v21', null, '/tmp/source-v21/nested',
        'dddddddddddddddddddddddddddddddddddddddd',
        'refs/heads/topic', 'false', null, 'active', 1,
        'create-direct-v21', 'request-direct-v21', null,
        '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z'
      );
    `);
  } finally {
    source.close();
  }

  const preparation = prepareDatabaseFile(databasePath);
  assert.equal(preparation.migrated, true);
  assert.equal(preparation.sourceVersion, 21);
  const migrated = new Database(databasePath);
  try {
    migrated.pragma("foreign_keys = ON");
    assert.deepEqual(migrated.prepare(`
      select execution_id as executionId, status,
        canonical_source_root as canonicalSourceRoot,
        workspace_id as workspaceId, error
      from project_executions
      order by execution_id
    `).all(), [
      {
        executionId: "execution-direct-v21",
        status: "active",
        canonicalSourceRoot: "/tmp/source-v21/nested",
        workspaceId: null,
        error: null,
      },
      {
        executionId: "execution-git-root-v21",
        status: "quarantined",
        canonicalSourceRoot: "/tmp/source-v21",
        workspaceId: null,
        error: "Legacy isolated-worktree execution cannot resume under the shared Project runtime. " +
          "Open the Project again with a new project_control operation.",
      },
      {
        executionId: "execution-managed-branch-v21",
        status: "quarantined",
        canonicalSourceRoot: "/tmp/source-v21",
        workspaceId: null,
        error: "Legacy isolated-worktree execution cannot resume under the shared Project runtime. " +
          "Open the Project again with a new project_control operation.",
      },
      {
        executionId: "execution-v21",
        status: "quarantined",
        canonicalSourceRoot: "/tmp/source-v21",
        workspaceId: null,
        error: "Legacy isolated-worktree execution cannot resume under the shared Project runtime. " +
          "Open the Project again with a new project_control operation.",
      },
    ]);
    assert.deepEqual(migrated.prepare(`
      select legacy_workspace_id as legacyWorkspaceId,
        workspace_root as workspaceRoot, source_root as sourceRoot,
        base_ref as baseRef, base_sha as baseSha, dirty_source as dirtySource,
        managed, previous_status as previousStatus, reason
      from legacy_managed_worktree_artifacts
      where reason like 'Legacy isolated Project execution %'
      order by legacy_workspace_id
    `).all(), [
      {
        legacyWorkspaceId: "execution-git-root-v21",
        workspaceRoot: "/tmp/git-worktree-v21",
        sourceRoot: "/tmp/source-v21",
        baseRef: null,
        baseSha: "cccccccccccccccccccccccccccccccccccccccc",
        dirtySource: "false",
        managed: "true",
        previousStatus: "active",
        reason: "Legacy isolated Project execution execution-git-root-v21 " +
          "(active) quarantined during the shared-Project migration.",
      },
      {
        legacyWorkspaceId: "execution-managed-branch-v21",
        workspaceRoot: "/tmp/managed-branch-v21",
        sourceRoot: "/tmp/source-v21",
        baseRef: "refs/heads/devspace/execution-managed-branch-v21",
        baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        dirtySource: "false",
        managed: "true",
        previousStatus: "active",
        reason: "Legacy isolated Project execution execution-managed-branch-v21 " +
          "(provisioning) quarantined during the shared-Project migration.",
      },
      {
        legacyWorkspaceId: "execution-v21",
        workspaceRoot: "/tmp/worktree-v21",
        sourceRoot: "/tmp/source-v21",
        baseRef: "refs/heads/devspace/execution-v21",
        baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        dirtySource: "false",
        managed: "true",
        previousStatus: "active",
        reason: "Legacy isolated Project execution execution-v21 " +
          "(active) quarantined during the shared-Project migration.",
      },
    ]);
    const executionColumns = migrated.prepare(
      "select name from pragma_table_info('project_executions')",
    ).pluck().all() as string[];
    for (const removed of [
      "git_root",
      "worktree_root",
      "project_root",
      "base_sha",
      "branch_ref",
      "dirty_source",
    ]) {
      assert.equal(executionColumns.includes(removed), false);
    }
    const foreignTables = migrated.prepare(
      "select distinct \"table\" as tableName from pragma_foreign_key_list('project_executions')",
    ).pluck().all() as string[];
    assert.equal(foreignTables.includes("oauth_clients"), false);
    assert.equal(foreignTables.includes("oauth_grants"), false);
    migrated.prepare("delete from oauth_clients where client_id = 'client-v21'").run();
    assert.equal(
      migrated.prepare(
        "select count(*) from project_executions where client_id = 'client-v21'",
      ).pluck().get(),
      4,
    );
  } finally {
    migrated.close();
  }
}

function testVersionTwentyTwoPreservesMultipleActiveGrants(): void {
  const directory = join(root, "v22-multiple-active-grants");
  const databasePath = join(directory, "devspace.sqlite");
  mkdirSync(directory, { recursive: true });
  const source = new Database(databasePath);
  try {
    source.exec(`
      create table devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
      insert into devspace_schema_migrations values (
        22, 'canonical-state-v22-durable-project-inventory',
        '2026-01-01T00:00:00.000Z'
      );
      create table connection_principals (
        principal_id text primary key,
        created_at text not null,
        last_used_at text not null,
        revoked_at text
      );
      insert into connection_principals values (
        'owner', '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z', null
      );
      create table oauth_clients (
        client_id text primary key,
        client_json text not null,
        issued_at integer not null
      );
      insert into oauth_clients values ('client-v22', '{}', 1);
      create table oauth_grants (
        grant_id text primary key,
        client_id text not null,
        principal_id text not null,
        granted_scopes_json text not null,
        allowed_root_ids_json text not null,
        authorization_epoch integer not null,
        absolute_expires_at integer,
        created_at text not null,
        last_used_at text not null,
        revoked_at text,
        unique (grant_id, principal_id, client_id)
      );
      insert into oauth_grants values (
        'grant-v22-a', 'client-v22', 'owner', '["project:read"]', '["root-a"]',
        2, null, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null
      );
      insert into oauth_grants values (
        'grant-v22-b', 'client-v22', 'owner', '["project:write"]', '["root-b"]',
        7, null, '2026-01-03T00:00:00.000Z', '2026-01-04T00:00:00.000Z', null
      );
      insert into oauth_grants values (
        'grant-v22-bad-scopes', 'client-v22', 'owner', '{broken', '["root-a"]',
        1, null, '2026-01-03T00:00:00.000Z', '2026-01-04T00:00:00.000Z', null
      );
      insert into oauth_grants values (
        'grant-v22-bad-roots', 'client-v22', 'owner', '["project:read"]', '{broken',
        1, null, '2026-01-03T00:00:00.000Z', '2026-01-04T00:00:00.000Z', null
      );
      insert into oauth_grants values (
        'grant-v22-legacy-scope', 'client-v22', 'owner', '["devspace"]', '["root-a"]',
        1, null, '2026-01-03T00:00:00.000Z', '2026-01-04T00:00:00.000Z', null
      );
      create table oauth_access_tokens (
        token_hash text primary key,
        grant_id text not null,
        client_id text not null,
        principal_id text not null,
        authorization_epoch integer not null,
        scopes_json text not null,
        expires_at integer not null,
        resource text
      );
      insert into oauth_access_tokens values (
        'access-v22-a', 'grant-v22-a', 'client-v22', 'owner', 2,
        '["project:read"]', 4102444800, null
      );
      insert into oauth_access_tokens values (
        'access-v22-b', 'grant-v22-b', 'client-v22', 'owner', 7,
        '["project:write"]', 4102444800, null
      );
      insert into oauth_access_tokens values (
        'access-v22-stale-epoch', 'grant-v22-a', 'client-v22', 'owner', 1,
        '["project:read"]', 4102444800, null
      );
      insert into oauth_access_tokens values (
        'access-v22-wrong-principal', 'grant-v22-a', 'client-v22', 'other', 2,
        '["project:read"]', 4102444800, null
      );
      insert into oauth_access_tokens values (
        'access-v22-excess-scope', 'grant-v22-a', 'client-v22', 'owner', 2,
        '["project:write"]', 4102444800, null
      );
      insert into oauth_access_tokens values (
        'access-v22-dropped-grant', 'grant-v22-bad-scopes', 'client-v22', 'owner', 1,
        '["project:read"]', 4102444800, null
      );
      insert into oauth_access_tokens values (
        'access-v22-legacy-scope', 'grant-v22-legacy-scope', 'client-v22', 'owner', 1,
        '["devspace"]', 4102444800, null
      );
    `);
  } finally {
    source.close();
  }

  const preparation = prepareDatabaseFile(databasePath);
  assert.equal(preparation.migrated, true);
  assert.equal(preparation.sourceVersion, 22);

  const migrated = new Database(databasePath, { readonly: true });
  try {
    assert.deepEqual(migrated.prepare(`
      select grant_id as grantId, client_id as clientId,
        authorization_epoch as authorizationEpoch, revoked_at as revokedAt
      from oauth_grants
      order by grant_id
    `).all(), [
      {
        grantId: "grant-v22-a",
        clientId: "client-v22",
        authorizationEpoch: 2,
        revokedAt: null,
      },
      {
        grantId: "grant-v22-b",
        clientId: "client-v22",
        authorizationEpoch: 7,
        revokedAt: null,
      },
    ]);
    assert.deepEqual(migrated.prepare(`
      select token_hash as tokenHash, grant_id as grantId
      from oauth_access_tokens
      order by token_hash
    `).all(), [
      { tokenHash: "access-v22-a", grantId: "grant-v22-a" },
      { tokenHash: "access-v22-b", grantId: "grant-v22-b" },
    ]);
    assert.equal(
      migrated.prepare(`
        select count(*) from sqlite_master
        where type = 'index' and name = 'oauth_grants_single_active_uq'
      `).pluck().get(),
      0,
    );
  } finally {
    migrated.close();
  }
}

function testVersionTwentyFourAddsProjectHandoffs(): void {
  const directory = join(root, "v24-project-handoffs");
  const databasePath = join(directory, "devspace.sqlite");
  mkdirSync(directory, { recursive: true });
  const source = new Database(databasePath);
  try {
    source.pragma("foreign_keys = ON");
    source.exec(`
      create table devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
      insert into devspace_schema_migrations values (
        24, 'canonical-state-v24-shared-projects',
        '2026-07-30T00:00:00.000Z'
      );
      create table connection_principals (
        principal_id text primary key,
        created_at text not null,
        last_used_at text not null,
        revoked_at text
      );
      insert into connection_principals values (
        'owner', '2026-07-30T00:00:00.000Z',
        '2026-07-30T00:00:00.000Z', null
      );
      create table oauth_clients (
        client_id text primary key,
        client_json text not null,
        issued_at integer not null
      );
      insert into oauth_clients values ('client-v24', '{}', 1);
      create table oauth_grants (
        grant_id text primary key,
        client_id text not null,
        principal_id text not null,
        granted_scopes_json text not null,
        allowed_root_ids_json text not null,
        authorization_epoch integer not null,
        absolute_expires_at integer,
        created_at text not null,
        last_used_at text not null,
        revoked_at text
      );
      insert into oauth_grants values (
        'grant-v24', 'client-v24', 'owner', '["project:read"]', '["*"]',
        4, null, '2026-07-30T00:00:00.000Z',
        '2026-07-30T00:00:00.000Z', null
      );
      create table project_executions (
        execution_id text primary key,
        principal_id text not null,
        client_id text not null,
        grant_id text not null,
        authorization_epoch integer not null,
        project_ref text not null,
        project_fingerprint text not null,
        source_root text not null,
        canonical_source_root text not null,
        workspace_id text,
        status text not null,
        state_generation integer not null,
        create_operation_id text not null,
        request_hash text not null,
        error text,
        created_at text not null,
        last_used_at text not null,
        updated_at text not null
      );
      insert into project_executions values (
        'execution-v24', 'owner', 'client-v24', 'grant-v24', 4,
        'project-v24', 'fingerprint-v24', '/tmp/project-v24',
        '/tmp/project-v24', null, 'provisioning', 1,
        'create-v24', 'request-v24', null,
        '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z',
        '2026-07-30T00:00:00.000Z'
      );
    `);
  } finally {
    source.close();
  }

  const preparation = prepareDatabaseFile(databasePath);
  assert.equal(preparation.migrated, true);
  assert.equal(preparation.sourceVersion, 24);
  const migrated = new Database(databasePath);
  try {
    assert.deepEqual(
      migrated.prepare(`
        select version, name
        from devspace_schema_migrations
      `).all(),
      [{
        version: CURRENT_DATABASE_SCHEMA_VERSION,
        name: CURRENT_DATABASE_SCHEMA_NAME,
      }],
    );
    assert.deepEqual(
      migrated.prepare(`
        select execution_id as executionId, handoff_id as handoffId,
          handoff_retired as handoffRetired
        from project_executions
      `).all(),
      [{ executionId: "execution-v24", handoffId: null, handoffRetired: 0 }],
    );
    assert.equal(
      migrated.prepare("select count(*) from project_handoffs").pluck().get(),
      0,
    );
  } finally {
    migrated.close();
  }
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
      [{ version: CURRENT_DATABASE_SCHEMA_VERSION, name: CURRENT_DATABASE_SCHEMA_NAME }],
    );
    const columns = database.prepare("pragma table_info(workspace_sessions)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    assert.equal(columns.some((column) => column.name === "connection_principal_id"), true);
    assert.equal(columns.some((column) => column.name === "owner_client_id"), false);
    for (const removed of [
      "mode",
      "source_root",
      "base_ref",
      "base_sha",
      "dirty_source",
      "managed",
    ]) {
      assert.equal(columns.some((column) => column.name === removed), false);
    }
    assert.equal(columns.find((column) => column.name === "alias")?.notnull, 1);
    const clientColumns = database.prepare("pragma table_info(oauth_clients)").all() as Array<{
      name: string;
    }>;
    assert.equal(clientColumns.some((column) => column.name === "principal_id"), false);
    assert.deepEqual(
      database.prepare(`
        select name
        from sqlite_master
        where type = 'table'
          and name in ('oauth_authorization_selections', 'oauth_authorization_codes')
        order by name
      `).all(),
      [
        { name: "oauth_authorization_codes" },
        { name: "oauth_authorization_selections" },
      ],
    );

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
    assert.equal(workspace.principalId, OWNER_PRINCIPAL_ID);
    assert.match(workspace.alias, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
    assert.equal(workspace.canonicalRoot, realpathSync(project));
    assert.equal(workspace.status, "closed");
    assert.equal(workspace.writeAccess, "read_write");
    assert.equal(workspace.stateGeneration, version >= 7 ? 7 : 1);

    assert.equal(database.prepare("select count(*) from oauth_grants").pluck().get(), 0);

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
      assert.equal(
        database.prepare("select count(*) from oauth_access_tokens").pluck().get(),
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

function testVersionFifteenFailsClosedAuthorization(): void {
  const directory = join(root, "v15");
  const project = join(directory, "project");
  const databasePath = join(directory, "devspace.sqlite");
  mkdirSync(project, { recursive: true });
  const source = new Database(databasePath);
  try {
    source.exec(`
      create table devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
      insert into devspace_schema_migrations values (
        15, 'canonical-state-v15', '2026-01-01T00:00:00.000Z'
      );
      create table connection_principals (
        principal_id text primary key,
        created_at text not null,
        last_used_at text not null,
        revoked_at text
      );
      create table oauth_clients (
        client_id text primary key,
        client_json text not null,
        issued_at integer not null
      );
      create table oauth_grants (
        grant_id text primary key,
        client_id text not null,
        principal_id text not null,
        subject_hash text,
        organization_hash text,
        granted_scopes_json text not null,
        authorization_epoch integer not null,
        created_at text not null,
        last_used_at text not null,
        revoked_at text
      );
      create table workspace_sessions (
        id text primary key,
        connection_principal_id text not null,
        alias text not null,
        root text not null,
        canonical_root text,
        status text not null,
        mode text not null,
        source_root text,
        base_ref text,
        base_sha text,
        dirty_source text not null,
        managed text not null,
        write_access text not null,
        state_generation integer not null,
        created_at text not null,
        last_used_at text not null
      );
      create table mutation_operations (
        connection_principal_id text not null,
        workspace_id text not null,
        tool text not null,
        operation_id text not null,
        workspace_generation integer not null,
        request_hash text not null,
        state text not null,
        result_json text,
        created_at text not null,
        updated_at text not null,
        expires_at text not null
      );
    `);
    source.prepare("insert into connection_principals values (?, ?, ?, null)").run(
      "principal-v15",
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    );
    source.prepare("insert into oauth_clients values (?, ?, ?)").run(
      "client-v15",
      JSON.stringify({ redirect_uris: ["https://chatgpt.com/callback"] }),
      1,
    );
    source.prepare("insert into oauth_grants values (?, ?, ?, ?, ?, ?, ?, ?, ?, null)").run(
      "grant-v15",
      "client-v15",
      "principal-v15",
      "sub_preserved",
      "org_preserved",
      JSON.stringify(["workspace:read", "workspace:write"]),
      7,
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    );
    source.prepare("insert into workspace_sessions values (?, ?, ?, ?, ?, ?, ?, null, null, null, ?, ?, ?, ?, ?, ?)").run(
      "workspace-v15",
      "principal-v15",
      "v15-project",
      project,
      realpathSync(project),
      "active",
      "checkout",
      "false",
      "false",
      "read_write",
      3,
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    );
    source.prepare("insert into mutation_operations values (?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?)").run(
      "principal-v15",
      "workspace-v15",
      "exec_command",
      "unknown-v15",
      3,
      "hash-v15",
      "outcome_unknown",
      "2026-01-02T00:00:00.000Z",
      "2026-01-02T00:00:01.000Z",
      "2099-01-01T00:00:00.000Z",
    );
  } finally {
    source.close();
  }

  const preparation = prepareDatabaseFile(databasePath);
  assert.equal(preparation.sourceVersion, 15);
  const migrated = new Database(databasePath, { readonly: true });
  try {
    assert.equal(migrated.prepare("select count(*) from oauth_grants").pluck().get(), 0);
    assert.deepEqual(
      migrated.prepare("select principal_id from connection_principals order by principal_id").all(),
      [{ principal_id: OWNER_PRINCIPAL_ID }],
    );
    assert.deepEqual(migrated.prepare(`
      select state, resolution_method as resolutionMethod, resolved_at as resolvedAt
      from mutation_operations where operation_id = 'unknown-v15'
    `).get(), {
      state: "outcome_unknown",
      resolutionMethod: null,
      resolvedAt: null,
    });
    assert.equal(
      migrated.prepare(`
        select connection_principal_id
        from workspace_sessions
        where id = 'workspace-v15'
      `).pluck().get(),
      OWNER_PRINCIPAL_ID,
    );
  } finally {
    migrated.close();
  }
}

function testVersionSixteenDoesNotPromoteClientIdToPrincipal(): void {
  const directory = join(root, "v16");
  const databasePath = join(directory, "devspace.sqlite");
  mkdirSync(directory, { recursive: true });
  const source = new Database(databasePath);
  try {
    source.exec(`
      create table devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
      insert into devspace_schema_migrations values (
        16, 'canonical-state-v16', '2026-01-01T00:00:00.000Z'
      );
      create table connection_principals (
        principal_id text primary key,
        created_at text not null,
        last_used_at text not null,
        revoked_at text
      );
      create table oauth_clients (
        client_id text primary key,
        client_json text not null,
        issued_at integer not null
      );
      create table oauth_grants (
        grant_id text primary key,
        client_id text not null,
        principal_id text not null,
        subject_hash text,
        organization_hash text,
        granted_scopes_json text not null,
        allowed_root_ids_json text not null,
        authorization_epoch integer not null,
        created_at text not null,
        last_used_at text not null,
        revoked_at text
      );
    `);
    source.prepare("insert into connection_principals values (?, ?, ?, null)").run(
      "principal-v16",
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    );
    source.prepare("insert into oauth_clients values (?, ?, ?)").run(
      "client-v16",
      JSON.stringify({ redirect_uris: ["https://chatgpt.com/callback"] }),
      1,
    );
    source.prepare("insert into oauth_grants values (?, ?, ?, null, null, ?, ?, 3, ?, ?, null)").run(
      "grant-v16",
      "client-v16",
      "principal-v16",
      JSON.stringify(["workspace:read"]),
      JSON.stringify(["root-v16"]),
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    );
  } finally {
    source.close();
  }

  const preparation = prepareDatabaseFile(databasePath);
  assert.equal(preparation.sourceVersion, 16);
  const migrated = new Database(databasePath, { readonly: true });
  try {
    assert.deepEqual(
      migrated.prepare("select principal_id from connection_principals order by principal_id").all(),
      [{ principal_id: OWNER_PRINCIPAL_ID }],
    );
    assert.equal(migrated.prepare("select count(*) from oauth_grants").pluck().get(), 0);
  } finally {
    migrated.close();
  }
}

function testVersionTwentyPreservesAuthorizationAndClosesLegacyRuntime(): void {
  const directory = join(root, "v20");
  const project = join(directory, "project");
  const sentinel = join(project, "must-survive.txt");
  const databasePath = join(directory, "devspace.sqlite");
  mkdirSync(project, { recursive: true });
  writeFileSync(sentinel, "unchanged\n");
  const source = new Database(databasePath);
  try {
    source.exec(`
      create table devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
      insert into devspace_schema_migrations values (
        20, 'canonical-state-v20-direct-checkout', '2026-01-01T00:00:00.000Z'
      );
      create table connection_principals (
        principal_id text primary key,
        created_at text not null,
        last_used_at text not null,
        revoked_at text
      );
      insert into connection_principals values (
        'owner', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null
      );
      create table oauth_clients (
        client_id text primary key,
        client_json text not null,
        issued_at integer not null
      );
      insert into oauth_clients values ('client-v20', '{}', 1);
      create table oauth_grants (
        grant_id text primary key,
        client_id text not null,
        principal_id text not null,
        subject_hash text,
        organization_hash text,
        granted_scopes_json text not null,
        allowed_root_ids_json text not null,
        authorization_epoch integer not null,
        absolute_expires_at integer,
        created_at text not null,
        last_used_at text not null,
        revoked_at text
      );
      insert into oauth_grants values (
        'grant-v20', 'client-v20', 'owner', 'subject-must-drop', 'org-must-drop',
        '["project:read","project:write"]', '["*"]', 7, null,
        '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null
      );
      create table oauth_access_tokens (
        token_hash text primary key,
        grant_id text not null,
        client_id text not null,
        principal_id text not null,
        authorization_epoch integer not null,
        scopes_json text not null,
        expires_at integer not null,
        resource text
      );
      insert into oauth_access_tokens values (
        'access-v20', 'grant-v20', 'client-v20', 'owner', 7,
        '["project:read"]', 4102444800000, null
      );
      create table oauth_refresh_tokens (
        token_hash text primary key,
        grant_id text not null,
        client_id text not null,
        principal_id text not null,
        authorization_epoch integer not null,
        family_id text not null,
        scopes_json text not null,
        expires_at integer not null,
        resource text
      );
      insert into oauth_refresh_tokens values (
        'refresh-v20', 'grant-v20', 'client-v20', 'owner', 7,
        'family-v20-00000001', '["project:read"]', 4102444800000, null
      );
      create table workspace_sessions (
        id text primary key,
        connection_principal_id text not null,
        alias text not null,
        root text not null,
        canonical_root text,
        status text not null,
        write_access text not null,
        state_generation integer not null,
        created_at text not null,
        last_used_at text not null
      );
      create table mutation_operations (
        connection_principal_id text not null,
        workspace_id text not null,
        tool text not null,
        operation_id text not null,
        workspace_generation integer not null,
        request_hash text not null,
        state text not null,
        result_json text,
        resolution_method text,
        evidence_type text,
        evidence_json text,
        resolved_at text,
        operator_ref text,
        created_at text not null,
        updated_at text not null,
        expires_at text not null
      );
      create table legacy_managed_worktree_artifacts (
        artifact_id integer primary key autoincrement,
        artifact_kind text not null,
        source_schema_version integer not null,
        legacy_workspace_id text not null,
        legacy_connection_principal_id text,
        legacy_alias text,
        workspace_root text not null,
        canonical_root text,
        source_root text,
        base_ref text,
        base_sha text,
        dirty_source text,
        managed text,
        previous_status text,
        write_access text,
        state_generation integer,
        workspace_created_at text,
        workspace_last_used_at text,
        legacy_job_id integer,
        reason text,
        recorded_at text not null
      );
    `);
    source.prepare(`
      insert into workspace_sessions values (
        'workspace-v20', 'owner', 'project-v20', ?, ?, 'active', 'read_write', 4,
        '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'
      )
    `).run(project, realpathSync(project));
    source.exec(`
      insert into mutation_operations values (
        'owner', 'workspace-v20', 'apply_patch', 'pending-v20', 4,
        'request-v20', 'pending', null, null, null, null, null, null,
        '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:01.000Z',
        '2099-01-01T00:00:00.000Z'
      );
      insert into legacy_managed_worktree_artifacts (
        artifact_kind, source_schema_version, legacy_workspace_id,
        legacy_connection_principal_id, legacy_alias, workspace_root,
        source_root, dirty_source, managed, previous_status, write_access,
        state_generation, workspace_created_at, workspace_last_used_at, recorded_at
      ) values (
        'workspace', 19, 'legacy-worktree-v19', 'owner', 'legacy-worktree',
        '/tmp/legacy-worktree-v19', '/tmp/source-v19', 'true', 'true',
        'closed', 'read_write', 2,
        '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      );
    `);
  } finally {
    source.close();
  }
  const before = filesystemSnapshot([project, sentinel]);

  const preparation = prepareDatabaseFile(databasePath);
  assert.equal(preparation.migrated, true);
  assert.equal(preparation.sourceVersion, 20);
  assert.deepEqual(filesystemSnapshot([project, sentinel]), before);

  const migrated = new Database(databasePath);
  try {
    const grantColumns = migrated.prepare(
      "select name from pragma_table_info('oauth_grants')",
    ).pluck().all() as string[];
    assert.equal(grantColumns.includes("subject_hash"), false);
    assert.equal(grantColumns.includes("organization_hash"), false);
    assert.deepEqual(migrated.prepare(`
      select grant_id as grantId, authorization_epoch as authorizationEpoch
      from oauth_grants
    `).get(), { grantId: "grant-v20", authorizationEpoch: 7 });
    assert.equal(migrated.prepare("select count(*) from oauth_access_tokens").pluck().get(), 1);
    assert.equal(migrated.prepare("select count(*) from oauth_refresh_tokens").pluck().get(), 1);
    assert.equal(
      migrated.prepare("select status from workspace_sessions where id = 'workspace-v20'").pluck().get(),
      "closed",
    );
    assert.equal(
      migrated.prepare("select state from mutation_operations where operation_id = 'pending-v20'").pluck().get(),
      "pending",
    );
    assert.equal(migrated.prepare("select count(*) from project_executions").pluck().get(), 0);
    assert.equal(
      migrated.prepare(`
        select count(*) from legacy_managed_worktree_artifacts
        where legacy_workspace_id = 'legacy-worktree-v19'
      `).pluck().get(),
      1,
    );
    assert.throws(
      () => migrated.prepare("delete from legacy_managed_worktree_artifacts").run(),
      /quarantine is read-only/u,
    );
  } finally {
    migrated.close();
  }
}

function testExplicitLegacyOwnershipCollapses(): void {
  const directory = join(root, "ambiguous");
  const project = join(directory, "project");
  const databasePath = join(directory, "devspace.sqlite");
  mkdirSync(project, { recursive: true });
  createHistoricalDatabase(databasePath, 11, project, { ambiguous: true });
  const before = fileHash(databasePath);

  const preparation = prepareDatabaseFile(databasePath);
  assert.equal(preparation.migrated, true);
  assert.ok(preparation.backupPath);
  assert.equal(fileHash(preparation.backupPath), before);
  const migrated = new Database(databasePath, { readonly: true });
  try {
    assert.deepEqual(
      migrated.prepare("select principal_id from connection_principals").all(),
      [{ principal_id: OWNER_PRINCIPAL_ID }],
    );
    assert.equal(migrated.prepare("select count(*) from workspace_sessions").pluck().get(), 2);
    assert.equal(migrated.prepare(
      "select count(distinct alias) from workspace_sessions",
    ).pluck().get(), 2);
  } finally {
    migrated.close();
  }
}

function testVersionEighteenCollapsesMultiplePrincipals(): void {
  const directory = join(root, "v18-multiple-principals");
  const projectA = join(directory, "project-a");
  const projectB = join(directory, "project-b");
  const worktree = join(directory, "legacy-worktree");
  const worktreeSentinel = join(worktree, "sentinel.txt");
  const databasePath = join(directory, "devspace.sqlite");
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(worktreeSentinel, "untouched\n");
  const source = new Database(databasePath);
  try {
    source.exec(`
      create table devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
      insert into devspace_schema_migrations values (
        18, 'canonical-state-v18', '2026-01-01T00:00:00.000Z'
      );
      create table connection_principals (
        principal_id text primary key,
        created_at text not null,
        last_used_at text not null,
        revoked_at text
      );
      create table oauth_clients (
        client_id text primary key,
        client_json text not null,
        issued_at integer not null
      );
      create table oauth_grants (
        grant_id text primary key,
        client_id text not null,
        principal_id text not null,
        subject_hash text,
        organization_hash text,
        granted_scopes_json text not null,
        allowed_root_ids_json text not null,
        authorization_epoch integer not null,
        absolute_expires_at integer,
        created_at text not null,
        last_used_at text not null,
        revoked_at text
      );
      create table oauth_access_tokens (
        token_hash text primary key,
        grant_id text not null,
        client_id text not null,
        principal_id text not null,
        authorization_epoch integer not null,
        scopes_json text not null,
        expires_at integer not null,
        resource text
      );
      create table oauth_refresh_tokens (
        token_hash text primary key,
        grant_id text not null,
        client_id text not null,
        principal_id text not null,
        authorization_epoch integer not null,
        family_id text not null,
        scopes_json text not null,
        expires_at integer not null,
        resource text
      );
      create table workspace_sessions (
        id text primary key,
        connection_principal_id text not null,
        alias text not null,
        root text not null,
        canonical_root text,
        status text not null,
        mode text not null,
        source_root text,
        base_ref text,
        base_sha text,
        dirty_source text not null,
        managed text not null,
        write_access text not null,
        state_generation integer not null,
        created_at text not null,
        last_used_at text not null
      );
      create table mutation_operations (
        connection_principal_id text not null,
        workspace_id text not null,
        tool text not null,
        operation_id text not null,
        workspace_generation integer not null,
        request_hash text not null,
        state text not null,
        result_json text,
        created_at text not null,
        updated_at text not null,
        expires_at text not null
      );
      create table apply_patch_changes (
        sequence integer primary key autoincrement,
        connection_principal_id text not null,
        workspace_id text not null,
        operation_id text not null,
        tool text not null,
        workspace_generation integer not null,
        applied_at text not null,
        patch text not null,
        files_json text not null,
        summary_json text not null
      );
      create table audit_events (
        id integer primary key autoincrement,
        ts text not null,
        level text not null,
        event text not null,
        request_id text,
        tool text,
        oauth_client_ref text,
        connection_ref text,
        workspace_activity_ref text,
        operation_ref text,
        error_code text,
        error_category text,
        error_fingerprint text,
        details_json text not null
      );
    `);
    const principalInsert = source.prepare(
      "insert into connection_principals values (?, ?, ?, null)",
    );
    for (const principal of ["principal-a", "principal-b", "legacy-orphaned-pre-identity"]) {
      principalInsert.run(principal, "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    }
    const clientInsert = source.prepare("insert into oauth_clients values (?, ?, ?)");
    clientInsert.run("client-a", JSON.stringify({ redirect_uris: ["https://chatgpt.com/callback"] }), 1);
    clientInsert.run("client-b", JSON.stringify({ redirect_uris: ["https://chatgpt.com/callback"] }), 2);
    const legacyScopes = JSON.stringify([
      "workspace:read", "workspace:write", "process:execute", "network:access",
    ]);
    const grantInsert = source.prepare(`
      insert into oauth_grants values (?, ?, ?, null, null, ?, ?, 1, null, ?, ?, null)
    `);
    grantInsert.run(
      "grant-a", "client-a", "principal-a", legacyScopes, JSON.stringify(["root-a"]),
      "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z",
    );
    grantInsert.run(
      "grant-b", "client-b", "principal-b", legacyScopes, JSON.stringify(["root-b"]),
      "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z",
    );
    source.prepare("insert into oauth_access_tokens values (?, ?, ?, ?, 1, ?, 4102444800, null)")
      .run("access-a", "grant-a", "client-a", "principal-a", legacyScopes);
    source.prepare("insert into oauth_refresh_tokens values (?, ?, ?, ?, 1, ?, ?, 4102444800, null)")
      .run("refresh-b", "grant-b", "client-b", "principal-b", "family-b-12345678", legacyScopes);
    const workspaceInsert = source.prepare(`
      insert into workspace_sessions values (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);
    workspaceInsert.run(
      "checkout-a", "principal-a", "shared", projectA, realpathSync(projectA),
      "active", "checkout", null, null, null, "false", "false", "read_write", 2,
      "2026-01-01T00:00:00.000Z", "2026-01-04T00:00:00.000Z",
    );
    workspaceInsert.run(
      "checkout-b", "principal-b", "shared", projectB, realpathSync(projectB),
      "active", "checkout", null, null, null, "false", "false", "read_write", 3,
      "2026-01-01T00:00:00.000Z", "2026-01-03T00:00:00.000Z",
    );
    workspaceInsert.run(
      "checkout-orphan", "legacy-orphaned-pre-identity", "history", projectA,
      realpathSync(projectA), "closed", "checkout", null, null, null, "false", "false",
      "read_write", 1, "2025-01-01T00:00:00.000Z", "2025-01-02T00:00:00.000Z",
    );
    workspaceInsert.run(
      "worktree-a", "principal-a", "branch", worktree, null, "active", "worktree",
      projectA, "refs/heads/legacy", "base-sha", "true", "true", "read_write", 4,
      "2026-01-01T00:00:00.000Z", "2026-01-05T00:00:00.000Z",
    );
    source.prepare(`
      insert into mutation_operations values (
        'principal-a', 'checkout-a', 'apply_patch', 'patch-a', 2, 'request-a',
        'settled', '{"ok":true}', '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:01.000Z', '2099-01-01T00:00:00.000Z'
      )
    `).run();
    source.prepare(`
      insert into mutation_operations values (
        'principal-a', 'worktree-a', 'exec_command', 'expired-worktree-a', 4,
        'request-worktree-a', 'outcome_unknown', null,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z',
        '2026-01-02T00:00:00.000Z'
      )
    `).run();
    source.prepare(`
      insert into apply_patch_changes (
        connection_principal_id, workspace_id, operation_id, tool,
        workspace_generation, applied_at, patch, files_json, summary_json
      ) values (
        'principal-a', 'checkout-a', 'patch-a', 'apply_patch', 2,
        '2026-01-01T00:00:01.000Z', '*** Begin Patch', '["src/a.ts"]',
        '{"filesChanged":1}'
      )
    `).run();
    const auditInsert = source.prepare(`
      insert into audit_events (
        ts, level, event, request_id, tool, oauth_client_ref, connection_ref,
        workspace_activity_ref, operation_ref, error_code, error_category,
        error_fingerprint, details_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    auditInsert.run(
      "2026-01-01T00:00:00.000Z", "info", "tool_call", "request-a", "read",
      "oauth-a", "connection-a", "activity-a", null, null, null, null, "{}",
    );
    auditInsert.run(
      "2026-01-02T00:00:00.000Z", "warn", "tool_input_rejected", "request-b",
      "exec_command", "oauth-b", "connection-b", null, null, "invalid_tool_input",
      "validation", "fingerprint-b", "{}",
    );
  } finally {
    source.close();
  }

  const filesystemBefore = filesystemSnapshot([projectA, projectB, worktree, worktreeSentinel]);
  const preparation = prepareDatabaseFile(databasePath);
  assert.equal(preparation.migrated, true);
  assert.equal(preparation.sourceVersion, 18);
  assert.ok(preparation.backupPath);
  assert.deepEqual(filesystemSnapshot([projectA, projectB, worktree, worktreeSentinel]), filesystemBefore);

  const migrated = new Database(databasePath, { readonly: true });
  try {
    assert.equal(migrated.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(migrated.pragma("foreign_key_check"), []);
    assert.deepEqual(
      migrated.prepare("select principal_id from connection_principals").all(),
      [{ principal_id: OWNER_PRINCIPAL_ID }],
    );
    assert.deepEqual(
      migrated.prepare(`
        select status, count(*) as count
        from workspace_sessions
        group by status
      `).all(),
      [{ status: "closed", count: 3 }],
    );
    assert.equal(migrated.prepare(
      "select count(*) from workspace_sessions where connection_principal_id = 'owner'",
    ).pluck().get(), 3);
    assert.equal(migrated.prepare(
      "select count(distinct alias) from workspace_sessions",
    ).pluck().get(), 3);
    assert.deepEqual(
      migrated.prepare(`
        select id, alias from workspace_sessions order by id
      `).all(),
      [
        { id: "checkout-a", alias: "shared" },
        { id: "checkout-b", alias: "shared-2" },
        { id: "checkout-orphan", alias: "history" },
      ],
    );
    assert.deepEqual(
      migrated.prepare(`
        select legacy_connection_principal_id as principal, legacy_alias as alias, reason
        from legacy_managed_worktree_artifacts
        where legacy_workspace_id = 'worktree-a'
      `).get(),
      {
        principal: "principal-a",
        alias: "branch",
        reason: "Quarantined with 1 expired unresolved mutation(s); effects remain unknown. " +
          "Operation IDs: expired-worktree-a (outcome_unknown). Full records remain in the pre-v25 backup.",
      },
    );
    assert.deepEqual(
      migrated.prepare(`
        select connection_principal_id as principal, workspace_id as workspaceId,
          operation_id as operationId
        from mutation_operations
      `).get(),
      { principal: OWNER_PRINCIPAL_ID, workspaceId: "checkout-a", operationId: "patch-a" },
    );
    assert.deepEqual(
      migrated.prepare(`
        select sequence, connection_principal_id as principal,
          workspace_id as workspaceId, operation_id as operationId, tool,
          workspace_generation as workspaceGeneration, applied_at as appliedAt,
          patch, files_json as filesJson, summary_json as summaryJson
        from apply_patch_changes
      `).get(),
      {
        sequence: 1,
        principal: OWNER_PRINCIPAL_ID,
        workspaceId: "checkout-a",
        operationId: "patch-a",
        tool: "apply_patch",
        workspaceGeneration: 2,
        appliedAt: "2026-01-01T00:00:01.000Z",
        patch: "*** Begin Patch",
        filesJson: '["src/a.ts"]',
        summaryJson: '{"filesChanged":1}',
      },
    );
    assert.equal(migrated.prepare("select count(*) from oauth_clients").pluck().get(), 2);
    for (const table of ["oauth_grants", "oauth_access_tokens", "oauth_refresh_tokens"]) {
      assert.equal(migrated.prepare(`select count(*) from ${table}`).pluck().get(), 0);
    }
    assert.deepEqual(
      migrated.prepare(`
        select id, ts, level, event, request_id as requestId, tool,
          oauth_client_ref as oauthClientRef, connection_ref as connectionRef,
          workspace_activity_ref as workspaceActivityRef,
          operation_ref as operationRef, error_code as errorCode,
          error_category as errorCategory, error_fingerprint as errorFingerprint,
          details_json as detailsJson
        from audit_events
        order by id
      `).all(),
      [
        {
          id: 1,
          ts: "2026-01-01T00:00:00.000Z",
          level: "info",
          event: "tool_call",
          requestId: "request-a",
          tool: "read",
          oauthClientRef: "oauth-a",
          connectionRef: "connection-a",
          workspaceActivityRef: "activity-a",
          operationRef: null,
          errorCode: null,
          errorCategory: null,
          errorFingerprint: null,
          detailsJson: "{}",
        },
        {
          id: 2,
          ts: "2026-01-02T00:00:00.000Z",
          level: "warn",
          event: "tool_input_rejected",
          requestId: "request-b",
          tool: "exec_command",
          oauthClientRef: "oauth-b",
          connectionRef: "connection-b",
          workspaceActivityRef: null,
          operationRef: null,
          errorCode: "invalid_tool_input",
          errorCategory: "validation",
          errorFingerprint: "fingerprint-b",
          detailsJson: "{}",
        },
      ],
    );
    const backup = new Database(preparation.backupPath!, { readonly: true });
    try {
      assert.deepEqual(
        backup.prepare(`
          select state, expires_at as expiresAt
          from mutation_operations
          where operation_id = 'expired-worktree-a'
        `).get(),
        { state: "outcome_unknown", expiresAt: "2026-01-02T00:00:00.000Z" },
      );
    } finally {
      backup.close();
    }
  } finally {
    migrated.close();
  }
}

function testVersionNineteenQuarantinesWorktreesWithoutTouchingFilesystem(): void {
  const directory = join(root, "v19-mixed");
  const checkoutRoot = join(directory, "checkout");
  const sourceRoot = join(directory, "source");
  const worktreeRoot = join(directory, "legacy-worktree");
  const worktreeSentinel = join(worktreeRoot, "uncommitted.txt");
  const gitRef = join(sourceRoot, ".git", "refs", "heads", "legacy-sentinel");
  const databasePath = join(directory, "devspace.sqlite");
  mkdirSync(checkoutRoot, { recursive: true });
  mkdirSync(join(sourceRoot, ".git", "refs", "heads"), { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  writeFileSync(worktreeSentinel, "uncommitted legacy worktree content\n", { mode: 0o640 });
  writeFileSync(gitRef, `${"a".repeat(40)}\n`, { mode: 0o600 });
  createVersionNineteenDatabase(databasePath, {
    checkoutRoot,
    sourceRoot,
    worktreeRoot,
    mutationState: "settled",
  });
  const sentinelPaths = [sourceRoot, worktreeRoot, worktreeSentinel, gitRef];
  const before = filesystemSnapshot(sentinelPaths);

  const preparation = prepareDatabaseFile(databasePath);
  assert.equal(preparation.migrated, true);
  assert.equal(preparation.sourceVersion, 19);
  assert.ok(preparation.backupPath);
  assert.equal(existsSync(preparation.backupPath), true);
  assert.deepEqual(filesystemSnapshot(sentinelPaths), before);

  const database = new Database(databasePath);
  try {
    assert.deepEqual(
      database.prepare(`
        select id, connection_principal_id as principalId, alias, root,
          canonical_root as canonicalRoot, status, write_access as writeAccess,
          state_generation as stateGeneration
        from workspace_sessions
      `).all(),
      [{
        id: "checkout-v19",
        principalId: OWNER_PRINCIPAL_ID,
        alias: "checkout-v19",
        root: checkoutRoot,
        canonicalRoot: checkoutRoot,
        status: "closed",
        writeAccess: "read_write",
        stateGeneration: 4,
      }],
    );
    const workspaceColumns = database.prepare(
      "select name from pragma_table_info('workspace_sessions') order by cid",
    ).pluck().all() as string[];
    for (const removed of [
      "mode",
      "source_root",
      "base_ref",
      "base_sha",
      "dirty_source",
      "managed",
    ]) {
      assert.equal(workspaceColumns.includes(removed), false);
    }

    assert.deepEqual(
      database.prepare(`
        select artifact_kind as artifactKind, source_schema_version as sourceSchemaVersion,
          legacy_workspace_id as workspaceId, legacy_connection_principal_id as principalId,
          legacy_alias as alias, workspace_root as workspaceRoot, source_root as sourceRoot,
          base_ref as baseRef, base_sha as baseSha, dirty_source as dirtySource,
          managed, previous_status as previousStatus, state_generation as stateGeneration,
          legacy_job_id as legacyJobId, reason
        from legacy_managed_worktree_artifacts
        order by artifact_id
      `).all(),
      [
        {
          artifactKind: "workspace",
          sourceSchemaVersion: 19,
          workspaceId: "worktree-v19",
          principalId: OWNER_PRINCIPAL_ID,
          alias: "legacy-worktree",
          workspaceRoot: worktreeRoot,
          sourceRoot,
          baseRef: "refs/heads/legacy-sentinel",
          baseSha: "a".repeat(40),
          dirtySource: "true",
          managed: "true",
          previousStatus: "active",
          stateGeneration: 6,
          legacyJobId: null,
          reason: null,
        },
        {
          artifactKind: "dirty_artifact",
          sourceSchemaVersion: 19,
          workspaceId: "worktree-v19",
          principalId: OWNER_PRINCIPAL_ID,
          alias: "legacy-worktree",
          workspaceRoot: worktreeRoot,
          sourceRoot,
          baseRef: "refs/heads/legacy-sentinel",
          baseSha: "a".repeat(40),
          dirtySource: "true",
          managed: "true",
          previousStatus: "active",
          stateGeneration: 6,
          legacyJobId: 7,
          reason: "dirty_worktree_preserved",
        },
      ],
    );
    assert.equal(
      database.prepare(`
        select count(*) from sqlite_master
        where type = 'table' and name = 'oauth_revocation_dirty_worktree_artifacts'
      `).pluck().get(),
      0,
    );
    const cleanupColumns = database.prepare(
      "select name from pragma_table_info('oauth_revocation_cleanup_jobs') order by cid",
    ).pluck().all() as string[];
    assert.equal(cleanupColumns.includes("workspace_root"), true);
    for (const removed of ["workspace_mode", "source_root", "managed", "dirty_source"]) {
      assert.equal(cleanupColumns.includes(removed), false);
    }
    assert.deepEqual(
      database.prepare(`
        select workspace_id as workspaceId, workspace_root as workspaceRoot, status
        from oauth_revocation_cleanup_jobs
      `).get(),
      { workspaceId: "worktree-v19", workspaceRoot: worktreeRoot, status: "pending" },
    );
    assert.equal(
      database.prepare("select count(*) from mutation_operations").pluck().get(),
      0,
    );

    assert.throws(
      () => database.prepare(`
        insert into legacy_managed_worktree_artifacts (
          artifact_kind, source_schema_version, legacy_workspace_id, workspace_root,
          legacy_alias, previous_status, state_generation, workspace_created_at,
          workspace_last_used_at, recorded_at
        ) values ('workspace', 19, 'new', '/tmp/new', 'new', 'closed', 1, 'x', 'x', 'x')
      `).run(),
      /quarantine is read-only/u,
    );
    assert.throws(
      () => database.prepare(`
        update legacy_managed_worktree_artifacts set reason = 'changed'
      `).run(),
      /quarantine is read-only/u,
    );
    assert.throws(
      () => database.prepare("delete from legacy_managed_worktree_artifacts").run(),
      /quarantine is read-only/u,
    );
  } finally {
    database.close();
  }
  assert.deepEqual(filesystemSnapshot(sentinelPaths), before);
}

function testVersionNineteenRefusesUnresolvedWorktreeMutation(
  state: "pending" | "outcome_unknown",
): void {
  const directory = join(root, `v19-${state}`);
  const checkoutRoot = join(directory, "checkout");
  const sourceRoot = join(directory, "source");
  const worktreeRoot = join(directory, "legacy-worktree");
  const sentinel = join(worktreeRoot, "must-survive.txt");
  const databasePath = join(directory, "devspace.sqlite");
  mkdirSync(checkoutRoot, { recursive: true });
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  writeFileSync(sentinel, `${state}\n`);
  createVersionNineteenDatabase(databasePath, {
    checkoutRoot,
    sourceRoot,
    worktreeRoot,
    mutationState: state,
  });
  const beforeDatabase = fileHash(databasePath);
  const beforeFilesystem = filesystemSnapshot([sourceRoot, worktreeRoot, sentinel]);

  assert.throws(
    () => prepareDatabaseFile(databasePath),
    new RegExp(
      `Cannot migrate legacy managed worktree worktree-v19: mutation mutation-worktree-v19 is ${state}.*pre-v20`,
      "u",
    ),
  );
  assert.equal(fileHash(databasePath), beforeDatabase);
  assert.deepEqual(filesystemSnapshot([sourceRoot, worktreeRoot, sentinel]), beforeFilesystem);
  assert.equal(
    readdirSync(directory).some((name) => name.includes("v25-migrating") || name.includes("pre-v25")),
    false,
  );
}

function testVersionNineteenQuarantinesExpiredUnresolvedWorktreeMutation(): void {
  const directory = join(root, "v19-expired-outcome-unknown");
  const checkoutRoot = join(directory, "checkout");
  const sourceRoot = join(directory, "source");
  const worktreeRoot = join(directory, "legacy-worktree");
  const sentinel = join(worktreeRoot, "must-survive.txt");
  const databasePath = join(directory, "devspace.sqlite");
  mkdirSync(checkoutRoot, { recursive: true });
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  writeFileSync(sentinel, "expired outcome unknown\n");
  createVersionNineteenDatabase(databasePath, {
    checkoutRoot,
    sourceRoot,
    worktreeRoot,
    mutationState: "outcome_unknown",
  });
  const source = new Database(databasePath);
  try {
    source.prepare(`
      update mutation_operations
      set expires_at = '2020-01-01T00:00:00.000Z'
      where operation_id = 'mutation-worktree-v19'
    `).run();
  } finally {
    source.close();
  }
  const beforeFilesystem = filesystemSnapshot([sourceRoot, worktreeRoot, sentinel]);

  prepareDatabaseFile(databasePath);

  const migrated = new Database(databasePath, { readonly: true });
  try {
    const row = migrated.prepare(`
      select reason
      from legacy_managed_worktree_artifacts
      where artifact_kind = 'workspace' and legacy_workspace_id = 'worktree-v19'
    `).get() as { reason: string };
    assert.match(row.reason, /1 expired unresolved mutation/u);
    assert.match(row.reason, /mutation-worktree-v19 \(outcome_unknown\)/u);
    assert.equal(
      migrated.prepare("select count(*) from workspace_sessions where id = 'worktree-v19'").pluck().get(),
      0,
    );
  } finally {
    migrated.close();
  }
  assert.deepEqual(filesystemSnapshot([sourceRoot, worktreeRoot, sentinel]), beforeFilesystem);
}

function createVersionNineteenDatabase(
  path: string,
  input: {
    checkoutRoot: string;
    sourceRoot: string;
    worktreeRoot: string;
    mutationState: "pending" | "settled" | "outcome_unknown";
  },
): void {
  const database = new Database(path);
  try {
    database.exec(`
      create table devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
      insert into devspace_schema_migrations values (
        19, 'canonical-state-v19-single-owner', '2026-01-01T00:00:00.000Z'
      );
      create table connection_principals (
        principal_id text primary key,
        created_at text not null,
        last_used_at text not null,
        revoked_at text
      );
      insert into connection_principals values (
        'owner', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null
      );
      create table workspace_sessions (
        id text primary key,
        connection_principal_id text not null,
        alias text not null,
        root text not null,
        canonical_root text,
        status text not null,
        mode text not null,
        source_root text,
        base_ref text,
        base_sha text,
        dirty_source text not null,
        managed text not null,
        write_access text not null,
        state_generation integer not null,
        created_at text not null,
        last_used_at text not null
      );
      create table mutation_operations (
        connection_principal_id text not null,
        workspace_id text not null,
        tool text not null,
        operation_id text not null,
        workspace_generation integer not null,
        request_hash text not null,
        state text not null,
        result_json text,
        resolution_method text,
        evidence_type text,
        evidence_json text,
        resolved_at text,
        operator_ref text,
        created_at text not null,
        updated_at text not null,
        expires_at text not null
      );
      create table oauth_revocation_cleanup_jobs (
        id integer primary key,
        connection_principal_id text not null,
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
      create table oauth_revocation_dirty_worktree_artifacts (
        job_id integer primary key,
        connection_principal_id text not null,
        workspace_id text not null,
        workspace_root text not null,
        source_root text,
        reason text not null,
        recorded_at text not null
      );
    `);
    const insertWorkspace = database.prepare(`
      insert into workspace_sessions values (
        ?, 'owner', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);
    insertWorkspace.run(
      "checkout-v19",
      "checkout-v19",
      input.checkoutRoot,
      input.checkoutRoot,
      "active",
      "checkout",
      null,
      null,
      null,
      "false",
      "false",
      "read_write",
      4,
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    );
    insertWorkspace.run(
      "worktree-v19",
      "legacy-worktree",
      input.worktreeRoot,
      null,
      "active",
      "worktree",
      input.sourceRoot,
      "refs/heads/legacy-sentinel",
      "a".repeat(40),
      "true",
      "true",
      "read_write",
      6,
      "2026-01-03T00:00:00.000Z",
      "2026-01-04T00:00:00.000Z",
    );
    database.prepare(`
      insert into mutation_operations values (
        'owner', 'worktree-v19', 'apply_patch', 'mutation-worktree-v19',
        6, 'request-hash', ?, null, null, null, null, null, null,
        '2026-01-04T00:00:00.000Z', '2026-01-04T00:00:01.000Z',
        '2099-01-01T00:00:00.000Z'
      )
    `).run(input.mutationState);
    database.prepare(`
      insert into oauth_revocation_cleanup_jobs values (
        7, 'owner', 'worktree-v19', ?, 'worktree', ?, 'true', 'true',
        'claimed', 'old-claim', '2099-01-01T00:00:00.000Z', 1, null,
        '2026-01-04T00:00:00.000Z', '2026-01-04T00:00:01.000Z', null
      )
    `).run(input.worktreeRoot, input.sourceRoot);
    database.prepare(`
      insert into oauth_revocation_dirty_worktree_artifacts values (
        7, 'owner', 'worktree-v19', ?, ?, 'dirty_worktree_preserved',
        '2026-01-04T00:00:02.000Z'
      )
    `).run(input.worktreeRoot, input.sourceRoot);
  } finally {
    database.close();
  }
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
      owner_client_id: version >= 11
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
    if (options.ambiguous) {
      const secondValues: Record<string, unknown> = {
        ...values,
        id: `workspace-v${version}-second-owner`,
        owner_client_id: "principal-b",
        alias: "second-owner",
      };
      database.prepare(`
        insert into workspace_sessions (${names.join(", ")})
        values (${names.map((name) => `@${name}`).join(", ")})
      `).run(Object.fromEntries(names.map((name) => [name, secondValues[name]])));
    }

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

function filesystemSnapshot(paths: readonly string[]): Array<{
  path: string;
  inode: number;
  mode: number;
  size: number;
  modifiedAtMs: number;
  content: string | null;
  entries: string[] | null;
}> {
  return paths.map((path) => {
    const stat = lstatSync(path);
    return {
      path,
      inode: stat.ino,
      mode: stat.mode,
      size: stat.size,
      modifiedAtMs: stat.mtimeMs,
      content: stat.isFile() ? readFileSync(path, "utf8") : null,
      entries: stat.isDirectory() ? readdirSync(path).sort() : null,
    };
  });
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

console.log("canonical v25 Project-handoff migration matrix passed");
