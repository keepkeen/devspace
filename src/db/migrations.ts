import type Database from "better-sqlite3";

interface Migration {
  version: number;
  name: string;
  up(sqlite: Database.Database): void;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "workspace-state",
    up: migrateWorkspaceState,
  },
  {
    version: 2,
    name: "oauth-state",
    up: migrateOAuthState,
  },
  {
    version: 3,
    name: "local-agent-sessions",
    up: migrateLocalAgentSessions,
  },
  {
    version: 4,
    name: "workspace-oauth-ownership",
    up: migrateWorkspaceOwnership,
  },
  {
    version: 5,
    name: "workspace-checkout-reuse",
    up: migrateWorkspaceCheckoutReuse,
  },
  {
    version: 6,
    name: "oauth-owner-credential",
    up: migrateOAuthOwnerCredential,
  },
  {
    version: 7,
    name: "workspace-resume-idempotency",
    up: migrateWorkspaceResumeIdempotency,
  },
  {
    version: 8,
    name: "workspace-generation-operation-identity",
    up: migrateWorkspaceGenerationOperationIdentity,
  },
  {
    version: 9,
    name: "workspace-worktree-source-state",
    up: migrateWorkspaceWorktreeSourceState,
  },
  {
    version: 10,
    name: "oauth-revocation-cleanup",
    up: migrateOAuthRevocationCleanup,
  },
  {
    version: 11,
    name: "connection-principals",
    up: migrateConnectionPrincipals,
  },
  {
    version: 12,
    name: "oauth-authorization-limits",
    up: migrateOAuthAuthorizationLimits,
  },
  {
    version: 13,
    name: "connection-principal-approval-lifecycle",
    up: migrateConnectionPrincipalApprovalLifecycle,
  },
];

export function migrateDatabase(sqlite: Database.Database): void {
  const migrate = sqlite.transaction(() => {
    sqlite.exec(`
      create table if not exists devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
    `);

    const applied = new Set(
      (
        sqlite.prepare("select version from devspace_schema_migrations").all() as Array<{
          version: number;
        }>
      ).map((row) => row.version),
    );
    const recordMigration = sqlite.prepare(
      "insert into devspace_schema_migrations (version, name, applied_at) values (?, ?, ?)",
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      migration.up(sqlite);
      recordMigration.run(migration.version, migration.name, new Date().toISOString());
    }
  });

  migrate.immediate();
}

function migrateWorkspaceState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_sessions (
      id text primary key,
      root text not null,
      status text not null default 'active',
      mode text not null default 'checkout',
      source_root text,
      base_ref text,
      base_sha text,
      dirty_source text not null default 'false',
      managed text not null default 'false',
      created_at text not null,
      last_used_at text not null
    );

    create index if not exists workspace_sessions_root_idx
      on workspace_sessions(root, last_used_at desc);

    create index if not exists workspace_sessions_status_idx
      on workspace_sessions(status, last_used_at desc);

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
  `);

  addColumnIfMissing(sqlite, "workspace_sessions", "mode", "text not null default 'checkout'");
  addColumnIfMissing(sqlite, "workspace_sessions", "source_root", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_ref", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_sha", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "dirty_source", "text not null default 'false'");
  addColumnIfMissing(sqlite, "workspace_sessions", "managed", "text not null default 'false'");
}

function migrateOAuthState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists oauth_clients (
      client_id text primary key,
      client_json text not null,
      issued_at integer not null
    );

    create index if not exists oauth_clients_issued_at_idx
      on oauth_clients(issued_at desc);

    create table if not exists oauth_access_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_access_tokens_client_id_idx
      on oauth_access_tokens(client_id);

    create index if not exists oauth_access_tokens_expires_at_idx
      on oauth_access_tokens(expires_at);

    create table if not exists oauth_refresh_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_refresh_tokens_client_id_idx
      on oauth_refresh_tokens(client_id);

    create index if not exists oauth_refresh_tokens_expires_at_idx
      on oauth_refresh_tokens(expires_at);
  `);
}

function migrateLocalAgentSessions(sqlite: Database.Database): void {
  sqlite.exec(`
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
  `);

  addColumnIfMissing(sqlite, "local_agent_sessions", "thinking", "text");
}

function migrateWorkspaceOwnership(sqlite: Database.Database): void {
  addColumnIfMissing(
    sqlite,
    "workspace_sessions",
    "owner_client_id",
    "text not null default '__legacy_unowned__'",
  );
  sqlite.exec(`
    create index if not exists workspace_sessions_owner_status_idx
      on workspace_sessions(owner_client_id, status, last_used_at desc);
  `);
}

function migrateWorkspaceCheckoutReuse(sqlite: Database.Database): void {
  // Keep existing rows nullable so duplicate legacy checkout sessions remain
  // intact. New sessions populate canonical_root and participate in the index.
  addColumnIfMissing(sqlite, "workspace_sessions", "canonical_root", "text");
  sqlite.exec(`
    create unique index if not exists workspace_sessions_active_checkout_owner_canonical_root_uq
      on workspace_sessions(owner_client_id, canonical_root)
      where canonical_root is not null and mode = 'checkout' and status = 'active';
  `);
}

function migrateOAuthOwnerCredential(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists oauth_owner_credential (
      id integer primary key check (id = 1),
      salt text not null,
      verifier text not null,
      updated_at text not null
    );
  `);
}

function migrateWorkspaceResumeIdempotency(sqlite: Database.Database): void {
  // Existing sessions receive the compatibility access level and initial
  // generation, while aliases remain nullable until first resumed/listed.
  addColumnIfMissing(sqlite, "workspace_sessions", "alias", "text");
  addColumnIfMissing(
    sqlite,
    "workspace_sessions",
    "write_access",
    "text not null default 'read_write' check (write_access in ('read_only', 'read_write'))",
  );
  addColumnIfMissing(
    sqlite,
    "workspace_sessions",
    "state_generation",
    "integer not null default 1 check (state_generation >= 1)",
  );

  sqlite.exec(`
    create unique index if not exists workspace_sessions_owner_alias_uq
      on workspace_sessions(owner_client_id, alias)
      where alias is not null;

    create trigger if not exists workspace_sessions_alias_immutable
      before update of alias on workspace_sessions
      when old.alias is not null and new.alias is not old.alias
      begin
        select raise(abort, 'workspace session alias is immutable');
      end;

    create table if not exists mutation_operations (
      owner_client_id text not null,
      workspace_id text not null,
      tool text not null,
      operation_id text not null,
      request_hash text not null,
      state text not null check (state in ('pending', 'settled', 'outcome_unknown')),
      result_json text,
      created_at text not null,
      updated_at text not null,
      expires_at text not null,
      primary key (owner_client_id, workspace_id, tool, operation_id),
      foreign key (workspace_id) references workspace_sessions(id) on delete cascade
    );

    create index if not exists mutation_operations_expires_at_idx
      on mutation_operations(expires_at);
  `);
}

function migrateWorkspaceGenerationOperationIdentity(sqlite: Database.Database): void {
  const invalidStatus = sqlite.prepare(`
    select status
    from workspace_sessions
    where status not in ('active', 'closed', 'revoked')
    order by status
    limit 1
  `).get() as { status: string } | undefined;
  if (invalidStatus) {
    throw new Error(
      `Cannot formalize workspace session statuses: unsupported status ${JSON.stringify(invalidStatus.status)}.`,
    );
  }

  sqlite.exec(`
    create unique index if not exists workspace_sessions_id_owner_uq
      on workspace_sessions(id, owner_client_id);

    create trigger if not exists workspace_sessions_status_insert_check
      before insert on workspace_sessions
      when new.status not in ('active', 'closed', 'revoked')
      begin
        select raise(abort, 'invalid workspace session status');
      end;

    create trigger if not exists workspace_sessions_status_update_check
      before update of status on workspace_sessions
      when new.status not in ('active', 'closed', 'revoked')
      begin
        select raise(abort, 'invalid workspace session status');
      end;

    create trigger if not exists workspace_sessions_revoked_terminal
      before update of status on workspace_sessions
      when old.status = 'revoked' and new.status != 'revoked'
      begin
        select raise(abort, 'revoked workspace session is terminal');
      end;

    create table mutation_operations_v8 (
      owner_client_id text not null,
      workspace_id text not null,
      tool text not null,
      operation_id text not null,
      workspace_generation integer not null check (workspace_generation >= 1),
      request_hash text not null,
      state text not null check (state in ('pending', 'settled', 'outcome_unknown')),
      result_json text,
      created_at text not null,
      updated_at text not null,
      expires_at text not null,
      primary key (owner_client_id, operation_id),
      foreign key (workspace_id, owner_client_id)
        references workspace_sessions(id, owner_client_id)
        on delete cascade
    );

    insert into mutation_operations_v8 (
      owner_client_id, workspace_id, tool, operation_id, workspace_generation,
      request_hash, state, result_json, created_at, updated_at, expires_at
    )
    select
      owner_client_id, workspace_id, tool, operation_id, workspace_generation,
      request_hash, state, result_json, created_at, updated_at, expires_at
    from (
      select
        operation.owner_client_id,
        operation.workspace_id,
        operation.tool,
        operation.operation_id,
        workspace.state_generation as workspace_generation,
        operation.request_hash,
        operation.state,
        operation.result_json,
        operation.created_at,
        operation.updated_at,
        operation.expires_at,
        row_number() over (
          partition by operation.owner_client_id, operation.operation_id
          order by
            case
              when operation.state = 'settled' and operation.result_json is not null then 3
              when operation.state = 'settled' then 2
              when operation.state = 'outcome_unknown' then 1
              else 0
            end desc,
            operation.updated_at desc,
            operation.created_at desc,
            operation.rowid desc
        ) as preference_rank
      from mutation_operations as operation
      inner join workspace_sessions as workspace
        on workspace.id = operation.workspace_id
       and workspace.owner_client_id = operation.owner_client_id
    ) as ranked
    where preference_rank = 1;

    drop table mutation_operations;
    alter table mutation_operations_v8 rename to mutation_operations;

    create index mutation_operations_expires_at_idx
      on mutation_operations(expires_at);
  `);
}

function migrateWorkspaceWorktreeSourceState(sqlite: Database.Database): void {
  addColumnIfMissing(
    sqlite,
    "workspace_sessions",
    "dirty_source",
    "text not null default 'false'",
  );
}

function migrateOAuthRevocationCleanup(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists oauth_revocation_cleanup_jobs (
      id integer primary key autoincrement,
      owner_client_id text not null,
      workspace_id text not null,
      workspace_root text not null,
      workspace_mode text not null check (workspace_mode in ('checkout', 'worktree')),
      source_root text,
      managed text not null check (managed in ('true', 'false')),
      dirty_source text not null check (dirty_source in ('true', 'false')),
      status text not null default 'pending'
        check (status in ('pending', 'claimed', 'failed', 'completed')),
      claim_token text,
      lease_expires_at text,
      attempts integer not null default 0 check (attempts >= 0),
      last_error text,
      created_at text not null,
      updated_at text not null,
      completed_at text,
      unique (owner_client_id, workspace_id),
      check (
        (status = 'claimed' and claim_token is not null and lease_expires_at is not null)
        or (status != 'claimed' and lease_expires_at is null)
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
      owner_client_id text not null,
      workspace_id text not null,
      workspace_root text not null,
      source_root text,
      reason text not null,
      recorded_at text not null
    );

    create index if not exists oauth_revocation_dirty_worktree_artifacts_recorded_idx
      on oauth_revocation_dirty_worktree_artifacts(recorded_at, job_id);
  `);
}

function migrateConnectionPrincipals(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists connection_principals (
      principal_id text primary key,
      created_at text not null,
      last_used_at text not null,
      revoked_at text
    );

    create index if not exists connection_principals_last_used_idx
      on connection_principals(last_used_at);

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
  `);

  addColumnIfMissing(sqlite, "oauth_clients", "principal_id", "text");
  const now = new Date().toISOString();
  sqlite.prepare(`
    insert into connection_principals (principal_id, created_at, last_used_at, revoked_at)
    select client_id, @now, @now, null
    from oauth_clients
    where principal_id is null
    on conflict(principal_id) do nothing
  `).run({ now });
  sqlite.prepare(`
    update oauth_clients
    set principal_id = client_id
    where principal_id is null
  `).run();

  sqlite.exec(`
    create index if not exists oauth_clients_principal_id_idx
      on oauth_clients(principal_id);

    create trigger if not exists oauth_clients_principal_insert_check
      before insert on oauth_clients
      when new.principal_id is not null
        and not exists (
          select 1 from connection_principals
          where principal_id = new.principal_id and revoked_at is null
        )
      begin
        select raise(abort, 'invalid connection principal');
      end;

    create trigger if not exists oauth_clients_principal_update_check
      before update of principal_id on oauth_clients
      when new.principal_id is not null
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
        select 1 from oauth_clients where principal_id = old.principal_id
      )
      or exists (
        select 1 from workspace_sessions where owner_client_id = old.principal_id
      )
      begin
        select raise(abort, 'connection principal still has retained state');
      end;
  `);
}

function migrateOAuthAuthorizationLimits(sqlite: Database.Database): void {
  sqlite.exec(`
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
  `);
}

function migrateConnectionPrincipalApprovalLifecycle(sqlite: Database.Database): void {
  sqlite.exec(`
    drop trigger if exists oauth_clients_principal_insert_check;
    drop trigger if exists oauth_clients_principal_update_check;
    drop trigger if exists connection_principals_delete_check;

    create trigger oauth_clients_principal_insert_check
      before insert on oauth_clients
      when new.principal_id is not null
        and not exists (
          select 1 from connection_principals
          where principal_id = new.principal_id and revoked_at is null
        )
      begin
        select raise(abort, 'invalid connection principal');
      end;

    create trigger oauth_clients_principal_update_check
      before update of principal_id on oauth_clients
      when new.principal_id is not null
        and not exists (
          select 1 from connection_principals
          where principal_id = new.principal_id and revoked_at is null
        )
      begin
        select raise(abort, 'invalid connection principal');
      end;

    create trigger connection_principals_delete_check
      before delete on connection_principals
      when exists (
        select 1 from oauth_clients where principal_id = old.principal_id
      )
      or exists (
        select 1 from workspace_sessions where owner_client_id = old.principal_id
      )
      begin
        select raise(abort, 'connection principal still has retained state');
      end;
  `);
}

function addColumnIfMissing(
  sqlite: Database.Database,
  table: "workspace_sessions" | "local_agent_sessions" | "oauth_clients",
  column: string,
  definition: string,
): void {
  const columns = sqlite.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((existingColumn) => existingColumn.name === column)) return;

  sqlite.exec(`alter table ${table} add column ${column} ${definition}`);
}
