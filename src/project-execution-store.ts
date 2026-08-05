import { randomUUID } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "./db/client.js";

export type ProjectExecutionStatus =
  | "provisioning"
  | "active"
  | "revoked"
  | "quarantined"
  | "closed";

export interface ProjectExecutionAuthorization {
  principalId: string;
  clientId: string;
  grantId: string;
  authorizationEpoch: number;
}

export interface ProjectExecutionGrantAuthorization {
  principalId: string;
  grantId: string;
  authorizationEpoch: number;
}

export interface ProjectExecution {
  executionId: string;
  principalId: string;
  clientId: string;
  grantId: string;
  authorizationEpoch: number;
  projectRef: string;
  projectFingerprint: string;
  sourceRoot: string;
  canonicalSourceRoot: string;
  workspaceId?: string;
  handoffId?: string;
  handoffRetired: boolean;
  status: ProjectExecutionStatus;
  stateGeneration: number;
  createOperationId: string;
  requestHash: string;
  error?: string;
  createdAt: string;
  lastUsedAt: string;
  updatedAt: string;
}

export interface ProjectExecutionRecoveryIdentity {
  projectRef: string;
  projectFingerprint: string;
  canonicalSourceRoot: string;
}

export interface ReserveProjectExecutionInput extends ProjectExecutionAuthorization {
  projectRef: string;
  projectFingerprint: string;
  sourceRoot: string;
  canonicalSourceRoot: string;
  handoffId?: string;
  createOperationId: string;
  requestHash: string;
}

export type ProjectExecutionReservation =
  | { status: "new"; execution: ProjectExecution }
  | { status: "replay"; execution: ProjectExecution }
  | { status: "conflict" };

export interface ActivateProjectExecutionInput {
  workspaceId: string;
  /** Internally verified managed checkout root. Defaults to the authorized source root. */
  workspaceRoot?: string;
}

export interface ProjectExecutionStoreOptions {
  now?: () => number;
  createExecutionId?: () => string;
}

export class ProjectExecutionHandoffUnavailableError extends Error {
  constructor() {
    super("Project handoff is not resumable for this Project");
    this.name = "ProjectExecutionHandoffUnavailableError";
  }
}

export interface ProjectExecutionCleanupJob {
  id: number;
  executionId: string;
  workspaceId: string;
  workspaceRoot: string;
}

export interface ProjectExecutionRevocationResult {
  executions: ProjectExecution[];
  workspaceCleanupJobs: ProjectExecutionCleanupJob[];
}

export interface ProjectExecutionDiagnostics {
  total: number;
  provisioning: number;
  active: number;
  revoked: number;
  quarantined: number;
  closed: number;
}

interface ProjectExecutionRow {
  execution_id: string;
  principal_id: string;
  client_id: string;
  grant_id: string;
  authorization_epoch: number;
  project_ref: string;
  project_fingerprint: string;
  source_root: string;
  canonical_source_root: string;
  workspace_id: string | null;
  handoff_id: string | null;
  handoff_retired: 0 | 1;
  status: ProjectExecutionStatus;
  state_generation: number;
  create_operation_id: string;
  request_hash: string;
  error: string | null;
  created_at: string;
  last_used_at: string;
  updated_at: string;
}

const MAX_ID_LENGTH = 1_024;
const MAX_PATH_LENGTH = 16_384;
const MAX_HASH_LENGTH = 1_024;
const MAX_ERROR_LENGTH = 8_192;

export class ProjectExecutionStore {
  private readonly database: DatabaseHandle;
  private readonly clock: () => number;
  private readonly createExecutionId: () => string;
  private closed = false;

  constructor(stateDir: string, options: ProjectExecutionStoreOptions = {}) {
    this.database = openDatabase(stateDir);
    this.clock = options.now ?? Date.now;
    this.createExecutionId = options.createExecutionId ?? randomUUID;
  }

  reserve(input: ReserveProjectExecutionInput): ProjectExecutionReservation {
    this.assertOpen();
    const normalized = validateReservation(input);
    const reserve = this.database.sqlite.transaction((): ProjectExecutionReservation => {
      const existing = this.database.sqlite.prepare(`
        select * from project_executions
        where grant_id = ? and authorization_epoch = ? and create_operation_id = ?
      `).get(
        normalized.grantId,
        normalized.authorizationEpoch,
        normalized.createOperationId,
      ) as ProjectExecutionRow | undefined;
      if (existing) {
        return reservationMatches(existing, normalized)
          ? { status: "replay", execution: mapRow(existing) }
          : { status: "conflict" };
      }

      const activeGrant = this.database.sqlite.prepare(`
        select 1
        from oauth_grants
        where grant_id = ? and principal_id = ? and client_id = ?
          and authorization_epoch = ? and revoked_at is null
          and (
            absolute_expires_at is null
            or absolute_expires_at > cast(strftime('%s','now') as integer)
          )
      `).get(
        normalized.grantId,
        normalized.principalId,
        normalized.clientId,
        normalized.authorizationEpoch,
      );
      if (!activeGrant) {
        throw new Error("Project execution authorization is not active");
      }

      const executionId = boundedString(
        this.createExecutionId(),
        "executionId",
        MAX_ID_LENGTH,
      );
      if (normalized.handoffId) {
        const handoff = this.database.sqlite.prepare(`
          select 1
          from project_handoffs
          where handoff_id = ? and project_fingerprint = ? and status = 'resumable'
        `).get(normalized.handoffId, normalized.projectFingerprint);
        if (!handoff) {
          throw new ProjectExecutionHandoffUnavailableError();
        }
      }
      const now = new Date(this.clock()).toISOString();
      this.database.sqlite.prepare(`
        insert into project_executions (
          execution_id, principal_id, client_id, grant_id, authorization_epoch,
          project_ref, project_fingerprint, source_root, canonical_source_root,
          workspace_id, handoff_id, handoff_retired, status, state_generation,
          create_operation_id, request_hash, error,
          created_at, last_used_at, updated_at
        ) values (
          ?, ?, ?, ?, ?, ?, ?, ?, ?,
          null, ?, 0, 'provisioning', 1,
          ?, ?, null, ?, ?, ?
        )
      `).run(
        executionId,
        normalized.principalId,
        normalized.clientId,
        normalized.grantId,
        normalized.authorizationEpoch,
        normalized.projectRef,
        normalized.projectFingerprint,
        normalized.sourceRoot,
        normalized.canonicalSourceRoot,
        normalized.handoffId ?? null,
        normalized.createOperationId,
        normalized.requestHash,
        now,
        now,
        now,
      );
      return {
        status: "new",
        execution: this.getRequired(executionId),
      };
    });
    return reserve.immediate();
  }

  findCreation(
    authorization: ProjectExecutionAuthorization,
    createOperationId: string,
  ): ProjectExecution | undefined {
    this.assertOpen();
    const auth = validateAuthorization(authorization);
    const operationId = boundedString(
      createOperationId,
      "createOperationId",
      MAX_ID_LENGTH,
    );
    const row = this.database.sqlite.prepare(`
      select *
      from project_executions
      where principal_id = ? and client_id = ? and grant_id = ?
        and authorization_epoch = ? and create_operation_id = ?
    `).get(...authorizationValues(auth), operationId) as ProjectExecutionRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  activate(
    executionId: string,
    authorization: ProjectExecutionAuthorization,
    input: ActivateProjectExecutionInput,
  ): ProjectExecution | undefined {
    this.assertOpen();
    const id = boundedString(executionId, "executionId", MAX_ID_LENGTH);
    const auth = validateAuthorization(authorization);
    const workspaceId = boundedString(input.workspaceId, "workspaceId", MAX_ID_LENGTH);
    const workspaceRoot = boundedString(
      input.workspaceRoot ?? this.getRequired(id).canonicalSourceRoot,
      "workspaceRoot",
      MAX_PATH_LENGTH,
    );
    const now = new Date(this.clock()).toISOString();
    const result = this.database.sqlite.prepare(`
      update project_executions
      set workspace_id = ?, status = 'active', error = null,
        state_generation = state_generation + 1, last_used_at = ?, updated_at = ?
      where execution_id = ? and principal_id = ? and client_id = ?
        and grant_id = ? and authorization_epoch = ?
        and (
          status = 'provisioning'
          or (status = 'active' and workspace_id is null)
        )
        and exists (
          select 1 from oauth_grants as grant
          where grant.grant_id = project_executions.grant_id
            and grant.principal_id = project_executions.principal_id
            and grant.client_id = project_executions.client_id
            and grant.authorization_epoch = project_executions.authorization_epoch
            and grant.revoked_at is null
            and (
              grant.absolute_expires_at is null
              or grant.absolute_expires_at > cast(strftime('%s','now') as integer)
            )
        )
        and exists (
          select 1 from workspace_sessions as workspace
          where workspace.id = ?
            and workspace.connection_principal_id = project_executions.principal_id
            and workspace.canonical_root = ?
            and workspace.status = 'active'
        )
    `).run(
      workspaceId,
      now,
      now,
      id,
      ...authorizationValues(auth),
      workspaceId,
      workspaceRoot,
    );
    return result.changes === 1 ? this.getRequired(id) : undefined;
  }

  resolveActive(
    executionId: string,
    authorization: ProjectExecutionAuthorization,
  ): ProjectExecution | undefined {
    this.assertOpen();
    const id = boundedString(executionId, "executionId", MAX_ID_LENGTH);
    const auth = validateAuthorization(authorization);
    const row = this.database.sqlite.prepare(`
      select execution.* from project_executions as execution
      join oauth_grants as grant
        on grant.grant_id = execution.grant_id
       and grant.principal_id = execution.principal_id
       and grant.client_id = execution.client_id
       and grant.authorization_epoch = execution.authorization_epoch
       and grant.revoked_at is null
       and (
         grant.absolute_expires_at is null
         or grant.absolute_expires_at > cast(strftime('%s','now') as integer)
       )
      where execution.execution_id = ? and execution.principal_id = ?
        and execution.client_id = ? and execution.grant_id = ?
        and execution.authorization_epoch = ? and execution.status = 'active'
    `).get(id, ...authorizationValues(auth)) as ProjectExecutionRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  findRecoveryIdentity(
    executionId: string,
  ): ProjectExecutionRecoveryIdentity | undefined {
    this.assertOpen();
    const id = boundedString(executionId, "executionId", MAX_ID_LENGTH);
    const row = this.database.sqlite.prepare(`
      select project_ref, project_fingerprint, canonical_source_root
      from project_executions
      where execution_id = ?
    `).get(id) as Pick<
      ProjectExecutionRow,
      "project_ref" | "project_fingerprint" | "canonical_source_root"
    > | undefined;
    return row
      ? {
          projectRef: row.project_ref,
          projectFingerprint: row.project_fingerprint,
          canonicalSourceRoot: row.canonical_source_root,
        }
      : undefined;
  }

  touch(
    executionId: string,
    authorization: ProjectExecutionAuthorization,
  ): ProjectExecution | undefined {
    this.assertOpen();
    const id = boundedString(executionId, "executionId", MAX_ID_LENGTH);
    const auth = validateAuthorization(authorization);
    const now = new Date(this.clock()).toISOString();
    const result = this.database.sqlite.prepare(`
      update project_executions
      set last_used_at = ?, updated_at = ?
      where execution_id = ? and principal_id = ? and client_id = ?
        and grant_id = ? and authorization_epoch = ? and status = 'active'
        and exists (
          select 1 from oauth_grants as grant
          where grant.grant_id = project_executions.grant_id
            and grant.principal_id = project_executions.principal_id
            and grant.client_id = project_executions.client_id
            and grant.authorization_epoch = project_executions.authorization_epoch
            and grant.revoked_at is null
            and (
              grant.absolute_expires_at is null
              or grant.absolute_expires_at > cast(strftime('%s','now') as integer)
            )
        )
    `).run(now, now, id, ...authorizationValues(auth));
    return result.changes === 1 ? this.getRequired(id) : undefined;
  }

  markRevoked(
    authorization: ProjectExecutionAuthorization,
    error?: string,
  ): number {
    this.assertOpen();
    const auth = validateAuthorization(authorization);
    const message = optionalBoundedString(error, "error", MAX_ERROR_LENGTH);
    const revoke = this.database.sqlite.transaction(() => {
      const rows = this.database.sqlite.prepare(`
        select * from project_executions
        where principal_id = ? and client_id = ? and grant_id = ?
          and authorization_epoch = ? and status in ('provisioning', 'active')
        order by created_at, execution_id
      `).all(...authorizationValues(auth)) as ProjectExecutionRow[];
      return this.revokeRows(rows, message).executions.length;
    });
    return revoke.immediate();
  }

  markRevokedGrant(
    authorization: ProjectExecutionGrantAuthorization,
    error?: string,
  ): number {
    this.assertOpen();
    const principalId = boundedString(
      authorization.principalId,
      "principalId",
      MAX_ID_LENGTH,
    );
    const grantId = boundedString(authorization.grantId, "grantId", MAX_ID_LENGTH);
    if (
      !Number.isSafeInteger(authorization.authorizationEpoch) ||
      authorization.authorizationEpoch < 1
    ) {
      throw new Error("authorizationEpoch must be a positive safe integer");
    }
    const message = optionalBoundedString(error, "error", MAX_ERROR_LENGTH);
    const revoke = this.database.sqlite.transaction(() => {
      const rows = this.database.sqlite.prepare(`
        select * from project_executions
        where principal_id = ? and grant_id = ? and authorization_epoch = ?
          and status in ('provisioning', 'active')
        order by created_at, execution_id
      `).all(
        principalId,
        grantId,
        authorization.authorizationEpoch,
      ) as ProjectExecutionRow[];
      return this.revokeRows(rows, message).executions.length;
    });
    return revoke.immediate();
  }

  reconcileAuthorizationBoundaries(
    nowSeconds = Math.floor(this.clock() / 1_000),
    error = "The Project execution authorization is absent, revoked, expired, or changed.",
  ): ProjectExecutionRevocationResult {
    this.assertOpen();
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
      throw new Error("nowSeconds must be a non-negative safe integer");
    }
    const message = optionalBoundedString(error, "error", MAX_ERROR_LENGTH);
    const reconcile = this.database.sqlite.transaction(() => {
      const rows = this.database.sqlite.prepare(`
        select execution.*
        from project_executions as execution
        left join oauth_grants as grant
          on grant.grant_id = execution.grant_id
         and grant.principal_id = execution.principal_id
         and grant.client_id = execution.client_id
        where execution.status in ('provisioning', 'active')
          and (
            grant.grant_id is null
            or grant.revoked_at is not null
            or grant.authorization_epoch != execution.authorization_epoch
            or (
              grant.absolute_expires_at is not null
              and grant.absolute_expires_at <= @nowSeconds
            )
          )
        order by execution.created_at, execution.execution_id
      `).all({ nowSeconds }) as ProjectExecutionRow[];
      return this.revokeRows(rows, message);
    });
    return reconcile.immediate();
  }

  listByAuthorization(
    authorization: ProjectExecutionAuthorization,
  ): ProjectExecution[] {
    this.assertOpen();
    const auth = validateAuthorization(authorization);
    return (this.database.sqlite.prepare(`
      select * from project_executions
      where principal_id = ? and client_id = ? and grant_id = ?
        and authorization_epoch = ?
      order by created_at, execution_id
    `).all(...authorizationValues(auth)) as ProjectExecutionRow[]).map(mapRow);
  }

  listOpen(): ProjectExecution[] {
    this.assertOpen();
    return (this.database.sqlite.prepare(`
      select * from project_executions
      where status in ('provisioning', 'active')
      order by last_used_at, execution_id
    `).all() as ProjectExecutionRow[]).map(mapRow);
  }

  diagnosticSnapshot(): ProjectExecutionDiagnostics {
    this.assertOpen();
    const row = this.database.sqlite.prepare(`
      select
        count(*) as total,
        coalesce(sum(status = 'provisioning'), 0) as provisioning,
        coalesce(sum(status = 'active'), 0) as active,
        coalesce(sum(status = 'revoked'), 0) as revoked,
        coalesce(sum(status = 'quarantined'), 0) as quarantined,
        coalesce(sum(status = 'closed'), 0) as closed
      from project_executions
    `).get() as ProjectExecutionDiagnostics;
    return row;
  }

  quarantine(executionId: string, error: string): ProjectExecution | undefined {
    return this.setTerminalStatus(executionId, "quarantined", error);
  }

  close(): void;
  close(executionId: string, error?: string): ProjectExecution | undefined;
  close(executionId?: string, error?: string): ProjectExecution | undefined | void {
    if (executionId !== undefined) {
      return this.setTerminalStatus(executionId, "closed", error);
    }
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private setTerminalStatus(
    executionId: string,
    status: "quarantined" | "closed",
    error?: string,
  ): ProjectExecution | undefined {
    this.assertOpen();
    const id = boundedString(executionId, "executionId", MAX_ID_LENGTH);
    const message = optionalBoundedString(error, "error", MAX_ERROR_LENGTH);
    const now = new Date(this.clock()).toISOString();
    const result = this.database.sqlite.prepare(`
      update project_executions
      set status = ?, error = ?,
        state_generation = state_generation + 1, updated_at = ?
      where execution_id = ? and status != 'closed'
    `).run(status, message, now, id);
    return result.changes === 1 ? this.getRequired(id) : undefined;
  }

  private revokeRows(
    rows: readonly ProjectExecutionRow[],
    error: string | null,
  ): ProjectExecutionRevocationResult {
    if (rows.length === 0) return { executions: [], workspaceCleanupJobs: [] };
    const now = new Date(this.clock()).toISOString();
    const executions: ProjectExecution[] = [];
    const cleanupById = new Map<number, ProjectExecutionCleanupJob>();
    for (const row of rows) {
      const updated = this.database.sqlite.prepare(`
        update project_executions
        set status = 'revoked', error = ?,
          state_generation = state_generation + 1, updated_at = ?
        where execution_id = ? and status in ('provisioning', 'active')
        returning *
      `).get(error, now, row.execution_id) as ProjectExecutionRow | undefined;
      if (!updated) continue;
      executions.push(mapRow(updated));
      if (updated.workspace_id === null) continue;
      const workspaceId = updated.workspace_id;
      this.database.sqlite.prepare(`
        update workspace_sessions
        set status = 'revoked',
            state_generation = state_generation + 1,
            last_used_at = @now
        where id = @workspaceId
          and connection_principal_id = @principalId
          and status in ('active', 'closed')
      `).run({
        workspaceId,
        principalId: updated.principal_id,
        now,
      });
      const workspace = this.database.sqlite.prepare(`
        select root
        from workspace_sessions
        where id = ? and connection_principal_id = ?
      `).get(
        workspaceId,
        updated.principal_id,
      ) as { root: string } | undefined;
      if (!workspace) continue;
      this.database.sqlite.prepare(`
        insert into oauth_revocation_cleanup_jobs (
          connection_principal_id, workspace_id, workspace_root,
          project_execution_id, status, claim_token, lease_expires_at,
          attempts, last_error, created_at, updated_at, completed_at
        ) values (
          @principalId, @workspaceId, @workspaceRoot,
          @executionId, 'pending', null, null,
          0, null, @now, @now, null
        )
        on conflict(connection_principal_id, workspace_id) do update set
          workspace_root = excluded.workspace_root,
          project_execution_id = excluded.project_execution_id,
          status = case
            when oauth_revocation_cleanup_jobs.status = 'completed' then 'pending'
            else oauth_revocation_cleanup_jobs.status
          end,
          claim_token = case
            when oauth_revocation_cleanup_jobs.status = 'completed' then null
            else oauth_revocation_cleanup_jobs.claim_token
          end,
          lease_expires_at = case
            when oauth_revocation_cleanup_jobs.status = 'completed' then null
            else oauth_revocation_cleanup_jobs.lease_expires_at
          end,
          attempts = case
            when oauth_revocation_cleanup_jobs.status = 'completed' then 0
            else oauth_revocation_cleanup_jobs.attempts
          end,
          last_error = case
            when oauth_revocation_cleanup_jobs.status = 'completed' then null
            else oauth_revocation_cleanup_jobs.last_error
          end,
          updated_at = excluded.updated_at,
          completed_at = null
      `).run({
        principalId: updated.principal_id,
        workspaceId,
        workspaceRoot: workspace.root,
        executionId: updated.execution_id,
        now,
      });
      const job = this.database.sqlite.prepare(`
        select id
        from oauth_revocation_cleanup_jobs
        where connection_principal_id = ? and workspace_id = ?
      `).get(updated.principal_id, workspaceId) as { id: number };
      cleanupById.set(job.id, {
        id: job.id,
        executionId: updated.execution_id,
        workspaceId,
        workspaceRoot: workspace.root,
      });
    }
    return {
      executions,
      workspaceCleanupJobs: [...cleanupById.values()],
    };
  }

  private getRequired(executionId: string): ProjectExecution {
    const row = this.database.sqlite.prepare(
      "select * from project_executions where execution_id = ?",
    ).get(executionId) as ProjectExecutionRow | undefined;
    if (!row) throw new Error("Project execution disappeared during update");
    return mapRow(row);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("ProjectExecutionStore is closed");
  }
}

function validateReservation(
  input: ReserveProjectExecutionInput,
): ReserveProjectExecutionInput {
  const auth = validateAuthorization(input);
  return {
    ...auth,
    projectRef: boundedString(input.projectRef, "projectRef", MAX_ID_LENGTH),
    projectFingerprint: boundedString(
      input.projectFingerprint,
      "projectFingerprint",
      MAX_HASH_LENGTH,
    ),
    sourceRoot: boundedString(input.sourceRoot, "sourceRoot", MAX_PATH_LENGTH),
    canonicalSourceRoot: boundedString(
      input.canonicalSourceRoot,
      "canonicalSourceRoot",
      MAX_PATH_LENGTH,
    ),
    ...(input.handoffId === undefined
      ? {}
      : { handoffId: boundedString(input.handoffId, "handoffId", MAX_ID_LENGTH) }),
    createOperationId: boundedString(
      input.createOperationId,
      "createOperationId",
      MAX_ID_LENGTH,
    ),
    requestHash: boundedString(input.requestHash, "requestHash", MAX_HASH_LENGTH),
  };
}

function validateAuthorization(
  input: ProjectExecutionAuthorization,
): ProjectExecutionAuthorization {
  if (!Number.isSafeInteger(input.authorizationEpoch) || input.authorizationEpoch < 1) {
    throw new Error("authorizationEpoch must be a positive safe integer");
  }
  return {
    principalId: boundedString(input.principalId, "principalId", MAX_ID_LENGTH),
    clientId: boundedString(input.clientId, "clientId", MAX_ID_LENGTH),
    grantId: boundedString(input.grantId, "grantId", MAX_ID_LENGTH),
    authorizationEpoch: input.authorizationEpoch,
  };
}

function authorizationValues(
  authorization: ProjectExecutionAuthorization,
): [string, string, string, number] {
  return [
    authorization.principalId,
    authorization.clientId,
    authorization.grantId,
    authorization.authorizationEpoch,
  ];
}

function reservationMatches(
  row: ProjectExecutionRow,
  input: ReserveProjectExecutionInput,
): boolean {
  return row.principal_id === input.principalId &&
    row.client_id === input.clientId &&
    row.request_hash === input.requestHash &&
    row.project_ref === input.projectRef &&
    row.project_fingerprint === input.projectFingerprint &&
    row.source_root === input.sourceRoot &&
    row.canonical_source_root === input.canonicalSourceRoot;
}

function mapRow(row: ProjectExecutionRow): ProjectExecution {
  return {
    executionId: row.execution_id,
    principalId: row.principal_id,
    clientId: row.client_id,
    grantId: row.grant_id,
    authorizationEpoch: row.authorization_epoch,
    projectRef: row.project_ref,
    projectFingerprint: row.project_fingerprint,
    sourceRoot: row.source_root,
    canonicalSourceRoot: row.canonical_source_root,
    ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
    ...(row.handoff_id === null ? {} : { handoffId: row.handoff_id }),
    handoffRetired: row.handoff_retired === 1,
    status: row.status,
    stateGeneration: row.state_generation,
    createOperationId: row.create_operation_id,
    requestHash: row.request_hash,
    ...(row.error === null ? {} : { error: row.error }),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    updatedAt: row.updated_at,
  };
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function optionalBoundedString(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  if (value === undefined) return null;
  return boundedString(value, label, maximum);
}
