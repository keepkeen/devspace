import { randomUUID } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "./db/client.js";

export const MAX_PROJECT_HANDOFF_TITLE_UTF8_BYTES = 256;
export const MAX_PROJECT_HANDOFF_PROGRESS_UTF8_BYTES = 8_192;
export const MAX_PROJECT_HANDOFF_MODEL_TEXT_JSON_BYTES = 12_000;
export const MAX_RESUMABLE_PROJECT_HANDOFFS = 20;
export const MAX_COMPLETED_PROJECT_HANDOFFS = 80;
export const MAX_LISTED_PROJECT_HANDOFFS = 100;

export type ProjectHandoffStatus = "resumable" | "completed";

export interface ProjectHandoff {
  handoffId: string;
  projectRef: string;
  projectFingerprint: string;
  title: string;
  progress: string;
  status: ProjectHandoffStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ProjectHandoffStoreOptions {
  now?: () => number;
  createHandoffId?: () => string;
}

export interface ListProjectHandoffsOptions {
  projectFingerprints: readonly string[];
  perProjectLimit?: number;
  totalLimit?: number;
}

export interface ProjectHandoffListing {
  handoffs: ProjectHandoff[];
  truncated: boolean;
}

export interface SaveProjectHandoffInput {
  executionId: string;
  projectRef: string;
  projectFingerprint: string;
  title: string;
  progress: string;
  status?: ProjectHandoffStatus;
  ifMatch?: number;
}

export type SaveProjectHandoffResult =
  | { status: "created"; handoff: ProjectHandoff }
  | { status: "updated"; handoff: ProjectHandoff }
  | { status: "execution_unavailable" }
  | { status: "if_match_unexpected" }
  | { status: "if_match_required"; current: ProjectHandoff }
  | { status: "revision_conflict"; current: ProjectHandoff }
  | { status: "handoff_completed"; current: ProjectHandoff }
  | { status: "handoff_retired" }
  | { status: "capacity"; limit: number };

interface ProjectHandoffRow {
  handoff_id: string;
  project_ref: string;
  project_fingerprint: string;
  title: string;
  progress: string;
  status: ProjectHandoffStatus;
  revision: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface ExecutionHandoffRow {
  project_ref: string;
  project_fingerprint: string;
  handoff_id: string | null;
  handoff_retired: 0 | 1;
}

const MAX_ID_UTF8_BYTES = 1_024;
const MAX_PROJECT_REF_UTF8_BYTES = 1_024;
const MAX_PROJECT_FINGERPRINT_UTF8_BYTES = 1_024;
const MAX_PROJECT_FINGERPRINTS_PER_LIST = 100;

export class ProjectHandoffStore {
  private readonly database: DatabaseHandle;
  private readonly clock: () => number;
  private readonly createHandoffId: () => string;
  private closed = false;

  constructor(stateDir: string, options: ProjectHandoffStoreOptions = {}) {
    this.database = openDatabase(stateDir);
    this.clock = options.now ?? Date.now;
    this.createHandoffId = options.createHandoffId ?? randomUUID;
  }

  getForProject(
    projectFingerprint: string,
    handoffId: string,
    options: { resumableOnly?: boolean } = {},
  ): ProjectHandoff | undefined {
    this.assertOpen();
    const fingerprint = boundedUtf8String(
      projectFingerprint,
      "projectFingerprint",
      MAX_PROJECT_FINGERPRINT_UTF8_BYTES,
    );
    const id = boundedUtf8String(handoffId, "handoffId", MAX_ID_UTF8_BYTES);
    const row = this.database.sqlite.prepare(`
      select *
      from project_handoffs
      where project_fingerprint = ? and handoff_id = ?
        ${options.resumableOnly ? "and status = 'resumable'" : ""}
    `).get(fingerprint, id) as ProjectHandoffRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  getForExecution(executionId: string): ProjectHandoff | undefined {
    this.assertOpen();
    const id = boundedUtf8String(executionId, "executionId", MAX_ID_UTF8_BYTES);
    const row = this.database.sqlite.prepare(`
      select handoff.*
      from project_executions as execution
      join project_handoffs as handoff
        on handoff.handoff_id = execution.handoff_id
       and handoff.project_fingerprint = execution.project_fingerprint
      where execution.execution_id = ?
    `).get(id) as ProjectHandoffRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  listResumable(options: ListProjectHandoffsOptions): ProjectHandoffListing {
    this.assertOpen();
    const perProjectLimit = boundedLimit(
      options.perProjectLimit ?? MAX_RESUMABLE_PROJECT_HANDOFFS,
      "perProjectLimit",
      MAX_RESUMABLE_PROJECT_HANDOFFS,
    );
    const totalLimit = boundedLimit(
      options.totalLimit ?? MAX_LISTED_PROJECT_HANDOFFS,
      "totalLimit",
      MAX_LISTED_PROJECT_HANDOFFS,
    );
    const projectFingerprints = [...new Set(options.projectFingerprints.map((value) =>
      boundedUtf8String(
        value,
        "projectFingerprint",
        MAX_PROJECT_FINGERPRINT_UTF8_BYTES,
      )
    ))];
    if (projectFingerprints.length > MAX_PROJECT_FINGERPRINTS_PER_LIST) {
      throw new Error(
        `projectFingerprints must contain at most ${MAX_PROJECT_FINGERPRINTS_PER_LIST} entries`,
      );
    }
    if (projectFingerprints.length === 0) return { handoffs: [], truncated: false };

    const placeholders = projectFingerprints.map(() => "?").join(", ");
    const rows = this.database.sqlite.prepare(`
      select *
      from project_handoffs
      where status = 'resumable'
        and project_fingerprint in (${placeholders})
      order by updated_at desc, handoff_id
    `).all(...projectFingerprints) as ProjectHandoffRow[];

    const handoffs: ProjectHandoff[] = [];
    const perProjectCounts = new Map<string, number>();
    let truncated = false;
    for (const row of rows) {
      const count = perProjectCounts.get(row.project_fingerprint) ?? 0;
      if (count >= perProjectLimit || handoffs.length >= totalLimit) {
        truncated = true;
        continue;
      }
      handoffs.push(mapRow(row));
      perProjectCounts.set(row.project_fingerprint, count + 1);
    }
    return { handoffs, truncated };
  }

  listSelection(projectFingerprint: string): ProjectHandoff[] {
    return this.listResumable({
      projectFingerprints: [projectFingerprint],
      perProjectLimit: 2,
      totalLimit: 2,
    }).handoffs;
  }

  saveForExecution(input: SaveProjectHandoffInput): SaveProjectHandoffResult {
    this.assertOpen();
    const normalized = validateSaveInput(input);
    const save = this.database.sqlite.transaction((): SaveProjectHandoffResult => {
      const execution = this.database.sqlite.prepare(`
        select project_ref, project_fingerprint, handoff_id, handoff_retired
        from project_executions
        where execution_id = ? and project_ref = ? and project_fingerprint = ?
          and status = 'active'
      `).get(
        normalized.executionId,
        normalized.projectRef,
        normalized.projectFingerprint,
      ) as ExecutionHandoffRow | undefined;
      if (!execution) return { status: "execution_unavailable" };
      if (execution.handoff_retired === 1) return { status: "handoff_retired" };

      if (execution.handoff_id === null) {
        if (normalized.ifMatch !== undefined) return { status: "if_match_unexpected" };
        if (normalized.status === "resumable") {
          const activeCount = this.database.sqlite.prepare(`
            select count(*) as count
            from project_handoffs
            where project_fingerprint = ? and status = 'resumable'
          `).get(normalized.projectFingerprint) as { count: number };
          if (activeCount.count >= MAX_RESUMABLE_PROJECT_HANDOFFS) {
            return {
              status: "capacity",
              limit: MAX_RESUMABLE_PROJECT_HANDOFFS,
            };
          }
        }

        const now = new Date(this.clock()).toISOString();
        if (normalized.status === "completed") {
          this.pruneCompletedForInsert(normalized.projectFingerprint, now);
        }
        const handoffId = boundedUtf8String(
          this.createHandoffId(),
          "handoffId",
          MAX_ID_UTF8_BYTES,
        );
        this.database.sqlite.prepare(`
          insert into project_handoffs (
            handoff_id, project_ref, project_fingerprint, title, progress,
            status, revision, created_at, updated_at, completed_at
          ) values (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        `).run(
          handoffId,
          normalized.projectRef,
          normalized.projectFingerprint,
          normalized.title,
          normalized.progress,
          normalized.status,
          now,
          now,
          normalized.status === "completed" ? now : null,
        );
        const attached = this.database.sqlite.prepare(`
          update project_executions
          set handoff_id = ?, handoff_retired = 0, updated_at = ?
          where execution_id = ? and project_fingerprint = ?
            and handoff_id is null and handoff_retired = 0 and status = 'active'
        `).run(
          handoffId,
          now,
          normalized.executionId,
          normalized.projectFingerprint,
        );
        if (attached.changes !== 1) {
          throw new Error("Project execution handoff attachment changed concurrently");
        }
        return {
          status: "created",
          handoff: this.getRequired(handoffId),
        };
      }

      const current = this.getRequired(execution.handoff_id);
      if (current.status === "completed") {
        return { status: "handoff_completed", current };
      }
      if (normalized.ifMatch === undefined) {
        return { status: "if_match_required", current };
      }
      if (normalized.ifMatch !== current.revision) {
        return { status: "revision_conflict", current };
      }

      const now = new Date(this.clock()).toISOString();
      if (normalized.status === "completed") {
        this.pruneCompletedForInsert(normalized.projectFingerprint, now);
      }
      const updated = this.database.sqlite.prepare(`
        update project_handoffs
        set project_ref = ?, title = ?, progress = ?, status = ?,
          revision = revision + 1, updated_at = ?, completed_at = ?
        where handoff_id = ? and project_fingerprint = ?
          and status = 'resumable' and revision = ?
      `).run(
        normalized.projectRef,
        normalized.title,
        normalized.progress,
        normalized.status,
        now,
        normalized.status === "completed" ? now : null,
        current.handoffId,
        normalized.projectFingerprint,
        normalized.ifMatch,
      );
      if (updated.changes !== 1) {
        const latest = this.getRequired(current.handoffId);
        return latest.status === "completed"
          ? { status: "handoff_completed", current: latest }
          : { status: "revision_conflict", current: latest };
      }
      return {
        status: "updated",
        handoff: this.getRequired(current.handoffId),
      };
    });
    return save.immediate();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private getRequired(handoffId: string): ProjectHandoff {
    const row = this.database.sqlite.prepare(`
      select * from project_handoffs where handoff_id = ?
    `).get(handoffId) as ProjectHandoffRow | undefined;
    if (!row) throw new Error("Project handoff disappeared during update");
    return mapRow(row);
  }

  private pruneCompletedForInsert(
    projectFingerprint: string,
    updatedAt: string,
  ): void {
    const completedCount = this.database.sqlite.prepare(`
      select count(*) as count
      from project_handoffs
      where project_fingerprint = ? and status = 'completed'
    `).get(projectFingerprint) as { count: number };
    const pruneCount = completedCount.count - MAX_COMPLETED_PROJECT_HANDOFFS + 1;
    if (pruneCount <= 0) return;

    const rows = this.database.sqlite.prepare(`
      select handoff_id
      from project_handoffs
      where project_fingerprint = ? and status = 'completed'
      order by completed_at, updated_at, handoff_id
      limit ?
    `).all(projectFingerprint, pruneCount) as Array<{ handoff_id: string }>;
    if (rows.length !== pruneCount) {
      throw new Error("Completed Project handoff retention changed concurrently");
    }
    const detach = this.database.sqlite.prepare(`
      update project_executions
      set handoff_id = null, handoff_retired = 1, updated_at = ?
      where project_fingerprint = ? and handoff_id = ?
    `);
    const remove = this.database.sqlite.prepare(`
      delete from project_handoffs
      where project_fingerprint = ? and handoff_id = ? and status = 'completed'
    `);
    for (const row of rows) {
      detach.run(updatedAt, projectFingerprint, row.handoff_id);
      const removed = remove.run(projectFingerprint, row.handoff_id);
      if (removed.changes !== 1) {
        throw new Error("Completed Project handoff retention changed concurrently");
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("ProjectHandoffStore is closed");
  }
}

function validateSaveInput(input: SaveProjectHandoffInput): Required<
  Omit<SaveProjectHandoffInput, "ifMatch" | "status">
> & {
  status: ProjectHandoffStatus;
  ifMatch?: number;
} {
  if (
    input.ifMatch !== undefined &&
    (!Number.isSafeInteger(input.ifMatch) || input.ifMatch < 1)
  ) {
    throw new Error("ifMatch must be a positive safe integer");
  }
  const status = input.status ?? "resumable";
  if (status !== "resumable" && status !== "completed") {
    throw new Error("status must be resumable or completed");
  }
  const title = boundedUtf8String(
    input.title,
    "title",
    MAX_PROJECT_HANDOFF_TITLE_UTF8_BYTES,
  );
  const progress = boundedUtf8String(
    input.progress,
    "progress",
    MAX_PROJECT_HANDOFF_PROGRESS_UTF8_BYTES,
  );
  if (
    projectHandoffModelTextJsonBytes(title, progress) >
      MAX_PROJECT_HANDOFF_MODEL_TEXT_JSON_BYTES
  ) {
    throw new Error(
      `title and progress exceed the ${MAX_PROJECT_HANDOFF_MODEL_TEXT_JSON_BYTES}-byte serialized context limit`,
    );
  }
  return {
    executionId: boundedUtf8String(input.executionId, "executionId", MAX_ID_UTF8_BYTES),
    projectRef: boundedUtf8String(
      input.projectRef,
      "projectRef",
      MAX_PROJECT_REF_UTF8_BYTES,
    ),
    projectFingerprint: boundedUtf8String(
      input.projectFingerprint,
      "projectFingerprint",
      MAX_PROJECT_FINGERPRINT_UTF8_BYTES,
    ),
    title,
    progress,
    status,
    ...(input.ifMatch === undefined ? {} : { ifMatch: input.ifMatch }),
  };
}

export function projectHandoffModelTextJsonBytes(
  title: string,
  progress: string,
): number {
  return Buffer.byteLength(JSON.stringify({ title, progress }), "utf8");
}

function mapRow(row: ProjectHandoffRow): ProjectHandoff {
  return {
    handoffId: row.handoff_id,
    projectRef: row.project_ref,
    projectFingerprint: row.project_fingerprint,
    title: row.title,
    progress: row.progress,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

function boundedUtf8String(value: unknown, label: string, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new Error(
      `${label} must be a non-empty string of at most ${maximumBytes} UTF-8 bytes without NUL`,
    );
  }
  return value;
}

function boundedLimit(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  }
  return value;
}
