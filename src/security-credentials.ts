import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { Algorithm, hashSync, verifySync } from "@node-rs/argon2";

export const DEVSPACE_AUTH_SCHEMA_VERSION = 2 as const;
export type MasterKeyDerivation = "hkdf-v1" | "legacy-direct";
export type MasterKeySource = "auth_file" | "environment" | "legacy_environment";

export interface OwnerCredentialInput {
  password?: string;
  passwordHash?: string;
}

export interface SecurityKeyring {
  derivation: MasterKeyDerivation;
  source: MasterKeySource;
  legacyCompatibility: boolean;
  masterKeyFingerprint: string;
  hostIdentity: Buffer;
  authorizationRoot: Buffer;
  projectFingerprint: Buffer;
  cursor: Buffer;
  receipt: Buffer;
  auditReference: Buffer;
  internalDiagnostics: Buffer;
  internalConfigReload: Buffer;
  internalRevocation: Buffer;
}

const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19 * 1_024,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

const MASTER_KEY_SALT = Buffer.from("devspace-master-key-hkdf-v1\0", "utf8");

export function hashOwnerPassword(password: string): string {
  assertOwnerPassword(password);
  return hashSync(password, ARGON2_OPTIONS);
}

export function verifyOwnerPassword(passwordHash: string, password: string): boolean {
  if (!isArgon2idHash(passwordHash) || typeof password !== "string") return false;
  try {
    return verifySync(passwordHash, password, { algorithm: Algorithm.Argon2id });
  } catch {
    return false;
  }
}

export function isArgon2idHash(value: string | undefined): value is string {
  return typeof value === "string" && value.startsWith("$argon2id$");
}

export function generateMasterKey(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Preserves every pre-v2 HMAC identifier while separating future password
 * rotation from key rotation. The old random Owner token becomes key material,
 * not a stored password.
 */
export function legacyMasterKeyFromOwnerPassword(ownerPassword: string): string {
  assertOwnerPassword(ownerPassword);
  return Buffer.from(ownerPassword, "utf8").toString("base64url");
}

export function createSecurityKeyring(input: {
  masterKey: string;
  derivation: MasterKeyDerivation;
  source: MasterKeySource;
}): SecurityKeyring {
  const masterKey = decodeMasterKey(input.masterKey);
  const purpose = (name: string): Buffer => input.derivation === "legacy-direct"
    ? Buffer.from(masterKey)
    : Buffer.from(hkdfSync(
        "sha256",
        masterKey,
        MASTER_KEY_SALT,
        Buffer.from(`devspace:${name}:v1`, "utf8"),
        32,
      ));
  return {
    derivation: input.derivation,
    source: input.source,
    legacyCompatibility: input.derivation === "legacy-direct",
    masterKeyFingerprint: createHash("sha256")
      .update("devspace-master-key-fingerprint-v1\0")
      .update(masterKey)
      .digest("hex")
      .slice(0, 16),
    hostIdentity: purpose("host-identity"),
    authorizationRoot: purpose("authorization-root"),
    projectFingerprint: purpose("project-fingerprint"),
    cursor: purpose("cursor"),
    receipt: purpose("receipt"),
    auditReference: purpose("audit-reference"),
    internalDiagnostics: purpose("internal-diagnostics"),
    internalConfigReload: purpose("internal-config-reload"),
    internalRevocation: purpose("internal-revocation"),
  };
}

export function ownerCredentialRevision(passwordHash: string): string {
  if (!isArgon2idHash(passwordHash)) throw new TypeError("Owner password hash must use Argon2id.");
  return createHash("sha256")
    .update("devspace-owner-credential-revision-v1\0")
    .update(passwordHash, "utf8")
    .digest("base64url");
}

export function assertOwnerPassword(password: string): void {
  if (typeof password !== "string" || password.trim().length < 16) {
    throw new Error("Owner password must be at least 16 characters long.");
  }
}

function decodeMasterKey(value: string): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("DevSpace master key must be base64url text.");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength < 16 || decoded.byteLength > 128) {
    throw new Error("DevSpace master key must decode to 16-128 bytes.");
  }
  return decoded;
}
