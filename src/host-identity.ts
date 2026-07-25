import { createHmac } from "node:crypto";

const HOST_IDENTITY_DOMAIN = "devspace-host-identity-v1\0";
const MAX_HOST_HINT_BYTES = 4_096;

export interface HashedHostIdentity {
  subjectHash?: string;
  sessionHash?: string;
  organizationHash?: string;
}

/**
 * Extracts OpenAI host hints from MCP request metadata and immediately turns
 * them into local, unlinkable identifiers. Raw host values are never returned
 * to callers and therefore never need to be persisted or logged.
 *
 * These values are consistency hints only. OAuth grant ownership remains the
 * authorization source of truth.
 */
export function hashOpenAiHostIdentity(
  meta: unknown,
  serverIdentityKey: string | Uint8Array,
): HashedHostIdentity {
  const record = objectRecord(meta);
  return {
    ...hashOptionalHint(record?.["openai/subject"], "subject", "sub", serverIdentityKey),
    ...hashOptionalHint(record?.["openai/session"], "session", "ses", serverIdentityKey),
    ...hashOptionalHint(
      record?.["openai/organization"],
      "organization",
      "org",
      serverIdentityKey,
    ),
  };
}

export function hostIdentityDigest(
  kind: "subject" | "session" | "organization",
  value: string,
  serverIdentityKey: string | Uint8Array,
): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_HOST_HINT_BYTES) {
    throw new RangeError(`Host ${kind} must be 1-${MAX_HOST_HINT_BYTES} UTF-8 bytes.`);
  }
  const prefix = kind === "subject" ? "sub" : kind === "session" ? "ses" : "org";
  const digest = createHmac("sha256", serverIdentityKey)
    .update(HOST_IDENTITY_DOMAIN, "utf8")
    .update(`${kind}\0${bytes.byteLength}:`, "utf8")
    .update(bytes)
    .digest("base64url");
  return `${prefix}_${digest}`;
}

function hashOptionalHint(
  value: unknown,
  kind: "subject" | "session" | "organization",
  fieldPrefix: "sub" | "ses" | "org",
  serverIdentityKey: string | Uint8Array,
): Partial<HashedHostIdentity> {
  if (typeof value !== "string") return {};
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength === 0 || byteLength > MAX_HOST_HINT_BYTES) return {};
  const digest = hostIdentityDigest(kind, value, serverIdentityKey);
  if (fieldPrefix === "sub") return { subjectHash: digest };
  if (fieldPrefix === "ses") return { sessionHash: digest };
  return { organizationHash: digest };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
