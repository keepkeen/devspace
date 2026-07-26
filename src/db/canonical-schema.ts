import type Database from "better-sqlite3";
import { DEVSPACE_CAPABILITY_SCOPES } from "../oauth-scopes.js";

export const CURRENT_DATABASE_SCHEMA_VERSION = 17 as const;
export const CURRENT_DATABASE_SCHEMA_NAME = "canonical-state-v17";

export function createCanonicalSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists devspace_schema_migrations (
      version integer primary key,
      name text not null,
      applied_at text not null
    );

    create table if not exists connection_principals (
      principal_id text primary key,
      created_at text not null,
      last_used_at text not null,
      revoked_at text
    );

    create index if not exists connection_principals_last_used_idx
      on connection_principals(last_used_at);

    create table if not exists oauth_clients (
      client_id text primary key,
      client_json text not null,
      issued_at integer not null
    );

    create index if not exists oauth_clients_issued_at_idx
      on oauth_clients(issued_at desc);

    create table if not exists oauth_grants (
      grant_id text primary key,
      client_id text not null,
      principal_id text not null,
      subject_hash text,
      organization_hash text,
      granted_scopes_json text not null,
      allowed_root_ids_json text not null,
      authorization_epoch integer not null check (authorization_epoch >= 1),
      absolute_expires_at integer check (absolute_expires_at is null or absolute_expires_at >= 1),
      created_at text not null,
      last_used_at text not null,
      revoked_at text,
      foreign key (client_id)
        references oauth_clients(client_id)
        on delete cascade,
      foreign key (principal_id)
        references connection_principals(principal_id),
      unique (grant_id, principal_id, client_id)
    );

    create index if not exists oauth_grants_client_id_idx
      on oauth_grants(client_id, last_used_at desc);

    create index if not exists oauth_grants_principal_id_idx
      on oauth_grants(principal_id, last_used_at desc);

    create index if not exists oauth_grants_subject_hash_idx
      on oauth_grants(subject_hash);

    create table if not exists workspace_sessions (
      id text primary key,
      connection_principal_id text not null,
      alias text not null,
      root text not null,
      canonical_root text,
      status text not null check (status in ('active', 'closed', 'revoked')),
      mode text not null check (mode in ('checkout', 'worktree')),
      source_root text,
      base_ref text,
      base_sha text,
      dirty_source text not null check (dirty_source in ('true', 'false')),
      managed text not null check (managed in ('true', 'false')),
      write_access text not null check (write_access in ('read_only', 'read_write')),
      state_generation integer not null check (state_generation >= 1),
      created_at text not null,
      last_used_at text not null,
      foreign key (connection_principal_id)
        references connection_principals(principal_id),
      check (mode != 'worktree' or write_access = 'read_write'),
      check (status != 'active' or mode != 'checkout' or canonical_root is not null)
    );

    create index if not exists workspace_sessions_root_idx
      on workspace_sessions(root, last_used_at desc);

    create index if not exists workspace_sessions_status_idx
      on workspace_sessions(status, last_used_at desc);

    create index if not exists workspace_sessions_principal_status_idx
      on workspace_sessions(connection_principal_id, status, last_used_at desc);

    create unique index if not exists workspace_sessions_id_principal_uq
      on workspace_sessions(id, connection_principal_id);

    create unique index if not exists workspace_sessions_principal_alias_uq
      on workspace_sessions(connection_principal_id, alias);

    create unique index if not exists workspace_sessions_active_checkout_principal_canonical_root_uq
      on workspace_sessions(connection_principal_id, canonical_root)
      where canonical_root is not null and mode = 'checkout' and status = 'active';

    create table if not exists loaded_agent_files (
      workspace_session_id text not null,
      path text not null,
      content_hash text not null,
      content text not null,
      loaded_at text not null,
      last_seen_at text not null,
      primary key (workspace_session_id, path),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists loaded_agent_files_path_idx
      on loaded_agent_files(path);

    create table if not exists mutation_operations (
      connection_principal_id text not null,
      workspace_id text not null,
      tool text not null,
      operation_id text not null,
      workspace_generation integer not null check (workspace_generation >= 1),
      request_hash text not null,
      state text not null check (state in (
        'pending', 'settled', 'outcome_unknown',
        'verified_committed', 'verified_not_started', 'acknowledged_unknown'
      )),
      result_json text,
      resolution_method text,
      evidence_type text,
      evidence_json text,
      resolved_at text,
      operator_ref text,
      created_at text not null,
      updated_at text not null,
      expires_at text not null,
      primary key (connection_principal_id, operation_id),
      foreign key (workspace_id, connection_principal_id)
        references workspace_sessions(id, connection_principal_id)
        on delete cascade
    );

    create index if not exists mutation_operations_expires_at_idx
      on mutation_operations(expires_at);

    create index if not exists mutation_operations_state_updated_idx
      on mutation_operations(state, updated_at desc);

    create table if not exists audit_events (
      id integer primary key autoincrement,
      ts text not null,
      level text not null check (level in ('error', 'warn', 'info', 'debug')),
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

    create index if not exists audit_events_ts_idx
      on audit_events(ts desc, id desc);

    create index if not exists audit_events_event_ts_idx
      on audit_events(event, ts desc, id desc);

    create index if not exists audit_events_tool_ts_idx
      on audit_events(tool, ts desc, id desc);

    create index if not exists audit_events_connection_ts_idx
      on audit_events(connection_ref, ts desc, id desc);

    create table if not exists oauth_access_tokens (
      token_hash text primary key,
      grant_id text not null,
      client_id text not null,
      principal_id text not null,
      authorization_epoch integer not null check (authorization_epoch >= 1),
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id)
        references oauth_clients(client_id)
        on delete cascade,
      foreign key (principal_id)
        references connection_principals(principal_id),
      foreign key (grant_id, principal_id, client_id)
        references oauth_grants(grant_id, principal_id, client_id)
        on delete cascade
    );

    create index if not exists oauth_access_tokens_client_id_idx
      on oauth_access_tokens(client_id);

    create index if not exists oauth_access_tokens_grant_id_idx
      on oauth_access_tokens(grant_id);

    create index if not exists oauth_access_tokens_expires_at_idx
      on oauth_access_tokens(expires_at);

    create table if not exists oauth_refresh_tokens (
      token_hash text primary key,
      grant_id text not null,
      client_id text not null,
      principal_id text not null,
      authorization_epoch integer not null check (authorization_epoch >= 1),
      family_id text not null check (length(family_id) between 16 and 128),
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id)
        references oauth_clients(client_id)
        on delete cascade,
      foreign key (principal_id)
        references connection_principals(principal_id),
      foreign key (grant_id, principal_id, client_id)
        references oauth_grants(grant_id, principal_id, client_id)
        on delete cascade
    );

    create index if not exists oauth_refresh_tokens_client_id_idx
      on oauth_refresh_tokens(client_id);

    create index if not exists oauth_refresh_tokens_grant_id_idx
      on oauth_refresh_tokens(grant_id);

    create index if not exists oauth_refresh_tokens_expires_at_idx
      on oauth_refresh_tokens(expires_at);

    create index if not exists oauth_refresh_tokens_family_id_idx
      on oauth_refresh_tokens(family_id);

    create table if not exists oauth_refresh_token_tombstones (
      token_hash text primary key,
      family_id text not null check (length(family_id) between 16 and 128),
      grant_id text not null,
      client_id text not null,
      principal_id text not null,
      authorization_epoch integer not null check (authorization_epoch >= 1),
      consumed_at integer not null,
      expires_at integer not null check (expires_at > consumed_at)
    );

    create index if not exists oauth_refresh_token_tombstones_family_idx
      on oauth_refresh_token_tombstones(family_id, expires_at);

    create index if not exists oauth_refresh_token_tombstones_expires_idx
      on oauth_refresh_token_tombstones(expires_at);

    create table if not exists oauth_owner_credential (
      id integer primary key check (id = 1),
      salt text not null,
      verifier text not null,
      updated_at text not null
    );

    create table if not exists oauth_principal_reconnect_codes (
      code_hash text primary key,
      principal_id text not null,
      created_at integer not null,
      expires_at integer not null,
      foreign key (principal_id)
        references connection_principals(principal_id)
        on delete cascade
    );

    create index if not exists oauth_principal_reconnect_codes_principal_idx
      on oauth_principal_reconnect_codes(principal_id);

    create index if not exists oauth_principal_reconnect_codes_expires_idx
      on oauth_principal_reconnect_codes(expires_at);

    create table if not exists oauth_authorization_limits (
      key_hash text primary key,
      scope text not null check (scope in ('session', 'client', 'ip', 'global')),
      tokens integer not null check (tokens >= 0),
      updated_at integer not null,
      failure_streak integer not null check (failure_streak >= 0),
      blocked_until integer not null,
      expires_at integer not null
    );

    create index if not exists oauth_authorization_limits_expires_idx
      on oauth_authorization_limits(expires_at);

    create table if not exists oauth_revocation_cleanup_jobs (
      id integer primary key autoincrement,
      connection_principal_id text not null,
      workspace_id text not null,
      workspace_root text not null,
      workspace_mode text not null check (workspace_mode in ('checkout', 'worktree')),
      source_root text,
      managed text not null check (managed in ('true', 'false')),
      dirty_source text not null check (dirty_source in ('true', 'false')),
      status text not null check (status in ('pending', 'claimed', 'failed', 'completed')),
      claim_token text,
      lease_expires_at text,
      attempts integer not null check (attempts >= 0),
      last_error text,
      created_at text not null,
      updated_at text not null,
      completed_at text,
      unique (connection_principal_id, workspace_id),
      check (
        (status = 'claimed' and claim_token is not null and lease_expires_at is not null)
        or (status != 'claimed' and claim_token is null and lease_expires_at is null)
      ),
      check (
        (status = 'completed' and completed_at is not null)
        or (status != 'completed' and completed_at is null)
      )
    );

    create index if not exists oauth_revocation_cleanup_jobs_status_idx
      on oauth_revocation_cleanup_jobs(status, lease_expires_at, created_at, id);

    create index if not exists oauth_revocation_cleanup_jobs_completed_idx
      on oauth_revocation_cleanup_jobs(completed_at, id)
      where status = 'completed';

    create table if not exists oauth_revocation_dirty_worktree_artifacts (
      job_id integer primary key,
      connection_principal_id text not null,
      workspace_id text not null,
      workspace_root text not null,
      source_root text,
      reason text not null,
      recorded_at text not null
    );

    create index if not exists oauth_revocation_dirty_worktree_artifacts_recorded_idx
      on oauth_revocation_dirty_worktree_artifacts(recorded_at, job_id);

    create table if not exists local_agent_sessions (
      id text primary key,
      workspace_id text,
      workspace_root text not null,
      profile_name text not null,
      provider text not null,
      model text,
      thinking text,
      provider_session_id text,
      status text not null,
      latest_response text,
      error text,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists local_agent_sessions_workspace_id_idx
      on local_agent_sessions(workspace_id, updated_at desc);

    create index if not exists local_agent_sessions_workspace_root_idx
      on local_agent_sessions(workspace_root, updated_at desc);

    create index if not exists local_agent_sessions_provider_session_id_idx
      on local_agent_sessions(provider_session_id);

    create trigger if not exists workspace_sessions_alias_immutable
      before update of alias on workspace_sessions
      when new.alias is not old.alias
      begin
        select raise(abort, 'workspace session alias is immutable');
      end;

    create trigger if not exists workspace_sessions_revoked_terminal
      before update of status on workspace_sessions
      when old.status = 'revoked' and new.status != 'revoked'
      begin
        select raise(abort, 'revoked workspace session is terminal');
      end;

    create trigger if not exists oauth_grants_principal_insert_check
      before insert on oauth_grants
      when not exists (
        select 1 from connection_principals
        where principal_id = new.principal_id and revoked_at is null
      )
      begin
        select raise(abort, 'invalid connection principal');
      end;

    create trigger if not exists oauth_grants_principal_update_check
      before update of principal_id on oauth_grants
      when new.principal_id is not old.principal_id
        and not exists (
          select 1 from connection_principals
          where principal_id = new.principal_id and revoked_at is null
        )
      begin
        select raise(abort, 'invalid connection principal');
      end;

    create trigger if not exists connection_principals_delete_check
      before delete on connection_principals
      when exists (
        select 1 from oauth_grants where principal_id = old.principal_id
      )
      or exists (
        select 1 from workspace_sessions
        where connection_principal_id = old.principal_id
      )
      begin
        select raise(abort, 'connection principal still has retained state');
      end;
  `);

  sqlite.prepare(`
    insert into devspace_schema_migrations (version, name, applied_at)
    values (?, ?, ?)
    on conflict(version) do update set
      name = excluded.name,
      applied_at = excluded.applied_at
  `).run(
    CURRENT_DATABASE_SCHEMA_VERSION,
    CURRENT_DATABASE_SCHEMA_NAME,
    new Date().toISOString(),
  );
}

export function validateCanonicalDatabase(sqlite: Database.Database): void {
  const integrity = sqlite.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") throw new Error(`Database integrity check failed: ${String(integrity)}`);

  const foreignKeyFailures = sqlite.pragma("foreign_key_check") as unknown[];
  if (foreignKeyFailures.length > 0) {
    throw new Error(`Database foreign-key check failed for ${foreignKeyFailures.length} row(s).`);
  }

  const migration = sqlite.prepare(`
    select version, name
    from devspace_schema_migrations
    order by version desc
    limit 1
  `).get() as { version: number; name: string } | undefined;
  if (
    migration?.version !== CURRENT_DATABASE_SCHEMA_VERSION ||
    migration.name !== CURRENT_DATABASE_SCHEMA_NAME
  ) {
    throw new Error("Database does not use the canonical DevSpace schema.");
  }

  const legacyWorkspaceColumns = sqlite.prepare(`
    select name
    from pragma_table_info('workspace_sessions')
    where name in ('owner_client_id')
  `).all() as Array<{ name: string }>;
  const legacyClientColumns = sqlite.prepare(`
    select name
    from pragma_table_info('oauth_clients')
    where name = 'principal_id'
  `).all() as Array<{ name: string }>;
  if (legacyWorkspaceColumns.length > 0 || legacyClientColumns.length > 0) {
    throw new Error("Canonical database still contains legacy owner columns.");
  }

  const invalidWorkspace = sqlite.prepare(`
    select id
    from workspace_sessions
    where connection_principal_id = '__legacy_unowned__'
       or alias is null
       or write_access not in ('read_only', 'read_write')
       or state_generation < 1
       or (status = 'active' and mode = 'checkout' and canonical_root is null)
    limit 1
  `).get() as { id: string } | undefined;
  if (invalidWorkspace) {
    throw new Error(`Canonical workspace invariant failed for ${invalidWorkspace.id}.`);
  }

  const invalidOperation = sqlite.prepare(`
    select operation.operation_id as operationId
    from mutation_operations as operation
    left join workspace_sessions as workspace
      on workspace.id = operation.workspace_id
     and workspace.connection_principal_id = operation.connection_principal_id
    where workspace.id is null
    limit 1
  `).get() as { operationId: string } | undefined;
  if (invalidOperation) {
    throw new Error(`Canonical mutation operation invariant failed for ${invalidOperation.operationId}.`);
  }

  const claimedCleanup = sqlite.prepare(`
    select count(*) as count
    from oauth_revocation_cleanup_jobs
    where status = 'claimed'
  `).get() as { count: number };
  if (claimedCleanup.count !== 0) {
    throw new Error("Canonical database contains cleanup claims owned by an earlier process.");
  }

  const grants = sqlite.prepare(`
    select grant_id as grantId, granted_scopes_json as scopesJson
    from oauth_grants
    where authorization_epoch < 1
       or not exists (
         select 1 from connection_principals as principal
         where principal.principal_id = oauth_grants.principal_id
           and principal.revoked_at is null
       )
  `).all() as Array<{ grantId: string; scopesJson: string }>;
  if (grants.length > 0) {
    throw new Error(`Canonical OAuth grant invariant failed for ${grants[0]!.grantId}.`);
  }

  for (const row of sqlite.prepare(`
    select grant_id as grantId, granted_scopes_json as scopesJson
    from oauth_grants
  `).all() as Array<{ grantId: string; scopesJson: string }>) {
    assertCanonicalScopes(row.scopesJson, `grant ${row.grantId}`);
  }

  for (const table of ["oauth_access_tokens", "oauth_refresh_tokens"] as const) {
    const rows = sqlite
      .prepare(`
        select
          token.token_hash as tokenHash,
          token.scopes_json as scopesJson,
          token.authorization_epoch as authorizationEpoch,
          grant.authorization_epoch as grantEpoch,
          grant.revoked_at as grantRevokedAt
        from ${table} as token
        left join oauth_grants as grant
          on grant.grant_id = token.grant_id
         and grant.principal_id = token.principal_id
         and grant.client_id = token.client_id
      `)
      .all() as Array<{
        tokenHash: string;
        scopesJson: string;
        authorizationEpoch: number;
        grantEpoch: number | null;
        grantRevokedAt: string | null;
      }>;
    for (const row of rows) {
      assertCanonicalScopes(row.scopesJson, `token ${row.tokenHash}`);
      if (
        row.grantEpoch === null ||
        row.grantRevokedAt !== null ||
        row.authorizationEpoch !== row.grantEpoch
      ) {
        throw new Error(`Canonical OAuth token grant invariant failed for ${row.tokenHash}.`);
      }
    }
  }

  assertNoRows(sqlite, `
    select token_hash
    from oauth_refresh_tokens
    where length(family_id) < 16 or length(family_id) > 128
  `, "OAuth refresh tokens must have a bounded family identifier");

  assertNoRows(sqlite, `
    select token_hash
    from oauth_refresh_token_tombstones
    where length(family_id) < 16
       or length(family_id) > 128
       or expires_at <= consumed_at
  `, "OAuth refresh-token tombstones must be bounded and expire after consumption");
}

function assertCanonicalScopes(scopesJson: string, context: string): void {
  const scopes = JSON.parse(scopesJson) as unknown;
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    scopes.some((scope) => !DEVSPACE_CAPABILITY_SCOPES.includes(scope as never))
  ) {
    throw new Error(`Canonical OAuth scope invariant failed for ${context}.`);
  }
}

function assertNoRows(
  sqlite: Database.Database,
  sql: string,
  message: string,
): void {
  if (sqlite.prepare(sql).get() !== undefined) throw new Error(message);
}
