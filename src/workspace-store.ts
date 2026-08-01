import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { and, eq, gt, lt, or } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  workspaceSessions,
  type WorkspaceSessionRow,
} from "./db/schema.js";

const MAX_CLEANUP_BATCH_SIZE = 10_000;

interface RevocationCleanupJobRow {
  id: number;
  connectionPrincipalId: string;
  workspaceId: string;
  workspaceRoot: string;
  projectExecutionId: string | null;
  status: RevocationCleanupJobStatus;
  claimToken: string | null;
  leaseExpiresAt: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface RevocationDirtyWorktreeArtifactRow {
  jobId: number;
  connectionPrincipalId: string;
  workspaceId: string;
  workspaceRoot: string;
  sourceRoot: string | null;
  reason: string;
  recordedAt: string;
}

export type WorkspaceStatus = "active" | "closed" | "revoked";
export type WorkspaceWriteAccess = "read_only" | "read_write";

export class WorkspaceQuotaError extends Error {
  readonly code: "active_workspace_quota";
  readonly publicText: string;

  constructor(
    code: "active_workspace_quota",
    publicText: string,
  ) {
    super(publicText);
    this.name = "WorkspaceQuotaError";
    this.code = code;
    this.publicText = publicText;
  }
}

export interface WorkspaceSession {
  id: string;
  connectionPrincipalId: string;
  alias: string;
  root: string;
  canonicalRoot?: string;
  status: WorkspaceStatus;
  writeAccess: WorkspaceWriteAccess;
  stateGeneration: number;
  createdAt: string;
  lastUsedAt: string;
}

export interface ActiveWorkspaceSummary {
  alias: string;
  writeAccess: WorkspaceWriteAccess;
  stateGeneration: number;
  createdAt: string;
  lastUsedAt: string;
}

export interface WorkspaceGenerationUpdate {
  id: string;
  connectionPrincipalId: string;
  stateGeneration: number;
}

export interface WorkspaceSessionCursor {
  lastUsedAt: string;
  id: string;
}

export type RevocationCleanupJobStatus = "pending" | "claimed" | "failed" | "completed";

export interface RevocationCleanupJob {
  id: number;
  connectionPrincipalId: string;
  workspaceId: string;
  workspaceRoot: string;
  projectExecutionId?: string;
  status: RevocationCleanupJobStatus;
  claimToken?: string;
  leaseExpiresAt?: string;
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface RevocationDirtyWorktreeArtifact {
  jobId: number;
  connectionPrincipalId: string;
  workspaceId: string;
  workspaceRoot: string;
  sourceRoot?: string;
  reason: string;
  recordedAt: string;
}

export interface RevocationHistoryCleanupResult {
  jobs: number;
  workspaceSessions: number;
}

export interface WorkspaceStore {
  createSession(input: {
    id: string;
    connectionPrincipalId: string;
    alias?: string;
    root: string;
    writeAccess?: WorkspaceWriteAccess;
    stateGeneration?: number;
  }): WorkspaceSession;
  createOrReuseCheckoutSession?(input: {
    id: string;
    connectionPrincipalId: string;
    alias?: string;
    root: string;
    canonicalRoot: string;
    writeAccess?: WorkspaceWriteAccess;
    replaceWriteAccess?: boolean;
    requestedAlias?: string | null;
    stateGeneration?: number;
  }): WorkspaceSession;
  getActiveSessionByAlias?(connectionPrincipalId: string, alias: string): WorkspaceSession | undefined;
  getSessionByAlias?(connectionPrincipalId: string, alias: string): WorkspaceSession | undefined;
  listActiveSessionSummaries?(connectionPrincipalId: string): ActiveWorkspaceSummary[];
  listSessions?(
    connectionPrincipalId?: string,
    statuses?: WorkspaceStatus[],
  ): WorkspaceSession[];
  updateStateGeneration?(
    id: string,
    connectionPrincipalId: string,
    stateGeneration: number,
  ): boolean;
  bumpStateGeneration?(id: string, connectionPrincipalId: string): number | undefined;
  bumpActiveStateGenerations?(connectionPrincipalId?: string): WorkspaceGenerationUpdate[];
  revokeSession?(id: string, connectionPrincipalId: string): number | undefined;
  listRevocationCleanupJobs?(limit?: number): RevocationCleanupJob[];
  claimRevocationCleanupJob?(
    id: number,
    options?: { leaseMs?: number; now?: number },
  ): RevocationCleanupJob | undefined;
  finalizeRevocationCleanupJob?(input: {
    id: number;
    claimToken: string;
    now?: number;
  }): boolean;
  listRevocationDirtyWorktreeArtifacts?(limit?: number): RevocationDirtyWorktreeArtifact[];
  failRevocationCleanupJob?(input: {
    id: number;
    claimToken: string;
    error: string;
    now?: number;
  }): boolean;
  cleanupRevocationHistory?(
    before: string,
    limit: number,
  ): RevocationHistoryCleanupResult;
  reactivateClosedSession?(
    id: string,
    connectionPrincipalId: string,
  ): number | undefined;
  getSession(id: string, connectionPrincipalId: string): WorkspaceSession | undefined;
  touchSession(id: string, connectionPrincipalId: string): void;
  closeSession(id: string, connectionPrincipalId: string): boolean;
  deleteSession(id: string, connectionPrincipalId: string): boolean;
  countActiveSessions?(connectionPrincipalId?: string): number;
  listActiveSessions?(connectionPrincipalId?: string): WorkspaceSession[];
  closeSessions?(sessions: Array<{ id: string; connectionPrincipalId: string }>): number;
  listExpiredSessions(
    before: string,
    limit: number,
    after?: WorkspaceSessionCursor,
  ): WorkspaceSession[];
  deleteClosedSessions?(before: string, limit: number): number;
  isReady(): boolean;
  close?(): void;
}

export class SqliteWorkspaceStore implements WorkspaceStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  createSession(input: {
    id: string;
    connectionPrincipalId: string;
    alias?: string;
    root: string;
    writeAccess?: WorkspaceWriteAccess;
    stateGeneration?: number;
  }): WorkspaceSession {
    const now = new Date().toISOString();
    const create = this.database.sqlite.transaction((): WorkspaceSession => {
      const session: WorkspaceSession = {
        id: input.id,
        connectionPrincipalId: input.connectionPrincipalId,
        alias: input.alias ?? generateWorkspaceAlias(
          this.database,
          input.connectionPrincipalId,
          input.root,
          input.id,
        ),
        root: input.root,
        status: "active",
        writeAccess: input.writeAccess ?? "read_write",
        stateGeneration: validateStateGeneration(input.stateGeneration ?? 1),
        createdAt: now,
        lastUsedAt: now,
      };
      this.database.db
        .insert(workspaceSessions)
        .values({
          id: session.id,
          connectionPrincipalId: session.connectionPrincipalId,
          alias: session.alias,
          root: session.root,
          canonicalRoot: resolve(session.root),
          status: session.status,
          writeAccess: session.writeAccess,
          stateGeneration: session.stateGeneration,
          createdAt: session.createdAt,
          lastUsedAt: session.lastUsedAt,
        })
        .run();
      return session;
    });
    return create.immediate();
  }

  createOrReuseCheckoutSession(input: {
    id: string;
    connectionPrincipalId: string;
    alias?: string;
    root: string;
    canonicalRoot: string;
    writeAccess?: WorkspaceWriteAccess;
    replaceWriteAccess?: boolean;
    requestedAlias?: string | null;
    stateGeneration?: number;
  }): WorkspaceSession {
    const now = new Date().toISOString();
    const writeAccess = input.writeAccess ?? "read_write";
    const stateGeneration = validateStateGeneration(input.stateGeneration ?? 1);
    const alias = input.alias ?? generateWorkspaceAlias(
      this.database,
      input.connectionPrincipalId,
      input.root,
      input.id,
    );
    const selectAlias = this.database.sqlite.prepare(`
      select
        id,
        connection_principal_id as connectionPrincipalId,
        alias,
        root,
        canonical_root as canonicalRoot,
        status,
        write_access as writeAccess,
        state_generation as stateGeneration,
        created_at as createdAt,
        last_used_at as lastUsedAt
      from workspace_sessions
      where connection_principal_id = @connectionPrincipalId
        and alias = @alias
      limit 1
    `);
    const updateExisting = this.database.sqlite.prepare(`
      update workspace_sessions
      set root = @root,
          canonical_root = @canonicalRoot,
          status = 'active',
          write_access = case
            when @replaceWriteAccess = 1 then @writeAccess
            else write_access
          end,
          state_generation = state_generation + case
            when @replaceWriteAccess = 1 and write_access != @writeAccess then 1
            else 0
          end,
          last_used_at = @now
      where id = @existingId
      returning
        id,
        connection_principal_id as connectionPrincipalId,
        alias,
        root,
        canonical_root as canonicalRoot,
        status,
        write_access as writeAccess,
        state_generation as stateGeneration,
        created_at as createdAt,
        last_used_at as lastUsedAt
    `);
    const insertCheckout = this.database.sqlite.prepare(`
      insert into workspace_sessions (
        id, connection_principal_id, alias, root, canonical_root, status,
        write_access, state_generation, created_at, last_used_at
      ) values (
        @id, @connectionPrincipalId, @alias, @root, @canonicalRoot, 'active',
        @writeAccess, @stateGeneration, @now, @now
      )
      on conflict(connection_principal_id, alias) do nothing
      returning
        id,
        connection_principal_id as connectionPrincipalId,
        alias,
        root,
        canonical_root as canonicalRoot,
        status,
        write_access as writeAccess,
        state_generation as stateGeneration,
        created_at as createdAt,
        last_used_at as lastUsedAt
    `);
    const getOrCreate = this.database.sqlite.transaction(
      (values: Omit<typeof input, "replaceWriteAccess" | "requestedAlias"> & {
        replaceWriteAccess: 0 | 1;
        requestedAlias: string | null;
        now: string;
      }): WorkspaceSessionRow => {
        const existing = selectAlias.get(values) as WorkspaceSessionRow | undefined;
        if (existing) {
          if (
            existing.status === "revoked" ||
            existing.canonicalRoot !== values.canonicalRoot
          ) {
            throw new Error(
              `Workspace alias ${values.alias} is already bound to another or revoked Project context.`,
            );
          }
          return updateExisting.get({
            ...values,
            existingId: existing.id,
          }) as WorkspaceSessionRow;
        }

        const inserted = insertCheckout.get({
          ...values,
        }) as WorkspaceSessionRow | undefined;
        if (inserted) return inserted;
        const concurrent = selectAlias.get(values) as WorkspaceSessionRow | undefined;
        if (!concurrent) throw new Error("Concurrent checkout workspace creation did not return a Workspace.");
        if (
          concurrent.status === "revoked" ||
          concurrent.canonicalRoot !== values.canonicalRoot
        ) {
          throw new Error(
            `Workspace alias ${values.alias} is already bound to another or revoked Project context.`,
          );
        }
        return concurrent;
      },
    );
    const row = getOrCreate.immediate({
      ...input,
      alias,
      writeAccess,
      replaceWriteAccess: input.replaceWriteAccess ? 1 : 0,
      requestedAlias: input.requestedAlias === undefined
        ? input.alias ?? null
        : input.requestedAlias,
      stateGeneration,
      now,
    });

    return rowToWorkspaceSession(row);
  }

  getActiveSessionByAlias(connectionPrincipalId: string, alias: string): WorkspaceSession | undefined {
    const row = this.database.db
      .select()
      .from(workspaceSessions)
      .where(and(
        eq(workspaceSessions.connectionPrincipalId, connectionPrincipalId),
        eq(workspaceSessions.alias, alias),
        eq(workspaceSessions.status, "active"),
      ))
      .get();
    return row ? rowToWorkspaceSession(row) : undefined;
  }

  getSessionByAlias(connectionPrincipalId: string, alias: string): WorkspaceSession | undefined {
    const row = this.database.db
      .select()
      .from(workspaceSessions)
      .where(and(
        eq(workspaceSessions.connectionPrincipalId, connectionPrincipalId),
        eq(workspaceSessions.alias, alias),
      ))
      .get();
    return row ? rowToWorkspaceSession(row) : undefined;
  }

  listSessions(
    connectionPrincipalId?: string,
    statuses: WorkspaceStatus[] = ["active"],
  ): WorkspaceSession[] {
    const normalizedStatuses = [...new Set(statuses)].filter(
      (status): status is WorkspaceStatus =>
        status === "active" || status === "closed" || status === "revoked",
    );
    if (normalizedStatuses.length === 0) return [];
    const statusCondition = or(
      ...normalizedStatuses.map((status) => eq(workspaceSessions.status, status)),
    );
    return this.database.db
      .select()
      .from(workspaceSessions)
      .where(connectionPrincipalId === undefined
        ? statusCondition
        : and(
            statusCondition,
            eq(workspaceSessions.connectionPrincipalId, connectionPrincipalId),
          ))
      .orderBy(workspaceSessions.lastUsedAt, workspaceSessions.id)
      .all()
      .map(rowToWorkspaceSession)
      .reverse();
  }

  listActiveSessionSummaries(connectionPrincipalId: string): ActiveWorkspaceSummary[] {
    return this.database.db
      .select()
      .from(workspaceSessions)
      .where(and(
        eq(workspaceSessions.connectionPrincipalId, connectionPrincipalId),
        eq(workspaceSessions.status, "active"),
      ))
      .orderBy(workspaceSessions.createdAt)
      .all()
      .map(rowToActiveWorkspaceSummary);
  }

  updateStateGeneration(
    id: string,
    connectionPrincipalId: string,
    stateGeneration: number,
  ): boolean {
    const result = this.database.db
      .update(workspaceSessions)
      .set({ stateGeneration: validateStateGeneration(stateGeneration) })
      .where(and(
        eq(workspaceSessions.id, id),
        eq(workspaceSessions.connectionPrincipalId, connectionPrincipalId),
        eq(workspaceSessions.status, "active"),
      ))
      .run();
    return result.changes > 0;
  }

  bumpStateGeneration(id: string, connectionPrincipalId: string): number | undefined {
    const row = this.database.sqlite.prepare(`
      update workspace_sessions
      set state_generation = state_generation + 1
      where id = ? and connection_principal_id = ? and status in ('active', 'closed')
      returning state_generation as stateGeneration
    `).get(id, connectionPrincipalId) as { stateGeneration: number } | undefined;
    return row?.stateGeneration;
  }

  bumpActiveStateGenerations(connectionPrincipalId?: string): WorkspaceGenerationUpdate[] {
    const statement = connectionPrincipalId === undefined
      ? this.database.sqlite.prepare(`
        update workspace_sessions
        set state_generation = state_generation + 1
        where status = 'active'
        returning id, connection_principal_id as connectionPrincipalId, state_generation as stateGeneration
      `)
      : this.database.sqlite.prepare(`
        update workspace_sessions
        set state_generation = state_generation + 1
        where status = 'active' and connection_principal_id = ?
        returning id, connection_principal_id as connectionPrincipalId, state_generation as stateGeneration
      `);
    const rows = (connectionPrincipalId === undefined
      ? statement.all()
      : statement.all(connectionPrincipalId)) as WorkspaceGenerationUpdate[];
    return rows.sort(compareGenerationUpdates);
  }

  revokeSession(id: string, connectionPrincipalId: string): number | undefined {
    const revoke = this.database.sqlite.transaction(() => {
      const now = new Date().toISOString();
      const row = this.database.sqlite.prepare(`
        update workspace_sessions
        set status = 'revoked',
            state_generation = state_generation + 1,
            last_used_at = ?
        where id = ? and connection_principal_id = ? and status in ('active', 'closed')
        returning state_generation as stateGeneration
      `).get(now, id, connectionPrincipalId) as
        | { stateGeneration: number }
        | undefined;
      if (!row) return undefined;
      this.database.sqlite.prepare(`
        insert into oauth_revocation_cleanup_jobs (
          connection_principal_id, workspace_id, workspace_root, status,
          claim_token, lease_expires_at, attempts, last_error, created_at,
          updated_at, completed_at
        )
        select
          connection_principal_id, id, root, 'pending',
          null, null, 0, null, @now, @now, null
        from workspace_sessions
        where id = @id and connection_principal_id = @connectionPrincipalId
        on conflict(connection_principal_id, workspace_id) do update set
          workspace_root = excluded.workspace_root,
          status = 'pending',
          claim_token = null,
          lease_expires_at = null,
          attempts = 0,
          last_error = null,
          updated_at = excluded.updated_at,
          completed_at = null
        where oauth_revocation_cleanup_jobs.status = 'completed'
      `).run({ now, id, connectionPrincipalId });
      return row;
    });
    const row = revoke.immediate();
    return row?.stateGeneration;
  }

  listRevocationCleanupJobs(limit = 100): RevocationCleanupJob[] {
    const rows = this.database.sqlite.prepare(`
      select
        id,
        connection_principal_id as connectionPrincipalId,
        workspace_id as workspaceId,
        workspace_root as workspaceRoot,
        project_execution_id as projectExecutionId,
        status,
        claim_token as claimToken,
        lease_expires_at as leaseExpiresAt,
        attempts,
        last_error as lastError,
        created_at as createdAt,
        updated_at as updatedAt,
        completed_at as completedAt
      from oauth_revocation_cleanup_jobs
      where status != 'completed'
      order by created_at, id
      limit ?
    `).all(cleanupBatchSize(limit)) as RevocationCleanupJobRow[];
    return rows.map(rowToRevocationCleanupJob);
  }

  claimRevocationCleanupJob(
    id: number,
    options: { leaseMs?: number; now?: number } = {},
  ): RevocationCleanupJob | undefined {
    const jobId = positiveInteger(id, "Revocation cleanup job id");
    const leaseMs = positiveInteger(options.leaseMs ?? 5 * 60_000, "Revocation cleanup lease");
    const nowMs = nonNegativeInteger(options.now ?? Date.now(), "Revocation cleanup clock");
    const now = new Date(nowMs).toISOString();
    const leaseExpiresAt = new Date(nowMs + leaseMs).toISOString();
    const claimToken = randomUUID();
    const row = this.database.sqlite.prepare(`
      update oauth_revocation_cleanup_jobs
      set status = 'claimed',
          claim_token = @claimToken,
          lease_expires_at = @leaseExpiresAt,
          attempts = attempts + 1,
          last_error = null,
          updated_at = @now
      where id = @id
        and (
          status in ('pending', 'failed')
          or (status = 'claimed' and lease_expires_at <= @now)
        )
      returning
        id,
        connection_principal_id as connectionPrincipalId,
        workspace_id as workspaceId,
        workspace_root as workspaceRoot,
        project_execution_id as projectExecutionId,
        status,
        claim_token as claimToken,
        lease_expires_at as leaseExpiresAt,
        attempts,
        last_error as lastError,
        created_at as createdAt,
        updated_at as updatedAt,
        completed_at as completedAt
    `).get({ id: jobId, claimToken, leaseExpiresAt, now }) as
      | RevocationCleanupJobRow
      | undefined;
    return row ? rowToRevocationCleanupJob(row) : undefined;
  }

  finalizeRevocationCleanupJob(input: {
    id: number;
    claimToken: string;
    now?: number;
  }): boolean {
    const id = positiveInteger(input.id, "Revocation cleanup job id");
    const claimToken = nonEmptyString(input.claimToken, "Revocation cleanup claim token");
    const now = new Date(nonNegativeInteger(input.now ?? Date.now(), "Revocation cleanup clock"))
      .toISOString();
    const finalize = this.database.sqlite.transaction(() => {
      const job = this.database.sqlite.prepare(`
        select
          id,
          connection_principal_id as connectionPrincipalId,
          workspace_id as workspaceId,
          workspace_root as workspaceRoot,
          project_execution_id as projectExecutionId,
          status,
          claim_token as claimToken,
          lease_expires_at as leaseExpiresAt,
          attempts,
          last_error as lastError,
          created_at as createdAt,
          updated_at as updatedAt,
          completed_at as completedAt
        from oauth_revocation_cleanup_jobs
        where id = ?
      `).get(id) as RevocationCleanupJobRow | undefined;
      if (!job) return false;
      if (job.status === "completed") return job.claimToken === claimToken;
      if (job.status !== "claimed" || job.claimToken !== claimToken) return false;
      const result = this.database.sqlite.prepare(`
        update oauth_revocation_cleanup_jobs
        set status = 'completed',
            claim_token = null,
            lease_expires_at = null,
            last_error = null,
            updated_at = @now,
            completed_at = @now
        where id = @id and status = 'claimed' and claim_token = @claimToken
      `).run({ id, claimToken, now });
      return result.changes === 1;
    });
    return finalize.immediate();
  }

  failRevocationCleanupJob(input: {
    id: number;
    claimToken: string;
    error: string;
    now?: number;
  }): boolean {
    const id = positiveInteger(input.id, "Revocation cleanup job id");
    const claimToken = nonEmptyString(input.claimToken, "Revocation cleanup claim token");
    const error = nonEmptyString(input.error, "Revocation cleanup error");
    const now = new Date(nonNegativeInteger(input.now ?? Date.now(), "Revocation cleanup clock"))
      .toISOString();
    const result = this.database.sqlite.prepare(`
      update oauth_revocation_cleanup_jobs
      set status = 'failed',
          claim_token = null,
          lease_expires_at = null,
          last_error = @error,
          updated_at = @now
      where id = @id
        and claim_token = @claimToken
        and status in ('claimed', 'failed')
    `).run({ id, claimToken, error, now });
    return result.changes === 1;
  }

  listRevocationDirtyWorktreeArtifacts(limit = 100): RevocationDirtyWorktreeArtifact[] {
    const rows = this.database.sqlite.prepare(`
      select
        legacy_job_id as jobId,
        coalesce(legacy_connection_principal_id, 'owner') as connectionPrincipalId,
        legacy_workspace_id as workspaceId,
        workspace_root as workspaceRoot,
        source_root as sourceRoot,
        reason,
        recorded_at as recordedAt
      from legacy_managed_worktree_artifacts
      where artifact_kind = 'dirty_artifact'
      order by recorded_at desc, artifact_id desc
      limit ?
    `).all(cleanupBatchSize(limit)) as RevocationDirtyWorktreeArtifactRow[];
    return rows.map(rowToRevocationDirtyWorktreeArtifact);
  }

  cleanupRevocationHistory(before: string, limit: number): RevocationHistoryCleanupResult {
    const boundedLimit = cleanupBatchSize(limit);
    const cutoff = validIsoDate(before, "Revocation history cutoff");
    const cleanup = this.database.sqlite.transaction(() => {
      const jobs = this.database.sqlite.prepare(`
        delete from oauth_revocation_cleanup_jobs
        where id in (
          select id
          from oauth_revocation_cleanup_jobs
          where status = 'completed' and completed_at < ?
          order by completed_at, id
          limit ?
        )
      `).run(cutoff, boundedLimit).changes;
      const workspaceSessions = this.database.sqlite.prepare(`
        delete from workspace_sessions
        where id in (
          select workspace.id
          from workspace_sessions as workspace
          where workspace.status = 'revoked'
            and workspace.last_used_at < @before
            and not exists (
              select 1
              from oauth_revocation_cleanup_jobs as job
              where job.connection_principal_id = workspace.connection_principal_id
                and job.workspace_id = workspace.id
                and job.status != 'completed'
            )
          order by workspace.last_used_at, workspace.id
          limit @limit
        )
      `).run({ before: cutoff, limit: boundedLimit }).changes;
      return { jobs, workspaceSessions };
    });
    return cleanup.immediate();
  }

  reactivateClosedSession(
    id: string,
    connectionPrincipalId: string,
  ): number | undefined {
    const reactivate = this.database.sqlite.transaction(() => {
      const closed = this.database.sqlite.prepare(`
        select 1
        from workspace_sessions
        where id = ? and connection_principal_id = ? and status = 'closed'
      `).get(id, connectionPrincipalId);
      if (!closed) return undefined;
      return this.database.sqlite.prepare(`
      update workspace_sessions
      set status = 'active',
          state_generation = state_generation + 1,
          last_used_at = ?
      where id = ? and connection_principal_id = ? and status = 'closed'
      returning state_generation as stateGeneration
      `).get(new Date().toISOString(), id, connectionPrincipalId) as
        | { stateGeneration: number }
        | undefined;
    });
    const row = reactivate.immediate();
    return row?.stateGeneration;
  }

  getSession(id: string, connectionPrincipalId: string): WorkspaceSession | undefined {
    const row = this.database.db
      .select()
      .from(workspaceSessions)
      .where(and(
        eq(workspaceSessions.id, id),
        eq(workspaceSessions.connectionPrincipalId, connectionPrincipalId),
        eq(workspaceSessions.status, "active"),
      ))
      .get();

    return row ? rowToWorkspaceSession(row) : undefined;
  }

  touchSession(id: string, connectionPrincipalId: string): void {
    this.database.db
      .update(workspaceSessions)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(and(
        eq(workspaceSessions.id, id),
        eq(workspaceSessions.connectionPrincipalId, connectionPrincipalId),
        eq(workspaceSessions.status, "active"),
      ))
      .run();
  }

  closeSession(id: string, connectionPrincipalId: string): boolean {
    const result = this.database.sqlite.prepare(`
      update workspace_sessions
      set status = 'closed',
          state_generation = state_generation + 1,
          last_used_at = ?
      where id = ? and connection_principal_id = ? and status = 'active'
    `).run(new Date().toISOString(), id, connectionPrincipalId);
    return result.changes > 0;
  }

  deleteSession(id: string, connectionPrincipalId: string): boolean {
    const result = this.database.db
      .delete(workspaceSessions)
      .where(and(
        eq(workspaceSessions.id, id),
        eq(workspaceSessions.connectionPrincipalId, connectionPrincipalId),
      ))
      .run();
    return result.changes > 0;
  }

  countActiveSessions(connectionPrincipalId?: string): number {
    const row = connectionPrincipalId === undefined
      ? this.database.sqlite
        .prepare("select count(*) as count from workspace_sessions where status = 'active'")
        .get()
      : this.database.sqlite
        .prepare("select count(*) as count from workspace_sessions where status = 'active' and connection_principal_id = ?")
        .get(connectionPrincipalId);
    return (row as { count: number }).count;
  }

  listActiveSessions(connectionPrincipalId?: string): WorkspaceSession[] {
    return this.database.db
      .select()
      .from(workspaceSessions)
      .where(connectionPrincipalId === undefined
        ? eq(workspaceSessions.status, "active")
        : and(
            eq(workspaceSessions.status, "active"),
            eq(workspaceSessions.connectionPrincipalId, connectionPrincipalId),
          ))
      .all()
      .map(rowToWorkspaceSession);
  }

  closeSessions(sessions: Array<{ id: string; connectionPrincipalId: string }>): number {
    if (sessions.length === 0) return 0;
    const now = new Date().toISOString();
    const close = this.database.sqlite.prepare(
      `update workspace_sessions
       set status = 'closed', last_used_at = ?
       where id = ? and connection_principal_id = ? and status = 'active'`,
    );
    const closeAll = this.database.sqlite.transaction(
      (entries: Array<{ id: string; connectionPrincipalId: string }>) => entries.reduce(
        (count, entry) => count + close.run(now, entry.id, entry.connectionPrincipalId).changes,
        0,
      ),
    );
    return closeAll.immediate(sessions);
  }

  listExpiredSessions(
    before: string,
    limit: number,
    after?: WorkspaceSessionCursor,
  ): WorkspaceSession[] {
    return this.database.db
      .select()
      .from(workspaceSessions)
      .where(and(
        eq(workspaceSessions.status, "active"),
        lt(workspaceSessions.lastUsedAt, before),
        after
          ? or(
              gt(workspaceSessions.lastUsedAt, after.lastUsedAt),
              and(
                eq(workspaceSessions.lastUsedAt, after.lastUsedAt),
                gt(workspaceSessions.id, after.id),
              ),
            )
          : undefined,
      ))
      .orderBy(workspaceSessions.lastUsedAt, workspaceSessions.id)
      .limit(cleanupBatchSize(limit))
      .all()
      .map(rowToWorkspaceSession);
  }

  deleteClosedSessions(before: string, limit: number): number {
    const result = this.database.sqlite.prepare(`
      delete from workspace_sessions
      where id in (
        select id
        from workspace_sessions
        where status = 'closed' and last_used_at < ?
        order by last_used_at
        limit ?
      )
    `).run(before, cleanupBatchSize(limit));
    return result.changes;
  }

  isReady(): boolean {
    try {
      this.database.sqlite.prepare("select 1").get();
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.database.close();
  }

}

export function createWorkspaceStore(stateDir: string): WorkspaceStore {
  return new SqliteWorkspaceStore(stateDir);
}

function rowToWorkspaceSession(row: WorkspaceSessionRow): WorkspaceSession {
  return {
    id: row.id,
    connectionPrincipalId: row.connectionPrincipalId,
    alias: row.alias,
    root: row.root,
    canonicalRoot: row.canonicalRoot ?? undefined,
    status: row.status,
    writeAccess: workspaceWriteAccess(row.writeAccess),
    stateGeneration: validateStateGeneration(row.stateGeneration),
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function rowToActiveWorkspaceSummary(row: WorkspaceSessionRow): ActiveWorkspaceSummary {
  return {
    alias: row.alias,
    writeAccess: workspaceWriteAccess(row.writeAccess),
    stateGeneration: validateStateGeneration(row.stateGeneration),
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function rowToRevocationCleanupJob(row: RevocationCleanupJobRow): RevocationCleanupJob {
  return {
    id: row.id,
    connectionPrincipalId: row.connectionPrincipalId,
    workspaceId: row.workspaceId,
    workspaceRoot: row.workspaceRoot,
    ...(row.projectExecutionId === null
      ? {}
      : { projectExecutionId: row.projectExecutionId }),
    status: row.status,
    ...(row.claimToken === null ? {} : { claimToken: row.claimToken }),
    ...(row.leaseExpiresAt === null ? {} : { leaseExpiresAt: row.leaseExpiresAt }),
    attempts: row.attempts,
    ...(row.lastError === null ? {} : { lastError: row.lastError }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.completedAt === null ? {} : { completedAt: row.completedAt }),
  };
}

function rowToRevocationDirtyWorktreeArtifact(
  row: RevocationDirtyWorktreeArtifactRow,
): RevocationDirtyWorktreeArtifact {
  return {
    jobId: row.jobId,
    connectionPrincipalId: row.connectionPrincipalId,
    workspaceId: row.workspaceId,
    workspaceRoot: row.workspaceRoot,
    ...(row.sourceRoot === null ? {} : { sourceRoot: row.sourceRoot }),
    reason: row.reason,
    recordedAt: row.recordedAt,
  };
}

function generateWorkspaceAlias(
  database: DatabaseHandle,
  connectionPrincipalId: string,
  identityPath: string,
  workspaceId: string,
): string {
  const pathName = basename(resolve(identityPath));
  const sanitized = pathName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLocaleLowerCase("en-US");
  const fallback = `workspace-${workspaceId.replace(/[^A-Za-z0-9]/gu, "").slice(0, 12) || "new"}`;
  const base = (sanitized || fallback).slice(0, 64);
  const used = new Set(
    (database.sqlite.prepare(`
      select alias from workspace_sessions where connection_principal_id = ?
    `).all(connectionPrincipalId) as Array<{ alias: string }>).map((row) => row.alias),
  );
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 1_000_000; suffix += 1) {
    const suffixText = `-${suffix}`;
    const candidate = `${base.slice(0, Math.max(1, 64 - suffixText.length))}${suffixText}`;
    if (!used.has(candidate)) return candidate;
  }
  return fallback.slice(0, 64);
}

function validateStateGeneration(stateGeneration: number): number {
  if (!Number.isInteger(stateGeneration) || stateGeneration < 1) {
    throw new Error("Workspace state generation must be a positive integer.");
  }
  return stateGeneration;
}

function workspaceWriteAccess(value: string): WorkspaceWriteAccess {
  if (value === "read_only" || value === "read_write") return value;
  throw new Error(`Unsupported Workspace write access: ${value}`);
}

function compareGenerationUpdates(
  left: WorkspaceGenerationUpdate,
  right: WorkspaceGenerationUpdate,
): number {
  return left.connectionPrincipalId.localeCompare(right.connectionPrincipalId) || left.id.localeCompare(right.id);
}

function cleanupBatchSize(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Workspace cleanup limit must be a positive integer.");
  }
  return Math.min(limit, MAX_CLEANUP_BATCH_SIZE);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function nonEmptyString(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function validIsoDate(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be an ISO date string.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${label} must be an ISO date string.`);
  }
  return parsed.toISOString();
}
