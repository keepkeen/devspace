import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { operationId as validateOperationId } from "./operation-id.js";

export type ProjectTaskEventSource = "server" | "model" | "host";
export type ProjectTaskEventTrust = "server_observed" | "untrusted" | "host_asserted";
export type ProjectTaskEventVisibility = "model" | "widget" | "audit";

export type ProjectActivityStatus =
  | "idle"
  | "queued"
  | "running"
  | "waiting_approval"
  | "blocked"
  | "completed"
  | "failed"
  | "interrupted"
  | "outcome_unknown"
  | "paused"
  | "archived";

export type ProjectActivityPhase =
  | "idle"
  | "validating"
  | "reading"
  | "executing"
  | "applying_patch"
  | "waiting_approval"
  | "finalizing";

export interface ProjectActivityItemProjection {
  itemId: string;
  operationId?: string;
  kind: "operation" | "command" | "patch" | "approval";
  status: "queued" | "running" | "waiting_approval";
  summary: string;
  updatedAt: string;
}

export interface ProjectActivityProjection {
  threadId: string;
  status: ProjectActivityStatus;
  phase: ProjectActivityPhase;
  summary: string;
  activeItems: ProjectActivityItemProjection[];
  latestOutput?: {
    outputId: string;
    nextOffset: number;
    totalBytes: number;
    storedBytes: number;
    droppedBytes: number;
    status: "active" | "completed" | "unknown";
  };
  latestPatch?: {
    operationId?: string;
    files: number;
    additions: number;
    removals: number;
  };
  pendingApproval?: {
    approvalRef: string;
    actionSummary: string;
    expiresAt?: string;
  };
  lastSequence: number;
  updatedAt: string;
}

export interface ProjectTaskEvent {
  eventId: string;
  eventKey: string;
  threadId: string;
  sequence: number;
  type: string;
  source: ProjectTaskEventSource;
  trust: ProjectTaskEventTrust;
  visibility: ProjectTaskEventVisibility;
  runId?: string;
  operationId?: string;
  itemId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ProjectTaskSnapshot {
  snapshotId: string;
  threadId: string;
  throughSequence: number;
  objective?: string;
  observedState: Record<string, unknown>;
  modelSummary?: string;
  modelSummaryTrust?: "untrusted";
  createdAt: string;
}

export interface ProjectHostIdentity {
  actorId: string;
  subjectRef?: string;
  organizationRef?: string;
  sessionRef?: string;
}

export interface ProjectTaskSessionBinding {
  sessionRef: string;
  actorId: string;
  organizationRef?: string;
  threadId: string;
  executionId?: string;
  boundAt: string;
  lastSeenAt: string;
}

interface EventRow {
  event_id: string;
  event_key: string | null;
  thread_id: string;
  sequence: number;
  event_type: string;
  source: ProjectTaskEventSource;
  trust: ProjectTaskEventTrust;
  visibility: ProjectTaskEventVisibility | null;
  run_id: string | null;
  operation_id: string | null;
  item_id: string | null;
  payload_json: string;
  created_at: string;
}

interface ActivityProjectionRow {
  thread_id: string;
  last_sequence: number;
  projection_json: string;
  updated_at: string;
}

interface SnapshotRow {
  snapshot_id: string;
  thread_id: string;
  through_sequence: number;
  objective: string | null;
  observed_state_json: string;
  model_summary: string | null;
  created_at: string;
}

interface SessionBindingRow {
  session_ref: string;
  actor_id: string;
  organization_ref: string | null;
  thread_id: string;
  execution_id: string | null;
  bound_at: string;
  last_seen_at: string;
}

const MAX_ID_BYTES = 1_024;
const MAX_EVENT_KEY_BYTES = 2_048;
const MAX_TYPE_BYTES = 128;
const MAX_OBJECTIVE_BYTES = 4_096;
const MAX_MODEL_SUMMARY_BYTES = 8_192;
const MAX_PAYLOAD_BYTES = 64 * 1_024;
const MAX_OBSERVED_STATE_BYTES = 128 * 1_024;

export class ProjectTaskContinuityStore {
  private readonly database: Database.Database;
  private readonly clock: () => number;
  private readonly createEventId: () => string;
  private readonly createSnapshotId: () => string;
  private readonly onEvent?: (event: ProjectTaskEvent) => void;
  private closed = false;

  constructor(stateDir: string, options: {
    now?: () => number;
    createEventId?: () => string;
    createSnapshotId?: () => string;
    onEvent?: (event: ProjectTaskEvent) => void;
  } = {}) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    const path = join(stateDir, "project-task-continuity.sqlite");
    this.database = new Database(path);
    chmodSync(path, 0o600);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = NORMAL");
    this.database.pragma("busy_timeout = 5000");
    this.database.pragma("foreign_keys = ON");
    this.clock = options.now ?? Date.now;
    this.createEventId = options.createEventId ?? randomUUID;
    this.createSnapshotId = options.createSnapshotId ?? randomUUID;
    this.onEvent = options.onEvent;
    this.createSchema();
  }

  observeHostIdentity(input: {
    actorId: string;
    subjectRef?: string;
    organizationRef?: string;
    sessionRef?: string;
  }): ProjectHostIdentity {
    this.assertOpen();
    const timestamp = this.timestamp();
    const actorId = bounded(input.actorId, "actorId", MAX_ID_BYTES);
    const subjectRef = optionalBounded(input.subjectRef, "subjectRef", MAX_ID_BYTES);
    const organizationRef = optionalBounded(input.organizationRef, "organizationRef", MAX_ID_BYTES);
    const sessionRef = optionalBounded(input.sessionRef, "sessionRef", MAX_ID_BYTES);
    this.database.prepare(`
      insert into project_task_actors (
        actor_id, subject_ref, organization_ref, created_at, last_seen_at
      ) values (?, ?, ?, ?, ?)
      on conflict(actor_id) do update set
        subject_ref = coalesce(excluded.subject_ref, project_task_actors.subject_ref),
        organization_ref = coalesce(excluded.organization_ref, project_task_actors.organization_ref),
        last_seen_at = excluded.last_seen_at
    `).run(actorId, subjectRef, organizationRef, timestamp, timestamp);
    return {
      actorId,
      ...(subjectRef ? { subjectRef } : {}),
      ...(organizationRef ? { organizationRef } : {}),
      ...(sessionRef ? { sessionRef } : {}),
    };
  }

  bindSession(input: {
    sessionRef: string;
    actorId: string;
    threadId: string;
    executionId: string;
    organizationRef?: string;
  }): void {
    this.assertOpen();
    const timestamp = this.timestamp();
    this.database.prepare(`
      insert into project_task_session_bindings (
        session_ref, actor_id, organization_ref, thread_id, execution_id,
        binding_status, bound_at, last_seen_at
      ) values (?, ?, ?, ?, ?, 'active', ?, ?)
      on conflict(session_ref, actor_id) do update set
        organization_ref = excluded.organization_ref,
        thread_id = excluded.thread_id,
        execution_id = excluded.execution_id,
        binding_status = 'active',
        bound_at = excluded.bound_at,
        last_seen_at = excluded.last_seen_at
    `).run(
      bounded(input.sessionRef, "sessionRef", MAX_ID_BYTES),
      bounded(input.actorId, "actorId", MAX_ID_BYTES),
      optionalBounded(input.organizationRef, "organizationRef", MAX_ID_BYTES),
      bounded(input.threadId, "threadId", MAX_ID_BYTES),
      bounded(input.executionId, "executionId", MAX_ID_BYTES),
      timestamp,
      timestamp,
    );
  }

  resolveSession(sessionRef: string, actorId: string): ProjectTaskSessionBinding | undefined {
    this.assertOpen();
    const row = this.database.prepare(`
      select session_ref, actor_id, organization_ref, thread_id, execution_id,
        bound_at, last_seen_at
      from project_task_session_bindings
      where session_ref = ? and actor_id = ? and binding_status = 'active'
    `).get(
      bounded(sessionRef, "sessionRef", MAX_ID_BYTES),
      bounded(actorId, "actorId", MAX_ID_BYTES),
    ) as SessionBindingRow | undefined;
    return row ? mapSessionBinding(row) : undefined;
  }

  touchSession(input: {
    sessionRef: string;
    actorId: string;
    threadId: string;
    executionId: string;
  }): boolean {
    this.assertOpen();
    const result = this.database.prepare(`
      update project_task_session_bindings
      set last_seen_at = ?
      where session_ref = ? and actor_id = ? and thread_id = ?
        and execution_id = ? and binding_status = 'active'
    `).run(
      this.timestamp(),
      bounded(input.sessionRef, "sessionRef", MAX_ID_BYTES),
      bounded(input.actorId, "actorId", MAX_ID_BYTES),
      bounded(input.threadId, "threadId", MAX_ID_BYTES),
      bounded(input.executionId, "executionId", MAX_ID_BYTES),
    );
    return result.changes === 1;
  }

  releaseSession(input: {
    sessionRef: string;
    actorId: string;
    threadId: string;
    executionId?: string;
  }): boolean {
    this.assertOpen();
    const executionId = optionalBounded(input.executionId, "executionId", MAX_ID_BYTES);
    const result = this.database.prepare(`
      update project_task_session_bindings
      set binding_status = 'released', last_seen_at = ?
      where session_ref = ? and actor_id = ? and thread_id = ?
        and execution_id is ? and binding_status = 'active'
    `).run(
      this.timestamp(),
      bounded(input.sessionRef, "sessionRef", MAX_ID_BYTES),
      bounded(input.actorId, "actorId", MAX_ID_BYTES),
      bounded(input.threadId, "threadId", MAX_ID_BYTES),
      executionId,
    );
    return result.changes === 1;
  }

  appendEvent(input: {
    threadId: string;
    eventKey?: string;
    type: string;
    source: ProjectTaskEventSource;
    trust: ProjectTaskEventTrust;
    visibility?: ProjectTaskEventVisibility;
    runId?: string;
    operationId?: string;
    itemId?: string;
    payload: Record<string, unknown>;
  }): ProjectTaskEvent {
    this.assertOpen();
    const threadId = bounded(input.threadId, "threadId", MAX_ID_BYTES);
    const type = bounded(input.type, "type", MAX_TYPE_BYTES);
    const operationId = input.operationId === undefined
      ? null
      : validateOperationId(input.operationId);
    const eventId = bounded(this.createEventId(), "eventId", MAX_ID_BYTES);
    const eventKey = bounded(
      input.eventKey ?? (operationId ? `${type}:${operationId}` : `event:${eventId}`),
      "eventKey",
      MAX_EVENT_KEY_BYTES,
    );
    const visibility = input.visibility ?? "model";
    const runId = optionalBounded(input.runId, "runId", MAX_ID_BYTES);
    const itemId = optionalBounded(input.itemId, "itemId", MAX_ID_BYTES);
    const payloadJson = stableJson(input.payload, MAX_PAYLOAD_BYTES, "payload");
    const append = this.database.transaction(() => {
      const existing = this.database.prepare(`
        select * from project_task_events where thread_id = ? and event_key = ?
      `).get(threadId, eventKey) as EventRow | undefined;
      if (existing) return mapEvent(existing);
      const sequence = Number(this.database.prepare(`
        select coalesce(max(sequence), 0) + 1
        from project_task_events where thread_id = ?
      `).pluck().get(threadId));
      const event: ProjectTaskEvent = {
        eventId,
        eventKey,
        threadId,
        sequence,
        type,
        source: input.source,
        trust: input.trust,
        visibility,
        ...(runId ? { runId } : {}),
        ...(operationId ? { operationId } : {}),
        ...(itemId ? { itemId } : {}),
        payload: JSON.parse(payloadJson) as Record<string, unknown>,
        createdAt: this.timestamp(),
      };
      this.database.prepare(`
        insert into project_task_events (
          event_id, event_key, thread_id, sequence, event_type, source, trust,
          visibility, run_id, operation_id, item_id, payload_json, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.eventId,
        event.eventKey,
        event.threadId,
        event.sequence,
        event.type,
        event.source,
        event.trust,
        event.visibility,
        event.runId ?? null,
        event.operationId ?? null,
        event.itemId ?? null,
        payloadJson,
        event.createdAt,
      );
      const projection = projectActivityProjection(
        threadId,
        this.database.prepare(`
          select * from project_task_events where thread_id = ? order by sequence asc
        `).all(threadId) as EventRow[],
      );
      this.database.prepare(`
        insert into project_activity_projections (
          thread_id, last_sequence, projection_json, updated_at
        ) values (?, ?, ?, ?)
        on conflict(thread_id) do update set
          last_sequence = excluded.last_sequence,
          projection_json = excluded.projection_json,
          updated_at = excluded.updated_at
      `).run(
        threadId,
        projection.lastSequence,
        JSON.stringify(projection),
        projection.updatedAt,
      );
      return event;
    });
    const event = append.immediate();
    this.onEvent?.(event);
    return event;
  }

  listEvents(input: { threadId: string; afterSequence?: number; limit?: number }): ProjectTaskEvent[] {
    this.assertOpen();
    const limit = positiveLimit(input.limit ?? 100);
    const afterSequence = input.afterSequence ?? 0;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new Error("afterSequence must be a non-negative integer.");
    }
    const rows = this.database.prepare(`
      select * from project_task_events
      where thread_id = ? and sequence > ?
      order by sequence asc
      limit ?
    `).all(
      bounded(input.threadId, "threadId", MAX_ID_BYTES),
      afterSequence,
      limit,
    ) as EventRow[];
    return rows.map(mapEvent);
  }

  activityProjection(threadId: string): ProjectActivityProjection {
    this.assertOpen();
    const normalizedThreadId = bounded(threadId, "threadId", MAX_ID_BYTES);
    const row = this.database.prepare(`
      select * from project_activity_projections where thread_id = ?
    `).get(normalizedThreadId) as ActivityProjectionRow | undefined;
    if (row) return JSON.parse(row.projection_json) as ProjectActivityProjection;
    return emptyActivityProjection(normalizedThreadId, this.timestamp());
  }

  saveSnapshot(input: {
    threadId: string;
    objective?: string;
    observedState: Record<string, unknown>;
    modelSummary?: string;
  }): ProjectTaskSnapshot {
    this.assertOpen();
    const threadId = bounded(input.threadId, "threadId", MAX_ID_BYTES);
    const observedStateJson = stableJson(input.observedState, MAX_OBSERVED_STATE_BYTES, "observedState");
    const throughSequence = Number(this.database.prepare(`
      select coalesce(max(sequence), 0) from project_task_events where thread_id = ?
    `).pluck().get(threadId));
    const snapshot: ProjectTaskSnapshot = {
      snapshotId: bounded(this.createSnapshotId(), "snapshotId", MAX_ID_BYTES),
      threadId,
      throughSequence,
      ...(input.objective ? { objective: bounded(input.objective, "objective", MAX_OBJECTIVE_BYTES) } : {}),
      observedState: JSON.parse(observedStateJson) as Record<string, unknown>,
      ...(input.modelSummary
        ? {
            modelSummary: bounded(input.modelSummary, "modelSummary", MAX_MODEL_SUMMARY_BYTES),
            modelSummaryTrust: "untrusted" as const,
          }
        : {}),
      createdAt: this.timestamp(),
    };
    this.database.prepare(`
      insert into project_task_snapshots (
        snapshot_id, thread_id, through_sequence, objective,
        observed_state_json, model_summary, created_at
      ) values (?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.snapshotId,
      snapshot.threadId,
      snapshot.throughSequence,
      snapshot.objective ?? null,
      observedStateJson,
      snapshot.modelSummary ?? null,
      snapshot.createdAt,
    );
    return snapshot;
  }

  latestSnapshot(threadId: string): ProjectTaskSnapshot | undefined {
    this.assertOpen();
    const row = this.database.prepare(`
      select * from project_task_snapshots
      where thread_id = ?
      order by through_sequence desc, created_at desc
      limit 1
    `).get(bounded(threadId, "threadId", MAX_ID_BYTES)) as SnapshotRow | undefined;
    return row ? mapSnapshot(row) : undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private createSchema(): void {
    this.database.exec(`
      create table if not exists project_task_actors (
        actor_id text primary key,
        subject_ref text,
        organization_ref text,
        created_at text not null,
        last_seen_at text not null
      );
      create table if not exists project_task_session_bindings (
        session_ref text not null,
        actor_id text not null references project_task_actors(actor_id) on delete cascade,
        organization_ref text,
        thread_id text not null,
        execution_id text,
        binding_status text not null check (binding_status in ('active', 'released')),
        bound_at text not null,
        last_seen_at text not null,
        primary key (session_ref, actor_id)
      );
      create index if not exists project_task_session_thread_idx
        on project_task_session_bindings(thread_id, last_seen_at desc);
      create table if not exists project_task_events (
        event_id text primary key,
        event_key text,
        thread_id text not null,
        sequence integer not null check (sequence >= 1),
        event_type text not null,
        source text not null check (source in ('server', 'model', 'host')),
        trust text not null check (trust in ('server_observed', 'untrusted', 'host_asserted')),
        visibility text check (visibility in ('model', 'widget', 'audit')),
        run_id text,
        operation_id text,
        item_id text,
        payload_json text not null,
        created_at text not null,
        unique (thread_id, sequence)
      );
      create table if not exists project_activity_projections (
        thread_id text primary key,
        last_sequence integer not null check (last_sequence >= 0),
        projection_json text not null,
        updated_at text not null
      );
      create table if not exists project_task_snapshots (
        snapshot_id text primary key,
        thread_id text not null,
        through_sequence integer not null check (through_sequence >= 0),
        objective text,
        observed_state_json text not null,
        model_summary text,
        created_at text not null
      );
      create index if not exists project_task_snapshots_thread_idx
        on project_task_snapshots(thread_id, through_sequence desc, created_at desc);
    `);
    ensureColumn(this.database, "project_task_session_bindings", "execution_id", "text");
    ensureColumn(this.database, "project_task_events", "event_key", "text");
    ensureColumn(this.database, "project_task_events", "visibility", "text");
    ensureColumn(this.database, "project_task_events", "run_id", "text");
    ensureColumn(this.database, "project_task_events", "item_id", "text");
    this.database.exec(`
      drop index if exists project_task_events_operation_uq;
      update project_task_events
      set event_key = event_type || ':' || coalesce(operation_id, event_id)
      where event_key is null;
      update project_task_events set visibility = 'model' where visibility is null;
      create unique index if not exists project_task_events_key_uq
        on project_task_events(thread_id, event_key);
    `);
    const threadIds = this.database.prepare(`
      select distinct thread_id from project_task_events order by thread_id
    `).pluck().all() as string[];
    const upsertProjection = this.database.prepare(`
      insert into project_activity_projections (
        thread_id, last_sequence, projection_json, updated_at
      ) values (?, ?, ?, ?)
      on conflict(thread_id) do update set
        last_sequence = excluded.last_sequence,
        projection_json = excluded.projection_json,
        updated_at = excluded.updated_at
    `);
    const rebuild = this.database.transaction(() => {
      for (const threadId of threadIds) {
        const events = this.database.prepare(`
          select * from project_task_events where thread_id = ? order by sequence asc
        `).all(threadId) as EventRow[];
        const projection = projectActivityProjection(threadId, events);
        upsertProjection.run(
          threadId,
          projection.lastSequence,
          JSON.stringify(projection),
          projection.updatedAt,
        );
      }
    });
    rebuild.immediate();
  }

  private timestamp(): string {
    return new Date(this.clock()).toISOString();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("ProjectTaskContinuityStore is closed.");
  }
}

function mapSessionBinding(row: SessionBindingRow): ProjectTaskSessionBinding {
  return {
    sessionRef: row.session_ref,
    actorId: row.actor_id,
    ...(row.organization_ref ? { organizationRef: row.organization_ref } : {}),
    threadId: row.thread_id,
    ...(row.execution_id ? { executionId: row.execution_id } : {}),
    boundAt: row.bound_at,
    lastSeenAt: row.last_seen_at,
  };
}

function mapEvent(row: EventRow): ProjectTaskEvent {
  return {
    eventId: row.event_id,
    eventKey: row.event_key ?? `${row.event_type}:${row.operation_id ?? row.event_id}`,
    threadId: row.thread_id,
    sequence: row.sequence,
    type: row.event_type,
    source: row.source,
    trust: row.trust,
    visibility: row.visibility ?? "model",
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.operation_id ? { operationId: row.operation_id } : {}),
    ...(row.item_id ? { itemId: row.item_id } : {}),
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

function emptyActivityProjection(threadId: string, updatedAt: string): ProjectActivityProjection {
  return {
    threadId,
    status: "idle",
    phase: "idle",
    summary: "No DevSpace activity has been recorded.",
    activeItems: [],
    lastSequence: 0,
    updatedAt,
  };
}

function projectActivityProjection(threadId: string, rows: EventRow[]): ProjectActivityProjection {
  let projection = emptyActivityProjection(threadId, rows.at(-1)?.created_at ?? new Date(0).toISOString());
  const activeItems = new Map<string, ProjectActivityItemProjection>();
  for (const row of rows) {
    const event = mapEvent(row);
    const summary = typeof event.payload.summary === "string"
      ? event.payload.summary
      : event.type.replaceAll("_", " ").replaceAll(".", " ");
    const itemId = event.itemId ?? event.operationId;
    if (event.type === "operation.accepted") {
      projection = { ...projection, status: "queued", phase: "validating", summary };
    } else if (event.type === "command.started") {
      projection = { ...projection, status: "running", phase: "executing", summary };
      if (itemId) activeItems.set(itemId, {
        itemId,
        ...(event.operationId ? { operationId: event.operationId } : {}),
        kind: "command",
        status: "running",
        summary,
        updatedAt: event.createdAt,
      });
    } else if (event.type === "command.output_available") {
      const outputId = typeof event.payload.outputId === "string" ? event.payload.outputId : undefined;
      if (outputId) projection = {
        ...projection,
        latestOutput: {
          outputId,
          nextOffset: numberPayload(event.payload.nextOffset),
          totalBytes: numberPayload(event.payload.totalBytes),
          storedBytes: numberPayload(event.payload.storedBytes),
          droppedBytes: numberPayload(event.payload.droppedBytes),
          status: event.payload.status === "completed" || event.payload.status === "unknown"
            ? event.payload.status
            : "active",
        },
      };
    } else if (event.type === "patch.received" || event.type === "patch.validated") {
      projection = { ...projection, status: "running", phase: "applying_patch", summary };
      if (itemId) activeItems.set(itemId, {
        itemId,
        ...(event.operationId ? { operationId: event.operationId } : {}),
        kind: "patch",
        status: "running",
        summary,
        updatedAt: event.createdAt,
      });
    } else if (event.type === "patch.applied" || event.type === "patch_applied") {
      projection = {
        ...projection,
        status: "completed",
        phase: "finalizing",
        summary,
        latestPatch: {
          ...(event.operationId ? { operationId: event.operationId } : {}),
          files: numberPayload(event.payload.files ?? objectNumber(event.payload.summary, "files")),
          additions: numberPayload(
            event.payload.additions ?? objectNumber(event.payload.summary, "additions"),
          ),
          removals: numberPayload(
            event.payload.removals ?? objectNumber(event.payload.summary, "removals"),
          ),
        },
      };
      if (itemId) activeItems.delete(itemId);
    } else if (event.type === "approval.required") {
      projection = { ...projection, status: "waiting_approval", phase: "waiting_approval", summary };
      if (typeof event.payload.approvalRef === "string") projection.pendingApproval = {
        approvalRef: event.payload.approvalRef,
        actionSummary: summary,
        ...(typeof event.payload.expiresAt === "string" ? { expiresAt: event.payload.expiresAt } : {}),
      };
    } else if (event.type === "command.completed" || event.type === "command_completed" || event.type === "operation.settled") {
      const { pendingApproval: _pendingApproval, ...withoutApproval } = projection;
      const terminalOutputId = typeof event.payload.outputId === "string"
        ? event.payload.outputId
        : projection.latestOutput?.outputId;
      projection = {
        ...withoutApproval,
        status: "completed",
        phase: "finalizing",
        summary,
        ...(terminalOutputId
          ? {
              latestOutput: {
                outputId: terminalOutputId,
                nextOffset: numberPayload(
                  event.payload.storedBytes ?? projection.latestOutput?.nextOffset,
                ),
                totalBytes: numberPayload(
                  event.payload.totalBytes ?? projection.latestOutput?.totalBytes,
                ),
                storedBytes: numberPayload(
                  event.payload.storedBytes ?? projection.latestOutput?.storedBytes,
                ),
                droppedBytes: numberPayload(
                  event.payload.droppedBytes ?? projection.latestOutput?.droppedBytes,
                ),
                status: "completed" as const,
              },
            }
          : {}),
      };
      if (itemId) activeItems.delete(itemId);
    } else if (event.type === "command.failed" || event.type === "operation.failed") {
      const terminalOutputId = typeof event.payload.outputId === "string"
        ? event.payload.outputId
        : projection.latestOutput?.outputId;
      projection = {
        ...projection,
        status: "failed",
        phase: "finalizing",
        summary,
        ...(terminalOutputId && projection.latestOutput
          ? { latestOutput: { ...projection.latestOutput, status: "completed" as const } }
          : {}),
      };
      if (itemId) activeItems.delete(itemId);
    } else if (event.type === "operation.interrupt_requested") {
      projection = { ...projection, status: "running", phase: "executing", summary };
    } else if (event.type === "command.interrupted" || event.type === "operation.interrupted") {
      projection = { ...projection, status: "interrupted", phase: "finalizing", summary };
      if (itemId) activeItems.delete(itemId);
    } else if (event.type === "operation.outcome_unknown") {
      projection = { ...projection, status: "outcome_unknown", phase: "finalizing", summary };
    } else if (event.type === "thread_paused") {
      projection = { ...projection, status: "paused", phase: "idle", summary };
    } else if (event.type === "thread_archived") {
      projection = { ...projection, status: "archived", phase: "idle", summary };
    }
    projection = {
      ...projection,
      activeItems: [...activeItems.values()],
      lastSequence: event.sequence,
      updatedAt: event.createdAt,
    };
  }
  return projection;
}

function numberPayload(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function objectNumber(value: unknown, key: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function ensureColumn(
  database: Database.Database,
  table: string,
  column: string,
  declaration: string,
): void {
  const columns = database.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((candidate) => candidate.name === column)) {
    database.exec(`alter table ${table} add column ${column} ${declaration}`);
  }
}

function mapSnapshot(row: SnapshotRow): ProjectTaskSnapshot {
  return {
    snapshotId: row.snapshot_id,
    threadId: row.thread_id,
    throughSequence: row.through_sequence,
    ...(row.objective ? { objective: row.objective } : {}),
    observedState: JSON.parse(row.observed_state_json) as Record<string, unknown>,
    ...(row.model_summary ? { modelSummary: row.model_summary, modelSummaryTrust: "untrusted" as const } : {}),
    createdAt: row.created_at,
  };
}

function optionalBounded(value: string | undefined, name: string, maximum: number): string | null {
  return value === undefined ? null : bounded(value, name, maximum);
}

function bounded(value: string, name: string, maximum: number): string {
  if (!value || value.includes("\0") || Buffer.byteLength(value, "utf8") > maximum) {
    throw new Error(`${name} is invalid or exceeds ${maximum} UTF-8 bytes.`);
  }
  return value;
}

function stableJson(value: Record<string, unknown>, maximum: number, name: string): string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > maximum) {
    throw new Error(`${name} exceeds ${maximum} UTF-8 bytes.`);
  }
  return serialized;
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("limit must be positive.");
  return Math.min(value, 500);
}
