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
  type OAuthAuthorizationLimitInput,
  type OAuthDiagnosticSnapshot,
  type OAuthCleanupCounts,
  type OAuthRevocationCounts,
} from "./oauth-store.js";
import { requestIp } from "./logger.js";
import {
  DEFAULT_DEVSPACE_OAUTH_SCOPES,
  defaultOAuthAuthorizationScopes,
  oauthScopeDescription,
} from "./oauth-scopes.js";

export interface OAuthConfig {
  ownerToken: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  scopes: string[];
  allowedRedirectHosts: string[];
  trustProxy?: boolean;
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
}

export interface OAuthAuthorizationBoundaryChange {
  connectionPrincipalId: string;
  reason: "principal_created" | "principal_relinked";
}

interface AuthorizationCodeRecord {
  clientId: string;
  params: AuthorizationParams;
  expiresAtMs: number;
}

const CODE_TTL_MS = 5 * 60 * 1000;
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
}): string {
  const scopes = params.scopes.length > 0 ? params.scopes : [...DEFAULT_DEVSPACE_OAUTH_SCOPES];
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
      input { box-sizing: border-box; width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid #475569; background: #020617; color: #e2e8f0; font-size: 16px; }
      .optional { margin-top: 22px; padding-top: 18px; border-top: 1px solid #334155; }
      .help { margin: 6px 0 0; color: #94a3b8; font-size: 13px; }
      button { margin-top: 18px; width: 100%; border: 0; border-radius: 10px; padding: 12px 14px; font-weight: 700; color: #020617; background: #38bdf8; cursor: pointer; }
      .error { color: #fecaca; background: #7f1d1d; border-radius: 10px; padding: 10px 12px; }
      .warning { color: #fde68a; }
    </style>
  </head>
  <body>
    <main>
      <h1>Connect DevSpace</h1>
      <p class="warning">Only approve this if you are intentionally connecting your own ChatGPT or MCP client to this local machine.</p>
      ${error}
      <dl>
        <dt>Client</dt><dd>${htmlEscape(params.clientName)}</dd>
        <dt>Capabilities</dt><dd><ul>${scopeItems}</ul></dd>
        <dt>Resource</dt><dd>${htmlEscape(resourceText)}</dd>
      </dl>
      <form method="post">
${hiddenFields}
        <label for="owner_token">Owner password</label>
        <input id="owner_token" name="owner_token" type="password" autocomplete="current-password" autofocus required />
        <div class="optional">
          <label for="reconnect_code">Reconnect code (optional)</label>
          <input id="reconnect_code" name="reconnect_code" type="text" autocomplete="off" spellcheck="false" />
          <p class="help">Use a short-lived code created locally with <code>devspace auth reconnect-code</code> to recover an earlier connection principal. New registrations remain isolated by default.</p>
        </div>
        <button type="submit">Authorize DevSpace</button>
      </form>
    </main>
  </body>
</html>`;
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
  private readonly codes = new Map<string, AuthorizationCodeRecord>();
  private readonly oauthStore: SqliteOAuthStore;
  private readonly resourceServerUrl: URL;

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
    this.ownerCredentialChanged = this.oauthStore.reconcileOwnerCredential(config.ownerToken);
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
        }),
      );
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
      sendAuthorizationRateLimit(res, preflight.retryAfterMs, client, authorizedParams);
      return;
    }

    const providedToken = String(res.req.body?.owner_token ?? "");
    const tokenMatches = safeEquals(providedToken, this.config.ownerToken);
    if (!tokenMatches) {
      this.emitAudit("oauth_authorization_failed", client.client_id);
      const failure = this.oauthStore.recordAuthorizationFailure(authorizationLimits, now);
      if (failure.limited) {
        this.emitAudit("oauth_authorization_rate_limited", client.client_id);
        sendAuthorizationRateLimit(res, failure.retryAfterMs, client, authorizedParams);
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
        }),
      );
      return;
    }
    this.oauthStore.clearAuthorizationLimit(
      "session",
      authorizationLimits[0]!.key,
    );
    const reconnectCode = String(res.req.body?.reconnect_code ?? "").trim();
    let connectionPrincipalId: string;
    let boundaryChangeReason: OAuthAuthorizationBoundaryChange["reason"] | undefined;
    if (reconnectCode) {
      try {
        const linked = this.oauthStore.consumeReconnectCode(reconnectCode, client.client_id);
        connectionPrincipalId = linked.targetPrincipalId;
        if (linked.changed) {
          boundaryChangeReason = "principal_relinked";
          this.emitAudit("oauth_principal_linked", client.client_id);
        }
      } catch (error) {
        if (!(error instanceof PrincipalReconnectError)) throw error;
        res.status(400).setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(
          formHtml({
            error: error.message,
            clientName: client.client_name ?? client.client_id,
            scopes,
            resource: authorizedParams.resource,
            fields: authorizationFormFields(client, authorizedParams),
          }),
        );
        return;
      }
    } else {
      const assignment = this.oauthStore.ensurePrincipalAssignmentForClient(client.client_id);
      connectionPrincipalId = assignment.principalId;
      if (assignment.created) boundaryChangeReason = "principal_created";
    }
    this.oauthStore.touchPrincipal(connectionPrincipalId);
    if (boundaryChangeReason) {
      this.onAuthorizationBoundaryChanged?.({
        connectionPrincipalId,
        reason: boundaryChangeReason,
      });
    }
    this.emitAudit("oauth_authorization_succeeded", client.client_id);

    const code = `code-${randomUUID()}`;
    this.codes.set(code, {
      clientId: client.client_id,
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
    const principalId = this.oauthStore.ensurePrincipalForClient(client.client_id);
    const tokens = this.issueTokens(client.client_id, record.params.scopes ?? this.config.scopes, record.params.resource);
    this.oauthStore.touchPrincipal(principalId);
    this.emitAudit("oauth_token_issued", client.client_id);
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

    const tokens = this.issueTokens(
      client.client_id,
      requestedScopes,
      resource ?? (record.resource ? new URL(record.resource) : undefined),
      refreshTokenHash,
    );
    const principalId = this.oauthStore.principalForClient(client.client_id);
    if (principalId) this.oauthStore.touchPrincipal(principalId);
    this.emitAudit("oauth_token_refreshed", client.client_id);
    return tokens;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.oauthStore.getAccessToken(hashToken(token));
    if (!record || record.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidTokenError("Invalid or expired access token");
    }

    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: record.resource ? new URL(record.resource) : undefined,
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
    clientId: string,
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
          clientId,
          scopes,
          expiresAt: accessExpiresAt,
          resource: resource?.href,
        },
        refreshTokenHash: hashToken(refreshToken),
        refreshToken: {
          clientId,
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

  private emitAudit(event: OAuthAuditEventName, clientId: string): void {
    try {
      this.onAuditEvent?.({ event, clientId });
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
