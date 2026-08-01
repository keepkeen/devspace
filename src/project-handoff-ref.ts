import { createHmac, timingSafeEqual } from "node:crypto";

const PROJECT_HANDOFF_REF_PREFIX = "phf1_";
const PROJECT_HANDOFF_REF_DOMAIN = "devspace:project-handoff-ref:v1\0";
const MAX_HANDOFF_ID_BYTES = 128;
const MAC_BYTES = 32;

export class ProjectHandoffRefError extends Error {
  readonly code = "project_handoff_not_found";

  constructor() {
    super("The Project handoff reference is invalid or unavailable.");
    this.name = "ProjectHandoffRefError";
  }
}

export function encodeProjectHandoffRef(
  handoffId: string,
  key: string | Uint8Array,
): string {
  const payload = encodeHandoffId(handoffId);
  const mac = handoffRefMac(payload, key).toString("base64url");
  return `${PROJECT_HANDOFF_REF_PREFIX}${payload}.${mac}`;
}

export function decodeProjectHandoffRef(
  handoffRef: string,
  key: string | Uint8Array,
): string {
  if (
    typeof handoffRef !== "string" ||
    handoffRef.length < PROJECT_HANDOFF_REF_PREFIX.length + 3 ||
    handoffRef.length > 512 ||
    !handoffRef.startsWith(PROJECT_HANDOFF_REF_PREFIX)
  ) {
    throw new ProjectHandoffRefError();
  }
  const encoded = handoffRef.slice(PROJECT_HANDOFF_REF_PREFIX.length);
  const separator = encoded.indexOf(".");
  if (separator < 1 || separator !== encoded.lastIndexOf(".")) {
    throw new ProjectHandoffRefError();
  }
  const payload = encoded.slice(0, separator);
  const suppliedMac = decodeBase64Url(encoded.slice(separator + 1));
  const expectedMac = handoffRefMac(payload, key);
  if (
    !suppliedMac ||
    suppliedMac.byteLength !== MAC_BYTES ||
    !timingSafeEqual(suppliedMac, expectedMac)
  ) {
    throw new ProjectHandoffRefError();
  }
  const handoffIdBytes = decodeBase64Url(payload);
  if (
    !handoffIdBytes ||
    handoffIdBytes.byteLength < 1 ||
    handoffIdBytes.byteLength > MAX_HANDOFF_ID_BYTES
  ) {
    throw new ProjectHandoffRefError();
  }
  const handoffId = handoffIdBytes.toString("utf8");
  if (
    Buffer.from(handoffId, "utf8").compare(handoffIdBytes) !== 0 ||
    encodeHandoffId(handoffId) !== payload
  ) {
    throw new ProjectHandoffRefError();
  }
  return handoffId;
}

function encodeHandoffId(handoffId: string): string {
  if (typeof handoffId !== "string") throw new TypeError("handoffId must be a string.");
  const bytes = Buffer.from(handoffId, "utf8");
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_HANDOFF_ID_BYTES ||
    handoffId.includes("\0")
  ) {
    throw new RangeError(`handoffId must be 1-${MAX_HANDOFF_ID_BYTES} UTF-8 bytes without NUL.`);
  }
  return bytes.toString("base64url");
}

function handoffRefMac(payload: string, key: string | Uint8Array): Buffer {
  return createHmac("sha256", key)
    .update(PROJECT_HANDOFF_REF_DOMAIN, "utf8")
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
