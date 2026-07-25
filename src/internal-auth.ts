import { createHmac, timingSafeEqual } from "node:crypto";

const DIAGNOSTICS_DOMAIN = "devspace-internal-diagnostics-v1\0";
const CONFIG_RELOAD_DOMAIN = "devspace-internal-config-reload-v1\0";
const REVOCATION_DOMAIN = "devspace-internal-revocation-v1\0";

export function internalDiagnosticsToken(key: string | Uint8Array): string {
  return internalToken(DIAGNOSTICS_DOMAIN, key);
}

export function internalRevocationToken(key: string | Uint8Array): string {
  return internalToken(REVOCATION_DOMAIN, key);
}

export function internalConfigReloadToken(key: string | Uint8Array): string {
  return internalToken(CONFIG_RELOAD_DOMAIN, key);
}

export function validInternalDiagnosticsToken(key: string | Uint8Array, supplied: string | undefined): boolean {
  if (!supplied) return false;
  const expected = Buffer.from(internalDiagnosticsToken(key));
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function validInternalRevocationToken(key: string | Uint8Array, supplied: string | undefined): boolean {
  if (!supplied) return false;
  const expected = Buffer.from(internalRevocationToken(key));
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function validInternalConfigReloadToken(key: string | Uint8Array, supplied: string | undefined): boolean {
  if (!supplied) return false;
  const expected = Buffer.from(internalConfigReloadToken(key));
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function internalToken(domain: string, key: string | Uint8Array): string {
  return createHmac("sha256", key).update(domain, "utf8").digest("base64url");
}
