export const LEGACY_DEVSPACE_SCOPE = "devspace";

export const DEVSPACE_CAPABILITY_SCOPES = [
  "workspace:read",
  "workspace:write",
  "process:execute",
  "network:access",
  "worktree:create",
  "workspace:revoke",
] as const;

export type DevSpaceCapabilityScope = typeof DEVSPACE_CAPABILITY_SCOPES[number];

export const DEFAULT_DEVSPACE_OAUTH_SCOPES = [
  LEGACY_DEVSPACE_SCOPE,
  ...DEVSPACE_CAPABILITY_SCOPES,
] as const;

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
  return grantedScopes.includes(LEGACY_DEVSPACE_SCOPE) || grantedScopes.includes(requiredScope);
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
  const granular = DEVSPACE_CAPABILITY_SCOPES.filter((scope) => supported.has(scope));
  if (granular.length > 0) return [...granular];
  if (supported.has(LEGACY_DEVSPACE_SCOPE)) return [LEGACY_DEVSPACE_SCOPE];
  return [...supportedScopes];
}

export function oauthScopeDescription(scope: string): string {
  if (scope === LEGACY_DEVSPACE_SCOPE) {
    return "Legacy full DevSpace access (all capabilities)";
  }
  return SCOPE_DESCRIPTIONS[scope as DevSpaceCapabilityScope] ?? scope;
}
