import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidRequestError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { OWNER_PRINCIPAL_ID } from "./db/canonical-schema.js";
import { DEVSPACE_CAPABILITY_SCOPES } from "./oauth-scopes.js";
import {
  ALL_AUTHORIZED_ROOTS_ID,
  normalizeAuthorizedRootIds,
} from "./authorization-roots.js";
import {
  hashOwnerPassword,
  isArgon2idHash,
  verifyOwnerPassword,
  type OwnerCredentialInput,
} from "./security-credentials.js";

interface OwnerCredentialReconciliationInput extends OwnerCredentialInput {
  /** Ephemeral compatibility material; never persisted or used for approval. */
  legacyVerifierSecret?: Uint8Array;
}

export interface PersistedAccessTokenRecord {
  grantId?: string;
  clientId: string;
  principalId?: string;
  authorizationEpoch?: number;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

export interface PersistedRefreshTokenRecord {
  grantId?: string;
  clientId: string;
  principalId?: string;
  authorizationEpoch?: number;
  familyId?: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

export interface OAuthRefreshTokenTombstone {
  tokenHash: string;
  familyId: string;
  grantId: string;
  clientId: string;
  principalId: string;
  authorizationEpoch: number;
  consumedAt: number;
  expiresAt: number;
}

export type TokenPairRotationResult =
  | { status: "saved" }
  | { status: "invalid" }
  | { status: "replay"; tombstone: OAuthRefreshTokenTombstone };

export interface PersistedTokenPair {
  accessTokenHash: string;
  accessToken: PersistedAccessTokenRecord;
  refreshTokenHash: string;
  refreshToken: PersistedRefreshTokenRecord;
}

export interface OAuthRevocationCounts {
  clients: number;
  grants: number;
  accessTokens: number;
  refreshTokens: number;
  workspaceCleanupJobs: number;
}

export interface OAuthDiagnosticSnapshot extends OAuthRevocationCounts {
  principals: number;
  expiredAccessTokens: number;
  expiredRefreshTokens: number;
  legacyWildcardGrants: number;
}

export interface OAuthCleanupCounts {
  accessTokens: number;
  refreshTokens: number;
  authorizationLimits: number;
  authorizationSelections: number;
  authorizationCodes: number;
  unapprovedClients: number;
  staleGrants: number;
  authorizationCleanup: OAuthAuthorizationCleanupResult;
}

export interface PersistedAuthorizationSelectionRecord {
  clientId: string;
  authorizationSessionKey: string;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface PersistedAuthorizationCodeRecord {
  clientId: string;
  grantId: string;
  principalId: string;
  authorizationEpoch: number;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface OAuthGrantRecord {
  grantId: string;
  clientId: string;
  principalId: string;
  grantedScopes: string[];
  allowedRootIds: string[];
  authorizationEpoch: number;
  absoluteExpiresAt?: number;
  createdAt: string;
  lastUsedAt: string;
  revokedAt?: string;
}

export interface OAuthAuthorizationTuple {
  principalId: string;
  grantId: string;
  authorizationEpoch: number;
}

export interface OAuthRevokedProjectExecution {
  executionId: string;
  principalId: string;
  clientId: string;
  grantId: string;
  authorizationEpoch: number;
  workspaceId?: string;
  workspaceRoot?: string;
}

export interface OAuthQueuedWorkspaceCleanupJob {
  id: number;
  projectExecutionId: string;
  workspaceId: string;
  workspaceRoot: string;
}

export interface OAuthAuthorizationCleanupResult {
  revokedAuthorizations: OAuthAuthorizationTuple[];
  revokedExecutions: OAuthRevokedProjectExecution[];
  workspaceCleanupJobs: OAuthQueuedWorkspaceCleanupJob[];
}

export interface OAuthGrantCreationResult extends OAuthGrantRecord {
  revokedAuthorizations: OAuthAuthorizationTuple[];
  authorizationCleanup: OAuthAuthorizationCleanupResult;
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

export interface PrincipalAssignmentResult {
  principalId: string;
  created: boolean;
}

const MAX_AUTHORIZATION_LIMIT_KEY_LENGTH = 4_096;
const PENDING_OAUTH_CLIENT_TTL_SECONDS = 60 * 60;
const MAX_PENDING_OAUTH_CLIENTS = 64;
const MAX_TOTAL_OAUTH_CLIENTS = 512;
const REFRESH_REPLAY_TOMBSTONE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const OAUTH_AUTHORIZATION_SELECTION_TTL_MS = 5 * 60_000;
export const OAUTH_AUTHORIZATION_CODE_TTL_MS = 5 * 60_000;

interface AuthorizationLimitRow {
  tokens: number;
  updated_at: number;
  failure_streak: number;
  blocked_until: number;
}

interface OAuthGrantRow {
  grantId: string;
  clientId: string;
  principalId: string;
  grantedScopesJson: string;
  allowedRootIdsJson: string;
  authorizationEpoch: number;
  absoluteExpiresAt: number | null;
  createdAt: string;
  lastUsedAt: string;
  revokedAt: string | null;
}

interface OAuthTokenRow {
  grant_id: string;
  client_id: string;
  principal_id: string;
  authorization_epoch: number;
  scopes_json: string;
  expires_at: number;
  resource: string | null;
}

interface OAuthRefreshTokenRow extends OAuthTokenRow {
  family_id: string;
}

interface OAuthRefreshTokenTombstoneRow {
  token_hash: string;
  family_id: string;
  grant_id: string;
  client_id: string;
  principal_id: string;
  authorization_epoch: number;
  consumed_at: number;
  expires_at: number;
}

interface OAuthAuthorizationSelectionRow {
  clientId: string;
  authorizationSessionKey: string;
  createdAtMs: number;
  expiresAtMs: number;
}

interface OAuthAuthorizationCodeRow {
  clientId: string;
  grantId: string;
  principalId: string;
  authorizationEpoch: number;
  redirectUri: string;
  codeChallenge: string;
  scopesJson: string;
  resource: string | null;
  createdAtMs: number;
  expiresAtMs: number;
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
    const rows = this.database.sqlite.prepare(`
      select distinct grant.principal_id as principalId
      from oauth_grants as grant
      inner join connection_principals as principal
        on principal.principal_id = grant.principal_id
      where grant.client_id = ?
        and grant.revoked_at is null
        and principal.revoked_at is null
      order by grant.last_used_at desc
      limit 2
    `).all(clientId) as Array<{ principalId: string }>;
    return rows.length === 1 ? rows[0]!.principalId : undefined;
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

    const register = this.database.sqlite.transaction(() => {
      this.cleanupExpiredUnapprovedClients(now);
      const counts = this.database.sqlite.prepare(`
        select
          count(*) as total,
          count(*) filter (where not exists (
            select 1 from oauth_grants as grant
            where grant.client_id = oauth_clients.client_id
          )) as pending
        from oauth_clients
      `).get() as { total: number; pending: number };
      if (counts.pending >= MAX_PENDING_OAUTH_CLIENTS) {
        throw new InvalidRequestError(
          "Too many unapproved OAuth client registrations are pending; retry after older registrations expire",
        );
      }
      if (counts.total >= MAX_TOTAL_OAUTH_CLIENTS) {
        throw new InvalidRequestError(
          "OAuth client registration capacity reached; revoke unused clients before registering another",
        );
      }
      this.database.sqlite.prepare(`
        insert into oauth_clients (
          client_id, client_json, issued_at
        ) values (?, ?, ?)
      `).run(registered.client_id, JSON.stringify(registered), now);
    });
    register.immediate();

    return registered;
  }

  ensurePrincipalForClient(clientId: string): string {
    return this.ensurePrincipalAssignmentForClient(clientId).principalId;
  }

  ensurePrincipalAssignmentForClient(clientId: string): PrincipalAssignmentResult {
    const existing = this.principalForClient(clientId);
    if (existing) return { principalId: existing, created: false };
    const grant = this.createAuthorizationGrant({
      clientId,
      scopes: [...DEVSPACE_CAPABILITY_SCOPES],
    });
    return { principalId: grant.principalId, created: false };
  }

  createAuthorizationGrant(input: {
    clientId: string;
    scopes: string[];
    allowedRootIds?: string[];
    absoluteExpiresAt?: number;
  }): OAuthGrantCreationResult {
    const scopes = normalizeGrantScopes(input.scopes);
    const allowedRootIds = normalizeAuthorizedRootIds(
      input.allowedRootIds ?? [ALL_AUTHORIZED_ROOTS_ID],
    );
    if (
      input.absoluteExpiresAt !== undefined &&
      (!Number.isSafeInteger(input.absoluteExpiresAt) || input.absoluteExpiresAt < 1)
    ) {
      throw new InvalidRequestError("OAuth grant absolute expiry must be a positive Unix timestamp");
    }
    const create = this.database.sqlite.transaction((): OAuthGrantCreationResult => {
      const client = this.database.sqlite.prepare(`
        select client_id
        from oauth_clients
        where client_id = ?
      `).get(input.clientId) as { client_id: string } | undefined;
      if (!client) throw new InvalidRequestError("OAuth client registration was not found");

      const now = new Date().toISOString();
      const grantId = `grant-${randomUUID()}`;
      this.database.sqlite.prepare(`
        insert into oauth_grants (
          grant_id, client_id, principal_id, granted_scopes_json,
          allowed_root_ids_json, authorization_epoch, absolute_expires_at,
          created_at, last_used_at, revoked_at
        ) values (?, ?, ?, ?, ?, 1, ?, ?, ?, null)
      `).run(
        grantId,
        input.clientId,
        OWNER_PRINCIPAL_ID,
        JSON.stringify(scopes),
        JSON.stringify(allowedRootIds),
        input.absoluteExpiresAt ?? null,
        now,
        now,
      );
      this.touchPrincipal(OWNER_PRINCIPAL_ID);
      return {
        grantId,
        clientId: input.clientId,
        principalId: OWNER_PRINCIPAL_ID,
        grantedScopes: scopes,
        allowedRootIds,
        authorizationEpoch: 1,
        ...(input.absoluteExpiresAt ? { absoluteExpiresAt: input.absoluteExpiresAt } : {}),
        createdAt: now,
        lastUsedAt: now,
        revokedAuthorizations: [],
        authorizationCleanup: {
          revokedAuthorizations: [],
          revokedExecutions: [],
          workspaceCleanupJobs: [],
        },
      };
    });
    return create.immediate();
  }

  getAuthorizationGrant(grantId: string): OAuthGrantRecord | undefined {
    const row = this.database.sqlite.prepare(`
      select
        grant.grant_id as grantId,
        grant.client_id as clientId,
        grant.principal_id as principalId,
        grant.granted_scopes_json as grantedScopesJson,
        grant.allowed_root_ids_json as allowedRootIdsJson,
        grant.authorization_epoch as authorizationEpoch,
        grant.absolute_expires_at as absoluteExpiresAt,
        grant.created_at as createdAt,
        grant.last_used_at as lastUsedAt,
        grant.revoked_at as revokedAt
      from oauth_grants as grant
      inner join oauth_clients as client
        on client.client_id = grant.client_id
      inner join connection_principals as principal
        on principal.principal_id = grant.principal_id
      where grant.grant_id = ?
        and grant.revoked_at is null
        and (grant.absolute_expires_at is null or grant.absolute_expires_at > cast(strftime('%s','now') as integer))
        and principal.revoked_at is null
    `).get(grantId) as OAuthGrantRow | undefined;
    return row ? rowToOAuthGrantRecord(row) : undefined;
  }

  validateAndTouchAuthorizationGrant(input: {
    grantId: string;
    clientId: string;
    principalId: string;
    authorizationEpoch: number;
    scopes: readonly string[];
  }): OAuthGrantRecord | undefined {
    const validate = this.database.sqlite.transaction(() => {
      const grant = this.getAuthorizationGrant(input.grantId);
      if (
        !grant ||
        grant.clientId !== input.clientId ||
        grant.principalId !== input.principalId ||
        grant.authorizationEpoch !== input.authorizationEpoch ||
        input.scopes.some((scope) => !grant.grantedScopes.includes(scope))
      ) {
        return undefined;
      }
      const now = new Date().toISOString();
      const touched = this.database.sqlite.prepare(`
        update oauth_grants
        set last_used_at = ?
        where grant_id = ?
          and client_id = ?
          and principal_id = ?
          and authorization_epoch = ?
          and revoked_at is null
      `).run(
        now,
        grant.grantId,
        grant.clientId,
        grant.principalId,
        grant.authorizationEpoch,
      );
      if (touched.changes !== 1) return undefined;
      this.touchPrincipal(grant.principalId);
      return {
        ...grant,
        lastUsedAt: now,
      };
    });
    return validate.immediate();
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

  saveAuthorizationSelection(
    tokenHash: string,
    record: Pick<
      PersistedAuthorizationSelectionRecord,
      "clientId" | "authorizationSessionKey"
    >,
    nowMs = Date.now(),
  ): PersistedAuthorizationSelectionRecord {
    assertOAuthArtifactTime(nowMs);
    const persisted = {
      ...record,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + OAUTH_AUTHORIZATION_SELECTION_TTL_MS,
    };
    this.database.sqlite.prepare(`
      insert into oauth_authorization_selections (
        token_hash, client_id, authorization_session_key, created_at, expires_at
      ) values (?, ?, ?, ?, ?)
    `).run(
      tokenHash,
      persisted.clientId,
      persisted.authorizationSessionKey,
      persisted.createdAtMs,
      persisted.expiresAtMs,
    );
    return persisted;
  }

  getAuthorizationSelection(
    tokenHash: string,
    clientId: string,
    authorizationSessionKey: string,
    nowMs = Date.now(),
  ): PersistedAuthorizationSelectionRecord | undefined {
    assertOAuthArtifactTime(nowMs);
    const row = this.database.sqlite.prepare(`
      select
        client_id as clientId,
        authorization_session_key as authorizationSessionKey,
        created_at as createdAtMs,
        expires_at as expiresAtMs
      from oauth_authorization_selections
      where token_hash = ?
        and client_id = ?
        and authorization_session_key = ?
        and expires_at > ?
    `).get(tokenHash, clientId, authorizationSessionKey, nowMs) as
      OAuthAuthorizationSelectionRow | undefined;
    return row;
  }

  consumeAuthorizationSelection(
    tokenHash: string,
    clientId: string,
    authorizationSessionKey: string,
    nowMs = Date.now(),
  ): PersistedAuthorizationSelectionRecord | undefined {
    assertOAuthArtifactTime(nowMs);
    const consume = this.database.sqlite.transaction(() => {
      const record = this.getAuthorizationSelection(
        tokenHash,
        clientId,
        authorizationSessionKey,
        nowMs,
      );
      if (!record) return undefined;
      const deleted = this.database.sqlite.prepare(`
        delete from oauth_authorization_selections
        where token_hash = ?
          and client_id = ?
          and authorization_session_key = ?
          and expires_at > ?
      `).run(tokenHash, clientId, authorizationSessionKey, nowMs);
      return deleted.changes === 1 ? record : undefined;
    });
    return consume.immediate();
  }

  saveAuthorizationCode(
    codeHash: string,
    record: Omit<PersistedAuthorizationCodeRecord, "createdAtMs" | "expiresAtMs">,
    nowMs = Date.now(),
  ): PersistedAuthorizationCodeRecord {
    assertOAuthArtifactTime(nowMs);
    const save = this.database.sqlite.transaction(() => {
      const grant = this.getAuthorizationGrant(record.grantId);
      if (
        !grant ||
        grant.clientId !== record.clientId ||
        grant.principalId !== record.principalId ||
        grant.authorizationEpoch !== record.authorizationEpoch
      ) {
        throw new InvalidRequestError(
          "OAuth authorization code fields do not match an active authorization grant",
        );
      }
      const scopes = normalizeGrantScopes(record.scopes);
      if (scopes.some((scope) => !grant.grantedScopes.includes(scope))) {
        throw new InvalidRequestError(
          "OAuth authorization code scopes exceed its authorization grant",
        );
      }
      const persisted: PersistedAuthorizationCodeRecord = {
        ...record,
        scopes,
        createdAtMs: nowMs,
        expiresAtMs: nowMs + OAUTH_AUTHORIZATION_CODE_TTL_MS,
      };
      this.database.sqlite.prepare(`
        insert into oauth_authorization_codes (
          code_hash, client_id, grant_id, principal_id, authorization_epoch,
          redirect_uri, code_challenge, scopes_json, resource, created_at, expires_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        codeHash,
        persisted.clientId,
        persisted.grantId,
        persisted.principalId,
        persisted.authorizationEpoch,
        persisted.redirectUri,
        persisted.codeChallenge,
        JSON.stringify(persisted.scopes),
        persisted.resource ?? null,
        persisted.createdAtMs,
        persisted.expiresAtMs,
      );
      return persisted;
    });
    return save.immediate();
  }

  getAuthorizationCode(
    codeHash: string,
    clientId: string,
    nowMs = Date.now(),
  ): PersistedAuthorizationCodeRecord | undefined {
    assertOAuthArtifactTime(nowMs);
    const row = this.database.sqlite.prepare(`
      select
        code.client_id as clientId,
        code.grant_id as grantId,
        code.principal_id as principalId,
        code.authorization_epoch as authorizationEpoch,
        code.redirect_uri as redirectUri,
        code.code_challenge as codeChallenge,
        code.scopes_json as scopesJson,
        code.resource,
        code.created_at as createdAtMs,
        code.expires_at as expiresAtMs
      from oauth_authorization_codes as code
      inner join oauth_grants as grant
        on grant.grant_id = code.grant_id
       and grant.client_id = code.client_id
       and grant.principal_id = code.principal_id
      inner join connection_principals as principal
        on principal.principal_id = code.principal_id
      where code.code_hash = ?
        and code.client_id = ?
        and code.expires_at > ?
        and code.authorization_epoch = grant.authorization_epoch
        and grant.revoked_at is null
        and (grant.absolute_expires_at is null or grant.absolute_expires_at > ?)
        and principal.revoked_at is null
    `).get(codeHash, clientId, nowMs, Math.floor(nowMs / 1_000)) as
      OAuthAuthorizationCodeRow | undefined;
    return row ? rowToAuthorizationCodeRecord(row) : undefined;
  }

  consumeAuthorizationCode(
    codeHash: string,
    clientId: string,
    nowMs = Date.now(),
  ): PersistedAuthorizationCodeRecord | undefined {
    assertOAuthArtifactTime(nowMs);
    const consume = this.database.sqlite.transaction(() => {
      const record = this.getAuthorizationCode(codeHash, clientId, nowMs);
      if (!record) return undefined;
      const deleted = this.database.sqlite.prepare(`
        delete from oauth_authorization_codes
        where code_hash = ? and client_id = ? and expires_at > ?
      `).run(codeHash, clientId, nowMs);
      return deleted.changes === 1 ? record : undefined;
    });
    return consume.immediate();
  }

  saveAccessToken(tokenHash: string, record: PersistedAccessTokenRecord): void {
    const normalized = this.resolveTokenGrant(record);
    this.database.sqlite
      .prepare(
        `insert into oauth_access_tokens (
           token_hash, grant_id, client_id, principal_id, authorization_epoch,
           scopes_json, expires_at, resource
         ) values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(token_hash) do update set
           grant_id = excluded.grant_id,
           client_id = excluded.client_id,
           principal_id = excluded.principal_id,
           authorization_epoch = excluded.authorization_epoch,
           scopes_json = excluded.scopes_json,
           expires_at = excluded.expires_at,
           resource = excluded.resource`,
      )
      .run(
        tokenHash,
        normalized.grantId,
        normalized.clientId,
        normalized.principalId,
        normalized.authorizationEpoch,
        JSON.stringify(normalized.scopes),
        normalized.expiresAt,
        normalized.resource ?? null,
      );
  }

  getAccessToken(tokenHash: string): PersistedAccessTokenRecord | undefined {
    const row = this.database.sqlite.prepare(`
      select
        token.grant_id,
        token.client_id,
        token.principal_id,
        token.authorization_epoch,
        token.scopes_json,
        token.expires_at,
        token.resource
      from oauth_access_tokens as token
      inner join oauth_grants as grant
        on grant.grant_id = token.grant_id
       and grant.client_id = token.client_id
       and grant.principal_id = token.principal_id
      inner join connection_principals as principal
        on principal.principal_id = token.principal_id
      where token.token_hash = ?
        and token.authorization_epoch = grant.authorization_epoch
        and grant.revoked_at is null
        and (grant.absolute_expires_at is null or grant.absolute_expires_at > cast(strftime('%s','now') as integer))
        and principal.revoked_at is null
    `).get(tokenHash) as OAuthTokenRow | undefined;

    return row ? rowToAccessTokenRecord(row) : undefined;
  }

  deleteAccessToken(tokenHash: string, clientId: string): boolean {
    return this.database.sqlite.prepare(`
      delete from oauth_access_tokens where token_hash = ? and client_id = ?
    `).run(tokenHash, clientId).changes === 1;
  }

  saveRefreshToken(tokenHash: string, record: PersistedRefreshTokenRecord): void {
    const normalized = this.resolveTokenGrant(record);
    const familyId = normalizeRefreshFamilyId(record.familyId ?? newRefreshFamilyId());
    this.database.sqlite
      .prepare(
        `insert into oauth_refresh_tokens (
           token_hash, grant_id, client_id, principal_id, authorization_epoch,
           family_id, scopes_json, expires_at, resource
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(token_hash) do update set
           grant_id = excluded.grant_id,
           client_id = excluded.client_id,
           principal_id = excluded.principal_id,
           authorization_epoch = excluded.authorization_epoch,
           family_id = excluded.family_id,
           scopes_json = excluded.scopes_json,
           expires_at = excluded.expires_at,
           resource = excluded.resource`,
      )
      .run(
        tokenHash,
        normalized.grantId,
        normalized.clientId,
        normalized.principalId,
        normalized.authorizationEpoch,
        familyId,
        JSON.stringify(normalized.scopes),
        normalized.expiresAt,
        normalized.resource ?? null,
      );
  }

  saveTokenPair(pair: PersistedTokenPair, consumedRefreshTokenHash?: string): boolean {
    return this.rotateTokenPair(pair, consumedRefreshTokenHash).status === "saved";
  }

  rotateTokenPair(
    pair: PersistedTokenPair,
    consumedRefreshTokenHash?: string,
    nowSeconds = Math.floor(Date.now() / 1_000),
  ): TokenPairRotationResult {
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
      throw new RangeError("Refresh-token rotation time must be a non-negative Unix timestamp.");
    }
    const save = this.database.sqlite.transaction((): TokenPairRotationResult => {
      const access = this.resolveTokenGrant(pair.accessToken);
      const refresh = this.resolveTokenGrant(pair.refreshToken);
      if (
        access.grantId !== refresh.grantId ||
        access.clientId !== refresh.clientId ||
        access.principalId !== refresh.principalId ||
        access.authorizationEpoch !== refresh.authorizationEpoch ||
        access.resource !== refresh.resource ||
        access.scopes.length !== refresh.scopes.length ||
        access.scopes.some((scope) => !refresh.scopes.includes(scope))
      ) {
        throw new InvalidRequestError(
          "OAuth access and refresh tokens in one pair must belong to the same authorization grant",
        );
      }
      let familyId = pair.refreshToken.familyId
        ? normalizeRefreshFamilyId(pair.refreshToken.familyId)
        : newRefreshFamilyId();
      if (consumedRefreshTokenHash) {
        const consumed = this.getRefreshToken(consumedRefreshTokenHash);
        if (!consumed) {
          const tombstone = this.getRefreshTokenTombstone(consumedRefreshTokenHash, nowSeconds);
          return tombstone ? { status: "replay", tombstone } : { status: "invalid" };
        }
        if (
          consumed.grantId !== refresh.grantId ||
          consumed.principalId !== refresh.principalId ||
          consumed.clientId !== refresh.clientId
        ) return { status: "invalid" };
        familyId = normalizeRefreshFamilyId(consumed.familyId ?? familyId);
        const result = this.database.sqlite
          .prepare("delete from oauth_refresh_tokens where token_hash = ?")
          .run(consumedRefreshTokenHash);
        if (result.changes !== 1) {
          const tombstone = this.getRefreshTokenTombstone(consumedRefreshTokenHash, nowSeconds);
          return tombstone ? { status: "replay", tombstone } : { status: "invalid" };
        }
        this.database.sqlite.prepare(`
          insert into oauth_refresh_token_tombstones (
            token_hash, family_id, grant_id, client_id, principal_id,
            authorization_epoch, consumed_at, expires_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(token_hash) do update set
            family_id = excluded.family_id,
            grant_id = excluded.grant_id,
            client_id = excluded.client_id,
            principal_id = excluded.principal_id,
            authorization_epoch = excluded.authorization_epoch,
            consumed_at = excluded.consumed_at,
            expires_at = excluded.expires_at
        `).run(
          consumedRefreshTokenHash,
          familyId,
          consumed.grantId,
          consumed.clientId,
          consumed.principalId,
          consumed.authorizationEpoch,
          nowSeconds,
          Math.max(consumed.expiresAt, nowSeconds + REFRESH_REPLAY_TOMBSTONE_TTL_SECONDS),
        );
      }

      this.saveAccessToken(pair.accessTokenHash, pair.accessToken);
      this.saveRefreshToken(pair.refreshTokenHash, { ...pair.refreshToken, familyId });
      return { status: "saved" };
    });

    return save.immediate();
  }

  getRefreshToken(tokenHash: string): PersistedRefreshTokenRecord | undefined {
    const row = this.database.sqlite.prepare(`
      select
        token.grant_id,
        token.client_id,
        token.principal_id,
        token.authorization_epoch,
        token.family_id,
        token.scopes_json,
        token.expires_at,
        token.resource
      from oauth_refresh_tokens as token
      inner join oauth_grants as grant
        on grant.grant_id = token.grant_id
       and grant.client_id = token.client_id
       and grant.principal_id = token.principal_id
      inner join connection_principals as principal
        on principal.principal_id = token.principal_id
      where token.token_hash = ?
        and token.authorization_epoch = grant.authorization_epoch
        and grant.revoked_at is null
        and (grant.absolute_expires_at is null or grant.absolute_expires_at > cast(strftime('%s','now') as integer))
        and principal.revoked_at is null
    `).get(tokenHash) as OAuthRefreshTokenRow | undefined;

    return row ? rowToRefreshTokenRecord(row) : undefined;
  }

  getRefreshTokenTombstone(
    tokenHash: string,
    nowSeconds = Math.floor(Date.now() / 1_000),
  ): OAuthRefreshTokenTombstone | undefined {
    const row = this.database.sqlite.prepare(`
      select
        token_hash, family_id, grant_id, client_id, principal_id,
        authorization_epoch, consumed_at, expires_at
      from oauth_refresh_token_tombstones
      where token_hash = ? and expires_at > ?
    `).get(tokenHash, nowSeconds) as OAuthRefreshTokenTombstoneRow | undefined;
    return row ? rowToRefreshTokenTombstone(row) : undefined;
  }

  revokeRefreshTokenFamilyOnReplay(
    tombstone: OAuthRefreshTokenTombstone,
  ): {
    changed: boolean;
    connectionPrincipalId: string;
    grantId: string;
    authorizationCleanup: OAuthAuthorizationCleanupResult;
  } {
    const revoke = this.database.sqlite.transaction(() => {
      const now = new Date().toISOString();
      const result = this.database.sqlite.prepare(`
        update oauth_grants
        set revoked_at = ?, last_used_at = ?, authorization_epoch = authorization_epoch + 1
        where grant_id = ?
          and client_id = ?
          and principal_id = ?
          and authorization_epoch = ?
          and revoked_at is null
      `).run(
        now,
        now,
        tombstone.grantId,
        tombstone.clientId,
        tombstone.principalId,
        tombstone.authorizationEpoch,
      );
      this.database.sqlite.prepare("delete from oauth_access_tokens where grant_id = ?")
        .run(tombstone.grantId);
      this.database.sqlite.prepare(`
        delete from oauth_refresh_tokens where grant_id = ?
      `).run(tombstone.grantId);
      const revokedAuthorizations = result.changes === 1
        ? [{
            principalId: tombstone.principalId,
            grantId: tombstone.grantId,
            authorizationEpoch: tombstone.authorizationEpoch,
          }]
        : [];
      return {
        changed: result.changes === 1,
        connectionPrincipalId: tombstone.principalId,
        grantId: tombstone.grantId,
        authorizationCleanup: this.revokeProjectExecutions(
          revokedAuthorizations,
          "The OAuth authorization was revoked after refresh-token replay.",
          now,
        ),
      };
    });
    return revoke.immediate();
  }

  deleteRefreshToken(tokenHash: string, clientId: string): boolean {
    return this.database.sqlite.prepare(`
      delete from oauth_refresh_tokens where token_hash = ? and client_id = ?
    `).run(tokenHash, clientId).changes === 1;
  }

  /**
   * Reconciles the configured owner credential with its salted verifier. A
   * changed credential revokes every issued token in the same transaction,
   * while preserving public dynamic client registrations so browser clients
   * can reauthorize without having to forget and recreate the connector.
   */
  reconcileOwnerCredential(input: OwnerCredentialReconciliationInput): {
    changed: boolean;
    passwordHash: string;
    upgraded: boolean;
  } {
    const reconcile = this.database.sqlite.transaction(() => {
      const row = this.database.sqlite
        .prepare("select salt, verifier from oauth_owner_credential where id = 1")
        .get() as { salt: string; verifier: string } | undefined;

      if (!row) {
        const passwordHash = activeOwnerPasswordHash(input);
        this.saveOwnerCredentialHash(passwordHash);
        return { changed: false, passwordHash, upgraded: false };
      }

      if (isArgon2idHash(row.verifier)) {
        const matches = input.passwordHash === row.verifier || (
          input.password !== undefined && verifyOwnerPassword(row.verifier, input.password)
        );
        if (matches) {
          return { changed: false, passwordHash: row.verifier, upgraded: false };
        }
      } else {
        const legacySecret = input.password ?? input.legacyVerifierSecret;
        const legacyVerifierMatches = legacySecret !== undefined && verifiersEqual(
          deriveOwnerCredentialVerifier(legacySecret, row.salt),
          row.verifier,
        );
        const declaredHashMatches = input.passwordHash === undefined || (
          legacySecret !== undefined && verifyOwnerPassword(input.passwordHash, legacySecret)
        );
        if (legacyVerifierMatches && declaredHashMatches) {
          const passwordHash = input.passwordHash ?? (
            typeof legacySecret === "string"
              ? hashOwnerPassword(legacySecret)
              : undefined
          );
          if (!passwordHash) {
            throw new Error("Legacy Owner credential upgrade requires an Argon2id hash.");
          }
          this.saveOwnerCredentialHash(passwordHash);
          return { changed: false, passwordHash, upgraded: true };
        }
      }

      this.database.sqlite.prepare("delete from oauth_access_tokens").run();
      this.database.sqlite.prepare("delete from oauth_refresh_tokens").run();
      this.database.sqlite.prepare("delete from oauth_authorization_codes").run();
      this.database.sqlite.prepare("delete from oauth_authorization_selections").run();
      const passwordHash = activeOwnerPasswordHash(input);
      this.saveOwnerCredentialHash(passwordHash);
      return { changed: true, passwordHash, upgraded: false };
    });

    return reconcile.immediate();
  }

  revokeAll(): OAuthRevocationCounts {
    const revoke = this.database.sqlite.transaction(() => {
      const counts = this.diagnosticSnapshot();
      const now = new Date().toISOString();
      this.database.sqlite.prepare(`
        insert into oauth_revocation_cleanup_jobs (
          connection_principal_id, workspace_id, workspace_root, status,
          claim_token, lease_expires_at, attempts, last_error, created_at,
          updated_at, completed_at
        )
        select
          workspace.connection_principal_id,
          workspace.id,
          workspace.root,
          'pending',
          null,
          null,
          0,
          null,
          @now,
          @now,
          null
        from workspace_sessions as workspace
        where workspace.connection_principal_id in (
          select principal_id from oauth_grants
        )
          and workspace.status in ('active', 'closed')
        on conflict(connection_principal_id, workspace_id) do nothing
      `).run({ now });
      const revokedAuthorizations = this.database.sqlite.prepare(`
        select
          principal_id as principalId,
          grant_id as grantId,
          authorization_epoch as authorizationEpoch
        from oauth_grants
        where revoked_at is null
        order by created_at, grant_id
      `).all() as OAuthAuthorizationTuple[];
      this.revokeProjectExecutions(
        revokedAuthorizations,
        "All OAuth credentials were revoked.",
        now,
      );
      this.database.sqlite.prepare(`
        update workspace_sessions
        set status = 'revoked',
            state_generation = state_generation + 1,
            last_used_at = @now
        where status in ('active', 'closed')
          and connection_principal_id in (select principal_id from oauth_grants)
      `).run({ now });
      this.database.sqlite.prepare(`
        update connection_principals
        set last_used_at = @now
        where principal_id = @ownerPrincipalId
      `).run({ now, ownerPrincipalId: OWNER_PRINCIPAL_ID });
      this.database.sqlite.prepare(`
        update oauth_grants
        set revoked_at = @now, last_used_at = @now,
            authorization_epoch = authorization_epoch + 1
        where revoked_at is null
      `).run({ now });
      this.database.sqlite.prepare("delete from oauth_access_tokens").run();
      this.database.sqlite.prepare("delete from oauth_refresh_tokens").run();
      this.database.sqlite.prepare("delete from oauth_refresh_token_tombstones").run();
      this.database.sqlite.prepare("delete from oauth_clients").run();
      const workspaceCleanupJobs = this.database.sqlite.prepare(`
        select count(*) as count
        from oauth_revocation_cleanup_jobs
        where status != 'completed'
      `).get() as { count: number };
      return {
        clients: counts.clients,
        grants: counts.grants,
        accessTokens: counts.accessTokens,
        refreshTokens: counts.refreshTokens,
        workspaceCleanupJobs: workspaceCleanupJobs.count,
      };
    });
    return revoke.immediate();
  }

  diagnosticSnapshot(nowSeconds = Math.floor(Date.now() / 1000)): OAuthDiagnosticSnapshot {
    const row = this.database.sqlite.prepare(`
      select
        (select count(*) from oauth_clients) as clients,
        (select count(*) from oauth_grants
          where revoked_at is null
            and (absolute_expires_at is null or absolute_expires_at > @nowSeconds)) as grants,
        (select count(*) from connection_principals where revoked_at is null) as principals,
        (select count(*) from oauth_access_tokens) as accessTokens,
        (select count(*) from oauth_refresh_tokens) as refreshTokens,
        (select count(*) from oauth_revocation_cleanup_jobs where status != 'completed') as workspaceCleanupJobs,
        (select count(*) from oauth_access_tokens where expires_at < @nowSeconds) as expiredAccessTokens,
        (select count(*) from oauth_refresh_tokens where expires_at < @nowSeconds) as expiredRefreshTokens,
        (select count(*)
          from oauth_grants as grant
          where grant.revoked_at is null
            and (grant.absolute_expires_at is null or grant.absolute_expires_at > @nowSeconds)
            and exists (
              select 1 from json_each(grant.allowed_root_ids_json) where value = '*'
            )) as legacyWildcardGrants
    `).get({ nowSeconds }) as OAuthDiagnosticSnapshot;
    return row;
  }

  cleanupExpired(nowSeconds = Math.floor(Date.now() / 1000)): OAuthCleanupCounts {
    const nowMs = nowSeconds * 1_000;
    const cleanup = this.database.sqlite.transaction(() => {
      const nowIso = new Date(nowMs).toISOString();
      const revokedAuthorizations = this.database.sqlite.prepare(`
        select
          principal_id as principalId,
          grant_id as grantId,
          authorization_epoch as authorizationEpoch
        from oauth_grants
        where revoked_at is null
          and absolute_expires_at is not null
          and absolute_expires_at <= @nowSeconds
        order by created_at, grant_id
      `).all({ nowSeconds }) as OAuthAuthorizationTuple[];
      const authorizationCleanup = this.revokeProjectExecutions(
        revokedAuthorizations,
        "The OAuth authorization expired.",
        nowIso,
      );
      this.database.sqlite.prepare(`
        update oauth_grants
        set revoked_at = @nowIso,
            last_used_at = @nowIso,
            authorization_epoch = authorization_epoch + 1
        where revoked_at is null
          and absolute_expires_at is not null
          and absolute_expires_at <= @nowSeconds
      `).run({ nowIso, nowSeconds });
      const accessTokens = this.database.sqlite.prepare(`
        delete from oauth_access_tokens
        where expires_at < @nowSeconds
           or exists (
             select 1 from oauth_grants as grant
             where grant.grant_id = oauth_access_tokens.grant_id
               and grant.revoked_at is not null
           )
      `).run({ nowSeconds }).changes;
      const refreshTokens = this.database.sqlite.prepare(`
        delete from oauth_refresh_tokens
        where expires_at < @nowSeconds
           or exists (
             select 1 from oauth_grants as grant
             where grant.grant_id = oauth_refresh_tokens.grant_id
               and grant.revoked_at is not null
           )
      `).run({ nowSeconds }).changes;
      this.database.sqlite.prepare(
        "delete from oauth_refresh_token_tombstones where expires_at <= ?",
      ).run(nowSeconds);
      const authorizationLimits = this.database.sqlite
        .prepare("delete from oauth_authorization_limits where expires_at <= ?")
        .run(nowMs).changes;
      const authorizationSelections = this.database.sqlite
        .prepare("delete from oauth_authorization_selections where expires_at <= ?")
        .run(nowMs).changes;
      const authorizationCodes = this.database.sqlite
        .prepare("delete from oauth_authorization_codes where expires_at <= ?")
        .run(nowMs).changes;
      const unapprovedClients = this.cleanupExpiredUnapprovedClients(nowSeconds);
      const staleGrants = this.database.sqlite.prepare(`
        delete from oauth_grants
        where grant_id in (
          select grant.grant_id
          from oauth_grants as grant
          where grant.created_at < ?
            and not exists (
              select 1 from oauth_access_tokens as token
              where token.grant_id = grant.grant_id
            )
            and not exists (
              select 1 from oauth_refresh_tokens as token
              where token.grant_id = grant.grant_id
            )
            and not exists (
              select 1 from project_executions as execution
              where execution.grant_id = grant.grant_id
                and execution.status in ('provisioning', 'active')
            )
          order by grant.created_at, grant.grant_id
          limit 1000
        )
      `).run(new Date(nowMs - PENDING_OAUTH_CLIENT_TTL_SECONDS * 1_000).toISOString()).changes;
      return {
        accessTokens,
        refreshTokens,
        authorizationLimits,
        authorizationSelections,
        authorizationCodes,
        unapprovedClients,
        staleGrants,
        authorizationCleanup,
      };
    });
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

  private revokeProjectExecutions(
    revokedAuthorizations: readonly OAuthAuthorizationTuple[],
    error: string,
    now: string,
  ): OAuthAuthorizationCleanupResult {
    const revokedExecutions: OAuthRevokedProjectExecution[] = [];
    const cleanupById = new Map<number, OAuthQueuedWorkspaceCleanupJob>();
    for (const authorization of revokedAuthorizations) {
      const rows = this.database.sqlite.prepare(`
        update project_executions
        set status = 'revoked',
            error = @error,
            state_generation = state_generation + 1,
            updated_at = @now
        where principal_id = @principalId
          and grant_id = @grantId
          and authorization_epoch = @authorizationEpoch
          and status in ('provisioning', 'active')
        returning
          execution_id as executionId,
          principal_id as principalId,
          client_id as clientId,
          grant_id as grantId,
          authorization_epoch as authorizationEpoch,
          workspace_id as workspaceId
      `).all({
        error,
        now,
        principalId: authorization.principalId,
        grantId: authorization.grantId,
        authorizationEpoch: authorization.authorizationEpoch,
      }) as Array<{
        executionId: string;
        principalId: string;
        clientId: string;
        grantId: string;
        authorizationEpoch: number;
        workspaceId: string | null;
      }>;
      for (const row of rows) {
        const workspace = row.workspaceId === null
          ? undefined
          : this.database.sqlite.prepare(`
              select root
              from workspace_sessions
              where id = ? and connection_principal_id = ?
            `).get(row.workspaceId, row.principalId) as { root: string } | undefined;
        revokedExecutions.push({
          executionId: row.executionId,
          principalId: row.principalId,
          clientId: row.clientId,
          grantId: row.grantId,
          authorizationEpoch: row.authorizationEpoch,
          ...(row.workspaceId === null ? {} : { workspaceId: row.workspaceId }),
          ...(workspace === undefined ? {} : { workspaceRoot: workspace.root }),
        });
        if (row.workspaceId === null || workspace === undefined) continue;
        const workspaceId = row.workspaceId;
        const cleanupRoot = workspace.root;
        this.database.sqlite.prepare(`
          update workspace_sessions
          set status = 'revoked',
              state_generation = state_generation + 1,
              last_used_at = @now
          where id = @workspaceId
            and connection_principal_id = @principalId
            and status in ('active', 'closed')
        `).run({
          workspaceId,
          principalId: row.principalId,
          now,
        });
        this.database.sqlite.prepare(`
          insert into oauth_revocation_cleanup_jobs (
            connection_principal_id, workspace_id, workspace_root,
            project_execution_id, status, claim_token, lease_expires_at,
            attempts, last_error, created_at, updated_at, completed_at
          ) values (
            @principalId, @workspaceId, @workspaceRoot,
            @executionId, 'pending', null, null,
            0, null, @now, @now, null
          )
          on conflict(connection_principal_id, workspace_id) do update set
            workspace_root = excluded.workspace_root,
            project_execution_id = excluded.project_execution_id,
            status = case
              when oauth_revocation_cleanup_jobs.status = 'completed' then 'pending'
              else oauth_revocation_cleanup_jobs.status
            end,
            claim_token = case
              when oauth_revocation_cleanup_jobs.status = 'completed' then null
              else oauth_revocation_cleanup_jobs.claim_token
            end,
            lease_expires_at = case
              when oauth_revocation_cleanup_jobs.status = 'completed' then null
              else oauth_revocation_cleanup_jobs.lease_expires_at
            end,
            attempts = case
              when oauth_revocation_cleanup_jobs.status = 'completed' then 0
              else oauth_revocation_cleanup_jobs.attempts
            end,
            last_error = case
              when oauth_revocation_cleanup_jobs.status = 'completed' then null
              else oauth_revocation_cleanup_jobs.last_error
            end,
            updated_at = excluded.updated_at,
            completed_at = null
        `).run({
          principalId: row.principalId,
          workspaceId,
          workspaceRoot: cleanupRoot,
          executionId: row.executionId,
          now,
        });
        const job = this.database.sqlite.prepare(`
          select id
          from oauth_revocation_cleanup_jobs
          where connection_principal_id = ? and workspace_id = ?
        `).get(row.principalId, workspaceId) as { id: number };
        cleanupById.set(job.id, {
          id: job.id,
          projectExecutionId: row.executionId,
          workspaceId,
          workspaceRoot: cleanupRoot,
        });
      }
    }
    return {
      revokedAuthorizations: [...revokedAuthorizations],
      revokedExecutions,
      workspaceCleanupJobs: [...cleanupById.values()],
    };
  }

  private saveOwnerCredentialHash(passwordHash: string): void {
    if (!isArgon2idHash(passwordHash)) {
      throw new TypeError("Owner credential must use Argon2id.");
    }
    this.database.sqlite.prepare(`
      insert into oauth_owner_credential (id, salt, verifier, updated_at)
      values (1, ?, ?, ?)
      on conflict(id) do update set
        salt = excluded.salt,
        verifier = excluded.verifier,
        updated_at = excluded.updated_at
    `).run("argon2id-v1", passwordHash, new Date().toISOString());
  }

  private resolveTokenGrant<T extends PersistedAccessTokenRecord | PersistedRefreshTokenRecord>(
    record: T,
  ): T & Required<Pick<T, "grantId" | "principalId" | "authorizationEpoch">> {
    const scopes = normalizeGrantScopes(record.scopes);
    const rows = this.database.sqlite.prepare(`
      select
        grant.grant_id as grantId,
        grant.client_id as clientId,
        grant.principal_id as principalId,
        grant.granted_scopes_json as grantedScopesJson,
        grant.allowed_root_ids_json as allowedRootIdsJson,
        grant.authorization_epoch as authorizationEpoch,
        grant.absolute_expires_at as absoluteExpiresAt,
        grant.created_at as createdAt,
        grant.last_used_at as lastUsedAt,
        grant.revoked_at as revokedAt
      from oauth_grants as grant
      inner join connection_principals as principal
        on principal.principal_id = grant.principal_id
      where grant.client_id = @clientId
        and grant.revoked_at is null
        and (grant.absolute_expires_at is null or grant.absolute_expires_at > cast(strftime('%s','now') as integer))
        and principal.revoked_at is null
        and (@grantId is null or grant.grant_id = @grantId)
      order by grant.last_used_at desc
      limit 2
    `).all({ clientId: record.clientId, grantId: record.grantId ?? null }) as OAuthGrantRow[];
    if (rows.length !== 1) {
      throw new InvalidRequestError(
        "OAuth token issuance requires one explicit or unambiguous active authorization grant",
      );
    }
    const grant = rowToOAuthGrantRecord(rows[0]!);
    if (
      (record.principalId !== undefined && record.principalId !== grant.principalId) ||
      (record.authorizationEpoch !== undefined &&
        record.authorizationEpoch !== grant.authorizationEpoch) ||
      scopes.some((scope) => !grant.grantedScopes.includes(scope))
    ) {
      throw new InvalidRequestError("OAuth token fields do not match the authorization grant");
    }
    return {
      ...record,
      grantId: grant.grantId,
      principalId: grant.principalId,
      authorizationEpoch: grant.authorizationEpoch,
      scopes,
    } as T & Required<Pick<T, "grantId" | "principalId" | "authorizationEpoch">>;
  }

  private cleanupExpiredUnapprovedClients(nowSeconds: number): number {
    return this.database.sqlite.prepare(`
      delete from oauth_clients
      where issued_at < ?
        and not exists (
          select 1 from oauth_grants as grant
          where grant.client_id = oauth_clients.client_id
        )
    `).run(nowSeconds - PENDING_OAUTH_CLIENT_TTL_SECONDS).changes;
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

function rowToAccessTokenRecord(row: OAuthTokenRow): PersistedAccessTokenRecord {
  return {
    grantId: row.grant_id,
    clientId: row.client_id,
    principalId: row.principal_id,
    authorizationEpoch: row.authorization_epoch,
    scopes: JSON.parse(row.scopes_json) as string[],
    expiresAt: row.expires_at,
    resource: row.resource ?? undefined,
  };
}

function rowToRefreshTokenRecord(row: OAuthRefreshTokenRow): PersistedRefreshTokenRecord {
  return {
    grantId: row.grant_id,
    clientId: row.client_id,
    principalId: row.principal_id,
    authorizationEpoch: row.authorization_epoch,
    familyId: row.family_id,
    scopes: JSON.parse(row.scopes_json) as string[],
    expiresAt: row.expires_at,
    resource: row.resource ?? undefined,
  };
}

function rowToRefreshTokenTombstone(
  row: OAuthRefreshTokenTombstoneRow,
): OAuthRefreshTokenTombstone {
  return {
    tokenHash: row.token_hash,
    familyId: row.family_id,
    grantId: row.grant_id,
    clientId: row.client_id,
    principalId: row.principal_id,
    authorizationEpoch: row.authorization_epoch,
    consumedAt: row.consumed_at,
    expiresAt: row.expires_at,
  };
}

function rowToAuthorizationCodeRecord(
  row: OAuthAuthorizationCodeRow,
): PersistedAuthorizationCodeRecord {
  return {
    clientId: row.clientId,
    grantId: row.grantId,
    principalId: row.principalId,
    authorizationEpoch: row.authorizationEpoch,
    redirectUri: row.redirectUri,
    codeChallenge: row.codeChallenge,
    scopes: normalizeGrantScopes(JSON.parse(row.scopesJson) as unknown),
    ...(row.resource ? { resource: row.resource } : {}),
    createdAtMs: row.createdAtMs,
    expiresAtMs: row.expiresAtMs,
  };
}

function rowToOAuthGrantRecord(row: OAuthGrantRow): OAuthGrantRecord {
  return {
    grantId: row.grantId,
    clientId: row.clientId,
    principalId: row.principalId,
    grantedScopes: normalizeGrantScopes(JSON.parse(row.grantedScopesJson) as unknown),
    allowedRootIds: normalizeAuthorizedRootIds(JSON.parse(row.allowedRootIdsJson) as unknown),
    authorizationEpoch: row.authorizationEpoch,
    ...(row.absoluteExpiresAt ? { absoluteExpiresAt: row.absoluteExpiresAt } : {}),
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
  };
}

function normalizeGrantScopes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidRequestError("OAuth grant scopes must be a non-empty array");
  }
  const requested = new Set(value);
  if (
    [...requested].some(
      (scope) => typeof scope !== "string" || !DEVSPACE_CAPABILITY_SCOPES.includes(scope as never),
    )
  ) {
    throw new InvalidRequestError("OAuth grant contains an unsupported scope");
  }
  return DEVSPACE_CAPABILITY_SCOPES.filter((scope) => requested.has(scope));
}

function assertOAuthArtifactTime(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new RangeError("OAuth authorization artifact time must be a non-negative safe integer.");
  }
}

function newRefreshFamilyId(): string {
  return `family-${randomBytes(32).toString("base64url")}`;
}

function normalizeRefreshFamilyId(value: string): string {
  if (typeof value !== "string" || value.length < 16 || value.length > 128) {
    throw new InvalidRequestError("OAuth refresh-token family identifier is invalid");
  }
  return value;
}

function deriveOwnerCredentialVerifier(
  ownerToken: string | Uint8Array,
  salt: string,
): string {
  return scryptSync(ownerToken, Buffer.from(salt, "base64url"), 32).toString("base64url");
}

function activeOwnerPasswordHash(input: OwnerCredentialInput): string {
  if (isArgon2idHash(input.passwordHash)) return input.passwordHash;
  if (input.password !== undefined) return hashOwnerPassword(input.password);
  throw new Error("Owner credential requires a password or Argon2id hash.");
}

function verifiersEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "base64url");
  const rightBytes = Buffer.from(right, "base64url");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
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
