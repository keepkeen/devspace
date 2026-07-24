import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidRequestError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { openDatabase, type DatabaseHandle } from "./db/client.js";

export interface PersistedAccessTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

export interface PersistedRefreshTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

export interface PersistedTokenPair {
  accessTokenHash: string;
  accessToken: PersistedAccessTokenRecord;
  refreshTokenHash: string;
  refreshToken: PersistedRefreshTokenRecord;
}

export interface OAuthRevocationCounts {
  clients: number;
  accessTokens: number;
  refreshTokens: number;
  workspaceCleanupJobs: number;
}

export interface OAuthDiagnosticSnapshot extends OAuthRevocationCounts {
  principals: number;
  expiredAccessTokens: number;
  expiredRefreshTokens: number;
}

export interface OAuthCleanupCounts {
  accessTokens: number;
  refreshTokens: number;
  reconnectCodes: number;
  authorizationLimits: number;
}

export type OAuthAuthorizationLimitScope = "session" | "client" | "ip" | "global";

export interface OAuthAuthorizationLimitInput {
  scope: OAuthAuthorizationLimitScope;
  key: string;
  capacity: number;
  refillIntervalMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  ttlMs: number;
}

export interface OAuthAuthorizationLimitDecision {
  limited: boolean;
  retryAfterMs: number;
}

export interface ConnectionPrincipalSummary {
  principalId: string;
  clientCount: number;
  activeWorkspaces: number;
  retainedWorkspaces: number;
  aliases: string[];
  createdAt: string;
  lastUsedAt: string;
}

export interface PrincipalReconnectCode {
  code: string;
  principalId: string;
  expiresAt: string;
}

export interface PrincipalLinkResult {
  clientId: string;
  sourcePrincipalId?: string;
  targetPrincipalId: string;
  changed: boolean;
}

export class PrincipalReconnectError extends Error {
  constructor(
    readonly code:
      | "reconnect_code_invalid"
      | "reconnect_source_in_use"
      | "connection_principal_not_found",
    message: string,
  ) {
    super(message);
    this.name = "PrincipalReconnectError";
  }
}

const DEFAULT_RECONNECT_CODE_TTL_MS = 10 * 60_000;
const MAX_RECONNECT_CODE_TTL_MS = 30 * 60_000;
const RECONNECT_CODE_PREFIX = "reconnect-";
const MAX_AUTHORIZATION_LIMIT_KEY_LENGTH = 4_096;

interface AuthorizationLimitRow {
  tokens: number;
  updated_at: number;
  failure_streak: number;
  blocked_until: number;
}

function redirectHostAllowed(redirectUri: string, allowedHosts: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return false;
  }

  if (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  }
  return parsed.protocol === "https:" && allowedHosts.includes(parsed.hostname);
}

export class SqliteOAuthStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
    this.cleanupExpired();
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.database.sqlite
      .prepare("select client_json from oauth_clients where client_id = ?")
      .get(clientId) as { client_json: string } | undefined;

    return row ? (JSON.parse(row.client_json) as OAuthClientInformationFull) : undefined;
  }

  principalForClient(clientId: string): string | undefined {
    const row = this.database.sqlite
      .prepare(`
        select client.principal_id as principalId
        from oauth_clients as client
        inner join connection_principals as principal
          on principal.principal_id = client.principal_id
        where client.client_id = ? and principal.revoked_at is null
      `)
      .get(clientId) as { principalId: string } | undefined;
    return row?.principalId;
  }

  touchPrincipal(principalId: string): boolean {
    const result = this.database.sqlite.prepare(`
      update connection_principals
      set last_used_at = ?
      where principal_id = ? and revoked_at is null
    `).run(new Date().toISOString(), principalId);
    return result.changes > 0;
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
    allowedRedirectHosts: string[],
  ): OAuthClientInformationFull {
    if (!client.redirect_uris.every((uri) => redirectHostAllowed(String(uri), allowedRedirectHosts))) {
      throw new InvalidRequestError("Client redirect_uri is not allowed for this DevSpace server");
    }

    const now = Math.floor(Date.now() / 1000);
    const registered: OAuthClientInformationFull = {
      ...client,
      client_id: `devspace-${randomUUID()}`,
      client_id_issued_at: now,
      token_endpoint_auth_method: client.token_endpoint_auth_method ?? "none",
      grant_types: client.grant_types ?? ["authorization_code", "refresh_token"],
      response_types: client.response_types ?? ["code"],
    };

    this.database.sqlite.prepare(`
      insert into oauth_clients (
        client_id, principal_id, client_json, issued_at
      ) values (?, null, ?, ?)
    `).run(registered.client_id, JSON.stringify(registered), now);

    return registered;
  }

  ensurePrincipalForClient(clientId: string): string {
    const ensure = this.database.sqlite.transaction(() => {
      const client = this.database.sqlite.prepare(`
        select principal_id as principalId
        from oauth_clients
        where client_id = ?
      `).get(clientId) as { principalId: string | null } | undefined;
      if (!client) throw new InvalidRequestError("OAuth client registration was not found");
      if (client.principalId) {
        const active = this.database.sqlite.prepare(`
          select principal_id
          from connection_principals
          where principal_id = ? and revoked_at is null
        `).get(client.principalId);
        if (!active) throw new InvalidRequestError("OAuth client has no active connection principal");
        return client.principalId;
      }

      const principalId = `principal-${randomUUID()}`;
      const now = new Date().toISOString();
      this.database.sqlite.prepare(`
        insert into connection_principals (
          principal_id, created_at, last_used_at, revoked_at
        ) values (?, ?, ?, null)
      `).run(principalId, now, now);
      this.database.sqlite.prepare(`
        update oauth_clients
        set principal_id = ?
        where client_id = ? and principal_id is null
      `).run(principalId, clientId);
      return principalId;
    });
    return ensure.immediate();
  }

  listConnectionPrincipals(): ConnectionPrincipalSummary[] {
    const principals = this.database.sqlite.prepare(`
      select
        principal.principal_id as principalId,
        principal.created_at as createdAt,
        principal.last_used_at as lastUsedAt,
        (select count(*) from oauth_clients as client
          where client.principal_id = principal.principal_id) as clientCount,
        (select count(*) from workspace_sessions as workspace
          where workspace.owner_client_id = principal.principal_id
            and workspace.status = 'active') as activeWorkspaces,
        (select count(*) from workspace_sessions as workspace
          where workspace.owner_client_id = principal.principal_id
            and workspace.status in ('active', 'closed')) as retainedWorkspaces
      from connection_principals as principal
      where principal.revoked_at is null
      order by principal.last_used_at desc, principal.principal_id
    `).all() as Array<Omit<ConnectionPrincipalSummary, "aliases">>;
    const aliases = this.database.sqlite.prepare(`
      select alias
      from workspace_sessions
      where owner_client_id = ? and status in ('active', 'closed') and alias is not null
      order by last_used_at desc, alias
      limit 20
    `);
    return principals.map((principal) => ({
      ...principal,
      aliases: (aliases.all(principal.principalId) as Array<{ alias: string }>).map(({ alias }) => alias),
    }));
  }

  issueReconnectCode(
    principalId: string,
    ttlMs = DEFAULT_RECONNECT_CODE_TTL_MS,
  ): PrincipalReconnectCode {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_RECONNECT_CODE_TTL_MS) {
      throw new RangeError(`Reconnect code TTL must be 1000-${MAX_RECONNECT_CODE_TTL_MS} ms.`);
    }
    const issue = this.database.sqlite.transaction(() => {
      const now = Date.now();
      this.cleanupExpiredReconnectCodes(now);
      const principal = this.database.sqlite.prepare(`
        select principal_id
        from connection_principals
        where principal_id = ? and revoked_at is null
      `).get(principalId) as { principal_id: string } | undefined;
      if (!principal) {
        throw new PrincipalReconnectError(
          "connection_principal_not_found",
          "The connection principal does not exist or has been revoked.",
        );
      }
      const code = `${RECONNECT_CODE_PREFIX}${randomBytes(24).toString("base64url")}`;
      const expiresAt = now + ttlMs;
      this.database.sqlite
        .prepare("delete from oauth_principal_reconnect_codes where principal_id = ?")
        .run(principalId);
      this.database.sqlite.prepare(`
        insert into oauth_principal_reconnect_codes (
          code_hash, principal_id, created_at, expires_at
        ) values (?, ?, ?, ?)
      `).run(hashReconnectCode(code), principalId, now, expiresAt);
      return {
        code,
        principalId,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    });
    return issue.immediate();
  }

  consumeReconnectCode(code: string, clientId: string): PrincipalLinkResult {
    if (!code.startsWith(RECONNECT_CODE_PREFIX) || code.length > 128) {
      throw new PrincipalReconnectError("reconnect_code_invalid", "The reconnect code is invalid or expired.");
    }
    const consume = this.database.sqlite.transaction(() => {
      const now = Date.now();
      this.cleanupExpiredReconnectCodes(now);
      const codeHash = hashReconnectCode(code);
      const target = this.database.sqlite.prepare(`
        select reconnect.principal_id as principalId
        from oauth_principal_reconnect_codes as reconnect
        inner join connection_principals as principal
          on principal.principal_id = reconnect.principal_id
        where reconnect.code_hash = ?
          and reconnect.expires_at > ?
          and principal.revoked_at is null
      `).get(codeHash, now) as { principalId: string } | undefined;
      const source = this.database.sqlite.prepare(`
        select principal_id as principalId
        from oauth_clients
        where client_id = ?
      `).get(clientId) as { principalId: string | null } | undefined;
      if (!target || !source) {
        throw new PrincipalReconnectError("reconnect_code_invalid", "The reconnect code is invalid or expired.");
      }
      this.database.sqlite
        .prepare("delete from oauth_principal_reconnect_codes where code_hash = ?")
        .run(codeHash);
      if (source.principalId === target.principalId) {
        this.touchPrincipal(target.principalId);
        return {
          clientId,
          sourcePrincipalId: source.principalId,
          targetPrincipalId: target.principalId,
          changed: false,
        };
      }
      if (source.principalId) {
        const sourceUsage = this.database.sqlite.prepare(`
          select
            (select count(*) from oauth_clients where principal_id = @principalId) as clients,
            (select count(*) from workspace_sessions where owner_client_id = @principalId) as workspaces
        `).get({ principalId: source.principalId }) as { clients: number; workspaces: number };
        if (sourceUsage.clients !== 1 || sourceUsage.workspaces !== 0) {
          throw new PrincipalReconnectError(
            "reconnect_source_in_use",
            "This OAuth registration already owns retained state and cannot be relinked.",
          );
        }
      }
      // A relink changes the authorization boundary for this dynamic client.
      // Revoke any tokens issued before the relink so only the authorization
      // flow currently presenting the one-time code can obtain fresh access.
      this.database.sqlite
        .prepare("delete from oauth_access_tokens where client_id = ?")
        .run(clientId);
      this.database.sqlite
        .prepare("delete from oauth_refresh_tokens where client_id = ?")
        .run(clientId);
      this.database.sqlite
        .prepare("update oauth_clients set principal_id = ? where client_id = ?")
        .run(target.principalId, clientId);
      this.touchPrincipal(target.principalId);
      if (source.principalId) {
        this.database.sqlite.prepare(`
          delete from connection_principals
          where principal_id = ?
            and not exists (
              select 1 from oauth_clients where principal_id = connection_principals.principal_id
            )
            and not exists (
              select 1 from workspace_sessions where owner_client_id = connection_principals.principal_id
            )
        `).run(source.principalId);
      }
      return {
        clientId,
        ...(source.principalId ? { sourcePrincipalId: source.principalId } : {}),
        targetPrincipalId: target.principalId,
        changed: true,
      };
    });
    return consume.immediate();
  }

  checkAuthorizationLimits(
    inputs: readonly OAuthAuthorizationLimitInput[],
    now = Date.now(),
  ): OAuthAuthorizationLimitDecision {
    return this.evaluateAuthorizationLimits(inputs, now, false);
  }

  recordAuthorizationFailure(
    inputs: readonly OAuthAuthorizationLimitInput[],
    now = Date.now(),
  ): OAuthAuthorizationLimitDecision {
    return this.evaluateAuthorizationLimits(inputs, now, true);
  }

  clearAuthorizationLimit(scope: OAuthAuthorizationLimitScope, key: string): boolean {
    const keyHash = authorizationLimitKeyHash(scope, boundedAuthorizationLimitKey(key));
    return this.database.sqlite
      .prepare("delete from oauth_authorization_limits where key_hash = ?")
      .run(keyHash).changes > 0;
  }

  saveAccessToken(tokenHash: string, record: PersistedAccessTokenRecord): void {
    this.assertClientHasActivePrincipal(record.clientId);
    this.database.sqlite
      .prepare(
        `insert into oauth_access_tokens (token_hash, client_id, scopes_json, expires_at, resource)
         values (?, ?, ?, ?, ?)
         on conflict(token_hash) do update set
           client_id = excluded.client_id,
           scopes_json = excluded.scopes_json,
           expires_at = excluded.expires_at,
           resource = excluded.resource`,
      )
      .run(
        tokenHash,
        record.clientId,
        JSON.stringify(record.scopes),
        record.expiresAt,
        record.resource ?? null,
      );
  }

  getAccessToken(tokenHash: string): PersistedAccessTokenRecord | undefined {
    const row = this.database.sqlite
      .prepare(
        "select client_id, scopes_json, expires_at, resource from oauth_access_tokens where token_hash = ?",
      )
      .get(tokenHash) as
      | {
          client_id: string;
          scopes_json: string;
          expires_at: number;
          resource: string | null;
        }
      | undefined;

    return row ? rowToAccessTokenRecord(row) : undefined;
  }

  deleteAccessToken(tokenHash: string): void {
    this.database.sqlite.prepare("delete from oauth_access_tokens where token_hash = ?").run(tokenHash);
  }

  saveRefreshToken(tokenHash: string, record: PersistedRefreshTokenRecord): void {
    this.assertClientHasActivePrincipal(record.clientId);
    this.database.sqlite
      .prepare(
        `insert into oauth_refresh_tokens (token_hash, client_id, scopes_json, expires_at, resource)
         values (?, ?, ?, ?, ?)
         on conflict(token_hash) do update set
           client_id = excluded.client_id,
           scopes_json = excluded.scopes_json,
           expires_at = excluded.expires_at,
           resource = excluded.resource`,
      )
      .run(
        tokenHash,
        record.clientId,
        JSON.stringify(record.scopes),
        record.expiresAt,
        record.resource ?? null,
      );
  }

  saveTokenPair(pair: PersistedTokenPair, consumedRefreshTokenHash?: string): boolean {
    const save = this.database.sqlite.transaction(() => {
      if (consumedRefreshTokenHash) {
        const result = this.database.sqlite
          .prepare("delete from oauth_refresh_tokens where token_hash = ?")
          .run(consumedRefreshTokenHash);
        if (result.changes !== 1) return false;
      }

      this.saveAccessToken(pair.accessTokenHash, pair.accessToken);
      this.saveRefreshToken(pair.refreshTokenHash, pair.refreshToken);
      return true;
    });

    return save.immediate();
  }

  getRefreshToken(tokenHash: string): PersistedRefreshTokenRecord | undefined {
    const row = this.database.sqlite
      .prepare(
        "select client_id, scopes_json, expires_at, resource from oauth_refresh_tokens where token_hash = ?",
      )
      .get(tokenHash) as
      | {
          client_id: string;
          scopes_json: string;
          expires_at: number;
          resource: string | null;
        }
      | undefined;

    return row ? rowToRefreshTokenRecord(row) : undefined;
  }

  deleteRefreshToken(tokenHash: string): void {
    this.database.sqlite.prepare("delete from oauth_refresh_tokens where token_hash = ?").run(tokenHash);
  }

  /**
   * Reconciles the configured owner credential with its salted verifier. A
   * changed credential revokes every issued token in the same transaction,
   * while preserving public dynamic client registrations so browser clients
   * can reauthorize without having to forget and recreate the connector.
   */
  reconcileOwnerCredential(ownerToken: string): boolean {
    const reconcile = this.database.sqlite.transaction(() => {
      const row = this.database.sqlite
        .prepare("select salt, verifier from oauth_owner_credential where id = 1")
        .get() as { salt: string; verifier: string } | undefined;

      if (!row) {
        this.saveOwnerCredential(ownerToken);
        return false;
      }

      const candidate = deriveOwnerCredentialVerifier(ownerToken, row.salt);
      if (verifiersEqual(candidate, row.verifier)) return false;

      this.database.sqlite.prepare("delete from oauth_access_tokens").run();
      this.database.sqlite.prepare("delete from oauth_refresh_tokens").run();
      this.saveOwnerCredential(ownerToken);
      return true;
    });

    return reconcile.immediate();
  }

  revokeAll(): OAuthRevocationCounts {
    const revoke = this.database.sqlite.transaction(() => {
      const counts = this.diagnosticSnapshot();
      const now = new Date().toISOString();
      const workspaceCleanupJobs = this.database.sqlite.prepare(`
        insert into oauth_revocation_cleanup_jobs (
          owner_client_id, workspace_id, workspace_root, workspace_mode,
          source_root, managed, dirty_source, status, claim_token,
          lease_expires_at, attempts, last_error, created_at, updated_at,
          completed_at
        )
        select
          workspace.owner_client_id,
          workspace.id,
          workspace.root,
          workspace.mode,
          workspace.source_root,
          workspace.managed,
          workspace.dirty_source,
          'pending',
          null,
          null,
          0,
          null,
          @now,
          @now,
          null
        from workspace_sessions as workspace
        inner join oauth_clients as client
          on client.principal_id = workspace.owner_client_id
        where workspace.status in ('active', 'closed')
        on conflict(owner_client_id, workspace_id) do nothing
      `).run({ now }).changes;
      this.database.sqlite.prepare(`
        update workspace_sessions
        set status = 'revoked',
            state_generation = state_generation + 1,
            last_used_at = @now
        where status in ('active', 'closed')
          and owner_client_id in (select principal_id from oauth_clients)
      `).run({ now });
      this.database.sqlite.prepare(`
        update connection_principals
        set revoked_at = @now, last_used_at = @now
        where principal_id in (select principal_id from oauth_clients)
      `).run({ now });
      this.database.sqlite.prepare("delete from oauth_principal_reconnect_codes").run();
      this.database.sqlite.prepare("delete from oauth_access_tokens").run();
      this.database.sqlite.prepare("delete from oauth_refresh_tokens").run();
      this.database.sqlite.prepare("delete from oauth_clients").run();
      return {
        clients: counts.clients,
        accessTokens: counts.accessTokens,
        refreshTokens: counts.refreshTokens,
        workspaceCleanupJobs,
      };
    });
    return revoke.immediate();
  }

  queueOrphanedWorkspaceCleanup(): number {
    const reconcile = this.database.sqlite.transaction(() => {
      const now = new Date().toISOString();
      const queued = this.database.sqlite.prepare(`
        insert into oauth_revocation_cleanup_jobs (
          owner_client_id, workspace_id, workspace_root, workspace_mode,
          source_root, managed, dirty_source, status, claim_token,
          lease_expires_at, attempts, last_error, created_at, updated_at,
          completed_at
        )
        select
          workspace.owner_client_id,
          workspace.id,
          workspace.root,
          workspace.mode,
          workspace.source_root,
          workspace.managed,
          workspace.dirty_source,
          'pending',
          null,
          null,
          0,
          null,
          @now,
          @now,
          null
        from workspace_sessions as workspace
        left join connection_principals as principal
          on principal.principal_id = workspace.owner_client_id
        where workspace.status in ('active', 'closed')
          and (
            principal.revoked_at is not null
            or (principal.principal_id is null and workspace.owner_client_id like 'devspace-%')
          )
        on conflict(owner_client_id, workspace_id) do nothing
      `).run({ now }).changes;
      this.database.sqlite.prepare(`
        update workspace_sessions
        set status = 'revoked',
            state_generation = state_generation + 1,
            last_used_at = @now
        where status in ('active', 'closed')
          and (
            owner_client_id in (
              select principal_id from connection_principals where revoked_at is not null
            )
            or (
              owner_client_id like 'devspace-%'
              and owner_client_id not in (select principal_id from connection_principals)
            )
          )
      `).run({ now });
      return queued;
    });
    return reconcile.immediate();
  }

  diagnosticSnapshot(nowSeconds = Math.floor(Date.now() / 1000)): OAuthDiagnosticSnapshot {
    const row = this.database.sqlite.prepare(`
      select
        (select count(*) from oauth_clients) as clients,
        (select count(*) from connection_principals where revoked_at is null) as principals,
        (select count(*) from oauth_access_tokens) as accessTokens,
        (select count(*) from oauth_refresh_tokens) as refreshTokens,
        (select count(*) from oauth_revocation_cleanup_jobs where status != 'completed') as workspaceCleanupJobs,
        (select count(*) from oauth_access_tokens where expires_at < @nowSeconds) as expiredAccessTokens,
        (select count(*) from oauth_refresh_tokens where expires_at < @nowSeconds) as expiredRefreshTokens
    `).get({ nowSeconds }) as OAuthDiagnosticSnapshot;
    return row;
  }

  cleanupExpired(nowSeconds = Math.floor(Date.now() / 1000)): OAuthCleanupCounts {
    const nowMs = nowSeconds * 1_000;
    const cleanup = this.database.sqlite.transaction(() => ({
      accessTokens: this.database.sqlite
        .prepare("delete from oauth_access_tokens where expires_at < ?")
        .run(nowSeconds).changes,
      refreshTokens: this.database.sqlite
        .prepare("delete from oauth_refresh_tokens where expires_at < ?")
        .run(nowSeconds).changes,
      reconnectCodes: this.cleanupExpiredReconnectCodes(nowMs),
      authorizationLimits: this.database.sqlite
        .prepare("delete from oauth_authorization_limits where expires_at <= ?")
        .run(nowMs).changes,
    }));
    return cleanup.immediate();
  }

  close(): void {
    this.database.close();
  }

  isReady(): boolean {
    try {
      this.database.sqlite.prepare("select 1").get();
      return true;
    } catch {
      return false;
    }
  }

  private saveOwnerCredential(ownerToken: string): void {
    const salt = randomBytes(16).toString("base64url");
    const verifier = deriveOwnerCredentialVerifier(ownerToken, salt);
    this.database.sqlite.prepare(`
      insert into oauth_owner_credential (id, salt, verifier, updated_at)
      values (1, ?, ?, ?)
      on conflict(id) do update set
        salt = excluded.salt,
        verifier = excluded.verifier,
        updated_at = excluded.updated_at
    `).run(salt, verifier, new Date().toISOString());
  }

  private assertClientHasActivePrincipal(clientId: string): void {
    const row = this.database.sqlite.prepare(`
      select 1
      from oauth_clients as client
      inner join connection_principals as principal
        on principal.principal_id = client.principal_id
      where client.client_id = ? and principal.revoked_at is null
    `).get(clientId);
    if (!row) {
      throw new InvalidRequestError(
        "OAuth tokens cannot be issued before the registration has an active connection principal",
      );
    }
  }

  private cleanupExpiredReconnectCodes(nowMs = Date.now()): number {
    return this.database.sqlite
      .prepare("delete from oauth_principal_reconnect_codes where expires_at <= ?")
      .run(nowMs).changes;
  }

  private evaluateAuthorizationLimits(
    inputs: readonly OAuthAuthorizationLimitInput[],
    now: number,
    consumeFailure: boolean,
  ): OAuthAuthorizationLimitDecision {
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RangeError("Authorization limit time must be a non-negative safe integer.");
    }
    const normalized = inputs.map(normalizeAuthorizationLimitInput);
    const evaluate = this.database.sqlite.transaction(() => {
      let limited = false;
      let retryAfterMs = 0;
      for (const input of normalized) {
        const keyHash = authorizationLimitKeyHash(input.scope, input.key);
        const row = this.database.sqlite.prepare(`
          select tokens, updated_at, failure_streak, blocked_until
          from oauth_authorization_limits
          where key_hash = ?
        `).get(keyHash) as AuthorizationLimitRow | undefined;
        const state = refreshAuthorizationLimit(row, input, now);
        const currentRetry = authorizationLimitRetryAfter(state, input, now);
        if (currentRetry > 0) {
          limited = true;
          retryAfterMs = Math.max(retryAfterMs, currentRetry);
          if (row && state.changed) {
            this.writeAuthorizationLimit(keyHash, input, state, now);
          }
          continue;
        }
        if (!consumeFailure) {
          if (row && state.changed) {
            this.writeAuthorizationLimit(keyHash, input, state, now);
          }
          continue;
        }

        const failureStreak = state.failureStreak + 1;
        const tokens = state.tokens - 1;
        const exponent = Math.min(20, Math.max(0, failureStreak - input.capacity));
        const backoffMs = tokens === 0
          ? Math.min(input.maxBackoffMs, input.baseBackoffMs * (2 ** exponent))
          : 0;
        this.writeAuthorizationLimit(keyHash, input, {
          ...state,
          tokens,
          failureStreak,
          blockedUntil: backoffMs > 0 ? now + backoffMs : state.blockedUntil,
          changed: true,
        }, now);
      }
      return { limited, retryAfterMs };
    });
    return evaluate.immediate();
  }

  private writeAuthorizationLimit(
    keyHash: string,
    input: OAuthAuthorizationLimitInput,
    state: RefreshedAuthorizationLimit,
    now: number,
  ): void {
    this.database.sqlite.prepare(`
      insert into oauth_authorization_limits (
        key_hash, scope, tokens, updated_at, failure_streak, blocked_until, expires_at
      ) values (?, ?, ?, ?, ?, ?, ?)
      on conflict(key_hash) do update set
        scope = excluded.scope,
        tokens = excluded.tokens,
        updated_at = excluded.updated_at,
        failure_streak = excluded.failure_streak,
        blocked_until = excluded.blocked_until,
        expires_at = excluded.expires_at
    `).run(
      keyHash,
      input.scope,
      state.tokens,
      state.updatedAt,
      state.failureStreak,
      state.blockedUntil,
      now + input.ttlMs,
    );
  }
}

export class SqliteOAuthClientsStore implements OAuthRegisteredClientsStore {
  constructor(
    private readonly store: SqliteOAuthStore,
    private readonly allowedRedirectHosts: string[],
    private readonly onClientRegistered?: (clientId: string) => void,
  ) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.store.getClient(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    const registered = this.store.registerClient(client, this.allowedRedirectHosts);
    this.onClientRegistered?.(registered.client_id);
    return registered;
  }
}

function rowToAccessTokenRecord(row: {
  client_id: string;
  scopes_json: string;
  expires_at: number;
  resource: string | null;
}): PersistedAccessTokenRecord {
  return {
    clientId: row.client_id,
    scopes: JSON.parse(row.scopes_json) as string[],
    expiresAt: row.expires_at,
    resource: row.resource ?? undefined,
  };
}

function rowToRefreshTokenRecord(row: {
  client_id: string;
  scopes_json: string;
  expires_at: number;
  resource: string | null;
}): PersistedRefreshTokenRecord {
  return {
    clientId: row.client_id,
    scopes: JSON.parse(row.scopes_json) as string[],
    expiresAt: row.expires_at,
    resource: row.resource ?? undefined,
  };
}

function deriveOwnerCredentialVerifier(ownerToken: string, salt: string): string {
  return scryptSync(ownerToken, Buffer.from(salt, "base64url"), 32).toString("base64url");
}

function verifiersEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "base64url");
  const rightBytes = Buffer.from(right, "base64url");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function hashReconnectCode(code: string): string {
  return createHash("sha256").update("devspace-principal-reconnect-v1\0").update(code).digest("hex");
}

interface RefreshedAuthorizationLimit {
  tokens: number;
  updatedAt: number;
  failureStreak: number;
  blockedUntil: number;
  changed: boolean;
}

function normalizeAuthorizationLimitInput(
  input: OAuthAuthorizationLimitInput,
): OAuthAuthorizationLimitInput {
  if (!["session", "client", "ip", "global"].includes(input.scope)) {
    throw new TypeError("Unknown OAuth authorization limit scope.");
  }
  const key = boundedAuthorizationLimitKey(input.key);
  for (const [name, value] of Object.entries({
    capacity: input.capacity,
    refillIntervalMs: input.refillIntervalMs,
    baseBackoffMs: input.baseBackoffMs,
    maxBackoffMs: input.maxBackoffMs,
    ttlMs: input.ttlMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive safe integer.`);
    }
  }
  if (input.baseBackoffMs > input.maxBackoffMs) {
    throw new RangeError("baseBackoffMs cannot exceed maxBackoffMs.");
  }
  return { ...input, key };
}

function boundedAuthorizationLimitKey(key: string): string {
  if (typeof key !== "string" || key.length < 1 || key.length > MAX_AUTHORIZATION_LIMIT_KEY_LENGTH) {
    throw new TypeError(
      `Authorization limit key must be 1-${MAX_AUTHORIZATION_LIMIT_KEY_LENGTH} characters.`,
    );
  }
  return key;
}

function authorizationLimitKeyHash(scope: OAuthAuthorizationLimitScope, key: string): string {
  return createHash("sha256")
    .update("devspace-oauth-authorization-limit-v1\0")
    .update(scope)
    .update("\0")
    .update(key)
    .digest("hex");
}

function refreshAuthorizationLimit(
  row: AuthorizationLimitRow | undefined,
  input: OAuthAuthorizationLimitInput,
  now: number,
): RefreshedAuthorizationLimit {
  if (!row) {
    return {
      tokens: input.capacity,
      updatedAt: now,
      failureStreak: 0,
      blockedUntil: 0,
      changed: false,
    };
  }
  const elapsed = Math.max(0, now - row.updated_at);
  const refills = Math.floor(elapsed / input.refillIntervalMs);
  const tokens = Math.min(input.capacity, row.tokens + refills);
  const fullyRefilled = tokens === input.capacity;
  const updatedAt = fullyRefilled
    ? now
    : refills > 0
      ? row.updated_at + refills * input.refillIntervalMs
      : row.updated_at;
  const failureStreak = fullyRefilled ? 0 : row.failure_streak;
  const blockedUntil = fullyRefilled || row.blocked_until <= now ? 0 : row.blocked_until;
  return {
    tokens,
    updatedAt,
    failureStreak,
    blockedUntil,
    changed:
      tokens !== row.tokens ||
      updatedAt !== row.updated_at ||
      failureStreak !== row.failure_streak ||
      blockedUntil !== row.blocked_until,
  };
}

function authorizationLimitRetryAfter(
  state: RefreshedAuthorizationLimit,
  input: OAuthAuthorizationLimitInput,
  now: number,
): number {
  const blockedRetry = Math.max(0, state.blockedUntil - now);
  const tokenRetry = state.tokens < 1
    ? Math.max(1, input.refillIntervalMs - Math.max(0, now - state.updatedAt))
    : 0;
  return Math.max(blockedRetry, tokenRetry);
}
