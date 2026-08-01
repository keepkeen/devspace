import type Database from "better-sqlite3";
import { DEVSPACE_CAPABILITY_SCOPES } from "../oauth-scopes.js";

export const CURRENT_DATABASE_SCHEMA_VERSION = 25 as const;
export const CURRENT_DATABASE_SCHEMA_NAME = "canonical-state-v25-project-handoffs";
export const OWNER_PRINCIPAL_ID = "owner";

export function createCanonicalSchema(
  sqlite: Database.Database,
  options: { deferLegacyQuarantineSeal?: boolean } = {},
): void {
  sqlite.exec(`
    create table if not exists devspace_schema_migrations (
      version integer primary key,
      name text not null,
      applied_at text not null
    );

    create table if not exists connection_principals (
      principal_id text primary key check (principal_id = 'owner'),
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

    create table if not exists workspace_sessions (
      id text primary key,
      connection_principal_id text not null,
      alias text not null,
      root text not null,
      canonical_root text,
      status text not null check (status in ('active', 'closed', 'revoked')),
      write_access text not null check (write_access in ('read_only', 'read_write')),
      state_generation integer not null check (state_generation >= 1),
      created_at text not null,
      last_used_at text not null,
      foreign key (connection_principal_id)
        references connection_principals(principal_id),
      check (status != 'active' or canonical_root is not null)
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

    create table if not exists project_handoffs (
      handoff_id text primary key,
      project_ref text not null,
      project_fingerprint text not null,
      title text not null
        check (
          length(cast(title as blob)) between 1 and 256
          and instr(title, char(0)) = 0
        ),
      progress text not null
        check (
          length(cast(progress as blob)) between 1 and 8192
          and instr(progress, char(0)) = 0
        ),
      status text not null check (status in ('resumable', 'completed')),
      revision integer not null check (revision >= 1),
      created_at text not null,
      updated_at text not null,
      completed_at text,
      check (
        (status = 'completed' and completed_at is not null)
        or (status = 'resumable' and completed_at is null)
      )
    );

    create unique index if not exists project_handoffs_project_id_uq
      on project_handoffs(project_fingerprint, handoff_id);

    create index if not exists project_handoffs_project_status_idx
      on project_handoffs(project_fingerprint, status, updated_at desc, handoff_id);

    create table if not exists project_executions (
      execution_id text primary key,
      principal_id text not null,
      client_id text not null,
      grant_id text not null,
      authorization_epoch integer not null check (authorization_epoch >= 1),
      project_ref text not null,
      project_fingerprint text not null,
      source_root text not null,
      canonical_source_root text not null,
      workspace_id text,
      handoff_id text,
      handoff_retired integer not null default 0
        check (handoff_retired in (0, 1)),
      status text not null check (status in (
        'provisioning', 'active', 'revoked', 'quarantined', 'closed'
      )),
      state_generation integer not null check (state_generation >= 1),
      create_operation_id text not null,
      request_hash text not null,
      error text,
      created_at text not null,
      last_used_at text not null,
      updated_at text not null,
      foreign key (principal_id)
        references connection_principals(principal_id),
      foreign key (workspace_id)
        references workspace_sessions(id)
        on delete set null,
      foreign key (project_fingerprint, handoff_id)
        references project_handoffs(project_fingerprint, handoff_id),
      check (handoff_retired = 0 or handoff_id is null)
    );

    create unique index if not exists project_executions_create_operation_uq
      on project_executions(grant_id, authorization_epoch, create_operation_id);

    create index if not exists project_executions_authorization_idx
      on project_executions(
        principal_id, client_id, grant_id, authorization_epoch, status, last_used_at desc
      );

    create index if not exists project_executions_project_idx
      on project_executions(project_fingerprint, status, last_used_at desc);

    create index if not exists project_executions_handoff_idx
      on project_executions(handoff_id);

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
      primary key (connection_principal_id, workspace_id, operation_id),
      foreign key (workspace_id, connection_principal_id)
        references workspace_sessions(id, connection_principal_id)
        on delete cascade
    );

    create index if not exists mutation_operations_expires_at_idx
      on mutation_operations(expires_at);

    create index if not exists mutation_operations_state_updated_idx
      on mutation_operations(state, updated_at desc);

    create table if not exists apply_patch_changes (
      sequence integer primary key autoincrement,
      connection_principal_id text not null,
      workspace_id text not null,
      operation_id text not null,
      tool text not null default 'apply_patch' check (tool = 'apply_patch'),
      workspace_generation integer not null check (workspace_generation >= 1),
      applied_at text not null,
      patch text not null,
      files_json text not null,
      summary_json text not null,
      foreign key (connection_principal_id, workspace_id, operation_id)
        references mutation_operations(
          connection_principal_id, workspace_id, operation_id
        )
        on delete cascade
    );

    create unique index if not exists apply_patch_changes_operation_uq
      on apply_patch_changes(
        connection_principal_id, workspace_id, operation_id
      );

    create index if not exists apply_patch_changes_workspace_sequence_idx
      on apply_patch_changes(
        connection_principal_id, workspace_id, sequence
      );

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

    create table if not exists oauth_authorization_selections (
      token_hash text primary key,
      client_id text not null,
      authorization_session_key text not null,
      created_at integer not null,
      expires_at integer not null check (expires_at = created_at + 300000),
      foreign key (client_id)
        references oauth_clients(client_id)
        on delete cascade
    );

    create index if not exists oauth_authorization_selections_expires_idx
      on oauth_authorization_selections(expires_at);

    create table if not exists oauth_authorization_codes (
      code_hash text primary key,
      client_id text not null,
      grant_id text not null,
      principal_id text not null,
      authorization_epoch integer not null check (authorization_epoch >= 1),
      redirect_uri text not null,
      code_challenge text not null,
      scopes_json text not null,
      resource text,
      created_at integer not null,
      expires_at integer not null check (expires_at = created_at + 300000),
      foreign key (client_id)
        references oauth_clients(client_id)
        on delete cascade,
      foreign key (principal_id)
        references connection_principals(principal_id),
      foreign key (grant_id, principal_id, client_id)
        references oauth_grants(grant_id, principal_id, client_id)
        on delete cascade
    );

    create index if not exists oauth_authorization_codes_expires_idx
      on oauth_authorization_codes(expires_at);

    create index if not exists oauth_authorization_codes_client_id_idx
      on oauth_authorization_codes(client_id);

    create table if not exists oauth_revocation_cleanup_jobs (
      id integer primary key autoincrement,
      connection_principal_id text not null,
      workspace_id text not null,
      workspace_root text not null,
      project_execution_id text,
      status text not null check (status in ('pending', 'claimed', 'failed', 'completed')),
      claim_token text,
      lease_expires_at text,
      attempts integer not null check (attempts >= 0),
      last_error text,
      created_at text not null,
      updated_at text not null,
      completed_at text,
      foreign key (project_execution_id)
        references project_executions(execution_id),
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

    create unique index if not exists oauth_revocation_cleanup_jobs_execution_uq
      on oauth_revocation_cleanup_jobs(project_execution_id)
      where project_execution_id is not null;

    create table if not exists legacy_managed_worktree_artifacts (
      artifact_id integer primary key autoincrement,
      artifact_kind text not null check (artifact_kind in ('workspace', 'dirty_artifact')),
      source_schema_version integer not null check (source_schema_version >= 0),
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
      recorded_at text not null,
      check (dirty_source is null or dirty_source in ('true', 'false')),
      check (managed is null or managed in ('true', 'false')),
      check (
        previous_status is null
        or previous_status in ('active', 'closed', 'revoked')
      ),
      check (
        write_access is null
        or write_access in ('read_only', 'read_write')
      ),
      check (state_generation is null or state_generation >= 1),
      check (
        (artifact_kind = 'workspace'
          and legacy_alias is not null
          and previous_status is not null
          and state_generation is not null
          and workspace_created_at is not null
          and workspace_last_used_at is not null)
        or
        (artifact_kind = 'dirty_artifact'
          and legacy_job_id is not null
          and reason is not null)
      )
    );

    create index if not exists legacy_managed_worktree_artifacts_recorded_idx
      on legacy_managed_worktree_artifacts(recorded_at, artifact_id);

    create index if not exists legacy_managed_worktree_artifacts_workspace_idx
      on legacy_managed_worktree_artifacts(legacy_workspace_id, artifact_kind);

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

  if (!options.deferLegacyQuarantineSeal) {
    sealLegacyManagedWorktreeArtifacts(sqlite);
  }

  const now = new Date().toISOString();
  sqlite.prepare(`
    insert into connection_principals (
      principal_id, created_at, last_used_at, revoked_at
    ) values (?, ?, ?, null)
    on conflict(principal_id) do nothing
  `).run(OWNER_PRINCIPAL_ID, now, now);

  sqlite.prepare(`
    insert into devspace_schema_migrations (version, name, applied_at)
    values (?, ?, ?)
    on conflict(version) do update set
      name = excluded.name,
      applied_at = excluded.applied_at
  `).run(
    CURRENT_DATABASE_SCHEMA_VERSION,
    CURRENT_DATABASE_SCHEMA_NAME,
    now,
  );
}

export function sealLegacyManagedWorktreeArtifacts(sqlite: Database.Database): void {
  sqlite.exec(`
    create trigger if not exists legacy_managed_worktree_artifacts_no_insert
      before insert on legacy_managed_worktree_artifacts
      begin
        select raise(abort, 'legacy managed-worktree quarantine is read-only');
      end;

    create trigger if not exists legacy_managed_worktree_artifacts_no_update
      before update on legacy_managed_worktree_artifacts
      begin
        select raise(abort, 'legacy managed-worktree quarantine is read-only');
      end;

    create trigger if not exists legacy_managed_worktree_artifacts_no_delete
      before delete on legacy_managed_worktree_artifacts
      begin
        select raise(abort, 'legacy managed-worktree quarantine is read-only');
      end;
  `);
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
    where name in (
      'owner_client_id', 'mode', 'source_root', 'base_ref', 'base_sha',
      'dirty_source', 'managed'
    )
  `).all() as Array<{ name: string }>;
  const legacyCleanupColumns = sqlite.prepare(`
    select name
    from pragma_table_info('oauth_revocation_cleanup_jobs')
    where name in ('workspace_mode', 'source_root', 'managed', 'dirty_source')
  `).all() as Array<{ name: string }>;
  const legacyClientColumns = sqlite.prepare(`
    select name
    from pragma_table_info('oauth_clients')
    where name = 'principal_id'
  `).all() as Array<{ name: string }>;
  const legacyGrantColumns = sqlite.prepare(`
    select name
    from pragma_table_info('oauth_grants')
    where name in ('subject_hash', 'organization_hash')
  `).all() as Array<{ name: string }>;
  const legacyProjectExecutionColumns = sqlite.prepare(`
    select name
    from pragma_table_info('project_executions')
    where name in (
      'git_root', 'worktree_root', 'project_root', 'base_sha', 'branch_ref',
      'dirty_source'
    )
  `).all() as Array<{ name: string }>;
  if (
    legacyWorkspaceColumns.length > 0 ||
    legacyCleanupColumns.length > 0 ||
    legacyClientColumns.length > 0 ||
    legacyGrantColumns.length > 0 ||
    legacyProjectExecutionColumns.length > 0
  ) {
    throw new Error("Canonical database still contains legacy live-state columns.");
  }

  const forbiddenLegacyTable = sqlite.prepare(`
    select name from sqlite_master
    where type = 'table'
      and name in (
        'oauth_principal_reconnect_codes',
        'oauth_revocation_dirty_worktree_artifacts'
      )
    limit 1
  `).get() as { name: string } | undefined;
  if (forbiddenLegacyTable) {
    throw new Error(`Canonical database still contains the legacy ${forbiddenLegacyTable.name} table.`);
  }

  const quarantineTriggers = sqlite.prepare(`
    select count(*) as count
    from sqlite_master
    where type = 'trigger'
      and name in (
        'legacy_managed_worktree_artifacts_no_insert',
        'legacy_managed_worktree_artifacts_no_update',
        'legacy_managed_worktree_artifacts_no_delete'
      )
  `).get() as { count: number };
  if (quarantineTriggers.count !== 3) {
    throw new Error("Legacy managed-worktree quarantine is not sealed read-only.");
  }

  assertNoRows(sqlite, `
    select principal_id
    from connection_principals
    where principal_id != 'owner' or revoked_at is not null
  `, "Canonical database must retain only the active hidden Owner principal");

  const ownerCount = sqlite.prepare(`
    select count(*) as count from connection_principals
  `).get() as { count: number };
  if (ownerCount.count !== 1) {
    throw new Error("Canonical database must contain exactly one hidden Owner principal.");
  }

  const invalidWorkspace = sqlite.prepare(`
    select id
    from workspace_sessions
    where connection_principal_id = '__legacy_unowned__'
       or alias is null
       or write_access not in ('read_only', 'read_write')
       or state_generation < 1
       or (status = 'active' and canonical_root is null)
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

  const invalidApplyPatchChange = sqlite.prepare(`
    select change.operation_id as operationId
    from apply_patch_changes as change
    left join mutation_operations as operation
      on operation.connection_principal_id = change.connection_principal_id
     and operation.workspace_id = change.workspace_id
     and operation.operation_id = change.operation_id
    where operation.operation_id is null
       or operation.tool != 'apply_patch'
       or operation.state != 'settled'
       or operation.workspace_generation != change.workspace_generation
       or change.tool != 'apply_patch'
    limit 1
  `).get() as { operationId: string } | undefined;
  if (invalidApplyPatchChange) {
    throw new Error(
      `Canonical apply_patch change invariant failed for ${invalidApplyPatchChange.operationId}.`,
    );
  }

  const invalidExecution = sqlite.prepare(`
    select execution.execution_id as executionId
    from project_executions as execution
    left join project_handoffs as handoff
      on handoff.handoff_id = execution.handoff_id
     and handoff.project_fingerprint = execution.project_fingerprint
    where execution.authorization_epoch < 1
       or execution.state_generation < 1
       or (execution.handoff_id is not null and handoff.handoff_id is null)
       or execution.handoff_retired not in (0, 1)
       or (execution.handoff_retired = 1 and execution.handoff_id is not null)
    limit 1
  `).get() as { executionId: string } | undefined;
  if (invalidExecution) {
    throw new Error(`Canonical Project execution invariant failed for ${invalidExecution.executionId}.`);
  }

  const invalidHandoff = sqlite.prepare(`
    select handoff_id as handoffId
    from project_handoffs
    where revision < 1
       or status not in ('resumable', 'completed')
       or length(cast(title as blob)) not between 1 and 256
       or length(cast(progress as blob)) not between 1 and 8192
       or instr(title, char(0)) != 0
       or instr(progress, char(0)) != 0
       or (status = 'completed' and completed_at is null)
       or (status = 'resumable' and completed_at is not null)
    limit 1
  `).get() as { handoffId: string } | undefined;
  if (invalidHandoff) {
    throw new Error(`Canonical Project handoff invariant failed for ${invalidHandoff.handoffId}.`);
  }

  assertNoRows(sqlite, `
    select job.id
    from oauth_revocation_cleanup_jobs as job
    left join project_executions as execution
      on execution.execution_id = job.project_execution_id
    where job.project_execution_id is not null
      and execution.execution_id is null
    limit 1
  `, "Project execution cleanup jobs must retain their durable execution inventory");

  const claimedCleanup = sqlite.prepare(`
    select count(*) as count
    from oauth_revocation_cleanup_jobs
    where status = 'claimed'
  `).get() as { count: number };
  if (claimedCleanup.count !== 0) {
    throw new Error("Canonical database contains cleanup claims owned by an earlier process.");
  }

  assertNoRows(sqlite, `
    select artifact_id
    from legacy_managed_worktree_artifacts
    where source_schema_version >= ${CURRENT_DATABASE_SCHEMA_VERSION}
       or source_schema_version < 0
    limit 1
  `, "Legacy managed-worktree quarantine must identify an older source schema");

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

  for (const row of sqlite.prepare(`
    select code_hash as codeHash, scopes_json as scopesJson
    from oauth_authorization_codes
  `).all() as Array<{ codeHash: string; scopesJson: string }>) {
    assertCanonicalScopes(row.scopesJson, `authorization code ${row.codeHash}`);
  }

  assertNoRows(sqlite, `
    select token_hash
    from oauth_authorization_selections
    where expires_at != created_at + 300000
  `, "OAuth authorization selections must use the fixed five-minute lifetime");

  assertNoRows(sqlite, `
    select code_hash
    from oauth_authorization_codes
    where expires_at != created_at + 300000
  `, "OAuth authorization codes must use the fixed five-minute lifetime");
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
