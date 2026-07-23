import { randomUUID } from "node:crypto";
import { and, eq, gt, lt, or } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  workspaceSessions,
  type WorkspaceSessionRow,
} from "./db/schema.js";

const MAX_CLEANUP_BATCH_SIZE = 10_000;

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
  ownerClientId: string;
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
  ownerClientId: string;
  stateGeneration: number;
}

export interface WorkspaceSessionCursor {
  lastUsedAt: string;
  id: string;
}

export interface WorkspaceStore {
  createSession(input: {
    id: string;
    ownerClientId: string;
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
    ownerClientId: string;
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
    ownerClientId: string,
    sourceRoot: string,
    baseSha: string,
  ): WorkspaceSession | undefined;
  createOrReuseCheckoutSession?(input: {
    id: string;
    ownerClientId: string;
    alias?: string;
    root: string;
    canonicalRoot: string;
    writeAccess?: WorkspaceWriteAccess;
    replaceWriteAccess?: boolean;
    stateGeneration?: number;
    maxActiveSessionsPerClient?: number;
  }): WorkspaceSession;
  allocateSessionAlias?(id: string, ownerClientId: string, alias?: string): string | undefined;
  getActiveSessionByAlias?(ownerClientId: string, alias: string): WorkspaceSession | undefined;
  listActiveSessionSummaries?(ownerClientId: string): ActiveWorkspaceSummary[];
  updateStateGeneration?(
    id: string,
    ownerClientId: string,
    stateGeneration: number,
  ): boolean;
  bumpStateGeneration?(id: string, ownerClientId: string): number | undefined;
  bumpActiveStateGenerations?(ownerClientId?: string): WorkspaceGenerationUpdate[];
  revokeSession?(id: string, ownerClientId: string): number | undefined;
  reactivateClosedSession?(id: string, ownerClientId: string): number | undefined;
  getSession(id: string, ownerClientId: string): WorkspaceSession | undefined;
  touchSession(id: string, ownerClientId: string): void;
  closeSession(id: string, ownerClientId: string): boolean;
  deleteSession(id: string, ownerClientId: string): boolean;
  countManagedWorktrees(): number;
  countActiveSessions?(ownerClientId?: string): number;
  listActiveSessions?(): WorkspaceSession[];
  closeSessions?(sessions: Array<{ id: string; ownerClientId: string }>): number;
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
    ownerClientId: string;
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
      ownerClientId: input.ownerClientId,
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
      this.assertActiveSessionQuota(session.ownerClientId, input.maxActiveSessionsPerClient);
      this.database.db
        .insert(workspaceSessions)
        .values({
          id: session.id,
          ownerClientId: session.ownerClientId,
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
    ownerClientId: string;
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
        owner_client_id as ownerClientId,
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
      where owner_client_id = @ownerClientId
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
        @id, @ownerClientId, @alias, @root, null, 'active', 'worktree',
        @sourceRoot, @baseRef, @baseSha, @dirtySource, 'true', 'read_write',
        @stateGeneration, @now, @now
      )
      returning
        id,
        owner_client_id as ownerClientId,
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
      this.assertActiveSessionQuota(input.ownerClientId, input.maxActiveSessionsPerClient);
      return insertManaged.get({
        ...values,
        dirtySource: String(input.dirtySource),
      }) as WorkspaceSessionRow;
    });

    return rowToWorkspaceSession(createOrReuse.immediate());
  }

  createOrReuseCheckoutSession(input: {
    id: string;
    ownerClientId: string;
    alias?: string;
    root: string;
    canonicalRoot: string;
    writeAccess?: WorkspaceWriteAccess;
    replaceWriteAccess?: boolean;
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
        owner_client_id as ownerClientId,
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
      where owner_client_id = @ownerClientId
        and canonical_root = @canonicalRoot
        and mode = 'checkout'
        and status in ('active', 'closed')
      order by case status when 'active' then 0 else 1 end, last_used_at desc
      limit 1
    `);
    const selectLegacy = this.database.sqlite.prepare(`
      select id
      from workspace_sessions
      where owner_client_id = @ownerClientId
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
          last_used_at = @now
      where id = @existingId
      returning
        id,
        owner_client_id as ownerClientId,
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
        @id, @ownerClientId, @alias, @root, @canonicalRoot, 'active', 'checkout', 'false',
        @writeAccess, @stateGeneration, @now, @now
      )
      on conflict(owner_client_id, canonical_root)
        where canonical_root is not null and mode = 'checkout' and status = 'active'
      do update set
        root = excluded.root,
        write_access = case
          when @replaceWriteAccess = 1 then excluded.write_access
          else workspace_sessions.write_access
        end,
        last_used_at = excluded.last_used_at
      returning
        id,
        owner_client_id as ownerClientId,
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
      (values: Omit<typeof input, "replaceWriteAccess"> & {
        replaceWriteAccess: 0 | 1;
        now: string;
      }): WorkspaceSessionRow => {
        const existing = selectCanonical.get(values) as WorkspaceSessionRow | undefined;
        if (existing) {
          return updateExisting.get({
            ...values,
            existingId: existing.id,
          }) as WorkspaceSessionRow;
        }

        const legacy = selectLegacy.get(values) as { id: string } | undefined;
        if (legacy) {
          return updateExisting.get({
            ...values,
            existingId: legacy.id,
          }) as WorkspaceSessionRow;
        }

        this.assertActiveSessionQuota(values.ownerClientId, values.maxActiveSessionsPerClient);

        return insertCheckout.get(values) as WorkspaceSessionRow;
      },
    );
    const row = getOrCreate.immediate({
      ...input,
      alias,
      writeAccess,
      replaceWriteAccess: input.replaceWriteAccess ? 1 : 0,
      stateGeneration,
      now,
    });

    return rowToWorkspaceSession(row);
  }

  findActiveManagedSession(
    ownerClientId: string,
    sourceRoot: string,
    baseSha: string,
  ): WorkspaceSession | undefined {
    const row = this.database.db
      .select()
      .from(workspaceSessions)
      .where(and(
        eq(workspaceSessions.ownerClientId, ownerClientId),
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

  allocateSessionAlias(id: string, ownerClientId: string, alias = generateWorkspaceAlias()): string | undefined {
    const row = this.database.sqlite.prepare(`
      update workspace_sessions
      set alias = coalesce(alias, @alias)
      where id = @id and owner_client_id = @ownerClientId and status = 'active'
      returning alias
    `).get({ id, ownerClientId, alias }) as { alias: string } | undefined;
    return row?.alias;
  }

  getActiveSessionByAlias(ownerClientId: string, alias: string): WorkspaceSession | undefined {
    const row = this.database.db
      .select()
      .from(workspaceSessions)
      .where(and(
        eq(workspaceSessions.ownerClientId, ownerClientId),
        eq(workspaceSessions.alias, alias),
        eq(workspaceSessions.status, "active"),
      ))
      .get();
    return row ? rowToWorkspaceSession(row) : undefined;
  }

  listActiveSessionSummaries(ownerClientId: string): ActiveWorkspaceSummary[] {
    const allocateMissingAliases = this.database.sqlite.transaction(() => {
      const rows = this.database.sqlite.prepare(`
        select id
        from workspace_sessions
        where owner_client_id = ? and status = 'active' and alias is null
      `).all(ownerClientId) as Array<{ id: string }>;
      for (const row of rows) {
        this.allocateSessionAlias(row.id, ownerClientId);
      }
    });
    allocateMissingAliases.immediate();

    return this.database.db
      .select()
      .from(workspaceSessions)
      .where(and(
        eq(workspaceSessions.ownerClientId, ownerClientId),
        eq(workspaceSessions.status, "active"),
      ))
      .orderBy(workspaceSessions.createdAt)
      .all()
      .map(rowToActiveWorkspaceSummary);
  }

  updateStateGeneration(
    id: string,
    ownerClientId: string,
    stateGeneration: number,
  ): boolean {
    const result = this.database.db
      .update(workspaceSessions)
      .set({ stateGeneration: validateStateGeneration(stateGeneration) })
      .where(and(
        eq(workspaceSessions.id, id),
        eq(workspaceSessions.ownerClientId, ownerClientId),
        eq(workspaceSessions.status, "active"),
      ))
      .run();
    return result.changes > 0;
  }

  bumpStateGeneration(id: string, ownerClientId: string): number | undefined {
    const row = this.database.sqlite.prepare(`
      update workspace_sessions
      set state_generation = state_generation + 1
      where id = ? and owner_client_id = ? and status in ('active', 'closed')
      returning state_generation as stateGeneration
    `).get(id, ownerClientId) as { stateGeneration: number } | undefined;
    return row?.stateGeneration;
  }

  bumpActiveStateGenerations(ownerClientId?: string): WorkspaceGenerationUpdate[] {
    const statement = ownerClientId === undefined
      ? this.database.sqlite.prepare(`
        update workspace_sessions
        set state_generation = state_generation + 1
        where status = 'active'
        returning id, owner_client_id as ownerClientId, state_generation as stateGeneration
      `)
      : this.database.sqlite.prepare(`
        update workspace_sessions
        set state_generation = state_generation + 1
        where status = 'active' and owner_client_id = ?
        returning id, owner_client_id as ownerClientId, state_generation as stateGeneration
      `);
    const rows = (ownerClientId === undefined
      ? statement.all()
      : statement.all(ownerClientId)) as WorkspaceGenerationUpdate[];
    return rows.sort(compareGenerationUpdates);
  }

  revokeSession(id: string, ownerClientId: string): number | undefined {
    const row = this.database.sqlite.prepare(`
      update workspace_sessions
      set status = 'revoked',
          state_generation = state_generation + 1,
          last_used_at = ?
      where id = ? and owner_client_id = ? and status in ('active', 'closed')
      returning state_generation as stateGeneration
    `).get(new Date().toISOString(), id, ownerClientId) as
      | { stateGeneration: number }
      | undefined;
    return row?.stateGeneration;
  }

  reactivateClosedSession(id: string, ownerClientId: string): number | undefined {
    const row = this.database.sqlite.prepare(`
      update workspace_sessions
      set status = 'active',
          state_generation = state_generation + 1,
          last_used_at = ?
      where id = ? and owner_client_id = ? and status = 'closed'
      returning state_generation as stateGeneration
    `).get(new Date().toISOString(), id, ownerClientId) as
      | { stateGeneration: number }
      | undefined;
    return row?.stateGeneration;
  }

  getSession(id: string, ownerClientId: string): WorkspaceSession | undefined {
    const row = this.database.db
      .select()
      .from(workspaceSessions)
      .where(and(
        eq(workspaceSessions.id, id),
        eq(workspaceSessions.ownerClientId, ownerClientId),
        eq(workspaceSessions.status, "active"),
      ))
      .get();

    return row ? rowToWorkspaceSession(row) : undefined;
  }

  touchSession(id: string, ownerClientId: string): void {
    this.database.db
      .update(workspaceSessions)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(and(eq(workspaceSessions.id, id), eq(workspaceSessions.ownerClientId, ownerClientId)))
      .run();
  }

  closeSession(id: string, ownerClientId: string): boolean {
    const result = this.database.sqlite.prepare(`
      update workspace_sessions
      set status = 'closed',
          state_generation = state_generation + 1,
          last_used_at = ?
      where id = ? and owner_client_id = ? and status = 'active'
    `).run(new Date().toISOString(), id, ownerClientId);
    return result.changes > 0;
  }

  deleteSession(id: string, ownerClientId: string): boolean {
    const result = this.database.db
      .delete(workspaceSessions)
      .where(and(eq(workspaceSessions.id, id), eq(workspaceSessions.ownerClientId, ownerClientId)))
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

  countActiveSessions(ownerClientId?: string): number {
    const row = ownerClientId === undefined
      ? this.database.sqlite
        .prepare("select count(*) as count from workspace_sessions where status = 'active'")
        .get()
      : this.database.sqlite
        .prepare("select count(*) as count from workspace_sessions where status = 'active' and owner_client_id = ?")
        .get(ownerClientId);
    return (row as { count: number }).count;
  }

  listActiveSessions(): WorkspaceSession[] {
    return this.database.db
      .select()
      .from(workspaceSessions)
      .where(eq(workspaceSessions.status, "active"))
      .all()
      .map(rowToWorkspaceSession);
  }

  closeSessions(sessions: Array<{ id: string; ownerClientId: string }>): number {
    if (sessions.length === 0) return 0;
    const now = new Date().toISOString();
    const close = this.database.sqlite.prepare(
      `update workspace_sessions
       set status = 'closed', last_used_at = ?
       where id = ? and owner_client_id = ? and status = 'active'`,
    );
    const closeAll = this.database.sqlite.transaction(
      (entries: Array<{ id: string; ownerClientId: string }>) => entries.reduce(
        (count, entry) => count + close.run(now, entry.id, entry.ownerClientId).changes,
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
    ownerClientId: string,
    maxActiveSessionsPerClient: number | undefined,
  ): void {
    if (maxActiveSessionsPerClient === undefined) return;
    if (!Number.isInteger(maxActiveSessionsPerClient) || maxActiveSessionsPerClient < 1) {
      throw new Error("Active workspace session quota must be a positive integer.");
    }
    if (this.countActiveSessions(ownerClientId) >= maxActiveSessionsPerClient) {
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
    ownerClientId: row.ownerClientId,
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
  return left.ownerClientId.localeCompare(right.ownerClientId) || left.id.localeCompare(right.id);
}

function cleanupBatchSize(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Workspace cleanup limit must be a positive integer.");
  }
  return Math.min(limit, MAX_CLEANUP_BATCH_SIZE);
}
