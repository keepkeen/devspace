import { createHmac, timingSafeEqual } from "node:crypto";

const PROJECT_EXECUTION_REF_PREFIX = "pex1_";
const PROJECT_EXECUTION_REF_DOMAIN = "devspace:project-execution-ref:v1\0";
const MAX_EXECUTION_ID_BYTES = 128;
const MAC_BYTES = 32;

export class ProjectExecutionRefError extends Error {
  readonly code = "project_execution_not_found";

  constructor() {
    super("The Project execution reference is invalid or unavailable.");
    this.name = "ProjectExecutionRefError";
  }
}

export function encodeProjectExecutionRef(
  executionId: string,
  key: string | Uint8Array,
): string {
  const payload = encodeExecutionId(executionId);
  return `${PROJECT_EXECUTION_REF_PREFIX}${payload}.${executionRefMac(payload, key).toString("base64url")}`;
}

export function decodeProjectExecutionRef(
  executionRef: string,
  key: string | Uint8Array,
): string {
  if (
    typeof executionRef !== "string" ||
    executionRef.length < PROJECT_EXECUTION_REF_PREFIX.length + 3 ||
    executionRef.length > 512 ||
    !executionRef.startsWith(PROJECT_EXECUTION_REF_PREFIX)
  ) {
    throw new ProjectExecutionRefError();
  }
  const encoded = executionRef.slice(PROJECT_EXECUTION_REF_PREFIX.length);
  const separator = encoded.indexOf(".");
  if (separator < 1 || separator !== encoded.lastIndexOf(".")) {
    throw new ProjectExecutionRefError();
  }
  const payload = encoded.slice(0, separator);
  const suppliedMac = decodeBase64Url(encoded.slice(separator + 1));
  const expectedMac = executionRefMac(payload, key);
  if (
    !suppliedMac ||
    suppliedMac.byteLength !== MAC_BYTES ||
    !timingSafeEqual(suppliedMac, expectedMac)
  ) {
    throw new ProjectExecutionRefError();
  }
  const executionIdBytes = decodeBase64Url(payload);
  if (
    !executionIdBytes ||
    executionIdBytes.byteLength < 1 ||
    executionIdBytes.byteLength > MAX_EXECUTION_ID_BYTES
  ) {
    throw new ProjectExecutionRefError();
  }
  const executionId = executionIdBytes.toString("utf8");
  if (
    Buffer.from(executionId, "utf8").compare(executionIdBytes) !== 0 ||
    encodeExecutionId(executionId) !== payload
  ) {
    throw new ProjectExecutionRefError();
  }
  return executionId;
}

function encodeExecutionId(executionId: string): string {
  if (typeof executionId !== "string") throw new TypeError("executionId must be a string.");
  const bytes = Buffer.from(executionId, "utf8");
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_EXECUTION_ID_BYTES || executionId.includes("\0")) {
    throw new RangeError(`executionId must be 1-${MAX_EXECUTION_ID_BYTES} UTF-8 bytes without NUL.`);
  }
  return bytes.toString("base64url");
}

function executionRefMac(payload: string, key: string | Uint8Array): Buffer {
  return createHmac("sha256", key)
    .update(PROJECT_EXECUTION_REF_DOMAIN, "utf8")
    .update(payload, "ascii")
    .digest();
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.toString("base64url") === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}
