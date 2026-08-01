export const DEVSPACE_CAPABILITY_SCOPES = [
  "project:read",
  "project:write",
  "process:execute",
] as const;

export type DevSpaceCapabilityScope = typeof DEVSPACE_CAPABILITY_SCOPES[number];

/** Every capability this server can support when explicitly requested. */
export const FULL_DEVSPACE_OAUTH_SCOPES = [...DEVSPACE_CAPABILITY_SCOPES] as const;

/**
 * Capabilities advertised by default. Local process execution is deliberately
 * opt-in through DEVSPACE_OAUTH_SCOPES because it runs with the backend OS
 * user's authority rather than inside a filesystem sandbox.
 */
export const DEFAULT_DEVSPACE_OAUTH_SCOPES = [
  "project:read",
  "project:write",
] as const satisfies readonly DevSpaceCapabilityScope[];

/** Least-privilege scopes used only when an authorization request omits `scope`. */
export const DEFAULT_AUTHORIZATION_SCOPES = ["project:read"] as const;

const SCOPE_DESCRIPTIONS: Record<DevSpaceCapabilityScope, string> = {
  "project:read": "Read approved project files, instructions, Skills, and metadata",
  "project:write": "Modify approved project files",
  "process:execute": "Start and interact with local processes inside an approved project",
};

export function oauthScopeAllows(
  grantedScopes: readonly string[],
  requiredScope: DevSpaceCapabilityScope,
): boolean {
  return grantedScopes.includes(requiredScope);
}

export function missingOAuthScopes(
  grantedScopes: readonly string[],
  requiredScopes: readonly DevSpaceCapabilityScope[],
): DevSpaceCapabilityScope[] {
  return requiredScopes.filter((scope) => !oauthScopeAllows(grantedScopes, scope));
}

export function defaultOAuthAuthorizationScopes(
  supportedScopes: readonly string[],
): string[] {
  const supported = new Set(supportedScopes);
  return DEFAULT_AUTHORIZATION_SCOPES.filter((scope) => supported.has(scope));
}

export function oauthScopeDescription(scope: string): string {
  return SCOPE_DESCRIPTIONS[scope as DevSpaceCapabilityScope] ?? scope;
}
