import { randomUUID } from "node:crypto";
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
  workspaceMode: WorkspaceMode;
  sourceRoot: string | null;
  managed: string;
  dirtySource: string;
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

export type WorkspaceMode = "checkout" | "worktree";
export type WorkspaceStatus = "active" | "closed" | "revoked";
export type WorkspaceWriteAccess = "read_only" | "read_write";

export class WorkspaceQuotaError extends Error {
  readonly code: "active_workspace_quota" | "managed_worktree_quota";
  readonly publicText: string;

  constructor(
    code: "active_workspace_quota" | "managed_worktree_quota",
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
  alias?: string;
  root: string;
  canonicalRoot?: string;
  status: WorkspaceStatus;
  mode: WorkspaceMode;
  sourceRoot?: string;
  baseRef?: string;
  baseSha?: string;
  dirtySource: boolean;
  managed: boolean;
  writeAccess?: WorkspaceWriteAccess;
  stateGeneration?: number;
  createdAt: string;
  lastUsedAt: string;
}

export interface ActiveWorkspaceSummary {
  alias: string;
  mode: WorkspaceMode;
  managed: boolean;
  dirtySource?: boolean;
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
  workspaceMode: WorkspaceMode;
  sourceRoot?: string;
  managed: boolean;
  dirtySource: boolean;
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
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    dirtySource?: boolean;
    managed?: boolean;
    writeAccess?: WorkspaceWriteAccess;
    stateGeneration?: number;
    maxActiveSessionsPerClient?: number;
  }): WorkspaceSession;
  createOrReuseManagedSession?(input: {
    id: string;
    connectionPrincipalId: string;
    alias?: string;
    root: string;
    sourceRoot: string;
    baseRef: string;
    baseSha: string;
    dirtySource: boolean;
    forceNew?: boolean;
    stateGeneration?: number;
    maxActiveSessionsPerClient?: number;
  }): WorkspaceSession;
  findActiveManagedSession?(
    connectionPrincipalId: string,
    sourceRoot: string,
    baseSha: string,
  ): WorkspaceSession | undefined;
  findActiveManagedSessionsBySource?(
    connectionPrincipalId: string,
    sourceRoot: string,
  ): WorkspaceSession[];
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
    maxActiveSessionsPerClient?: number;
  }): WorkspaceSession;
  allocateSessionAlias?(id: string, connectionPrincipalId: string, alias?: string): string | undefined;
  getActiveSessionByAlias?(connectionPrincipalId: string, alias: string): WorkspaceSession | undefined;
  listActiveSessionSummaries?(connectionPrincipalId: string): ActiveWorkspaceSummary[];
  updateStateGeneration?(
    id: string,
    connectionPrincipalId: string,
    stateGeneration: number,
  ): boolean;
  updateManagedSessionBaseSha?(
    id: string,
    connectionPrincipalId: string,
    baseSha: string,
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
    retainedDirtyWorktreeReason?: string;
    now?: number;
  }): boolean;
  failRevocationCleanupJob?(input: {
    id: number;
    claimToken: string;
    error: string;
    now?: number;
  }): boolean;
  listRevocationDirtyWorktreeArtifacts?(limit?: number): RevocationDirtyWorktreeArtifact[];
  cleanupRevocationHistory?(
    before: string,
    limit: number,
  ): RevocationHistoryCleanupResult;
  reactivateClosedSession?(
    id: string,
    connectionPrincipalId: string,
    maxActiveSessionsPerClient?: number,
  ): number | undefined;
  getSession(id: string, connectionPrincipalId: string): WorkspaceSession | undefined;
  touchSession(id: string, connectionPrincipalId: string): void;
  closeSession(id: string, connectionPrincipalId: string): boolean;
  deleteSession(id: string, connectionPrincipalId: string): boolean;
  countManagedWorktrees(): number;
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
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    dirtySource?: boolean;
    managed?: boolean;
    writeAccess?: WorkspaceWriteAccess;
    stateGeneration?: number;
    maxActiveSessionsPerClient?: number;
  }): WorkspaceSession {
    const now = new Date().toISOString();
    const alias = input.alias ?? generateWorkspaceAlias();
    const session: WorkspaceSession = {
      id: input.id,
      connectionPrincipalId: input.connectionPrincipalId,
      alias,
      root: input.root,
      status: "active",
      mode: input.mode ?? "checkout",
      sourceRoot: input.sourceRoot,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      dirtySource: input.dirtySource ?? false,
      managed: input.managed ?? false,
      writeAccess: input.writeAccess ?? "read_write",
      stateGeneration: validateStateGeneration(input.stateGeneration ?? 1),
      createdAt: now,
      lastUsedAt: now,
    };

    const create = this.database.sqlite.transaction(() => {
      this.assertActiveSessionQuota(session.connectionPrincipalId, input.maxActiveSessionsPerClient);
      this.database.db
        .insert(workspaceSessions)
        .values({
          id: session.id,
          connectionPrincipalId: session.connectionPrincipalId,
          alias: session.alias,
          root: session.root,
          canonicalRoot: null,
          status: session.status,
          mode: session.mode,
          sourceRoot: session.sourceRoot ?? null,
          baseRef: session.baseRef ?? null,
          baseSha: session.baseSha ?? null,
          dirtySource: String(session.dirtySource),
          managed: String(session.managed),
          writeAccess: session.writeAccess,
          stateGeneration: session.stateGeneration,
          createdAt: session.createdAt,
          lastUsedAt: session.lastUsedAt,
        })
        .run();
    });
    create.immediate();

    return session;
  }

  createOrReuseManagedSession(input: {
    id: string;
    connectionPrincipalId: string;
    alias?: string;
    root: string;
    sourceRoot: string;
    baseRef: string;
    baseSha: string;
    dirtySource: boolean;
    forceNew?: boolean;
    stateGeneration?: number;
    maxActiveSessionsPerClient?: number;
  }): WorkspaceSession {
    const now = new Date().toISOString();
    const values = {
      ...input,
      alias: input.alias ?? generateWorkspaceAlias(),
      stateGeneration: validateStateGeneration(input.stateGeneration ?? 1),
      now,
    };
    const selectExisting = this.database.sqlite.prepare(`
      select
        id,
        owner_client_id as connectionPrincipalId,
        alias,
        root,
        canonical_root as canonicalRoot,
        status,
        mode,
        source_root as sourceRoot,
        base_ref as baseRef,
        base_sha as baseSha,
        dirty_source as dirtySource,
        managed,
        write_access as writeAccess,
        state_generation as stateGeneration,
        created_at as createdAt,
        last_used_at as lastUsedAt
      from workspace_sessions
      where owner_client_id = @connectionPrincipalId
        and source_root = @sourceRoot
        and base_sha = @baseSha
        and mode = 'worktree'
        and managed = 'true'
        and status = 'active'
      order by last_used_at desc
      limit 1
    `);
    const insertManaged = this.database.sqlite.prepare(`
      insert into workspace_sessions (
        id, owner_client_id, alias, root, canonical_root, status, mode,
        source_root, base_ref, base_sha, dirty_source, managed, write_access,
        state_generation, created_at, last_used_at
      ) values (
        @id, @connectionPrincipalId, @alias, @root, null, 'active', 'worktree',
        @sourceRoot, @baseRef, @baseSha, @dirtySource, 'true', 'read_write',
        @stateGeneration, @now, @now
      )
      returning
        id,
        owner_client_id as connectionPrincipalId,
        alias,
        root,
        canonical_root as canonicalRoot,
        status,
        mode,
        source_root as sourceRoot,
        base_ref as baseRef,
        base_sha as baseSha,
        dirty_source as dirtySource,
        managed,
        write_access as writeAccess,
        state_generation as stateGeneration,
        created_at as createdAt,
        last_used_at as lastUsedAt
    `);
    const createOrReuse = this.database.sqlite.transaction((): WorkspaceSessionRow => {
      if (!input.forceNew) {
        const existing = selectExisting.get(values) as WorkspaceSessionRow | undefined;
        if (existing) return existing;
      }
      this.assertActiveSessionQuota(input.connectionPrincipalId, input.maxActiveSessionsPerClient);
      return insertManaged.get({
        ...values,
        dirtySource: String(input.dirtySource),
      }) as WorkspaceSessionRow;
    });

    return rowToWorkspaceSession(createOrReuse.immediate());
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
    maxActiveSessionsPerClient?: number;
  }): WorkspaceSession {
    const now = new Date().toISOString();
    const alias = input.alias ?? generateWorkspaceAlias();
    const writeAccess = input.writeAccess ?? "read_write";
    const stateGeneration = validateStateGeneration(input.stateGeneration ?? 1);
    const selectCanonical = this.database.sqlite.prepare(`
      select
        id,
        owner_client_id as connectionPrincipalId,
        alias,
        root,
        canonical_root as canonicalRoot,
        status,
        mode,
        source_root as sourceRoot,
        base_ref as baseRef,
        base_sha as baseSha,
        dirty_source as dirtySource,
        managed,
        write_access as writeAccess,
        state_generation as stateGeneration,
        created_at as createdAt,
        last_used_at as lastUsedAt
      from workspace_sessions
      where owner_client_id = @connectionPrincipalId
        and canonical_root = @canonicalRoot
        and mode = 'checkout'
        and status in ('active', 'closed')
      order by case status when 'active' then 0 else 1 end, last_used_at desc
      limit 1
    `);
    const selectLegacy = this.database.sqlite.prepare(`
      select id, alias, status
      from workspace_sessions
      where owner_client_id = @connectionPrincipalId
        and root = @root
        and canonical_root is null
        and mode = 'checkout'
        and status in ('active', 'closed')
      order by last_used_at desc
      limit 1
    `);
    const updateExisting = this.database.sqlite.prepare(`
      update workspace_sessions
      set root = @root,
          canonical_root = @canonicalRoot,
          status = 'active',
          alias = coalesce(alias, @alias),
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
        owner_client_id as connectionPrincipalId,
        alias,
        root,
        canonical_root as canonicalRoot,
        status,
        mode,
        source_root as sourceRoot,
        base_ref as baseRef,
        base_sha as baseSha,
        dirty_source as dirtySource,
        managed,
        write_access as writeAccess,
        state_generation as stateGeneration,
        created_at as createdAt,
        last_used_at as lastUsedAt
    `);
    const insertCheckout = this.database.sqlite.prepare(`
      insert into workspace_sessions (
        id, owner_client_id, alias, root, canonical_root, status, mode, managed,
        write_access, state_generation, created_at, last_used_at
      ) values (
        @id, @connectionPrincipalId, @alias, @root, @canonicalRoot, 'active', 'checkout', 'false',
        @writeAccess, @stateGeneration, @now, @now
      )
      on conflict(owner_client_id, canonical_root)
        where canonical_root is not null and mode = 'checkout' and status = 'active'
      do update set
        root = excluded.root,
        alias = coalesce(workspace_sessions.alias, excluded.alias),
        write_access = case
          when @replaceWriteAccess = 1 then excluded.write_access
          else workspace_sessions.write_access
        end,
        state_generation = workspace_sessions.state_generation + case
          when @replaceWriteAccess = 1
            and workspace_sessions.write_access != excluded.write_access then 1
          else 0
        end,
        last_used_at = excluded.last_used_at
      where @requestedAlias is null
        or workspace_sessions.alias is null
        or workspace_sessions.alias = @requestedAlias
      returning
        id,
        owner_client_id as connectionPrincipalId,
        alias,
        root,
        canonical_root as canonicalRoot,
        status,
        mode,
        source_root as sourceRoot,
        base_ref as baseRef,
        base_sha as baseSha,
        managed,
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
        const existing = selectCanonical.get(values) as WorkspaceSessionRow | undefined;
        if (existing) {
          if (
            values.requestedAlias !== null
            && existing.alias !== null
            && existing.alias !== values.requestedAlias
          ) {
            return existing;
          }
          if (existing.status === "closed") {
            this.assertActiveSessionQuota(values.connectionPrincipalId, values.maxActiveSessionsPerClient);
          }
          return updateExisting.get({
            ...values,
            existingId: existing.id,
          }) as WorkspaceSessionRow;
        }

        const legacy = selectLegacy.get(values) as
          | Pick<WorkspaceSessionRow, "id" | "alias" | "status">
          | undefined;
        if (legacy) {
          if (
            values.requestedAlias !== null
            && legacy.alias !== null
            && legacy.alias !== values.requestedAlias
          ) {
            return this.database.sqlite.prepare(`
              select
                id,
                owner_client_id as connectionPrincipalId,
                alias,
                root,
                canonical_root as canonicalRoot,
                status,
                mode,
                source_root as sourceRoot,
                base_ref as baseRef,
                base_sha as baseSha,
                dirty_source as dirtySource,
                managed,
                write_access as writeAccess,
                state_generation as stateGeneration,
                created_at as createdAt,
                last_used_at as lastUsedAt
              from workspace_sessions
              where id = @id
            `).get(legacy) as WorkspaceSessionRow;
          }
          if (legacy.status === "closed") {
            this.assertActiveSessionQuota(values.connectionPrincipalId, values.maxActiveSessionsPerClient);
          }
          return updateExisting.get({
            ...values,
            existingId: legacy.id,
          }) as WorkspaceSessionRow;
        }

        this.assertActiveSessionQuota(values.connectionPrincipalId, values.maxActiveSessionsPerClient);

        const inserted = insertCheckout.get(values) as WorkspaceSessionRow | undefined;
        if (inserted) return inserted;
        return selectCanonical.get(values) as WorkspaceSessionRow;
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

  findActiveManagedSession(
    connectionPrincipalId: string,
    sourceRoot: string,
    baseSha: string,
  ): WorkspaceSession | undefined {
    const row = this.database.db
      .select()
      .from(workspaceSessions)
      .where(and(
        eq(workspaceSessions.connectionPrincipalId, connectionPrincipalId),
        eq(workspaceSessions.sourceRoot, sourceRoot),
        eq(workspaceSessions.baseSha, baseSha),
        eq(workspaceSessions.mode, "worktree"),
        eq(workspaceSessions.managed, "true"),
        eq(workspaceSessions.status, "active"),
      ))
      .orderBy(workspaceSessions.lastUsedAt)
      .get();
    return row ? rowToWorkspaceSession(row) : undefined;
  }

  findActiveManagedSessionsBySource(
    connectionPrincipalId: string,
    sourceRoot: string,
  ): WorkspaceSession[] {
    return this.database.db
      .select()
      .from(workspaceSessions)
      .where(and(
        eq(workspaceSessions.connectionPrincipalId, connectionPrincipalId),
        eq(workspaceSessions.sourceRoot, sourceRoot),
        eq(workspaceSessions.mode, "worktree"),
        eq(workspaceSessions.managed, "true"),
        eq(workspaceSessions.status, "active"),
      ))
      .orderBy(workspaceSessions.lastUsedAt)
      .all()
      .map(rowToWorkspaceSession)
      .reverse();
  }

  allocateSessionAlias(id: string, connectionPrincipalId: string, alias = generateWorkspaceAlias()): string | undefined {
    const row = this.database.sqlite.prepare(`
      update workspace_sessions
      set alias = coalesce(alias, @alias)
      where id = @id and owner_client_id = @connectionPrincipalId and status = 'active'
      returning alias
    `).get({ id, connectionPrincipalId, alias }) as { alias: string } | undefined;
    return row?.alias;
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

  listActiveSessionSummaries(connectionPrincipalId: string): ActiveWorkspaceSummary[] {
    const allocateMissingAliases = this.database.sqlite.transaction(() => {
      const rows = this.database.sqlite.prepare(`
        select id
        from workspace_sessions
        where owner_client_id = ? and status = 'active' and alias is null
      `).all(connectionPrincipalId) as Array<{ id: string }>;
      for (const row of rows) {
        this.allocateSessionAlias(row.id, connectionPrincipalId);
      }
    });
    allocateMissingAliases.immediate();

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

  updateManagedSessionBaseSha(
    id: string,
    connectionPrincipalId: string,
    baseSha: string,
  ): boolean {
    if (!/^[0-9a-f]{40,64}$/u.test(baseSha)) {
      throw new Error("Managed workspace base SHA must be a full hexadecimal commit ID.");
    }
    const result = this.database.sqlite.prepare(`
      update workspace_sessions
      set base_sha = ?, last_used_at = ?
      where id = ?
        and owner_client_id = ?
        and status = 'active'
        and mode = 'worktree'
        and managed = 'true'
    `).run(baseSha, new Date().toISOString(), id, connectionPrincipalId);
    return result.changes > 0;
  }

  bumpStateGeneration(id: string, connectionPrincipalId: string): number | undefined {
    const row = this.database.sqlite.prepare(`
      update workspace_sessions
      set state_generation = state_generation + 1
      where id = ? and owner_client_id = ? and status in ('active', 'closed')
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
        returning id, owner_client_id as connectionPrincipalId, state_generation as stateGeneration
      `)
      : this.database.sqlite.prepare(`
        update workspace_sessions
        set state_generation = state_generation + 1
        where status = 'active' and owner_client_id = ?
        returning id, owner_client_id as connectionPrincipalId, state_generation as stateGeneration
      `);
    const rows = (connectionPrincipalId === undefined
      ? statement.all()
      : statement.all(connectionPrincipalId)) as WorkspaceGenerationUpdate[];
    return rows.sort(compareGenerationUpdates);
  }

  revokeSession(id: string, connectionPrincipalId: string): number | undefined {
    const row = this.database.sqlite.prepare(`
      update workspace_sessions
      set status = 'revoked',
          state_generation = state_generation + 1,
          last_used_at = ?
      where id = ? and owner_client_id = ? and status in ('active', 'closed')
      returning state_generation as stateGeneration
    `).get(new Date().toISOString(), id, connectionPrincipalId) as
      | { stateGeneration: number }
      | undefined;
    return row?.stateGeneration;
  }

  listRevocationCleanupJobs(limit = 100): RevocationCleanupJob[] {
    const rows = this.database.sqlite.prepare(`
      select
        id,
        owner_client_id as connectionPrincipalId,
        workspace_id as workspaceId,
        workspace_root as workspaceRoot,
        workspace_mode as workspaceMode,
        source_root as sourceRoot,
        managed,
        dirty_source as dirtySource,
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
        owner_client_id as connectionPrincipalId,
        workspace_id as workspaceId,
        workspace_root as workspaceRoot,
        workspace_mode as workspaceMode,
        source_root as sourceRoot,
        managed,
        dirty_source as dirtySource,
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
    retainedDirtyWorktreeReason?: string;
    now?: number;
  }): boolean {
    const id = positiveInteger(input.id, "Revocation cleanup job id");
    const claimToken = nonEmptyString(input.claimToken, "Revocation cleanup claim token");
    const now = new Date(nonNegativeInteger(input.now ?? Date.now(), "Revocation cleanup clock"))
      .toISOString();
    const reason = input.retainedDirtyWorktreeReason === undefined
      ? undefined
      : nonEmptyString(input.retainedDirtyWorktreeReason, "Dirty worktree retention reason");
    const finalize = this.database.sqlite.transaction(() => {
      const job = this.database.sqlite.prepare(`
        select
          id,
          owner_client_id as connectionPrincipalId,
          workspace_id as workspaceId,
          workspace_root as workspaceRoot,
          workspace_mode as workspaceMode,
          source_root as sourceRoot,
          managed,
          dirty_source as dirtySource,
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

      if (reason !== undefined) {
        if (job.workspaceMode !== "worktree" || job.managed !== "true") {
          throw new Error("Only managed worktree cleanup jobs can retain a dirty worktree artifact.");
        }
        this.database.sqlite.prepare(`
          insert into oauth_revocation_dirty_worktree_artifacts (
            job_id, owner_client_id, workspace_id, workspace_root,
            source_root, reason, recorded_at
          ) values (?, ?, ?, ?, ?, ?, ?)
          on conflict(job_id) do update set
            reason = excluded.reason,
            recorded_at = excluded.recorded_at
        `).run(
          job.id,
          job.connectionPrincipalId,
          job.workspaceId,
          job.workspaceRoot,
          job.sourceRoot,
          reason,
          now,
        );
      }
      const result = this.database.sqlite.prepare(`
        update oauth_revocation_cleanup_jobs
        set status = 'completed',
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
        job_id as jobId,
        owner_client_id as connectionPrincipalId,
        workspace_id as workspaceId,
        workspace_root as workspaceRoot,
        source_root as sourceRoot,
        reason,
        recorded_at as recordedAt
      from oauth_revocation_dirty_worktree_artifacts
      order by recorded_at desc, job_id desc
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
              where job.owner_client_id = workspace.owner_client_id
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
    maxActiveSessionsPerClient?: number,
  ): number | undefined {
    const reactivate = this.database.sqlite.transaction(() => {
      const closed = this.database.sqlite.prepare(`
        select 1
        from workspace_sessions
        where id = ? and owner_client_id = ? and status = 'closed'
      `).get(id, connectionPrincipalId);
      if (!closed) return undefined;
      this.assertActiveSessionQuota(connectionPrincipalId, maxActiveSessionsPerClient);
      return this.database.sqlite.prepare(`
      update workspace_sessions
      set status = 'active',
          state_generation = state_generation + 1,
          last_used_at = ?
      where id = ? and owner_client_id = ? and status = 'closed'
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
      where id = ? and owner_client_id = ? and status = 'active'
    `).run(new Date().toISOString(), id, connectionPrincipalId);
    return result.changes > 0;
  }

  deleteSession(id: string, connectionPrincipalId: string): boolean {
    const result = this.database.db
      .delete(workspaceSessions)
      .where(and(eq(workspaceSessions.id, id), eq(workspaceSessions.connectionPrincipalId, connectionPrincipalId)))
      .run();
    return result.changes > 0;
  }

  countManagedWorktrees(): number {
    const row = this.database.sqlite
      .prepare(
        "select count(*) as count from workspace_sessions where managed = 'true' and status = 'active' and owner_client_id != '__legacy_unowned__'",
      )
      .get() as { count: number };
    return row.count;
  }

  countActiveSessions(connectionPrincipalId?: string): number {
    const row = connectionPrincipalId === undefined
      ? this.database.sqlite
        .prepare("select count(*) as count from workspace_sessions where status = 'active'")
        .get()
      : this.database.sqlite
        .prepare("select count(*) as count from workspace_sessions where status = 'active' and owner_client_id = ?")
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
       where id = ? and owner_client_id = ? and status = 'active'`,
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

  private assertActiveSessionQuota(
    connectionPrincipalId: string,
    maxActiveSessionsPerClient: number | undefined,
  ): void {
    if (maxActiveSessionsPerClient === undefined) return;
    if (!Number.isInteger(maxActiveSessionsPerClient) || maxActiveSessionsPerClient < 1) {
      throw new Error("Active workspace session quota must be a positive integer.");
    }
    if (this.countActiveSessions(connectionPrincipalId) >= maxActiveSessionsPerClient) {
      throw new WorkspaceQuotaError(
        "active_workspace_quota",
        `Active workspace session limit reached for this OAuth client (${maxActiveSessionsPerClient}). Close an unused workspace before opening another.`,
      );
    }
  }

}

export function createWorkspaceStore(stateDir: string): WorkspaceStore {
  return new SqliteWorkspaceStore(stateDir);
}

function rowToWorkspaceSession(row: WorkspaceSessionRow): WorkspaceSession {
  return {
    id: row.id,
    connectionPrincipalId: row.connectionPrincipalId,
    alias: row.alias ?? undefined,
    root: row.root,
    canonicalRoot: row.canonicalRoot ?? undefined,
    status: row.status,
    mode: row.mode === "worktree" ? "worktree" : "checkout",
    sourceRoot: row.sourceRoot ?? undefined,
    baseRef: row.baseRef ?? undefined,
    baseSha: row.baseSha ?? undefined,
    dirtySource: row.dirtySource === "true",
    managed: row.managed === "true",
    writeAccess: row.writeAccess === "read_only" ? "read_only" : "read_write",
    stateGeneration: row.stateGeneration,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function rowToActiveWorkspaceSummary(row: WorkspaceSessionRow): ActiveWorkspaceSummary {
  if (row.alias === null) {
    throw new Error(`Active workspace ${row.id} does not have an alias.`);
  }
  return {
    alias: row.alias,
    mode: row.mode === "worktree" ? "worktree" : "checkout",
    managed: row.managed === "true",
    ...(row.managed === "true" ? { dirtySource: row.dirtySource === "true" } : {}),
    writeAccess: row.writeAccess === "read_only" ? "read_only" : "read_write",
    stateGeneration: row.stateGeneration,
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
    workspaceMode: row.workspaceMode,
    ...(row.sourceRoot === null ? {} : { sourceRoot: row.sourceRoot }),
    managed: row.managed === "true",
    dirtySource: row.dirtySource === "true",
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

function generateWorkspaceAlias(): string {
  return `ws-${randomUUID()}`;
}

function validateStateGeneration(stateGeneration: number): number {
  if (!Number.isInteger(stateGeneration) || stateGeneration < 1) {
    throw new Error("Workspace state generation must be a positive integer.");
  }
  return stateGeneration;
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
