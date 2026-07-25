export const DEVSPACE_CAPABILITY_SCOPES = [
  "workspace:read",
  "workspace:write",
  "process:execute",
  "network:access",
  "worktree:create",
  "workspace:revoke",
] as const;

export type DevSpaceCapabilityScope = typeof DEVSPACE_CAPABILITY_SCOPES[number];

/** Every capability this server can support when explicitly requested. */
export const FULL_DEVSPACE_OAUTH_SCOPES = [...DEVSPACE_CAPABILITY_SCOPES] as const;

/** Historical public name for the default supported capability set. */
export const DEFAULT_DEVSPACE_OAUTH_SCOPES = [...FULL_DEVSPACE_OAUTH_SCOPES] as const;

/** Least-privilege scopes used only when an authorization request omits `scope`. */
export const DEFAULT_AUTHORIZATION_SCOPES = ["workspace:read"] as const;

const SCOPE_DESCRIPTIONS: Record<DevSpaceCapabilityScope, string> = {
  "workspace:read": "Read approved workspace files, instructions, Skills, and metadata",
  "workspace:write": "Modify approved workspace files and review checkpoints",
  "process:execute": "Start and interact with local processes inside a writable workspace",
  "network:access": "Allow executed processes to use the host network",
  "worktree:create": "Create isolated managed Git worktrees",
  "workspace:revoke": "Close or permanently revoke Workspace access",
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
