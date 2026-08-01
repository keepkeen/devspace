import { createHmac, timingSafeEqual } from "node:crypto";

const PROJECT_THREAD_REF_PREFIX = "pth1_";
const PROJECT_THREAD_REF_DOMAIN = "devspace:project-thread-ref:v1\0";
const MAX_THREAD_ID_BYTES = 128;
const MAC_BYTES = 32;

export class ProjectThreadRefError extends Error {
  readonly code = "project_thread_not_found";

  constructor() {
    super("The Project thread reference is invalid or unavailable.");
    this.name = "ProjectThreadRefError";
  }
}

export function encodeProjectThreadRef(
  threadId: string,
  key: string | Uint8Array,
): string {
  const payload = encodeThreadId(threadId);
  return `${PROJECT_THREAD_REF_PREFIX}${payload}.${threadRefMac(payload, key).toString("base64url")}`;
}

export function decodeProjectThreadRef(
  threadRef: string,
  key: string | Uint8Array,
): string {
  if (
    typeof threadRef !== "string" ||
    threadRef.length < PROJECT_THREAD_REF_PREFIX.length + 3 ||
    threadRef.length > 512 ||
    !threadRef.startsWith(PROJECT_THREAD_REF_PREFIX)
  ) {
    throw new ProjectThreadRefError();
  }
  const encoded = threadRef.slice(PROJECT_THREAD_REF_PREFIX.length);
  const separator = encoded.indexOf(".");
  if (separator < 1 || separator !== encoded.lastIndexOf(".")) {
    throw new ProjectThreadRefError();
  }
  const payload = encoded.slice(0, separator);
  const suppliedMac = decodeBase64Url(encoded.slice(separator + 1));
  const expectedMac = threadRefMac(payload, key);
  if (
    !suppliedMac ||
    suppliedMac.byteLength !== MAC_BYTES ||
    !timingSafeEqual(suppliedMac, expectedMac)
  ) {
    throw new ProjectThreadRefError();
  }
  const threadIdBytes = decodeBase64Url(payload);
  if (
    !threadIdBytes ||
    threadIdBytes.byteLength < 1 ||
    threadIdBytes.byteLength > MAX_THREAD_ID_BYTES
  ) {
    throw new ProjectThreadRefError();
  }
  const threadId = threadIdBytes.toString("utf8");
  if (
    Buffer.from(threadId, "utf8").compare(threadIdBytes) !== 0 ||
    encodeThreadId(threadId) !== payload
  ) {
    throw new ProjectThreadRefError();
  }
  return threadId;
}

function encodeThreadId(threadId: string): string {
  if (typeof threadId !== "string") throw new TypeError("threadId must be a string.");
  const bytes = Buffer.from(threadId, "utf8");
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_THREAD_ID_BYTES || threadId.includes("\0")) {
    throw new RangeError(`threadId must be 1-${MAX_THREAD_ID_BYTES} UTF-8 bytes without NUL.`);
  }
  return bytes.toString("base64url");
}

function threadRefMac(payload: string, key: string | Uint8Array): Buffer {
  return createHmac("sha256", key)
    .update(PROJECT_THREAD_REF_DOMAIN, "utf8")
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
