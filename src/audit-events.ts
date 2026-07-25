import { openDatabase, type DatabaseHandle } from "./db/client.js";

export interface AuditEventQuery {
  event?: string;
  tool?: string;
  requestId?: string;
  connectionRef?: string;
  workspaceActivityRef?: string;
  since?: string;
  limit?: number;
}

export interface PersistedAuditEvent {
  id: number;
  ts: string;
  level: "error" | "warn" | "info" | "debug";
  event: string;
  requestId?: string;
  tool?: string;
  oauthClientRef?: string;
  connectionRef?: string;
  workspaceActivityRef?: string;
  operationRef?: string;
  errorCode?: string;
  errorCategory?: string;
  errorFingerprint?: string;
  details: Record<string, unknown>;
}

const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_MAX_EVENTS = 100_000;
const MAX_QUERY_LIMIT = 1_000;
const SAFE_DETAIL_KEYS = new Set([
  "reason",
  "method",
  "success",
  "status",
  "phase",
  "effectsKnown",
  "safeToRetry",
  "retryable",
  "durationMs",
  "transportMode",
  "isInitialize",
  "sessionIdPresent",
  "sessionIdPrefix",
  "commandLength",
  "stdinBytes",
  "contentLength",
  "activeStatelessRequests",
  "clientStatelessRequests",
  "oldestStatelessRequestAgeMs",
  "maxSessions",
  "maxSessionsPerClient",
  "bumpedWorkspaces",
  "invalidatedWorkspaces",
  "terminatedProcesses",
  "cleanupFailures",
  "cleanupPending",
  "added",
  "removed",
  "changed",
]);

export class AuditEventStore {
  private readonly database: DatabaseHandle;
  private closed = false;

  constructor(
    stateDir: string,
    private readonly retentionMs = DEFAULT_RETENTION_MS,
    private readonly maxEvents = DEFAULT_MAX_EVENTS,
  ) {
    this.database = openDatabase(stateDir);
  }

  record(entry: Record<string, unknown>): void {
    if (this.closed) return;
    const level = auditLevel(entry.level);
    const event = boundedLabel(entry.event, 128);
    const ts = validTimestamp(entry.ts) ?? new Date().toISOString();
    if (!level || !event) return;
    const details = Object.fromEntries(Object.entries(entry).flatMap(([key, value]) => {
      if (!SAFE_DETAIL_KEYS.has(key)) return [];
      const safe = safeDetailValue(value);
      return safe === undefined ? [] : [[key, safe]];
    }));
    this.database.sqlite.prepare(`
      insert into audit_events (
        ts, level, event, request_id, tool, oauth_client_ref, connection_ref,
        workspace_activity_ref, operation_ref, error_code, error_category,
        error_fingerprint, details_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ts,
      level,
      event,
      optionalLabel(entry.requestId, 128),
      optionalLabel(entry.tool, 128),
      optionalLabel(entry.oauthClientRef, 128),
      optionalLabel(entry.connectionRef, 128),
      optionalLabel(entry.workspaceActivityRef, 128),
      optionalLabel(entry.operationRef, 128),
      optionalLabel(entry.errorCode, 128),
      optionalLabel(entry.errorName ?? entry.errorCategory, 128),
      optionalLabel(entry.errorFingerprint, 128),
      JSON.stringify(details),
    );
  }

  query(query: AuditEventQuery = {}): PersistedAuditEvent[] {
    this.assertOpen();
    const clauses: string[] = [];
    const bindings: Record<string, unknown> = {};
    for (const [column, key] of [
      ["event", "event"],
      ["tool", "tool"],
      ["request_id", "requestId"],
      ["connection_ref", "connectionRef"],
      ["workspace_activity_ref", "workspaceActivityRef"],
    ] as const) {
      const value = query[key];
      if (!value) continue;
      clauses.push(`${column} = @${key}`);
      bindings[key] = value;
    }
    if (query.since) {
      clauses.push("ts >= @since");
      bindings.since = query.since;
    }
    const limit = Math.min(MAX_QUERY_LIMIT, Math.max(1, query.limit ?? 100));
    bindings.limit = limit;
    const rows = this.database.sqlite.prepare(`
      select
        id, ts, level, event, request_id as requestId, tool,
        oauth_client_ref as oauthClientRef, connection_ref as connectionRef,
        workspace_activity_ref as workspaceActivityRef,
        operation_ref as operationRef, error_code as errorCode,
        error_category as errorCategory, error_fingerprint as errorFingerprint,
        details_json as detailsJson
      from audit_events
      ${clauses.length > 0 ? `where ${clauses.join(" and ")}` : ""}
      order by ts desc, id desc
      limit @limit
    `).all(bindings) as Array<Omit<PersistedAuditEvent, "details"> & { detailsJson: string }>;
    return rows.map(({ detailsJson, ...row }) => ({
      id: row.id,
      ts: row.ts,
      level: row.level,
      event: row.event,
      ...(row.requestId ? { requestId: row.requestId } : {}),
      ...(row.tool ? { tool: row.tool } : {}),
      ...(row.oauthClientRef ? { oauthClientRef: row.oauthClientRef } : {}),
      ...(row.connectionRef ? { connectionRef: row.connectionRef } : {}),
      ...(row.workspaceActivityRef
        ? { workspaceActivityRef: row.workspaceActivityRef }
        : {}),
      ...(row.operationRef ? { operationRef: row.operationRef } : {}),
      ...(row.errorCode ? { errorCode: row.errorCode } : {}),
      ...(row.errorCategory ? { errorCategory: row.errorCategory } : {}),
      ...(row.errorFingerprint ? { errorFingerprint: row.errorFingerprint } : {}),
      details: parseDetails(detailsJson),
    }));
  }

  cleanup(now = Date.now()): number {
    this.assertOpen();
    const before = new Date(now - this.retentionMs).toISOString();
    const expired = this.database.sqlite.prepare(
      "delete from audit_events where ts < ?",
    ).run(before).changes;
    const overflow = this.database.sqlite.prepare(`
      delete from audit_events
      where id in (
        select id from audit_events
        order by ts desc, id desc
        limit -1 offset ?
      )
    `).run(this.maxEvents).changes;
    return expired + overflow;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Audit event store is closed.");
  }
}

function auditLevel(value: unknown): PersistedAuditEvent["level"] | undefined {
  return value === "error" || value === "warn" || value === "info" || value === "debug"
    ? value
    : undefined;
}

function boundedLabel(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, maximum);
  return normalized || undefined;
}

function optionalLabel(value: unknown, maximum: number): string | null {
  return boundedLabel(value, maximum) ?? null;
}

function validTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function safeDetailValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return value.slice(0, 256);
  return undefined;
}

function parseDetails(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
