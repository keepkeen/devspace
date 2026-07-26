import { timingSafeEqual, randomBytes, randomUUID, createHash } from "node:crypto";
import { isIP } from "node:net";
import type { Request, Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { AccessDeniedError, InvalidGrantError, InvalidRequestError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  SqliteOAuthClientsStore,
  SqliteOAuthStore,
  PrincipalReconnectError,
  OAuthGrantIdentityError,
  type OAuthAuthorizationLimitInput,
  type OAuthDiagnosticSnapshot,
  type OAuthCleanupCounts,
  type OAuthGrantRecord,
  type OAuthRevocationCounts,
  type ConnectionPrincipalSummary,
} from "./oauth-store.js";
import type { HashedHostIdentity } from "./host-identity.js";
import { requestIp } from "./logger.js";
import type { RuntimeCapabilities } from "./runtime-capabilities.js";
import {
  ALL_AUTHORIZED_ROOTS_ID,
  type AuthorizationRoot,
} from "./authorization-roots.js";
import {
  DEFAULT_AUTHORIZATION_SCOPES,
  DEFAULT_DEVSPACE_OAUTH_SCOPES,
  defaultOAuthAuthorizationScopes,
  oauthScopeDescription,
} from "./oauth-scopes.js";
import {
  verifyOwnerPassword,
  type OwnerCredentialInput,
  type SecurityKeyring,
} from "./security-credentials.js";

export interface OAuthConfig {
  ownerCredential: OwnerCredentialInput;
  keys: SecurityKeyring;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  scopes: string[];
  allowedRedirectHosts: string[];
  trustProxy?: boolean;
  runtimeCapabilities?: RuntimeCapabilities;
  resourceRoots?: () => readonly AuthorizationRoot[];
}

export type OAuthAuditEventName =
  | "oauth_client_registered"
  | "oauth_authorization_succeeded"
  | "oauth_authorization_failed"
  | "oauth_authorization_rate_limited"
  | "oauth_principal_linked"
  | "oauth_token_issued"
  | "oauth_token_refreshed";

export interface OAuthAuditEvent {
  event: OAuthAuditEventName;
  clientId: string;
  grantId?: string;
  connectionPrincipalId?: string;
  subjectHash?: string;
  organizationHash?: string;
}

export interface OAuthAuthorizationBoundaryChange {
  connectionPrincipalId: string;
  reason: "principal_created" | "principal_relinked";
}

interface AuthorizationCodeRecord {
  clientId: string;
  grantId: string;
  connectionPrincipalId: string;
  authorizationEpoch: number;
  params: AuthorizationParams;
  expiresAtMs: number;
}

interface AuthorizationSelectionRecord {
  clientId: string;
  authorizationSessionKey: string;
  expiresAtMs: number;
}

export interface OAuthRequestAuthorization {
  clientId: string;
  grantId: string;
  connectionPrincipalId: string;
  authorizationEpoch: number;
  scopes: string[];
  allowedRootIds: string[];
  subjectHash?: string;
  organizationHash?: string;
}

const AUTH_EXTRA_GRANT_ID = "devspace/grant-id";
const AUTH_EXTRA_PRINCIPAL_ID = "devspace/principal-id";
const AUTH_EXTRA_AUTHORIZATION_EPOCH = "devspace/authorization-epoch";

const CODE_TTL_MS = 5 * 60 * 1000;
const SELECTION_TTL_MS = 5 * 60 * 1000;
const AUTHORIZATION_LIMIT_TTL_MS = 24 * 60 * 60_000;

const AUTHORIZATION_LIMIT_POLICIES = {
  session: {
    capacity: 5,
    refillIntervalMs: 30_000,
    baseBackoffMs: 1_000,
    maxBackoffMs: 5 * 60_000,
  },
  client: {
    capacity: 20,
    refillIntervalMs: 10_000,
    baseBackoffMs: 1_000,
    maxBackoffMs: 10 * 60_000,
  },
  ip: {
    capacity: 40,
    refillIntervalMs: 5_000,
    baseBackoffMs: 1_000,
    maxBackoffMs: 10 * 60_000,
  },
  global: {
    capacity: 200,
    refillIntervalMs: 100,
    baseBackoffMs: 250,
    maxBackoffMs: 30_000,
  },
} as const;

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formHtml(params: {
  error?: string;
  clientName: string;
  scopes: string[];
  resource?: URL;
  fields: Record<string, string | undefined>;
  runtimeCapabilities?: RuntimeCapabilities;
  selectionToken?: string;
  principals?: readonly ConnectionPrincipalSummary[];
  roots?: readonly AuthorizationRoot[];
}): string {
  const scopes = params.scopes.length > 0 ? params.scopes : [...DEFAULT_AUTHORIZATION_SCOPES];
  const scopeItems = scopes
    .map((scope) =>
      `<li><code>${htmlEscape(scope)}</code><span>${htmlEscape(oauthScopeDescription(scope))}</span></li>`)
    .join("");
  const resourceText = params.resource?.href ?? "DevSpace MCP endpoint";
  const error = params.error
    ? `<p class="error">${htmlEscape(params.error)}</p>`
    : "";
  const hiddenFields = Object.entries(params.fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `        <input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}" />`)
    .join("\n");
  const runtimeWarnings = authorizationRuntimeWarnings(
    scopes,
    params.runtimeCapabilities,
  );
  const runtimePosture = runtimeWarnings.length > 0
    ? `<section class="risk"><strong>Runtime security posture</strong><ul>${runtimeWarnings
        .map((warning) => `<li>${htmlEscape(warning)}</li>`)
        .join("")}</ul></section>`
    : "";
  const selectionStage = Boolean(params.selectionToken);
  const principalOptions = (params.principals ?? [])
    .map((principal) => {
      const aliases = principal.aliases.length > 0
        ? ` — ${principal.aliases.slice(0, 4).join(", ")}`
        : "";
      const label = `${principal.principalId} (${principal.retainedWorkspaces} workspaces)${aliases}`;
      return `<option value="${htmlEscape(principal.principalId)}">${htmlEscape(label)}</option>`;
    })
    .join("");
  const rootChoices = (params.roots ?? []).map((root) =>
    `<label class="choice"><input type="checkbox" name="root_id" value="${htmlEscape(root.id)}" checked /><strong>${htmlEscape(root.label)}</strong><span>${htmlEscape(root.path)}</span></label>`
  ).join("");
  const authorizationControls = selectionStage
    ? `
        <input type="hidden" name="selection_token" value="${htmlEscape(params.selectionToken!)}" />
        <fieldset>
          <legend>Local connection</legend>
          <label class="choice"><input type="radio" name="connection_mode" value="new" checked /><strong>Create a new isolated local connection</strong></label>
          ${principalOptions
            ? `<label class="choice"><input type="radio" name="connection_mode" value="reuse" /><strong>Reuse an existing local connection</strong></label>
          <select name="reuse_principal_id">${principalOptions}</select>
          <p class="help">Reusing preserves that connection's Workspace aliases. This choice is made only after Owner-password approval.</p>`
            : ""}
        </fieldset>
        <fieldset>
          <legend>Authorized project roots</legend>
          ${rootChoices || "<p>No approved roots are currently configured.</p>"}
          <p class="help">Scopes control what this connection can do. These roots control where it can do it.</p>
        </fieldset>`
    : `
        <label for="owner_token">Owner password</label>
        <input id="owner_token" name="owner_token" type="password" autocomplete="current-password" autofocus required />`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Connect DevSpace</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
      main { max-width: 440px; margin: 12vh auto; padding: 32px; background: #111827; border: 1px solid #334155; border-radius: 18px; box-shadow: 0 24px 80px rgba(0,0,0,.35); }
      h1 { margin: 0 0 12px; font-size: 28px; }
      p { line-height: 1.5; color: #cbd5e1; }
      dl { padding: 16px; background: #020617; border-radius: 12px; }
      dt { color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
      dd { margin: 4px 0 12px; word-break: break-word; }
      ul { margin: 4px 0 12px; padding-left: 18px; }
      li { margin: 8px 0; }
      li code { display: block; color: #bae6fd; }
      li span { color: #cbd5e1; font-size: 13px; }
      label { display: block; margin: 18px 0 8px; font-weight: 600; }
      input, select { box-sizing: border-box; width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid #475569; background: #020617; color: #e2e8f0; font-size: 16px; }
      fieldset { margin: 18px 0; border: 1px solid #334155; border-radius: 12px; padding: 14px; }
      legend { padding: 0 8px; font-weight: 700; }
      .choice { display: grid; grid-template-columns: auto 1fr; gap: 4px 8px; align-items: start; padding: 8px 0; font-weight: 500; }
      .choice input { width: auto; margin-top: 3px; }
      .choice span { grid-column: 2; color: #94a3b8; font-size: 12px; word-break: break-all; }
      .optional { margin-top: 22px; padding-top: 18px; border-top: 1px solid #334155; }
      .help { margin: 6px 0 0; color: #94a3b8; font-size: 13px; }
      button { margin-top: 18px; width: 100%; border: 0; border-radius: 10px; padding: 12px 14px; font-weight: 700; color: #020617; background: #38bdf8; cursor: pointer; }
      .error { color: #fecaca; background: #7f1d1d; border-radius: 10px; padding: 10px 12px; }
      .warning { color: #fde68a; }
      .risk { margin: 16px 0; padding: 14px; color: #fde68a; background: #422006; border: 1px solid #a16207; border-radius: 12px; }
      .risk strong { display: block; margin-bottom: 6px; }
      .risk ul { margin-bottom: 0; }
    </style>
  </head>
  <body>
    <main>
      <h1>Connect DevSpace</h1>
      <p class="warning">Only approve this if you are intentionally connecting your own ChatGPT or MCP client to this local machine.</p>
      ${error}
      ${runtimePosture}
      <dl>
        <dt>Client</dt><dd>${htmlEscape(params.clientName)}</dd>
        <dt>Capabilities</dt><dd><ul>${scopeItems}</ul></dd>
        <dt>Resource</dt><dd>${htmlEscape(resourceText)}</dd>
      </dl>
      <form method="post">
${hiddenFields}
${authorizationControls}
        <button type="submit">${selectionStage ? "Connect DevSpace" : "Continue"}</button>
      </form>
    </main>
  </body>
</html>`;
}

function authorizationRuntimeWarnings(
  scopes: readonly string[],
  capabilities: RuntimeCapabilities | undefined,
): string[] {
  if (!capabilities) return [];
  const warnings: string[] = [];
  if (scopes.includes("process:execute") && !capabilities.processSandbox) {
    warnings.push(
      "Executed commands run with the local operating-system user's permissions; DevSpace command checks are guardrails, not a process sandbox.",
    );
  }
  if (
    scopes.includes("process:execute") &&
    capabilities.filesystemIsolation === "guardrail_only"
  ) {
    warnings.push(
      "Dedicated file tools are workspace-confined, but executed programs may access files outside the workspace that the local user can access.",
    );
  }
  if (scopes.includes("network:access") && !capabilities.networkIsolation) {
    warnings.push(
      "Executed programs can use the host network; this runtime cannot enforce per-process network denial.",
    );
  }
  return warnings;
}

function requestedScopesAllowed(requested: string[], supported: string[]): boolean {
  return requested.every((scope) => supported.includes(scope));
}

function authorizationSessionKey(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
): string {
  return createHash("sha256")
    .update("devspace-oauth-authorization-session-v1\0")
    .update(client.client_id)
    .update("\0")
    .update(params.redirectUri)
    .update("\0")
    .update(params.codeChallenge)
    .update("\0")
    .update([...(params.scopes ?? [])].sort().join(" "))
    .update("\0")
    .update(params.state ?? "")
    .digest("base64url");
}

function authorizationRequestIp(req: Request, trustProxy: boolean): string {
  return normalizeIp(requestIp(req, trustProxy));
}

function normalizeIp(value: string | undefined): string {
  if (!value) return "unknown";
  const withoutZone = value.split("%", 1)[0]!;
  const normalized = withoutZone.startsWith("::ffff:")
    ? withoutZone.slice(7)
    : withoutZone;
  return isIP(normalized) > 0 ? normalized : "unknown";
}

function authorizationLimitInputs(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
  req: Request,
  trustProxy: boolean,
): OAuthAuthorizationLimitInput[] {
  const sessionKey = authorizationSessionKey(client, params);
  const ip = authorizationRequestIp(req, trustProxy);
  const common = { ttlMs: AUTHORIZATION_LIMIT_TTL_MS };
  return [
    {
      scope: "session",
      key: `${ip}\0${client.client_id}\0${sessionKey}`,
      ...AUTHORIZATION_LIMIT_POLICIES.session,
      ...common,
    },
    {
      scope: "client",
      key: client.client_id,
      ...AUTHORIZATION_LIMIT_POLICIES.client,
      ...common,
    },
    {
      scope: "ip",
      key: ip,
      ...AUTHORIZATION_LIMIT_POLICIES.ip,
      ...common,
    },
    {
      scope: "global",
      key: "all-authorizations",
      ...AUTHORIZATION_LIMIT_POLICIES.global,
      ...common,
    },
  ];
}

function sendAuthorizationRateLimit(
  res: Response,
  retryAfterMs: number,
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
  runtimeCapabilities?: RuntimeCapabilities,
): void {
  res.status(429).setHeader("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1_000))));
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(
    formHtml({
      error: "Too many failed attempts for this authorization context. Wait before trying again.",
      clientName: client.client_name ?? client.client_id,
      scopes: params.scopes ?? [],
      resource: params.resource,
      fields: authorizationFormFields(client, params),
      runtimeCapabilities,
    }),
  );
}

function setAuthorizationResponseHeaders(res: Response, redirectUri: string): void {
  const redirectOrigin = new URL(redirectUri).origin;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${redirectOrigin}; frame-ancestors 'none'; base-uri 'none'`,
  );
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

export class SingleUserOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  readonly ownerCredentialChanged: boolean;
  readonly ownerCredentialUpgraded: boolean;
  private readonly codes = new Map<string, AuthorizationCodeRecord>();
  private readonly selections = new Map<string, AuthorizationSelectionRecord>();
  private readonly oauthStore: SqliteOAuthStore;
  private readonly resourceServerUrl: URL;
  private readonly ownerPasswordHash: string;

  constructor(
    private readonly config: OAuthConfig,
    resourceServerUrl: URL,
    stateDir: string,
    private readonly onAuditEvent?: (event: OAuthAuditEvent) => void,
    private readonly onAuthorizationBoundaryChanged?: (
      change: OAuthAuthorizationBoundaryChange,
    ) => void,
  ) {
    this.resourceServerUrl = resourceUrlFromServerUrl(resourceServerUrl);
    this.oauthStore = new SqliteOAuthStore(stateDir);
    const credential = this.oauthStore.reconcileOwnerCredential({
      ...config.ownerCredential,
      ...(config.keys.legacyCompatibility &&
          config.keys.source === "auth_file" &&
          config.ownerCredential.password === undefined &&
          config.ownerCredential.passwordHash !== undefined
        ? { legacyVerifierSecret: config.keys.hostIdentity }
        : {}),
    });
    this.ownerCredentialChanged = credential.changed;
    this.ownerCredentialUpgraded = credential.upgraded;
    this.ownerPasswordHash = credential.passwordHash;
    this.clientsStore = new SqliteOAuthClientsStore(
      this.oauthStore,
      config.allowedRedirectHosts,
      (clientId) => this.emitAudit("oauth_client_registered", clientId),
    );
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const scopes = params.scopes?.length
      ? [...params.scopes]
      : defaultOAuthAuthorizationScopes(this.config.scopes);
    const authorizedParams: AuthorizationParams = { ...params, scopes };
    setAuthorizationResponseHeaders(res, authorizedParams.redirectUri);
    if (!authorizedParams.resource || !checkResourceAllowed({ requestedResource: authorizedParams.resource, configuredResource: this.resourceServerUrl })) {
      throw new InvalidRequestError("Invalid or missing OAuth resource");
    }
    if (!requestedScopesAllowed(scopes, this.config.scopes)) {
      throw new InvalidRequestError("Requested scope is not supported");
    }

    if (res.req.method !== "POST") {
      res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        formHtml({
          clientName: client.client_name ?? client.client_id,
          scopes,
          resource: authorizedParams.resource,
          fields: authorizationFormFields(client, authorizedParams),
          runtimeCapabilities: this.config.runtimeCapabilities,
        }),
      );
      return;
    }

    const selectionToken = String(res.req.body?.selection_token ?? "").trim();
    if (selectionToken) {
      const selection = this.selections.get(selectionToken);
      if (
        !selection ||
        selection.clientId !== client.client_id ||
        selection.authorizationSessionKey !== authorizationSessionKey(client, authorizedParams) ||
        selection.expiresAtMs < Date.now()
      ) {
        this.selections.delete(selectionToken);
        res.status(400).setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(formHtml({
          error: "The local connection selection expired. Enter the Owner password again.",
          clientName: client.client_name ?? client.client_id,
          scopes,
          resource: authorizedParams.resource,
          fields: authorizationFormFields(client, authorizedParams),
          runtimeCapabilities: this.config.runtimeCapabilities,
        }));
        return;
      }
      const roots = [...(this.config.resourceRoots?.() ?? [])];
      const availableRootIds = new Set(roots.map((root) => root.id));
      const rawRootIds: unknown = res.req.body?.root_id;
      const submittedRoots: string[] = Array.isArray(rawRootIds)
        ? rawRootIds.map((rootId: unknown) => String(rootId))
        : rawRootIds
          ? [String(rawRootIds)]
          : [];
      const allowedRootIds = [...new Set(
        submittedRoots.filter((rootId) => availableRootIds.has(rootId)),
      )];
      const principalCandidates = this.oauthStore.listConnectionPrincipals();
      const mode = String(res.req.body?.connection_mode ?? "new");
      const reusePrincipalId = mode === "reuse"
        ? String(res.req.body?.reuse_principal_id ?? "").trim()
        : undefined;
      if (
        allowedRootIds.length === 0 ||
        (mode === "reuse" &&
          !principalCandidates.some((principal) => principal.principalId === reusePrincipalId))
      ) {
        res.status(400).setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(formHtml({
          error: allowedRootIds.length === 0
            ? "Select at least one currently approved project root."
            : "Select a current local connection to reuse.",
          clientName: client.client_name ?? client.client_id,
          scopes,
          resource: authorizedParams.resource,
          fields: authorizationFormFields(client, authorizedParams),
          runtimeCapabilities: this.config.runtimeCapabilities,
          selectionToken,
          principals: principalCandidates,
          roots,
        }));
        return;
      }
      this.selections.delete(selectionToken);
      await this.completeAuthorization(client, authorizedParams, res, {
        scopes,
        allowedRootIds,
        ...(reusePrincipalId ? { reusePrincipalId } : {}),
      });
      return;
    }

    const now = Date.now();
    const authorizationLimits = authorizationLimitInputs(
      client,
      authorizedParams,
      res.req,
      this.config.trustProxy === true,
    );
    const preflight = this.oauthStore.checkAuthorizationLimits(authorizationLimits, now);
    if (preflight.limited) {
      this.emitAudit("oauth_authorization_rate_limited", client.client_id);
      sendAuthorizationRateLimit(
        res,
        preflight.retryAfterMs,
        client,
        authorizedParams,
        this.config.runtimeCapabilities,
      );
      return;
    }

    const providedToken = String(res.req.body?.owner_token ?? "");
    const tokenMatches = verifyOwnerPassword(this.ownerPasswordHash, providedToken);
    if (!tokenMatches) {
      this.emitAudit("oauth_authorization_failed", client.client_id);
      const failure = this.oauthStore.recordAuthorizationFailure(authorizationLimits, now);
      if (failure.limited) {
        this.emitAudit("oauth_authorization_rate_limited", client.client_id);
        sendAuthorizationRateLimit(
          res,
          failure.retryAfterMs,
          client,
          authorizedParams,
          this.config.runtimeCapabilities,
        );
        return;
      }
      res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        formHtml({
          error: "The Owner password was not accepted.",
          clientName: client.client_name ?? client.client_id,
          scopes,
          resource: authorizedParams.resource,
          fields: authorizationFormFields(client, authorizedParams),
          runtimeCapabilities: this.config.runtimeCapabilities,
        }),
      );
      return;
    }
    this.oauthStore.clearAuthorizationLimit(
      "session",
      authorizationLimits[0]!.key,
    );
    if (this.config.resourceRoots) {
      const roots = [...this.config.resourceRoots()];
      if (roots.length === 0) {
        res.status(400).setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(formHtml({
          error: "No approved project roots are currently available.",
          clientName: client.client_name ?? client.client_id,
          scopes,
          resource: authorizedParams.resource,
          fields: authorizationFormFields(client, authorizedParams),
          runtimeCapabilities: this.config.runtimeCapabilities,
        }));
        return;
      }
      const token = randomToken();
      this.selections.set(token, {
        clientId: client.client_id,
        authorizationSessionKey: authorizationSessionKey(client, authorizedParams),
        expiresAtMs: Date.now() + SELECTION_TTL_MS,
      });
      res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(formHtml({
        clientName: client.client_name ?? client.client_id,
        scopes,
        resource: authorizedParams.resource,
        fields: authorizationFormFields(client, authorizedParams),
        runtimeCapabilities: this.config.runtimeCapabilities,
        selectionToken: token,
        principals: this.oauthStore.listConnectionPrincipals(),
        roots,
      }));
      return;
    }

    await this.completeAuthorization(client, authorizedParams, res, {
      scopes,
      allowedRootIds: [ALL_AUTHORIZED_ROOTS_ID],
    });
  }

  private async completeAuthorization(
    client: OAuthClientInformationFull,
    authorizedParams: AuthorizationParams,
    res: Response,
    input: {
      scopes: string[];
      allowedRootIds: string[];
      reusePrincipalId?: string;
    },
  ): Promise<void> {
    let grant;
    try {
      grant = this.oauthStore.createAuthorizationGrant({
        clientId: client.client_id,
        scopes: input.scopes,
        allowedRootIds: input.allowedRootIds,
        ...(input.reusePrincipalId ? { reusePrincipalId: input.reusePrincipalId } : {}),
      });
    } catch (error) {
      if (!(error instanceof PrincipalReconnectError)) throw error;
      res.status(400).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        formHtml({
          error: error.message,
          clientName: client.client_name ?? client.client_id,
          scopes: input.scopes,
          resource: authorizedParams.resource,
          fields: authorizationFormFields(client, authorizedParams),
          runtimeCapabilities: this.config.runtimeCapabilities,
        }),
      );
      return;
    }
    const boundaryChangeReason: OAuthAuthorizationBoundaryChange["reason"] =
      grant.reconnected || grant.principalReused
      ? "principal_relinked"
      : "principal_created";
    if (grant.reconnected || grant.principalReused) {
      this.emitAudit("oauth_principal_linked", client.client_id, grant);
    }
    if (grant.principalCreated || grant.reconnected || grant.principalReused) {
      this.onAuthorizationBoundaryChanged?.({
        connectionPrincipalId: grant.principalId,
        reason: boundaryChangeReason,
      });
    }
    this.emitAudit("oauth_authorization_succeeded", client.client_id, grant);

    const code = `code-${randomUUID()}`;
    this.codes.set(code, {
      clientId: client.client_id,
      grantId: grant.grantId,
      connectionPrincipalId: grant.principalId,
      authorizationEpoch: grant.authorizationEpoch,
      params: authorizedParams,
      expiresAtMs: Date.now() + CODE_TTL_MS,
    });

    const redirectUrl = new URL(authorizedParams.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (authorizedParams.state !== undefined) redirectUrl.searchParams.set("state", authorizedParams.state);
    res.redirect(302, redirectUrl.href);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = this.validCodeRecord(client, authorizationCode);
    return record.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.validCodeRecord(client, authorizationCode);
    if (redirectUri && redirectUri !== record.params.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    if (resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceServerUrl })) {
      throw new InvalidGrantError("Invalid resource");
    }

    this.codes.delete(authorizationCode);
    const grant = this.requireActiveGrant({
      clientId: client.client_id,
      grantId: record.grantId,
      principalId: record.connectionPrincipalId,
      authorizationEpoch: record.authorizationEpoch,
    });
    const tokens = this.issueTokens(
      grant,
      record.params.scopes ?? this.config.scopes,
      record.params.resource,
    );
    this.oauthStore.touchPrincipal(grant.principalId);
    this.emitAudit("oauth_token_issued", client.client_id, grant);
    return tokens;
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const refreshTokenHash = hashToken(refreshToken);
    const record = this.oauthStore.getRefreshToken(refreshTokenHash);
    if (!record || record.clientId !== client.client_id || record.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    if (resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceServerUrl })) {
      throw new InvalidGrantError("Invalid resource");
    }

    const requestedScopes = scopes ?? record.scopes;
    if (!requestedScopes.every((scope) => record.scopes.includes(scope))) {
      throw new AccessDeniedError("Refresh token cannot grant requested scopes");
    }

    if (!record.grantId || !record.principalId || !record.authorizationEpoch) {
      throw new InvalidGrantError("Refresh token has no active authorization grant");
    }
    const grant = this.requireActiveGrant({
      clientId: client.client_id,
      grantId: record.grantId,
      principalId: record.principalId,
      authorizationEpoch: record.authorizationEpoch,
    });
    const tokens = this.issueTokens(
      grant,
      requestedScopes,
      resource ?? (record.resource ? new URL(record.resource) : undefined),
      refreshTokenHash,
    );
    this.oauthStore.touchPrincipal(grant.principalId);
    this.emitAudit("oauth_token_refreshed", client.client_id, grant);
    return tokens;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.oauthStore.getAccessToken(hashToken(token));
    if (!record || record.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidTokenError("Invalid or expired access token");
    }
    if (!record.grantId || !record.principalId || !record.authorizationEpoch) {
      throw new InvalidTokenError("Access token has no active authorization grant");
    }

    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: record.resource ? new URL(record.resource) : undefined,
      extra: {
        [AUTH_EXTRA_GRANT_ID]: record.grantId,
        [AUTH_EXTRA_PRINCIPAL_ID]: record.principalId,
        [AUTH_EXTRA_AUTHORIZATION_EPOCH]: record.authorizationEpoch,
      },
    };
  }

  authorizeRequest(
    authInfo: AuthInfo,
    hostIdentity: HashedHostIdentity = {},
    options: { requireHostIdentity?: boolean } = {},
  ): OAuthRequestAuthorization {
    const grantId = authInfo.extra?.[AUTH_EXTRA_GRANT_ID];
    const principalId = authInfo.extra?.[AUTH_EXTRA_PRINCIPAL_ID];
    const authorizationEpoch = authInfo.extra?.[AUTH_EXTRA_AUTHORIZATION_EPOCH];
    if (
      typeof grantId !== "string" ||
      typeof principalId !== "string" ||
      !Number.isSafeInteger(authorizationEpoch) ||
      (authorizationEpoch as number) < 1
    ) {
      throw new InvalidTokenError("Access token authorization context is missing");
    }
    let grant: OAuthGrantRecord;
    try {
      grant = this.oauthStore.bindOrValidateGrantHostIdentity({
        grantId,
        clientId: authInfo.clientId,
        authorizationEpoch: authorizationEpoch as number,
        ...(hostIdentity.subjectHash ? { subjectHash: hostIdentity.subjectHash } : {}),
        ...(hostIdentity.organizationHash
          ? { organizationHash: hostIdentity.organizationHash }
          : {}),
        requireSubject: options.requireHostIdentity === true,
      });
    } catch (error) {
      if (error instanceof OAuthGrantIdentityError) {
        throw new InvalidTokenError(error.message);
      }
      throw error;
    }
    if (
      grant.principalId !== principalId ||
      authInfo.scopes.some((scope) => !grant.grantedScopes.includes(scope))
    ) {
      throw new InvalidTokenError("Access token does not match its authorization grant");
    }
    return {
      clientId: authInfo.clientId,
      grantId: grant.grantId,
      connectionPrincipalId: grant.principalId,
      authorizationEpoch: grant.authorizationEpoch,
      scopes: [...authInfo.scopes],
      allowedRootIds: [...grant.allowedRootIds],
      ...(grant.subjectHash ? { subjectHash: grant.subjectHash } : {}),
      ...(grant.organizationHash ? { organizationHash: grant.organizationHash } : {}),
    };
  }

  principalForClient(clientId: string): string | undefined {
    return this.oauthStore.principalForClient(clientId);
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hashed = hashToken(request.token);
    this.oauthStore.deleteAccessToken(hashed);
    this.oauthStore.deleteRefreshToken(hashed);
  }

  revokeAll(): OAuthRevocationCounts {
    this.codes.clear();
    this.selections.clear();
    return this.oauthStore.revokeAll();
  }

  queueOrphanedWorkspaceCleanup(): number {
    return this.oauthStore.queueOrphanedWorkspaceCleanup();
  }

  diagnosticSnapshot(): OAuthDiagnosticSnapshot {
    return this.oauthStore.diagnosticSnapshot();
  }

  cleanupExpired(nowSeconds = Math.floor(Date.now() / 1_000)): OAuthCleanupCounts & {
    authorizationCodes: number;
  } {
    let authorizationCodes = 0;
    const nowMs = nowSeconds * 1_000;
    for (const [code, record] of this.codes) {
      if (record.expiresAtMs >= nowMs) continue;
      this.codes.delete(code);
      authorizationCodes += 1;
    }
    for (const [token, record] of this.selections) {
      if (record.expiresAtMs >= nowMs) continue;
      this.selections.delete(token);
    }
    return { ...this.oauthStore.cleanupExpired(nowSeconds), authorizationCodes };
  }

  close(): void {
    this.oauthStore.close();
  }

  isReady(): boolean {
    return this.oauthStore.isReady();
  }

  private validCodeRecord(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): AuthorizationCodeRecord {
    const record = this.codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id || record.expiresAtMs < Date.now()) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return record;
  }

  private issueTokens(
    grant: Pick<
      OAuthGrantRecord,
      "grantId" | "clientId" | "principalId" | "authorizationEpoch"
    >,
    scopes: string[],
    resource?: URL,
    consumedRefreshTokenHash?: string,
  ): OAuthTokens {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const accessExpiresAt = now + this.config.accessTokenTtlSeconds;
    const refreshExpiresAt = now + this.config.refreshTokenTtlSeconds;

    const saved = this.oauthStore.saveTokenPair(
      {
        accessTokenHash: hashToken(accessToken),
        accessToken: {
          grantId: grant.grantId,
          clientId: grant.clientId,
          principalId: grant.principalId,
          authorizationEpoch: grant.authorizationEpoch,
          scopes,
          expiresAt: accessExpiresAt,
          resource: resource?.href,
        },
        refreshTokenHash: hashToken(refreshToken),
        refreshToken: {
          grantId: grant.grantId,
          clientId: grant.clientId,
          principalId: grant.principalId,
          authorizationEpoch: grant.authorizationEpoch,
          scopes,
          expiresAt: refreshExpiresAt,
          resource: resource?.href,
        },
      },
      consumedRefreshTokenHash,
    );
    if (!saved) {
      throw new InvalidGrantError("Invalid refresh token");
    }

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  private requireActiveGrant(input: {
    clientId: string;
    grantId: string;
    principalId: string;
    authorizationEpoch: number;
  }): OAuthGrantRecord {
    const grant = this.oauthStore.getAuthorizationGrant(input.grantId);
    if (
      !grant ||
      grant.clientId !== input.clientId ||
      grant.principalId !== input.principalId ||
      grant.authorizationEpoch !== input.authorizationEpoch
    ) {
      throw new InvalidGrantError("OAuth authorization grant is no longer active");
    }
    return grant;
  }

  private emitAudit(
    event: OAuthAuditEventName,
    clientId: string,
    grant?: Pick<
      OAuthGrantRecord,
      "grantId" | "principalId" | "subjectHash" | "organizationHash"
    >,
  ): void {
    try {
      this.onAuditEvent?.({
        event,
        clientId,
        ...(grant
          ? {
              grantId: grant.grantId,
              connectionPrincipalId: grant.principalId,
              ...(grant.subjectHash ? { subjectHash: grant.subjectHash } : {}),
              ...(grant.organizationHash
                ? { organizationHash: grant.organizationHash }
                : {}),
            }
          : {}),
      });
    } catch {
      // Observability must never change committed OAuth state or client results.
    }
  }
}

function authorizationFormFields(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
): Record<string, string | undefined> {
  return {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    scope: params.scopes?.join(" "),
    state: params.state,
    resource: params.resource?.href,
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
