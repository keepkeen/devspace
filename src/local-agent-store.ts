import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import type { ServerConfig } from "./config.js";

export type LocalAgentStatus = "starting" | "running" | "idle" | "error" | "stopped";

export interface LocalAgentRecord {
  id: string;
  workspaceId?: string;
  workspaceRoot: string;
  profileName: string;
  provider: string;
  model?: string;
  thinking?: string;
  providerSessionId?: string;
  status: LocalAgentStatus;
  latestResponse?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLocalAgentRecordInput {
  workspaceId?: string;
  workspaceRoot: string;
  profileName: string;
  provider: string;
  model?: string;
  thinking?: string;
}

export interface LocalAgentListScope {
  workspaceId?: string;
  workspaceRoot?: string;
}

export interface LocalAgentCleanupOptions {
  now?: number;
  staleStartingMs?: number;
  staleRunningMs?: number;
  retentionMs?: number;
  maxCompletedRecords?: number;
  batchSize?: number;
}

export interface LocalAgentCleanupResult {
  reconciledStarting: number;
  reconciledRunning: number;
  pruned: number;
}

const DEFAULT_STALE_STARTING_MS = 10 * 60_000;
const DEFAULT_STALE_RUNNING_MS = 24 * 60 * 60_000;
const DEFAULT_AGENT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_MAX_COMPLETED_AGENT_RECORDS = 1_000;
const DEFAULT_AGENT_CLEANUP_BATCH_SIZE = 100;

interface LocalAgentRow {
  id: string;
  workspace_id: string | null;
  workspace_root: string;
  profile_name: string;
  provider: string;
  model: string | null;
  thinking: string | null;
  provider_session_id: string | null;
  status: string;
  latest_response: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export class LocalAgentStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  list(scope: LocalAgentListScope = {}): LocalAgentRecord[] {
    let rows: LocalAgentRow[];
    if (scope.workspaceId) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_id = ?
           order by updated_at desc`,
        )
        .all(scope.workspaceId) as LocalAgentRow[];
    } else if (scope.workspaceRoot) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_root = ?
           order by updated_at desc`,
        )
        .all(resolve(scope.workspaceRoot)) as LocalAgentRow[];
    } else {
      rows = this.database.sqlite
        .prepare("select * from local_agent_sessions order by updated_at desc")
        .all() as LocalAgentRow[];
    }

    return rows.map(rowToLocalAgentRecord);
  }

  create(input: CreateLocalAgentRecordInput): LocalAgentRecord {
    const now = new Date().toISOString();
    const record: LocalAgentRecord = {
      id: `agt_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      workspaceId: input.workspaceId,
      workspaceRoot: resolve(input.workspaceRoot),
      profileName: input.profileName,
      provider: input.provider,
      model: input.model,
      thinking: input.thinking,
      status: "starting",
      createdAt: now,
      updatedAt: now,
    };

    this.database.sqlite
      .prepare(
        `insert into local_agent_sessions (
          id,
          workspace_id,
          workspace_root,
          profile_name,
          provider,
          model,
          thinking,
          status,
          created_at,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId ?? null,
        record.workspaceRoot,
        record.profileName,
        record.provider,
        record.model ?? null,
        record.thinking ?? null,
        record.status,
        record.createdAt,
        record.updatedAt,
      );

    return record;
  }

  get(idOrPrefix: string): LocalAgentRecord | undefined {
    const exact = this.database.sqlite
      .prepare(
        `select * from local_agent_sessions
         where id = ? or provider_session_id = ?
         limit 1`,
      )
      .get(idOrPrefix, idOrPrefix) as LocalAgentRow | undefined;
    if (exact) return rowToLocalAgentRecord(exact);

    const matches = this.database.sqlite
      .prepare(
        `select * from local_agent_sessions
         where id like ? escape '\\' or provider_session_id like ? escape '\\'
         order by updated_at desc`,
      )
      .all(`${escapeLike(idOrPrefix)}%`, `${escapeLike(idOrPrefix)}%`) as LocalAgentRow[];

    return matches.length === 1 ? rowToLocalAgentRecord(matches[0]!) : undefined;
  }

  update(id: string, patch: Partial<Omit<LocalAgentRecord, "id" | "createdAt">>): LocalAgentRecord {
    const current = this.getById(id);
    if (!current) throw new Error(`Unknown subagent id: ${id}`);

    const updated: LocalAgentRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    this.database.sqlite
      .prepare(
        `update local_agent_sessions set
          workspace_id = ?,
          workspace_root = ?,
          profile_name = ?,
          provider = ?,
          model = ?,
          thinking = ?,
          provider_session_id = ?,
          status = ?,
          latest_response = ?,
          error = ?,
          updated_at = ?
         where id = ?`,
      )
      .run(
        updated.workspaceId ?? null,
        resolve(updated.workspaceRoot),
        updated.profileName,
        updated.provider,
        updated.model ?? null,
        updated.thinking ?? null,
        updated.providerSessionId ?? null,
        updated.status,
        updated.latestResponse ?? null,
        updated.error ?? null,
        updated.updatedAt,
        updated.id,
      );

    return updated;
  }

  cleanup(options: LocalAgentCleanupOptions = {}): LocalAgentCleanupResult {
    const now = options.now ?? Date.now();
    const nowIso = new Date(now).toISOString();
    const staleStartingBefore = new Date(now - (options.staleStartingMs ?? DEFAULT_STALE_STARTING_MS)).toISOString();
    const staleRunningBefore = new Date(now - (options.staleRunningMs ?? DEFAULT_STALE_RUNNING_MS)).toISOString();
    const retentionBefore = new Date(now - (options.retentionMs ?? DEFAULT_AGENT_RETENTION_MS)).toISOString();
    const maxCompletedRecords = Math.max(0, options.maxCompletedRecords ?? DEFAULT_MAX_COMPLETED_AGENT_RECORDS);
    const batchSize = Math.max(1, options.batchSize ?? DEFAULT_AGENT_CLEANUP_BATCH_SIZE);

    const reconcile = this.database.sqlite.prepare(`
      update local_agent_sessions
      set status = 'error', error = ?, updated_at = ?
      where status = ? and updated_at < ?
    `);
    const pruneIds = this.database.sqlite.prepare(`
      select id
      from local_agent_sessions
      where status in ('idle', 'error', 'stopped')
        and (
          updated_at < @retentionBefore
          or id in (
            select id
            from local_agent_sessions
            where status in ('idle', 'error', 'stopped')
            order by updated_at desc
            limit -1 offset @maxCompletedRecords
          )
        )
      order by updated_at asc
      limit @batchSize
    `);
    const deleteRecord = this.database.sqlite.prepare("delete from local_agent_sessions where id = ?");
    const runCleanup = this.database.sqlite.transaction((): LocalAgentCleanupResult => {
      const starting = reconcile.run(
        "Detached subagent did not start before the stale-session deadline.",
        nowIso,
        "starting",
        staleStartingBefore,
      );
      const running = reconcile.run(
        "Detached subagent stopped updating before the stale-session deadline.",
        nowIso,
        "running",
        staleRunningBefore,
      );
      const ids = pruneIds.all({ retentionBefore, maxCompletedRecords, batchSize }) as Array<{ id: string }>;
      for (const { id } of ids) deleteRecord.run(id);
      return {
        reconciledStarting: starting.changes,
        reconciledRunning: running.changes,
        pruned: ids.length,
      };
    });
    return runCleanup.immediate();
  }

  close(): void {
    this.database.close();
  }

  private getById(id: string): LocalAgentRecord | undefined {
    const row = this.database.sqlite
      .prepare("select * from local_agent_sessions where id = ?")
      .get(id) as LocalAgentRow | undefined;
    return row ? rowToLocalAgentRecord(row) : undefined;
  }
}

export function createLocalAgentStore(config: ServerConfig): LocalAgentStore {
  return new LocalAgentStore(config.stateDir);
}

function rowToLocalAgentRecord(row: LocalAgentRow): LocalAgentRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id ?? undefined,
    workspaceRoot: row.workspace_root,
    profileName: row.profile_name,
    provider: row.provider,
    model: row.model ?? undefined,
    thinking: row.thinking ?? undefined,
    providerSessionId: row.provider_session_id ?? undefined,
    status: readStatus(row.status),
    latestResponse: row.latest_response ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readStatus(status: string): LocalAgentStatus {
  if (
    status === "starting" ||
    status === "running" ||
    status === "idle" ||
    status === "error" ||
    status === "stopped"
  ) {
    return status;
  }
  return "error";
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
