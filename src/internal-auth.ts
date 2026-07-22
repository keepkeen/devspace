import { createHash, timingSafeEqual } from "node:crypto";

const DIAGNOSTICS_DOMAIN = "devspace-internal-diagnostics-v1\0";
const REVOCATION_DOMAIN = "devspace-internal-revocation-v1\0";

export function internalDiagnosticsToken(ownerToken: string): string {
  return internalToken(DIAGNOSTICS_DOMAIN, ownerToken);
}

export function internalRevocationToken(ownerToken: string): string {
  return internalToken(REVOCATION_DOMAIN, ownerToken);
}

export function validInternalDiagnosticsToken(ownerToken: string, supplied: string | undefined): boolean {
  if (!supplied) return false;
  const expected = Buffer.from(internalDiagnosticsToken(ownerToken));
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function validInternalRevocationToken(ownerToken: string, supplied: string | undefined): boolean {
  if (!supplied) return false;
  const expected = Buffer.from(internalRevocationToken(ownerToken));
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function internalToken(domain: string, ownerToken: string): string {
  return createHash("sha256").update(domain).update(ownerToken).digest("base64url");
}
