import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export type ProjectThreadStatus = "active" | "paused" | "archived" | "completed" | "closed";
export type ProjectThreadVisibility = "private" | "shared";
export type ProjectThreadCheckoutKind = "checkout" | "worktree";
export type ProjectCheckpointCause =
  | "patch_applied"
  | "command_completed"
  | "execution_idle"
  | "service_shutdown"
  | "thread_left"
  | "manual";

export interface ProjectThread {
  threadId: string;
  profileId: string;
  projectRef: string;
  projectFingerprint: string;
  title: string;
  revision: number;
  status: ProjectThreadStatus;
  visibility: ProjectThreadVisibility;
  checkoutKind: ProjectThreadCheckoutKind;
  checkoutRoot: string;
  worktreeId?: string;
  instructionRevision?: string;
  skillRevision?: string;
  gitBase?: string;
  gitHead?: string;
  latestCheckpointId?: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  closedAt?: string;
}

export interface ProjectCheckpoint {
  checkpointId: string;
  threadId: string;
  cause: ProjectCheckpointCause;
  observedState: Record<string, unknown>;
  modelSummary?: string;
  modelSummaryTrust?: "untrusted";
  sourceOperationId?: string;
  createdAt: string;
}

export interface CreateProjectThreadInput {
  threadId?: string;
  profileId: string;
  projectRef: string;
  projectFingerprint: string;
  title?: string;
  visibility?: ProjectThreadVisibility;
  checkoutKind: ProjectThreadCheckoutKind;
  checkoutRoot: string;
  worktreeId?: string;
  instructionRevision?: string;
  skillRevision?: string;
  gitBase?: string;
  gitHead?: string;
}

export interface AppendProjectCheckpointInput {
  threadId: string;
  profileId: string;
  cause: ProjectCheckpointCause;
  observedState: Record<string, unknown>;
  modelSummary?: string;
  sourceOperationId?: string;
}

export interface ProjectThreadResumeState {
  thread: ProjectThread;
  checkpoint?: ProjectCheckpoint;
  modelSummary?: string;
}

export type SaveProjectThreadProgressResult =
  | { status: "saved"; thread: ProjectThread; checkpoint: ProjectCheckpoint }
  | { status: "thread_unavailable" }
  | { status: "if_match_unexpected"; current: ProjectThread }
  | { status: "if_match_required"; current: ProjectThread }
  | { status: "revision_conflict"; current: ProjectThread }
  | { status: "thread_closed"; current: ProjectThread };

export interface ProjectThreadStoreOptions {
  now?: () => number;
  createThreadId?: () => string;
  createCheckpointId?: () => string;
}

interface ThreadRow {
  thread_id: string;
  profile_id: string;
  project_ref: string;
  project_fingerprint: string;
  title: string;
  revision: number;
  status: ProjectThreadStatus;
  visibility: ProjectThreadVisibility;
  checkout_kind: ProjectThreadCheckoutKind;
  checkout_root: string;
  worktree_id: string | null;
  instruction_revision: string | null;
  skill_revision: string | null;
  git_base: string | null;
  git_head: string | null;
  latest_checkpoint_id: string | null;
  latest_summary_checkpoint_id: string | null;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  closed_at: string | null;
}

interface CheckpointRow {
  checkpoint_id: string;
  thread_id: string;
  cause: ProjectCheckpointCause;
  observed_state_json: string;
  model_summary: string | null;
  source_operation_id: string | null;
  created_at: string;
}

const MAX_ID_BYTES = 1_024;
const MAX_TITLE_BYTES = 512;
const MAX_ROOT_BYTES = 16_384;
const MAX_REVISION_BYTES = 1_024;
const MAX_MODEL_SUMMARY_BYTES = 8_192;
const MAX_OBSERVED_STATE_BYTES = 64 * 1_024;
const MAX_SOURCE_OPERATION_ID_BYTES = 128;

export class ProjectThreadStore {
  private readonly database: Database.Database;
  private readonly clock: () => number;
  private readonly createThreadId: () => string;
  private readonly createCheckpointId: () => string;
  private closed = false;

  constructor(stateDir: string, options: ProjectThreadStoreOptions = {}) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    const path = join(stateDir, "project-threads.sqlite");
    this.database = new Database(path);
    chmodSync(path, 0o600);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = NORMAL");
    this.database.pragma("busy_timeout = 5000");
    this.database.pragma("foreign_keys = ON");
    this.clock = options.now ?? Date.now;
    this.createThreadId = options.createThreadId ?? randomUUID;
    this.createCheckpointId = options.createCheckpointId ?? randomUUID;
    this.createSchema();
  }

  create(input: CreateProjectThreadInput): ProjectThread {
    this.assertOpen();
    const timestamp = this.timestamp();
    const thread: ProjectThread = {
      threadId: bounded(input.threadId ?? this.createThreadId(), "threadId", MAX_ID_BYTES),
      profileId: bounded(input.profileId, "profileId", MAX_ID_BYTES),
      projectRef: bounded(input.projectRef, "projectRef", MAX_ID_BYTES),
      projectFingerprint: bounded(input.projectFingerprint, "projectFingerprint", MAX_ID_BYTES),
      title: bounded(input.title ?? "New task", "title", MAX_TITLE_BYTES),
      revision: 1,
      status: "active",
      visibility: input.visibility ?? "private",
      checkoutKind: input.checkoutKind,
      checkoutRoot: bounded(input.checkoutRoot, "checkoutRoot", MAX_ROOT_BYTES),
      ...(input.worktreeId ? { worktreeId: bounded(input.worktreeId, "worktreeId", MAX_ID_BYTES) } : {}),
      ...(input.instructionRevision ? { instructionRevision: bounded(input.instructionRevision, "instructionRevision", MAX_REVISION_BYTES) } : {}),
      ...(input.skillRevision ? { skillRevision: bounded(input.skillRevision, "skillRevision", MAX_REVISION_BYTES) } : {}),
      ...(input.gitBase ? { gitBase: bounded(input.gitBase, "gitBase", MAX_REVISION_BYTES) } : {}),
      ...(input.gitHead ? { gitHead: bounded(input.gitHead, "gitHead", MAX_REVISION_BYTES) } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
    };
    this.database.prepare(`
      insert into project_threads (
        thread_id, profile_id, project_ref, project_fingerprint, title, revision,
        status, visibility, checkout_kind, checkout_root, worktree_id,
        instruction_revision, skill_revision, git_base, git_head,
        created_at, updated_at, last_activity_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      thread.threadId,
      thread.profileId,
      thread.projectRef,
      thread.projectFingerprint,
      thread.title,
      thread.revision,
      thread.status,
      thread.visibility,
      thread.checkoutKind,
      thread.checkoutRoot,
      thread.worktreeId ?? null,
      thread.instructionRevision ?? null,
      thread.skillRevision ?? null,
      thread.gitBase ?? null,
      thread.gitHead ?? null,
      thread.createdAt,
      thread.updatedAt,
      thread.lastActivityAt,
    );
    return thread;
  }

  get(threadId: string, profileId: string): ProjectThread | undefined {
    this.assertOpen();
    const row = this.database.prepare(`
      select * from project_threads where thread_id = ? and profile_id = ?
    `).get(
      bounded(threadId, "threadId", MAX_ID_BYTES),
      bounded(profileId, "profileId", MAX_ID_BYTES),
    ) as ThreadRow | undefined;
    return row ? mapThread(row) : undefined;
  }

  list(input: {
    profileId: string;
    projectFingerprint?: string;
    status?: ProjectThreadStatus;
    limit?: number;
  }): ProjectThread[] {
    this.assertOpen();
    const clauses = ["profile_id = ?"];
    const parameters: Array<string | number> = [
      bounded(input.profileId, "profileId", MAX_ID_BYTES),
    ];
    if (input.projectFingerprint) {
      clauses.push("project_fingerprint = ?");
      parameters.push(bounded(input.projectFingerprint, "projectFingerprint", MAX_ID_BYTES));
    }
    if (input.status) {
      clauses.push("status = ?");
      parameters.push(input.status);
    }
    parameters.push(positiveLimit(input.limit ?? 100));
    const rows = this.database.prepare(`
      select * from project_threads
      where ${clauses.join(" and ")}
      order by last_activity_at desc, thread_id
      limit ?
    `).all(...parameters) as ThreadRow[];
    return rows.map(mapThread);
  }

  bindExecution(threadId: string, profileId: string, executionId: string, grantId: string): void {
    this.assertOpen();
    const timestamp = this.timestamp();
    const transaction = this.database.transaction(() => {
      const updated = this.database.prepare(`
        update project_threads
        set updated_at = ?, last_activity_at = ?
        where thread_id = ? and profile_id = ? and status != 'closed'
      `).run(
        timestamp,
        timestamp,
        bounded(threadId, "threadId", MAX_ID_BYTES),
        bounded(profileId, "profileId", MAX_ID_BYTES),
      );
      if (updated.changes !== 1) throw new Error("Project thread is unavailable.");
      this.database.prepare(`
        insert into project_thread_executions (
          execution_id, thread_id, grant_id, bound_at, last_used_at
        ) values (?, ?, ?, ?, ?)
        on conflict(execution_id) do update set
          thread_id = excluded.thread_id,
          grant_id = excluded.grant_id,
          last_used_at = excluded.last_used_at
      `).run(
        bounded(executionId, "executionId", MAX_ID_BYTES),
        bounded(threadId, "threadId", MAX_ID_BYTES),
        bounded(grantId, "grantId", MAX_ID_BYTES),
        timestamp,
        timestamp,
      );
    });
    transaction.immediate();
  }

  threadIdForExecution(executionId: string): string | undefined {
    this.assertOpen();
    return this.database.prepare(`
      select thread_id from project_thread_executions where execution_id = ?
    `).pluck().get(bounded(executionId, "executionId", MAX_ID_BYTES)) as string | undefined;
  }

  executionIdsForThread(threadId: string, profileId: string): string[] {
    this.assertOpen();
    return this.database.prepare(`
      select execution.execution_id
      from project_thread_executions as execution
      join project_threads as thread on thread.thread_id = execution.thread_id
      where execution.thread_id = ? and thread.profile_id = ?
      order by execution.bound_at, execution.execution_id
    `).pluck().all(
      bounded(threadId, "threadId", MAX_ID_BYTES),
      bounded(profileId, "profileId", MAX_ID_BYTES),
    ) as string[];
  }

  resume(threadId: string, profileId: string): ProjectThreadResumeState | undefined {
    this.assertOpen();
    const thread = this.get(threadId, profileId);
    if (!thread || thread.status === "closed") return undefined;
    const checkpoint = this.latestCheckpoint(thread.threadId, profileId);
    return {
      thread,
      ...(checkpoint ? { checkpoint } : {}),
      ...(checkpoint?.modelSummary ? { modelSummary: checkpoint.modelSummary } : {}),
    };
  }

  appendCheckpoint(input: AppendProjectCheckpointInput): ProjectCheckpoint {
    this.assertOpen();
    const observedState = stableJson(input.observedState, MAX_OBSERVED_STATE_BYTES, "observedState");
    const modelSummary = optionalBounded(input.modelSummary, "modelSummary", MAX_MODEL_SUMMARY_BYTES);
    const sourceOperationId = optionalBounded(
      input.sourceOperationId,
      "sourceOperationId",
      MAX_SOURCE_OPERATION_ID_BYTES,
    );
    const normalizedThreadId = bounded(input.threadId, "threadId", MAX_ID_BYTES);
    const normalizedProfileId = bounded(input.profileId, "profileId", MAX_ID_BYTES);
    const existing = sourceOperationId
      ? this.database.prepare(`
          select checkpoint.*
          from project_thread_checkpoints as checkpoint
          join project_threads as thread on thread.thread_id = checkpoint.thread_id
          where checkpoint.thread_id = ? and thread.profile_id = ?
            and checkpoint.source_operation_id = ?
        `).get(normalizedThreadId, normalizedProfileId, sourceOperationId) as CheckpointRow | undefined
      : undefined;
    if (existing) return mapCheckpoint(existing);

    const checkpoint: ProjectCheckpoint = {
      checkpointId: bounded(this.createCheckpointId(), "checkpointId", MAX_ID_BYTES),
      threadId: normalizedThreadId,
      cause: input.cause,
      observedState: JSON.parse(observedState) as Record<string, unknown>,
      ...(modelSummary ? { modelSummary, modelSummaryTrust: "untrusted" as const } : {}),
      ...(sourceOperationId ? { sourceOperationId } : {}),
      createdAt: this.timestamp(),
    };
    const transaction = this.database.transaction(() => {
      const thread = this.database.prepare(`
        select * from project_threads where thread_id = ? and profile_id = ?
      `).get(normalizedThreadId, normalizedProfileId) as ThreadRow | undefined;
      if (!thread || thread.status === "closed") throw new Error("Project thread is unavailable.");
      this.insertCheckpoint(checkpoint, observedState);
      this.database.prepare(`
        update project_threads set
          latest_checkpoint_id = ?,
          latest_summary_checkpoint_id = coalesce(?, latest_summary_checkpoint_id),
          updated_at = ?, last_activity_at = ?
        where thread_id = ? and profile_id = ?
      `).run(
        checkpoint.checkpointId,
        checkpoint.modelSummary ? checkpoint.checkpointId : null,
        checkpoint.createdAt,
        checkpoint.createdAt,
        normalizedThreadId,
        normalizedProfileId,
      );
    });
    transaction.immediate();
    return checkpoint;
  }

  saveProgress(input: {
    threadId: string;
    profileId: string;
    title: string;
    modelSummary: string;
    observedState: Record<string, unknown>;
    sourceOperationId: string;
    ifMatch?: number;
    close?: boolean;
  }): SaveProjectThreadProgressResult {
    this.assertOpen();
    const threadId = bounded(input.threadId, "threadId", MAX_ID_BYTES);
    const profileId = bounded(input.profileId, "profileId", MAX_ID_BYTES);
    const title = bounded(input.title, "title", MAX_TITLE_BYTES);
    const summary = bounded(input.modelSummary, "modelSummary", MAX_MODEL_SUMMARY_BYTES);
    const operationId = bounded(
      input.sourceOperationId,
      "sourceOperationId",
      MAX_SOURCE_OPERATION_ID_BYTES,
    );
    const observedState = stableJson(input.observedState, MAX_OBSERVED_STATE_BYTES, "observedState");
    const save = this.database.transaction((): SaveProjectThreadProgressResult => {
      const row = this.database.prepare(`
        select * from project_threads where thread_id = ? and profile_id = ?
      `).get(threadId, profileId) as ThreadRow | undefined;
      if (!row) return { status: "thread_unavailable" };
      const current = mapThread(row);
      if (current.status === "closed") return { status: "thread_closed", current };
      if (current.revision === 1 && input.ifMatch !== undefined) {
        return { status: "if_match_unexpected", current };
      }
      if (current.revision > 1 && input.ifMatch === undefined) {
        return { status: "if_match_required", current };
      }
      if (input.ifMatch !== undefined && input.ifMatch !== current.revision) {
        return { status: "revision_conflict", current };
      }
      const existing = this.database.prepare(`
        select * from project_thread_checkpoints
        where thread_id = ? and source_operation_id = ?
      `).get(threadId, operationId) as CheckpointRow | undefined;
      if (existing) {
        return {
          status: "saved",
          thread: current,
          checkpoint: mapCheckpoint(existing),
        };
      }
      const timestamp = this.timestamp();
      const checkpoint: ProjectCheckpoint = {
        checkpointId: bounded(this.createCheckpointId(), "checkpointId", MAX_ID_BYTES),
        threadId,
        cause: "manual",
        observedState: JSON.parse(observedState) as Record<string, unknown>,
        modelSummary: summary,
        modelSummaryTrust: "untrusted",
        sourceOperationId: operationId,
        createdAt: timestamp,
      };
      this.insertCheckpoint(checkpoint, observedState);
      this.database.prepare(`
        update project_threads set
          title = ?, revision = revision + 1,
          status = ?, latest_checkpoint_id = ?, latest_summary_checkpoint_id = ?,
          updated_at = ?, last_activity_at = ?, closed_at = ?
        where thread_id = ? and profile_id = ?
      `).run(
        title,
        input.close ? "closed" : "active",
        checkpoint.checkpointId,
        checkpoint.checkpointId,
        timestamp,
        timestamp,
        input.close ? timestamp : null,
        threadId,
        profileId,
      );
      return {
        status: "saved",
        thread: this.getRequired(threadId, profileId),
        checkpoint,
      };
    });
    return save.immediate();
  }

  latestCheckpoint(threadId: string, profileId: string): ProjectCheckpoint | undefined {
    this.assertOpen();
    const row = this.database.prepare(`
      select checkpoint.*
      from project_threads as thread
      join project_thread_checkpoints as checkpoint
        on checkpoint.checkpoint_id = thread.latest_checkpoint_id
      where thread.thread_id = ? and thread.profile_id = ?
    `).get(
      bounded(threadId, "threadId", MAX_ID_BYTES),
      bounded(profileId, "profileId", MAX_ID_BYTES),
    ) as CheckpointRow | undefined;
    return row ? mapCheckpoint(row) : undefined;
  }

  updateRuntimeState(input: {
    threadId: string;
    profileId: string;
    instructionRevision?: string;
    skillRevision?: string;
    gitBase?: string;
    gitHead?: string;
  }): boolean {
    this.assertOpen();
    const timestamp = this.timestamp();
    const result = this.database.prepare(`
      update project_threads set
        instruction_revision = coalesce(?, instruction_revision),
        skill_revision = coalesce(?, skill_revision),
        git_base = coalesce(?, git_base),
        git_head = coalesce(?, git_head),
        updated_at = ?, last_activity_at = ?
      where thread_id = ? and profile_id = ? and status != 'closed'
    `).run(
      optionalBounded(input.instructionRevision, "instructionRevision", MAX_REVISION_BYTES),
      optionalBounded(input.skillRevision, "skillRevision", MAX_REVISION_BYTES),
      optionalBounded(input.gitBase, "gitBase", MAX_REVISION_BYTES),
      optionalBounded(input.gitHead, "gitHead", MAX_REVISION_BYTES),
      timestamp,
      timestamp,
      bounded(input.threadId, "threadId", MAX_ID_BYTES),
      bounded(input.profileId, "profileId", MAX_ID_BYTES),
    );
    return result.changes === 1;
  }

  setStatus(threadId: string, profileId: string, status: ProjectThreadStatus): boolean {
    this.assertOpen();
    const timestamp = this.timestamp();
    const write = () => this.database.prepare(`
        update project_threads
        set status = ?, revision = revision + 1,
          updated_at = ?, last_activity_at = ?, closed_at = ?
        where thread_id = ? and profile_id = ?
      `).run(
        status,
        timestamp,
        timestamp,
        status === "closed" ? timestamp : null,
        bounded(threadId, "threadId", MAX_ID_BYTES),
        bounded(profileId, "profileId", MAX_ID_BYTES),
      );
    if (status === "archived" || status === "completed") {
      this.database.pragma("ignore_check_constraints = ON");
      try {
        return write().changes === 1;
      } finally {
        this.database.pragma("ignore_check_constraints = OFF");
      }
    }
    return write().changes === 1;
  }

  reassignProfile(threadId: string, fromProfileId: string, toProfileId: string): ProjectThread | undefined {
    this.assertOpen();
    const normalizedThreadId = bounded(threadId, "threadId", MAX_ID_BYTES);
    const from = bounded(fromProfileId, "fromProfileId", MAX_ID_BYTES);
    const to = bounded(toProfileId, "toProfileId", MAX_ID_BYTES);
    if (from === to) return this.get(normalizedThreadId, to);
    const timestamp = this.timestamp();
    const result = this.database.prepare(`
      update project_threads
      set profile_id = ?, revision = revision + 1,
        updated_at = ?, last_activity_at = ?
      where thread_id = ? and profile_id = ?
    `).run(to, timestamp, timestamp, normalizedThreadId, from);
    return result.changes === 1 ? this.get(normalizedThreadId, to) : undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private insertCheckpoint(checkpoint: ProjectCheckpoint, observedStateJson: string): void {
    this.database.prepare(`
      insert into project_thread_checkpoints (
        checkpoint_id, thread_id, cause, observed_state_json,
        model_summary, source_operation_id, created_at
      ) values (?, ?, ?, ?, ?, ?, ?)
    `).run(
      checkpoint.checkpointId,
      checkpoint.threadId,
      checkpoint.cause,
      observedStateJson,
      checkpoint.modelSummary ?? null,
      checkpoint.sourceOperationId ?? null,
      checkpoint.createdAt,
    );
  }

  private getRequired(threadId: string, profileId: string): ProjectThread {
    const thread = this.get(threadId, profileId);
    if (!thread) throw new Error("Project thread is unavailable.");
    return thread;
  }

  private createSchema(): void {
    this.database.exec(`
      create table if not exists project_threads (
        thread_id text primary key,
        profile_id text not null,
        project_ref text not null,
        project_fingerprint text not null,
        title text not null,
        revision integer not null check (revision >= 1),
        status text not null check (status in ('active', 'paused', 'archived', 'completed', 'closed')),
        visibility text not null check (visibility in ('private', 'shared')),
        checkout_kind text not null check (checkout_kind in ('checkout', 'worktree')),
        checkout_root text not null,
        worktree_id text,
        instruction_revision text,
        skill_revision text,
        git_base text,
        git_head text,
        latest_checkpoint_id text,
        latest_summary_checkpoint_id text,
        created_at text not null,
        updated_at text not null,
        last_activity_at text not null,
        closed_at text
      );
      create index if not exists project_threads_profile_activity_idx
        on project_threads(profile_id, last_activity_at desc);
      create index if not exists project_threads_project_activity_idx
        on project_threads(profile_id, project_fingerprint, last_activity_at desc);
      create unique index if not exists project_threads_writable_checkout_uq
        on project_threads(checkout_root)
        where status != 'closed' and checkout_kind = 'worktree';

      create table if not exists project_thread_checkpoints (
        checkpoint_id text primary key,
        thread_id text not null references project_threads(thread_id) on delete cascade,
        cause text not null check (cause in (
          'patch_applied', 'command_completed', 'execution_idle',
          'service_shutdown', 'thread_left', 'manual'
        )),
        observed_state_json text not null,
        model_summary text,
        source_operation_id text,
        created_at text not null
      );
      create index if not exists project_thread_checkpoints_thread_created_idx
        on project_thread_checkpoints(thread_id, created_at desc);
      create unique index if not exists project_thread_checkpoints_operation_uq
        on project_thread_checkpoints(thread_id, source_operation_id)
        where source_operation_id is not null;

      create table if not exists project_thread_executions (
        execution_id text primary key,
        thread_id text not null references project_threads(thread_id) on delete cascade,
        grant_id text not null,
        bound_at text not null,
        last_used_at text not null
      );
      create index if not exists project_thread_executions_thread_idx
        on project_thread_executions(thread_id, last_used_at desc);
    `);
  }

  private timestamp(): string {
    return new Date(this.clock()).toISOString();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("ProjectThreadStore is closed.");
  }
}

function mapThread(row: ThreadRow): ProjectThread {
  return {
    threadId: row.thread_id,
    profileId: row.profile_id,
    projectRef: row.project_ref,
    projectFingerprint: row.project_fingerprint,
    title: row.title,
    revision: row.revision,
    status: row.status,
    visibility: row.visibility,
    checkoutKind: row.checkout_kind,
    checkoutRoot: row.checkout_root,
    ...(row.worktree_id ? { worktreeId: row.worktree_id } : {}),
    ...(row.instruction_revision ? { instructionRevision: row.instruction_revision } : {}),
    ...(row.skill_revision ? { skillRevision: row.skill_revision } : {}),
    ...(row.git_base ? { gitBase: row.git_base } : {}),
    ...(row.git_head ? { gitHead: row.git_head } : {}),
    ...(row.latest_checkpoint_id ? { latestCheckpointId: row.latest_checkpoint_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    ...(row.closed_at ? { closedAt: row.closed_at } : {}),
  };
}

function mapCheckpoint(row: CheckpointRow): ProjectCheckpoint {
  return {
    checkpointId: row.checkpoint_id,
    threadId: row.thread_id,
    cause: row.cause,
    observedState: JSON.parse(row.observed_state_json) as Record<string, unknown>,
    ...(row.model_summary
      ? { modelSummary: row.model_summary, modelSummaryTrust: "untrusted" as const }
      : {}),
    ...(row.source_operation_id ? { sourceOperationId: row.source_operation_id } : {}),
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
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("limit must be a positive integer.");
  return Math.min(value, 500);
}
