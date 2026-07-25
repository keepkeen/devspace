import { createHmac } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { isPathInsideRoot } from "./roots.js";

export const ALL_AUTHORIZED_ROOTS_ID = "*" as const;

export interface AuthorizationRoot {
  id: string;
  path: string;
  label: string;
}

const ROOT_ID_DOMAIN = "devspace-authorization-root-v1\0";

export function authorizationRootId(path: string, key: string | Uint8Array): string {
  const canonicalPath = canonicalAuthorizationPath(path);
  const digest = createHmac("sha256", key)
    .update(ROOT_ID_DOMAIN, "utf8")
    .update(canonicalPath, "utf8")
    .digest("base64url");
  return `root_${digest}`;
}

export function buildAuthorizationRoots(
  allowedRoots: readonly string[],
  key: string | Uint8Array,
): AuthorizationRoot[] {
  return [...new Set(allowedRoots.map(canonicalAuthorizationPath))]
    .sort((left, right) => left.localeCompare(right))
    .map((path) => ({
      id: authorizationRootId(path, key),
      path,
      label: basename(path) || path,
    }));
}

export function normalizeAuthorizedRootIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("At least one authorized root is required.");
  }
  const ids = [...new Set(value.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 128) {
      throw new TypeError("Authorized root identifiers must be non-empty strings.");
    }
    return entry;
  }))];
  return ids.includes(ALL_AUTHORIZED_ROOTS_ID) ? [ALL_AUTHORIZED_ROOTS_ID] : ids.sort();
}

export function resolveAuthorizedRootPaths(
  rootIds: readonly string[],
  availableRoots: readonly AuthorizationRoot[],
): string[] {
  if (rootIds.includes(ALL_AUTHORIZED_ROOTS_ID)) {
    return availableRoots.map((root) => root.path);
  }
  const available = new Map(availableRoots.map((root) => [root.id, root.path]));
  return rootIds.flatMap((id) => {
    const path = available.get(id);
    return path ? [path] : [];
  });
}

export function pathAllowedByAuthorizationRoots(
  path: string,
  authorizedRoots: readonly string[],
): boolean {
  const canonicalPath = canonicalAuthorizationPath(path);
  return authorizedRoots.some((root) =>
    isPathInsideRoot(canonicalPath, canonicalAuthorizationPath(root))
  );
}

function canonicalAuthorizationPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}
