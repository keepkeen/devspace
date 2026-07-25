import { openDatabase, type DatabaseHandle } from "./db/client.js";

export interface MutationOperationKey {
  connectionPrincipalId: string;
  workspaceId: string;
  tool: string;
  operationId: string;
}

export type MutationOperationState =
  | "pending"
  | "settled"
  | "outcome_unknown"
  | "verified_committed"
  | "verified_not_started"
  | "acknowledged_unknown";

export type MutationOperationResolution =
  | "verified_committed"
  | "verified_not_started"
  | "acknowledged_unknown";

export interface MutationOperationStatus {
  operationId: string;
  state: MutationOperationState;
  tool: string;
  workspaceId: string;
  workspaceGeneration: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  resultAvailable: boolean;
  resolution?: {
    state: MutationOperationResolution;
    method: string;
    evidenceType: string;
    evidence?: unknown;
    resolvedAt: string;
    operatorRef: string;
  };
}

export interface MutationOperationResolutionInput {
  connectionPrincipalId: string;
  operationId: string;
  resolution: MutationOperationResolution;
  method: string;
  evidenceType: string;
  evidence?: unknown;
  operatorRef: string;
}

export type MutationOperationReservation =
  | { status: "new" }
  | { status: "replay"; result: unknown }
  | { status: "conflict" }
  | { status: "stale_generation"; currentGeneration: number }
  | { status: "outcome_unknown" }
  | { status: "verified_not_started" }
  | { status: "result_unavailable" };

export type MutationOperationSettlement =
  | { status: "settled" }
  | { status: "result_unavailable" }
  | { status: "conflict" }
  | { status: "not_pending" };

export type MutationOperationUnknownOutcome =
  | { status: "outcome_unknown" }
  | { status: "conflict" }
  | { status: "not_pending" };

export interface MutationOperationStoreOptions {
  ttlMs?: number;
  maxResultBytes?: number;
  cleanupLimit?: number;
  now?: () => number;
}

interface MutationOperationRow {
  workspace_id: string;
  workspace_generation: number;
  tool: string;
  request_hash: string;
  state: MutationOperationState;
  result_json: string | null;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_RESULT_BYTES = 2 * 1024 * 1024;
const DEFAULT_CLEANUP_LIMIT = 100;
const MAX_CLEANUP_LIMIT = 10_000;
const MAX_KEY_PART_LENGTH = 1_024;
const MAX_TOOL_LENGTH = 256;
const MAX_REQUEST_HASH_LENGTH = 512;
const MAX_RESOLUTION_LABEL_LENGTH = 128;
const MAX_EVIDENCE_BYTES = 64 * 1024;

/**
 * Durable idempotency records for mutating tool calls. The store persists only
 * caller-supplied identity fields, a request digest, and the bounded result; it
 * never accepts or stores the request body itself. Result bodies expire, but
 * the operation identity remains a tombstone until its workspace is deleted so
 * an old operationId can never silently become a new mutation.
 */
export class MutationOperationStore {
  private readonly database: DatabaseHandle;
  private readonly ttlMs: number;
  private readonly maxResultBytes: number;
  private readonly cleanupLimit: number;
  private readonly clock: () => number;
  private closed = false;

  constructor(stateDir: string, options: MutationOperationStoreOptions = {}) {
    this.ttlMs = nonNegativeSafeInteger(options.ttlMs ?? DEFAULT_TTL_MS, "ttlMs");
    this.maxResultBytes = nonNegativeSafeInteger(
      options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
      "maxResultBytes",
    );
    this.cleanupLimit = positiveBoundedInteger(
      options.cleanupLimit ?? DEFAULT_CLEANUP_LIMIT,
      "cleanupLimit",
      MAX_CLEANUP_LIMIT,
    );
    this.clock = options.now ?? Date.now;
    this.database = openDatabase(stateDir);

    try {
      this.recoverInterruptedOperations();
    } catch (error) {
      this.database.close();
      this.closed = true;
      throw error;
    }
  }

  reserve(
    key: MutationOperationKey,
    requestHash: string,
    workspaceGeneration?: number,
  ): MutationOperationReservation {
    this.assertOpen();
    const normalizedKey = validateKey(key);
    const normalizedHash = boundedNonEmptyString(requestHash, "requestHash", MAX_REQUEST_HASH_LENGTH);
    const expectedGeneration = workspaceGeneration === undefined
      ? undefined
      : positiveSafeInteger(workspaceGeneration, "workspaceGeneration");
    const now = this.currentTime();
    const nowTimestamp = timestampFromMs(now);
    const expiresAt = expiryTimestamp(now, this.ttlMs);

    const reserveOperation = this.database.sqlite.transaction((): MutationOperationReservation => {
      this.database.sqlite
        .prepare(
          `update mutation_operations
           set result_json = null
           where connection_principal_id = ? and operation_id = ? and expires_at <= ?
             and result_json is not null`,
        )
        .run(normalizedKey.connectionPrincipalId, normalizedKey.operationId, nowTimestamp);

      const row = this.getRow(normalizedKey);
      if (row && !rowMatchesKey(row, normalizedKey)) return { status: "conflict" };
      if (row && row.request_hash !== normalizedHash) return { status: "conflict" };

      if (row) {
        if (
          expectedGeneration !== undefined &&
          row.workspace_generation !== expectedGeneration
        ) {
          return { status: "conflict" };
        }
        if (
          row.state === "outcome_unknown" ||
          row.state === "acknowledged_unknown" ||
          row.state === "pending"
        ) {
          return { status: "outcome_unknown" };
        }
        if (row.state === "verified_not_started") {
          return { status: "verified_not_started" };
        }
        if (row.result_json === null) return { status: "result_unavailable" };

        try {
          return { status: "replay", result: JSON.parse(row.result_json) as unknown };
        } catch {
          this.markSettledResultUnavailable(normalizedKey, nowTimestamp, expiresAt);
          return { status: "result_unavailable" };
        }
      }

      const currentGeneration = this.getWorkspaceGeneration(normalizedKey);
      if (currentGeneration === undefined) {
        throw new Error("Mutation operation workspace does not belong to the OAuth client");
      }
      if (expectedGeneration !== undefined && expectedGeneration !== currentGeneration) {
        return { status: "stale_generation", currentGeneration };
      }
      const observedGeneration = expectedGeneration ?? currentGeneration;

      this.database.sqlite
        .prepare(
          `insert into mutation_operations (
            connection_principal_id, workspace_id, tool, operation_id, workspace_generation,
            request_hash, state, result_json, created_at, updated_at, expires_at
          )
          values (?, ?, ?, ?, ?, ?, 'pending', null, ?, ?, ?)`,
        )
        .run(
          ...keyValues(normalizedKey),
          observedGeneration,
          normalizedHash,
          nowTimestamp,
          nowTimestamp,
          expiresAt,
        );
      return { status: "new" };
    });

    return reserveOperation.immediate();
  }

  settle(
    key: MutationOperationKey,
    requestHash: string,
    result: unknown,
  ): MutationOperationSettlement {
    this.assertOpen();
    const normalizedKey = validateKey(key);
    const normalizedHash = boundedNonEmptyString(requestHash, "requestHash", MAX_REQUEST_HASH_LENGTH);
    const resultJson = serializeJson(result);
    const resultAvailable = Buffer.byteLength(resultJson, "utf8") <= this.maxResultBytes;
    const now = this.currentTime();
    const nowTimestamp = timestampFromMs(now);
    const expiresAt = expiryTimestamp(now, this.ttlMs);

    const settleOperation = this.database.sqlite.transaction((): MutationOperationSettlement => {
      const row = this.getRow(normalizedKey);
      if (!row) return { status: "not_pending" };
      if (!rowMatchesKey(row, normalizedKey)) return { status: "conflict" };
      if (row.request_hash !== normalizedHash) return { status: "conflict" };
      if (row.state !== "pending") return { status: "not_pending" };

      this.database.sqlite
        .prepare(
          `update mutation_operations
           set state = 'settled', result_json = ?, updated_at = ?, expires_at = ?
           where connection_principal_id = ? and workspace_id = ? and tool = ? and operation_id = ?
             and request_hash = ? and state = 'pending'`,
        )
        .run(
          resultAvailable ? resultJson : null,
          nowTimestamp,
          expiresAt,
          ...keyValues(normalizedKey),
          normalizedHash,
        );

      return { status: resultAvailable ? "settled" : "result_unavailable" };
    });

    return settleOperation.immediate();
  }

  cancelPending(key: MutationOperationKey, requestHash: string): boolean {
    this.assertOpen();
    const normalizedKey = validateKey(key);
    const normalizedHash = boundedNonEmptyString(requestHash, "requestHash", MAX_REQUEST_HASH_LENGTH);
    const result = this.database.sqlite
      .prepare(
        `delete from mutation_operations
         where connection_principal_id = ? and workspace_id = ? and tool = ? and operation_id = ?
           and request_hash = ? and state = 'pending'`,
      )
      .run(...keyValues(normalizedKey), normalizedHash);
    return result.changes > 0;
  }

  markOutcomeUnknown(
    key: MutationOperationKey,
    requestHash: string,
  ): MutationOperationUnknownOutcome {
    this.assertOpen();
    const normalizedKey = validateKey(key);
    const normalizedHash = boundedNonEmptyString(requestHash, "requestHash", MAX_REQUEST_HASH_LENGTH);
    const now = this.currentTime();
    const nowTimestamp = timestampFromMs(now);
    const expiresAt = expiryTimestamp(now, this.ttlMs);

    const markUnknown = this.database.sqlite.transaction((): MutationOperationUnknownOutcome => {
      const row = this.getRow(normalizedKey);
      if (!row) return { status: "not_pending" };
      if (!rowMatchesKey(row, normalizedKey)) return { status: "conflict" };
      if (row.request_hash !== normalizedHash) return { status: "conflict" };
      if (row.state !== "pending") return { status: "not_pending" };

      this.database.sqlite
        .prepare(
          `update mutation_operations
           set state = 'outcome_unknown', result_json = null, updated_at = ?, expires_at = ?
           where connection_principal_id = ? and workspace_id = ? and tool = ? and operation_id = ?
             and request_hash = ? and state = 'pending'`,
        )
        .run(nowTimestamp, expiresAt, ...keyValues(normalizedKey), normalizedHash);
      return { status: "outcome_unknown" };
    });

    return markUnknown.immediate();
  }

  getOperationStatus(
    connectionPrincipalId: string,
    operationId: string,
  ): MutationOperationStatus | undefined {
    this.assertOpen();
    const normalizedConnectionPrincipalId = boundedNonEmptyString(
      connectionPrincipalId,
      "connectionPrincipalId",
      MAX_KEY_PART_LENGTH,
    );
    const normalizedOperationId = boundedNonEmptyString(
      operationId,
      "operationId",
      MAX_KEY_PART_LENGTH,
    );
    this.database.sqlite.prepare(`
      update mutation_operations
      set result_json = null
      where connection_principal_id = ? and operation_id = ? and expires_at <= ?
        and result_json is not null
    `).run(normalizedConnectionPrincipalId, normalizedOperationId, timestampFromMs(this.currentTime()));
    const row = this.database.sqlite.prepare(`
      select
        operation_id as operationId,
        state,
        tool,
        workspace_id as workspaceId,
        workspace_generation as workspaceGeneration,
        created_at as createdAt,
        updated_at as updatedAt,
        expires_at as expiresAt,
        resolution_method as resolutionMethod,
        evidence_type as evidenceType,
        evidence_json as evidenceJson,
        resolved_at as resolvedAt,
        operator_ref as operatorRef,
        case when state = 'settled' and result_json is not null then 1 else 0 end as resultAvailable
      from mutation_operations
      where connection_principal_id = ? and operation_id = ?
    `).get(normalizedConnectionPrincipalId, normalizedOperationId) as
      | Omit<MutationOperationStatus, "resultAvailable" | "resolution"> & {
          resultAvailable: 0 | 1;
          resolutionMethod: string | null;
          evidenceType: string | null;
          evidenceJson: string | null;
          resolvedAt: string | null;
          operatorRef: string | null;
        }
      | undefined;
    if (!row) return undefined;
    const {
      resolutionMethod,
      evidenceType,
      evidenceJson,
      resolvedAt,
      operatorRef,
      ...status
    } = row;
    const resolvedState = isResolutionState(row.state) ? row.state : undefined;
    return {
      ...status,
      resultAvailable: row.resultAvailable === 1,
      ...(resolvedState && resolutionMethod && evidenceType && resolvedAt && operatorRef
        ? {
            resolution: {
              state: resolvedState,
              method: resolutionMethod,
              evidenceType,
              ...(evidenceJson ? { evidence: parseJson(evidenceJson) } : {}),
              resolvedAt,
              operatorRef,
            },
          }
        : {}),
    };
  }

  resolveOutcome(input: MutationOperationResolutionInput): MutationOperationStatus | undefined {
    this.assertOpen();
    const connectionPrincipalId = boundedNonEmptyString(
      input.connectionPrincipalId,
      "connectionPrincipalId",
      MAX_KEY_PART_LENGTH,
    );
    const operationId = boundedNonEmptyString(
      input.operationId,
      "operationId",
      MAX_KEY_PART_LENGTH,
    );
    if (!isResolutionState(input.resolution)) throw new TypeError("Unknown operation resolution.");
    const method = boundedNonEmptyString(input.method, "method", MAX_RESOLUTION_LABEL_LENGTH);
    const evidenceType = boundedNonEmptyString(
      input.evidenceType,
      "evidenceType",
      MAX_RESOLUTION_LABEL_LENGTH,
    );
    const operatorRef = boundedNonEmptyString(
      input.operatorRef,
      "operatorRef",
      MAX_RESOLUTION_LABEL_LENGTH,
    );
    const evidenceJson = input.evidence === undefined ? null : serializeJson(input.evidence);
    if (evidenceJson && Buffer.byteLength(evidenceJson, "utf8") > MAX_EVIDENCE_BYTES) {
      throw new RangeError(`evidence exceeds ${MAX_EVIDENCE_BYTES} bytes`);
    }
    const now = timestampFromMs(this.currentTime());
    const result = this.database.sqlite.prepare(`
      update mutation_operations
      set state = ?, resolution_method = ?, evidence_type = ?, evidence_json = ?,
          resolved_at = ?, operator_ref = ?, updated_at = ?
      where connection_principal_id = ? and operation_id = ?
        and state = 'outcome_unknown'
    `).run(
      input.resolution,
      method,
      evidenceType,
      evidenceJson,
      now,
      operatorRef,
      now,
      connectionPrincipalId,
      operationId,
    );
    if (result.changes === 0) return undefined;
    return this.getOperationStatus(connectionPrincipalId, operationId);
  }

  cleanupExpired(limit = this.cleanupLimit): number {
    this.assertOpen();
    const boundedLimit = positiveBoundedInteger(limit, "limit", MAX_CLEANUP_LIMIT);
    const now = timestampFromMs(this.currentTime());
    return this.database.sqlite
      .prepare(
        `update mutation_operations
         set result_json = null
         where rowid in (
           select rowid from mutation_operations
           where expires_at <= ? and result_json is not null
           order by expires_at, rowid
           limit ?
         )`,
      )
      .run(now, boundedLimit).changes;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private recoverInterruptedOperations(): void {
    const now = this.currentTime();
    const nowTimestamp = timestampFromMs(now);
    const expiresAt = expiryTimestamp(now, this.ttlMs);
    const recover = this.database.sqlite.transaction(() => {
      this.database.sqlite
        .prepare(
          `update mutation_operations
           set state = 'outcome_unknown', result_json = null, updated_at = ?, expires_at = ?
           where state = 'pending'`,
        )
        .run(nowTimestamp, expiresAt);
    });
    recover.immediate();
  }

  private getRow(key: MutationOperationKey): MutationOperationRow | undefined {
    return this.database.sqlite
      .prepare(
        `select workspace_id, workspace_generation, tool, request_hash, state, result_json
         from mutation_operations
         where connection_principal_id = ? and operation_id = ?`,
      )
      .get(key.connectionPrincipalId, key.operationId) as MutationOperationRow | undefined;
  }

  private getWorkspaceGeneration(key: MutationOperationKey): number | undefined {
    const row = this.database.sqlite.prepare(`
      select state_generation as stateGeneration
      from workspace_sessions
      where id = ? and connection_principal_id = ?
    `).get(key.workspaceId, key.connectionPrincipalId) as { stateGeneration: number } | undefined;
    return row?.stateGeneration;
  }

  private markSettledResultUnavailable(key: MutationOperationKey, now: string, expiresAt: string): void {
    this.database.sqlite
      .prepare(
        `update mutation_operations
         set result_json = null, updated_at = ?, expires_at = ?
         where connection_principal_id = ? and workspace_id = ? and tool = ? and operation_id = ?
           and state = 'settled'`,
      )
      .run(now, expiresAt, ...keyValues(key));
  }

  private currentTime(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RangeError("now must return a non-negative safe integer");
    }
    return now;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Mutation operation store is closed");
  }
}

function validateKey(key: MutationOperationKey): MutationOperationKey {
  if (!key || typeof key !== "object") throw new TypeError("key must be an object");
  return {
    connectionPrincipalId: boundedNonEmptyString(
      key.connectionPrincipalId,
      "connectionPrincipalId",
      MAX_KEY_PART_LENGTH,
    ),
    workspaceId: boundedNonEmptyString(key.workspaceId, "workspaceId", MAX_KEY_PART_LENGTH),
    tool: boundedNonEmptyString(key.tool, "tool", MAX_TOOL_LENGTH),
    operationId: boundedNonEmptyString(key.operationId, "operationId", MAX_KEY_PART_LENGTH),
  };
}

function keyValues(key: MutationOperationKey): [string, string, string, string] {
  return [key.connectionPrincipalId, key.workspaceId, key.tool, key.operationId];
}

function rowMatchesKey(row: MutationOperationRow, key: MutationOperationKey): boolean {
  return row.workspace_id === key.workspaceId && row.tool === key.tool;
}

function boundedNonEmptyString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${name} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function positiveBoundedInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function expiryTimestamp(now: number, ttlMs: number): string {
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) throw new RangeError("operation expiry exceeds safe integer range");
  return timestampFromMs(expiresAt);
}

function timestampFromMs(value: number): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new RangeError("operation timestamp is outside the supported range");
  return timestamp.toISOString();
}

function serializeJson(result: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(result);
  } catch {
    throw new TypeError("result must be JSON-serializable");
  }
  if (serialized === undefined) throw new TypeError("result must be JSON-serializable");
  return serialized;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isResolutionState(value: string): value is MutationOperationResolution {
  return value === "verified_committed" ||
    value === "verified_not_started" ||
    value === "acknowledged_unknown";
}
