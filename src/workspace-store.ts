import { and, eq, lt } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  workspaceSessions,
  type WorkspaceSessionRow,
} from "./db/schema.js";

const MAX_CLEANUP_BATCH_SIZE = 10_000;

export type WorkspaceMode = "checkout" | "worktree";

export interface WorkspaceSession {
  id: string;
  ownerClientId: string;
  root: string;
  canonicalRoot?: string;
  status: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  baseRef?: string;
  baseSha?: string;
  managed: boolean;
  createdAt: string;
  lastUsedAt: string;
}

export interface WorkspaceStore {
  createSession(input: {
    id: string;
    ownerClientId: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
    maxActiveSessionsPerClient?: number;
  }): WorkspaceSession;
  createOrReuseCheckoutSession?(input: {
    id: string;
    ownerClientId: string;
    root: string;
    canonicalRoot: string;
    maxActiveSessionsPerClient?: number;
  }): WorkspaceSession;
  getSession(id: string, ownerClientId: string): WorkspaceSession | undefined;
  touchSession(id: string, ownerClientId: string): void;
  closeSession(id: string, ownerClientId: string): boolean;
  deleteSession(id: string, ownerClientId: string): boolean;
  countManagedWorktrees(): number;
  countActiveSessions?(ownerClientId?: string): number;
  listExpiredSessions(before: string, limit: number): WorkspaceSession[];
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
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
    maxActiveSessionsPerClient?: number;
  }): WorkspaceSession {
    const now = new Date().toISOString();
    const session: WorkspaceSession = {
      id: input.id,
      ownerClientId: input.ownerClientId,
      root: input.root,
      status: "active",
      mode: input.mode ?? "checkout",
      sourceRoot: input.sourceRoot,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      managed: input.managed ?? false,
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
          root: session.root,
          canonicalRoot: null,
          status: session.status,
          mode: session.mode,
          sourceRoot: session.sourceRoot ?? null,
          baseRef: session.baseRef ?? null,
          baseSha: session.baseSha ?? null,
          managed: String(session.managed),
          createdAt: session.createdAt,
          lastUsedAt: session.lastUsedAt,
        })
        .run();
    });
    create.immediate();

    return session;
  }

  createOrReuseCheckoutSession(input: {
    id: string;
    ownerClientId: string;
    root: string;
    canonicalRoot: string;
    maxActiveSessionsPerClient?: number;
  }): WorkspaceSession {
    const now = new Date().toISOString();
    const selectCanonical = this.database.sqlite.prepare(`
      select
        id,
        owner_client_id as ownerClientId,
        root,
        canonical_root as canonicalRoot,
        status,
        mode,
        source_root as sourceRoot,
        base_ref as baseRef,
        base_sha as baseSha,
        managed,
        created_at as createdAt,
        last_used_at as lastUsedAt
      from workspace_sessions
      where owner_client_id = @ownerClientId
        and canonical_root = @canonicalRoot
        and mode = 'checkout'
        and status = 'active'
      limit 1
    `);
    const selectLegacy = this.database.sqlite.prepare(`
      select id
      from workspace_sessions
      where owner_client_id = @ownerClientId
        and root = @root
        and canonical_root is null
        and mode = 'checkout'
        and status = 'active'
      order by last_used_at desc
      limit 1
    `);
    const updateExisting = this.database.sqlite.prepare(`
      update workspace_sessions
      set root = @root,
          canonical_root = @canonicalRoot,
          last_used_at = @now
      where id = @existingId
      returning
        id,
        owner_client_id as ownerClientId,
        root,
        canonical_root as canonicalRoot,
        status,
        mode,
        source_root as sourceRoot,
        base_ref as baseRef,
        base_sha as baseSha,
        managed,
        created_at as createdAt,
        last_used_at as lastUsedAt
    `);
    const insertCheckout = this.database.sqlite.prepare(`
      insert into workspace_sessions (
        id, owner_client_id, root, canonical_root, status, mode, managed, created_at, last_used_at
      ) values (
        @id, @ownerClientId, @root, @canonicalRoot, 'active', 'checkout', 'false', @now, @now
      )
      on conflict(owner_client_id, canonical_root)
        where canonical_root is not null and mode = 'checkout' and status = 'active'
      do update set
        root = excluded.root,
        last_used_at = excluded.last_used_at
      returning
        id,
        owner_client_id as ownerClientId,
        root,
        canonical_root as canonicalRoot,
        status,
        mode,
        source_root as sourceRoot,
        base_ref as baseRef,
        base_sha as baseSha,
        managed,
        created_at as createdAt,
        last_used_at as lastUsedAt
    `);
    const getOrCreate = this.database.sqlite.transaction(
      (values: typeof input & { now: string }): WorkspaceSessionRow => {
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
    const row = getOrCreate.immediate({ ...input, now });

    return rowToWorkspaceSession(row);
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
    const result = this.database.db
      .update(workspaceSessions)
      .set({ status: "closed", lastUsedAt: new Date().toISOString() })
      .where(and(
        eq(workspaceSessions.id, id),
        eq(workspaceSessions.ownerClientId, ownerClientId),
        eq(workspaceSessions.status, "active"),
      ))
      .run();
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

  listExpiredSessions(before: string, limit: number): WorkspaceSession[] {
    return this.database.db
      .select()
      .from(workspaceSessions)
      .where(and(
        eq(workspaceSessions.status, "active"),
        eq(workspaceSessions.managed, "false"),
        lt(workspaceSessions.lastUsedAt, before),
      ))
      .orderBy(workspaceSessions.lastUsedAt)
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
      throw new Error(
        `Active workspace session limit reached for this OAuth client (${maxActiveSessionsPerClient}).`,
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
    root: row.root,
    canonicalRoot: row.canonicalRoot ?? undefined,
    status: row.status,
    mode: row.mode === "worktree" ? "worktree" : "checkout",
    sourceRoot: row.sourceRoot ?? undefined,
    baseRef: row.baseRef ?? undefined,
    baseSha: row.baseSha ?? undefined,
    managed: row.managed === "true",
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function cleanupBatchSize(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Workspace cleanup limit must be a positive integer.");
  }
  return Math.min(limit, MAX_CLEANUP_BATCH_SIZE);
}
