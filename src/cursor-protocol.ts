import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const CURSOR_SCHEMA_VERSION = 1 as const;
export type CursorResourceType = "instruction" | "skill" | "process" | "diff";
export type CursorParameterValue = string | number | boolean;

export interface CursorCallerIdentity {
  connectionPrincipalId: string;
  grantId: string;
  authorizationEpoch: number;
  executionId: string;
}

export interface CursorEnvelope {
  schemaVersion: typeof CURSOR_SCHEMA_VERSION;
  resourceType: CursorResourceType;
  principalRef: string;
  workspaceGeneration?: number;
  queryHash: string;
  revision: string;
  offset: number;
  /** Signed opaque resource identity used when continuation should need only the cursor. */
  resourceId?: string;
  /** Small signed query state used to reconstruct a continuation request. */
  parameters?: Record<string, CursorParameterValue>;
  expiresAt: number;
}

export class CursorProtocolError extends Error {
  constructor(readonly reason: "invalid" | "expired") {
    super(reason === "expired" ? "Cursor expired." : "Cursor is invalid.");
    this.name = "CursorProtocolError";
  }
}

const CURSOR_PREFIX = "dcur1.";
const CURSOR_DOMAIN = "devspace-signed-cursor-v1\0";
const CALLER_DOMAIN = "devspace-cursor-caller-v3\0";
const DEFAULT_CURSOR_TTL_MS = 30 * 60_000;
const MAX_CURSOR_TTL_MS = 24 * 60 * 60_000;
const MAX_CURSOR_BYTES = 4_096;
const MAX_FIELD_BYTES = 512;

export function encodeCursor(
  input: Omit<CursorEnvelope, "schemaVersion" | "expiresAt"> & { expiresAt?: number },
  key: string | Uint8Array,
  options: { now?: number; ttlMs?: number } = {},
): string {
  const now = options.now ?? Date.now();
  const ttlMs = boundedTtl(options.ttlMs ?? DEFAULT_CURSOR_TTL_MS);
  const envelope: CursorEnvelope = {
    schemaVersion: CURSOR_SCHEMA_VERSION,
    resourceType: input.resourceType,
    principalRef: input.principalRef,
    ...(input.workspaceGeneration === undefined
      ? {}
      : { workspaceGeneration: input.workspaceGeneration }),
    queryHash: input.queryHash,
    revision: input.revision,
    offset: input.offset,
    ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
    ...(input.parameters === undefined ? {} : { parameters: { ...input.parameters } }),
    expiresAt: input.expiresAt ?? now + ttlMs,
  };
  assertCursorEnvelope(envelope);
  if (envelope.expiresAt <= now || envelope.expiresAt > now + MAX_CURSOR_TTL_MS) {
    throw new RangeError("Cursor expiry must be in the future and within 24 hours.");
  }
  const body = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
  const signature = cursorSignature(body, key).toString("base64url");
  const cursor = `${CURSOR_PREFIX}${body}.${signature}`;
  if (Buffer.byteLength(cursor, "utf8") > MAX_CURSOR_BYTES) {
    throw new RangeError("Cursor exceeds the maximum encoded size.");
  }
  return cursor;
}

export function decodeCursor(
  cursor: string,
  key: string | Uint8Array,
  now = Date.now(),
): CursorEnvelope {
  try {
    if (
      typeof cursor !== "string" ||
      !cursor.startsWith(CURSOR_PREFIX) ||
      Buffer.byteLength(cursor, "utf8") > MAX_CURSOR_BYTES
    ) {
      throw new CursorProtocolError("invalid");
    }
    const framed = cursor.slice(CURSOR_PREFIX.length);
    const [body, signature, extra] = framed.split(".");
    if (
      !body ||
      !signature ||
      extra !== undefined ||
      !/^[A-Za-z0-9_-]+$/u.test(body) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(signature)
    ) {
      throw new CursorProtocolError("invalid");
    }
    const expected = cursorSignature(body, key);
    const supplied = Buffer.from(signature, "base64url");
    if (
      supplied.toString("base64url") !== signature ||
      supplied.byteLength !== expected.byteLength ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw new CursorProtocolError("invalid");
    }
    const decodedBody = Buffer.from(body, "base64url");
    if (decodedBody.toString("base64url") !== body) {
      throw new CursorProtocolError("invalid");
    }
    const value = JSON.parse(decodedBody.toString("utf8")) as unknown;
    assertCursorEnvelope(value);
    if (value.expiresAt <= now) throw new CursorProtocolError("expired");
    if (value.expiresAt > now + MAX_CURSOR_TTL_MS) throw new CursorProtocolError("invalid");
    return value;
  } catch (error) {
    if (error instanceof CursorProtocolError) throw error;
    throw new CursorProtocolError("invalid");
  }
}

export function cursorCallerRef(
  identity: CursorCallerIdentity,
  key: string | Uint8Array,
): string {
  assertCursorCallerIdentity(identity);
  return `cpr_${createHmac("sha256", key)
    .update(CALLER_DOMAIN, "utf8")
    .update(framedCallerIdentity(identity), "utf8")
    .digest("base64url")}`;
}

export function cursorQueryHash(value: unknown): string {
  return `qry_${createHash("sha256")
    .update(stableJson(value), "utf8")
    .digest("base64url")}`;
}

export function cursorRevision(value: unknown): string {
  return `rev_${createHash("sha256")
    .update(stableJson(value), "utf8")
    .digest("base64url")}`;
}

function cursorSignature(body: string, key: string | Uint8Array): Buffer {
  return createHmac("sha256", key)
    .update(CURSOR_DOMAIN, "utf8")
    .update(body, "utf8")
    .digest();
}

function assertCursorEnvelope(value: unknown): asserts value is CursorEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CursorProtocolError("invalid");
  }
  const record = value as Partial<CursorEnvelope>;
  if (
    record.schemaVersion !== CURSOR_SCHEMA_VERSION ||
    !["instruction", "skill", "process", "diff"].includes(String(record.resourceType)) ||
    !boundedString(record.principalRef) ||
    !boundedString(record.queryHash) ||
    !boundedString(record.revision) ||
    !Number.isSafeInteger(record.offset) ||
    (record.offset ?? -1) < 0 ||
    !Number.isSafeInteger(record.expiresAt) ||
    (record.expiresAt ?? 0) < 1 ||
    (
      record.workspaceGeneration !== undefined &&
      (!Number.isSafeInteger(record.workspaceGeneration) || record.workspaceGeneration < 1)
    ) ||
    (record.resourceId !== undefined && !boundedString(record.resourceId)) ||
    (record.parameters !== undefined && !validCursorParameters(record.parameters))
  ) {
    throw new CursorProtocolError("invalid");
  }
}

function validCursorParameters(value: unknown): value is Record<string, CursorParameterValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 16 || Buffer.byteLength(JSON.stringify(value), "utf8") > 2_048) {
    return false;
  }
  return entries.every(([key, entry]) => {
    if (!key || Buffer.byteLength(key, "utf8") > 64) return false;
    if (typeof entry === "string") return Buffer.byteLength(entry, "utf8") <= MAX_FIELD_BYTES;
    if (typeof entry === "boolean") return true;
    return typeof entry === "number" && Number.isSafeInteger(entry);
  });
}

function assertCursorCallerIdentity(identity: CursorCallerIdentity): void {
  if (
    !identity ||
    !boundedString(identity.connectionPrincipalId) ||
    !boundedString(identity.grantId) ||
    !Number.isSafeInteger(identity.authorizationEpoch) ||
    identity.authorizationEpoch < 1 ||
    !boundedString(identity.executionId)
  ) {
    throw new TypeError("Cursor caller identity is incomplete.");
  }
}

function framedCallerIdentity(identity: CursorCallerIdentity): string {
  return [
    callerIdentityField("principal", identity.connectionPrincipalId),
    callerIdentityField("grant", identity.grantId),
    callerIdentityField("authorization_epoch", String(identity.authorizationEpoch)),
    callerIdentityField("execution", identity.executionId),
  ].join("");
}

function callerIdentityField(name: string, value: string): string {
  return `${name}\0${Buffer.byteLength(value, "utf8")}:${value}\0`;
}

function boundedString(value: unknown): value is string {
  return typeof value === "string" &&
    Buffer.byteLength(value, "utf8") > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_FIELD_BYTES;
}

function boundedTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CURSOR_TTL_MS) {
    throw new RangeError("Cursor TTL must be a positive integer no greater than 24 hours.");
  }
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
