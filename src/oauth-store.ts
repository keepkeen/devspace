import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidRequestError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
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
  reconnectCodes: number;
  authorizationLimits: number;
  unapprovedClients: number;
  orphanedGrants: number;
  revokedPrincipals: number;
}

export interface OAuthGrantRecord {
  grantId: string;
  clientId: string;
  principalId: string;
  subjectHash?: string;
  organizationHash?: string;
  grantedScopes: string[];
  allowedRootIds: string[];
  authorizationEpoch: number;
  absoluteExpiresAt?: number;
  createdAt: string;
  lastUsedAt: string;
  revokedAt?: string;
}

export interface OAuthGrantCreationResult extends OAuthGrantRecord {
  principalCreated: boolean;
  reconnected: boolean;
  principalReused: boolean;
}

export class OAuthGrantIdentityError extends Error {
  constructor(
    readonly code: "oauth_grant_invalid" | "host_identity_required" | "host_identity_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "OAuthGrantIdentityError";
  }
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

export interface PrincipalWorkspaceTransferPreview {
  sourcePrincipalId: string;
  targetPrincipalId: string;
  sourceClientCount: number;
  activeWorkspaces: number;
  closedWorkspaces: number;
  mutationOperations: number;
  aliasConflicts: string[];
  checkoutRootConflicts: string[];
  operationIdConflicts: string[];
  transferable: boolean;
}

export interface PrincipalWorkspaceTransferResult extends PrincipalWorkspaceTransferPreview {
  transferredWorkspaces: number;
  transferredOperations: number;
}

export interface OrphanPrincipalClosePreview {
  principalId: string;
  clientCount: number;
  activeWorkspaces: number;
  managedWorktrees: number;
  retainedWorkspaces: number;
  closable: boolean;
}

export interface OrphanPrincipalCloseResult extends OrphanPrincipalClosePreview {
  closedWorkspaces: number;
}

export interface ClientRelinkPreview {
  clientId: string;
  sourcePrincipalId?: string;
  targetPrincipalId: string;
  sourceRetainedWorkspaces: number;
  scopes: string[];
  allowedRootIds: string[];
  relinkable: boolean;
  changed: boolean;
}

export interface PrincipalAssignmentResult {
  principalId: string;
  created: boolean;
}

export class PrincipalReconnectError extends Error {
  constructor(
    readonly code:
      | "reconnect_code_invalid"
      | "reconnect_source_in_use"
      | "connection_principal_not_found"
      | "principal_not_orphaned"
      | "principal_transfer_conflict"
      | "oauth_client_not_found",
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
const PENDING_OAUTH_CLIENT_TTL_SECONDS = 60 * 60;
const MAX_PENDING_OAUTH_CLIENTS = 64;
const MAX_TOTAL_OAUTH_CLIENTS = 512;
const REFRESH_REPLAY_TOMBSTONE_TTL_SECONDS = 7 * 24 * 60 * 60;

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
  subjectHash: string | null;
  organizationHash: string | null;
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
    return { principalId: grant.principalId, created: grant.principalCreated };
  }

  createAuthorizationGrant(input: {
    clientId: string;
    scopes: string[];
    reconnectCode?: string;
    reusePrincipalId?: string;
    allowedRootIds?: string[];
    absoluteExpiresAt?: number;
  }): OAuthGrantCreationResult {
    const scopes = normalizeGrantScopes(input.scopes);
    const allowedRootIds = normalizeAuthorizedRootIds(
      input.allowedRootIds ?? [ALL_AUTHORIZED_ROOTS_ID],
    );
    if (input.reconnectCode && input.reusePrincipalId) {
      throw new InvalidRequestError("Choose either reconnect code or an existing principal, not both");
    }
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

      let principalId: string;
      let principalCreated = false;
      let reconnected = false;
      let principalReused = false;
      if (input.reconnectCode) {
        principalId = this.consumeReconnectCodeTarget(input.reconnectCode);
        reconnected = true;
      } else if (input.reusePrincipalId) {
        const existing = this.database.sqlite.prepare(`
          select principal_id as principalId
          from connection_principals
          where principal_id = ? and revoked_at is null
        `).get(input.reusePrincipalId) as { principalId: string } | undefined;
        if (!existing) {
          throw new PrincipalReconnectError(
            "connection_principal_not_found",
            "The selected local connection no longer exists.",
          );
        }
        principalId = existing.principalId;
        principalReused = true;
        const sourcePrincipals = this.database.sqlite.prepare(`
          select distinct principal_id as principalId
          from oauth_grants
          where client_id = ? and revoked_at is null
        `).all(input.clientId) as Array<{ principalId: string }>;
        for (const source of sourcePrincipals) {
          if (source.principalId === principalId) continue;
          const retained = (this.database.sqlite.prepare(`
            select count(*) as count
            from workspace_sessions
            where connection_principal_id = ? and status in ('active', 'closed')
          `).get(source.principalId) as { count: number }).count;
          if (retained > 0) {
            throw new PrincipalReconnectError(
              "reconnect_source_in_use",
              "This OAuth client already owns retained Workspaces under another local connection. Transfer or close them locally before reusing a different connection.",
            );
          }
        }
        if (sourcePrincipals.length > 0) {
          this.database.sqlite.prepare("delete from oauth_access_tokens where client_id = ?")
            .run(input.clientId);
          this.database.sqlite.prepare("delete from oauth_refresh_tokens where client_id = ?")
            .run(input.clientId);
          const revokedAt = new Date().toISOString();
          this.database.sqlite.prepare(`
            update oauth_grants
            set revoked_at = ?, last_used_at = ?, authorization_epoch = authorization_epoch + 1
            where client_id = ? and revoked_at is null
          `).run(revokedAt, revokedAt, input.clientId);
        }
      } else {
        principalId = `principal-${randomUUID()}`;
        const principalNow = new Date().toISOString();
        this.database.sqlite.prepare(`
          insert into connection_principals (
            principal_id, created_at, last_used_at, revoked_at
          ) values (?, ?, ?, null)
        `).run(principalId, principalNow, principalNow);
        principalCreated = true;
      }

      const now = new Date().toISOString();
      const grantId = `grant-${randomUUID()}`;
      this.database.sqlite.prepare(`
        insert into oauth_grants (
          grant_id, client_id, principal_id, subject_hash, organization_hash,
          granted_scopes_json, allowed_root_ids_json, authorization_epoch, absolute_expires_at,
          created_at, last_used_at, revoked_at
        ) values (?, ?, ?, null, null, ?, ?, 1, ?, ?, ?, null)
      `).run(
        grantId,
        input.clientId,
        principalId,
        JSON.stringify(scopes),
        JSON.stringify(allowedRootIds),
        input.absoluteExpiresAt ?? null,
        now,
        now,
      );
      this.touchPrincipal(principalId);
      return {
        grantId,
        clientId: input.clientId,
        principalId,
        grantedScopes: scopes,
        allowedRootIds,
        authorizationEpoch: 1,
        ...(input.absoluteExpiresAt ? { absoluteExpiresAt: input.absoluteExpiresAt } : {}),
        createdAt: now,
        lastUsedAt: now,
        principalCreated,
        reconnected,
        principalReused,
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
        grant.subject_hash as subjectHash,
        grant.organization_hash as organizationHash,
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
      where grant.grant_id = ?
        and grant.revoked_at is null
        and (grant.absolute_expires_at is null or grant.absolute_expires_at > cast(strftime('%s','now') as integer))
        and principal.revoked_at is null
    `).get(grantId) as OAuthGrantRow | undefined;
    return row ? rowToOAuthGrantRecord(row) : undefined;
  }

  bindOrValidateGrantHostIdentity(input: {
    grantId: string;
    clientId: string;
    authorizationEpoch: number;
    subjectHash?: string;
    organizationHash?: string;
    requireSubject?: boolean;
  }): OAuthGrantRecord {
    const bind = this.database.sqlite.transaction(() => {
      const grant = this.getAuthorizationGrant(input.grantId);
      if (
        !grant ||
        grant.clientId !== input.clientId ||
        grant.authorizationEpoch !== input.authorizationEpoch
      ) {
        throw new OAuthGrantIdentityError("oauth_grant_invalid", "The OAuth grant is no longer active.");
      }
      if (grant.subjectHash && input.requireSubject === true && !input.subjectHash) {
        throw new OAuthGrantIdentityError(
          "host_identity_required",
          "This OAuth grant requires the previously bound host subject.",
        );
      }
      if (
        grant.subjectHash &&
        input.subjectHash &&
        grant.subjectHash !== input.subjectHash
      ) {
        throw new OAuthGrantIdentityError(
          "host_identity_mismatch",
          "The host subject does not match this OAuth grant.",
        );
      }
      if (
        grant.organizationHash &&
        input.organizationHash &&
        grant.organizationHash !== input.organizationHash
      ) {
        throw new OAuthGrantIdentityError(
          "host_identity_mismatch",
          "The host organization does not match this OAuth grant.",
        );
      }
      const subjectHash = grant.subjectHash ?? input.subjectHash;
      const organizationHash = grant.organizationHash ?? input.organizationHash;
      const now = new Date().toISOString();
      this.database.sqlite.prepare(`
        update oauth_grants
        set subject_hash = ?, organization_hash = ?, last_used_at = ?
        where grant_id = ? and authorization_epoch = ? and revoked_at is null
      `).run(
        subjectHash ?? null,
        organizationHash ?? null,
        now,
        grant.grantId,
        grant.authorizationEpoch,
      );
      this.touchPrincipal(grant.principalId);
      return {
        ...grant,
        ...(subjectHash ? { subjectHash } : {}),
        ...(organizationHash ? { organizationHash } : {}),
        lastUsedAt: now,
      };
    });
    return bind.immediate();
  }

  listConnectionPrincipals(): ConnectionPrincipalSummary[] {
    const principals = this.database.sqlite.prepare(`
      select
        principal.principal_id as principalId,
        principal.created_at as createdAt,
        principal.last_used_at as lastUsedAt,
        (select count(distinct grant.client_id) from oauth_grants as grant
          where grant.principal_id = principal.principal_id
            and grant.revoked_at is null) as clientCount,
        (select count(*) from workspace_sessions as workspace
          where workspace.connection_principal_id = principal.principal_id
            and workspace.status = 'active') as activeWorkspaces,
        (select count(*) from workspace_sessions as workspace
          where workspace.connection_principal_id = principal.principal_id
            and workspace.status in ('active', 'closed')) as retainedWorkspaces
      from connection_principals as principal
      where principal.revoked_at is null
      order by principal.last_used_at desc, principal.principal_id
    `).all() as Array<Omit<ConnectionPrincipalSummary, "aliases">>;
    const aliases = this.database.sqlite.prepare(`
      select alias
      from workspace_sessions
      where connection_principal_id = ? and status in ('active', 'closed') and alias is not null
      order by last_used_at desc, alias
      limit 20
    `);
    return principals.map((principal) => ({
      ...principal,
      aliases: (aliases.all(principal.principalId) as Array<{ alias: string }>).map(({ alias }) => alias),
    }));
  }

  previewWorkspaceTransfer(
    sourcePrincipalId: string,
    targetPrincipalId: string,
  ): PrincipalWorkspaceTransferPreview {
    const source = this.requirePrincipalSummary(sourcePrincipalId);
    this.requirePrincipalSummary(targetPrincipalId);
    if (sourcePrincipalId === targetPrincipalId) {
      throw new PrincipalReconnectError(
        "principal_transfer_conflict",
        "Source and target connection principals must be different.",
      );
    }
    const counts = this.database.sqlite.prepare(`
      select
        count(*) filter (where status = 'active') as activeWorkspaces,
        count(*) filter (where status = 'closed') as closedWorkspaces
      from workspace_sessions
      where connection_principal_id = ? and status in ('active', 'closed')
    `).get(sourcePrincipalId) as { activeWorkspaces: number; closedWorkspaces: number };
    const mutationOperations = (this.database.sqlite.prepare(`
      select count(*) as count
      from mutation_operations
      where connection_principal_id = ?
    `).get(sourcePrincipalId) as { count: number }).count;
    const aliasConflicts = (this.database.sqlite.prepare(`
      select source.alias
      from workspace_sessions as source
      inner join workspace_sessions as target
        on target.connection_principal_id = @targetPrincipalId
       and target.alias = source.alias
      where source.connection_principal_id = @sourcePrincipalId
        and source.status in ('active', 'closed')
      order by source.alias
    `).all({ sourcePrincipalId, targetPrincipalId }) as Array<{ alias: string }>).map(({ alias }) => alias);
    const checkoutRootConflicts = (this.database.sqlite.prepare(`
      select source.canonical_root as canonicalRoot
      from workspace_sessions as source
      inner join workspace_sessions as target
        on target.connection_principal_id = @targetPrincipalId
       and target.status = 'active'
       and target.mode = 'checkout'
       and target.canonical_root = source.canonical_root
      where source.connection_principal_id = @sourcePrincipalId
        and source.status = 'active'
        and source.mode = 'checkout'
        and source.canonical_root is not null
      order by source.canonical_root
    `).all({ sourcePrincipalId, targetPrincipalId }) as Array<{ canonicalRoot: string }>).map(
      ({ canonicalRoot }) => canonicalRoot,
    );
    const operationIdConflicts = (this.database.sqlite.prepare(`
      select source.operation_id as operationId
      from mutation_operations as source
      inner join mutation_operations as target
        on target.connection_principal_id = @targetPrincipalId
       and target.operation_id = source.operation_id
      where source.connection_principal_id = @sourcePrincipalId
      order by source.operation_id
    `).all({ sourcePrincipalId, targetPrincipalId }) as Array<{ operationId: string }>).map(
      ({ operationId }) => operationId,
    );
    return {
      sourcePrincipalId,
      targetPrincipalId,
      sourceClientCount: source.clientCount,
      activeWorkspaces: counts.activeWorkspaces,
      closedWorkspaces: counts.closedWorkspaces,
      mutationOperations,
      aliasConflicts,
      checkoutRootConflicts,
      operationIdConflicts,
      transferable: source.clientCount === 0 &&
        aliasConflicts.length === 0 &&
        checkoutRootConflicts.length === 0 &&
        operationIdConflicts.length === 0,
    };
  }

  transferPrincipalWorkspaces(
    sourcePrincipalId: string,
    targetPrincipalId: string,
  ): PrincipalWorkspaceTransferResult {
    const transfer = this.database.sqlite.transaction(() => {
      const preview = this.previewWorkspaceTransfer(sourcePrincipalId, targetPrincipalId);
      if (preview.sourceClientCount !== 0) {
        throw new PrincipalReconnectError(
          "principal_not_orphaned",
          "Workspace transfer is allowed only from a principal with no active OAuth client.",
        );
      }
      if (!preview.transferable) {
        throw new PrincipalReconnectError(
          "principal_transfer_conflict",
          "Workspace transfer has alias, checkout-root, or operation-ID conflicts.",
        );
      }
      this.database.sqlite.pragma("defer_foreign_keys = ON");
      const transferredOperations = this.database.sqlite.prepare(`
        update mutation_operations
        set connection_principal_id = ?
        where connection_principal_id = ?
      `).run(targetPrincipalId, sourcePrincipalId).changes;
      this.database.sqlite.prepare(`
        update oauth_revocation_cleanup_jobs
        set connection_principal_id = ?
        where connection_principal_id = ?
      `).run(targetPrincipalId, sourcePrincipalId);
      this.database.sqlite.prepare(`
        update oauth_revocation_dirty_worktree_artifacts
        set connection_principal_id = ?
        where connection_principal_id = ?
      `).run(targetPrincipalId, sourcePrincipalId);
      const transferredWorkspaces = this.database.sqlite.prepare(`
        update workspace_sessions
        set connection_principal_id = ?, last_used_at = ?
        where connection_principal_id = ? and status in ('active', 'closed')
      `).run(targetPrincipalId, new Date().toISOString(), sourcePrincipalId).changes;
      this.touchPrincipal(targetPrincipalId);
      return {
        ...preview,
        transferredWorkspaces,
        transferredOperations,
      };
    });
    return transfer.immediate();
  }

  previewOrphanClose(principalId: string): OrphanPrincipalClosePreview {
    const principal = this.requirePrincipalSummary(principalId);
    const row = this.database.sqlite.prepare(`
      select
        count(*) filter (where status = 'active') as activeWorkspaces,
        count(*) filter (where status in ('active', 'closed')) as retainedWorkspaces,
        count(*) filter (
          where status = 'active' and mode = 'worktree' and managed = 'true'
        ) as managedWorktrees
      from workspace_sessions
      where connection_principal_id = ?
    `).get(principalId) as {
      activeWorkspaces: number;
      retainedWorkspaces: number;
      managedWorktrees: number;
    };
    return {
      principalId,
      clientCount: principal.clientCount,
      activeWorkspaces: row.activeWorkspaces,
      managedWorktrees: row.managedWorktrees,
      retainedWorkspaces: row.retainedWorkspaces,
      closable: principal.clientCount === 0,
    };
  }

  closeOrphanPrincipal(principalId: string): OrphanPrincipalCloseResult {
    const close = this.database.sqlite.transaction(() => {
      const preview = this.previewOrphanClose(principalId);
      if (!preview.closable) {
        throw new PrincipalReconnectError(
          "principal_not_orphaned",
          "Only a principal with no active OAuth client can be closed as an orphan.",
        );
      }
      const closedWorkspaces = this.database.sqlite.prepare(`
        update workspace_sessions
        set status = 'closed', last_used_at = ?
        where connection_principal_id = ? and status = 'active'
      `).run(new Date().toISOString(), principalId).changes;
      return { ...preview, closedWorkspaces };
    });
    return close.immediate();
  }

  previewClientRelink(clientId: string, targetPrincipalId: string): ClientRelinkPreview {
    if (!this.getClient(clientId)) {
      throw new PrincipalReconnectError("oauth_client_not_found", "The OAuth client does not exist.");
    }
    this.requirePrincipalSummary(targetPrincipalId);
    const grants = this.database.sqlite.prepare(`
      select
        principal_id as principalId,
        granted_scopes_json as scopesJson,
        allowed_root_ids_json as rootIdsJson
      from oauth_grants
      where client_id = ? and revoked_at is null
      order by last_used_at desc
    `).all(clientId) as Array<{
      principalId: string;
      scopesJson: string;
      rootIdsJson: string;
    }>;
    const sourcePrincipalId = grants.length === 1 ? grants[0]!.principalId : undefined;
    const sourceRetainedWorkspaces = sourcePrincipalId && sourcePrincipalId !== targetPrincipalId
      ? (this.database.sqlite.prepare(`
          select count(*) as count from workspace_sessions
          where connection_principal_id = ? and status in ('active', 'closed')
        `).get(sourcePrincipalId) as { count: number }).count
      : 0;
    const current = grants[0];
    return {
      clientId,
      ...(sourcePrincipalId ? { sourcePrincipalId } : {}),
      targetPrincipalId,
      sourceRetainedWorkspaces,
      scopes: current
        ? normalizeGrantScopes(JSON.parse(current.scopesJson) as unknown)
        : [...DEVSPACE_CAPABILITY_SCOPES],
      allowedRootIds: current
        ? normalizeAuthorizedRootIds(JSON.parse(current.rootIdsJson) as unknown)
        : [ALL_AUTHORIZED_ROOTS_ID],
      relinkable: sourceRetainedWorkspaces === 0,
      changed: sourcePrincipalId !== targetPrincipalId,
    };
  }

  relinkClientToPrincipal(clientId: string, targetPrincipalId: string): PrincipalLinkResult {
    const relink = this.database.sqlite.transaction(() => {
      const preview = this.previewClientRelink(clientId, targetPrincipalId);
      if (!preview.relinkable) {
        throw new PrincipalReconnectError(
          "reconnect_source_in_use",
          "Transfer or close the source principal's retained Workspaces before relinking this client.",
        );
      }
      if (!preview.changed) {
        return {
          clientId,
          ...(preview.sourcePrincipalId ? { sourcePrincipalId: preview.sourcePrincipalId } : {}),
          targetPrincipalId,
          changed: false,
        };
      }
      this.database.sqlite.prepare("delete from oauth_access_tokens where client_id = ?").run(clientId);
      this.database.sqlite.prepare("delete from oauth_refresh_tokens where client_id = ?").run(clientId);
      const now = new Date().toISOString();
      this.database.sqlite.prepare(`
        update oauth_grants
        set revoked_at = ?, last_used_at = ?, authorization_epoch = authorization_epoch + 1
        where client_id = ? and revoked_at is null
      `).run(now, now, clientId);
      this.database.sqlite.prepare(`
        insert into oauth_grants (
          grant_id, client_id, principal_id, subject_hash, organization_hash,
          granted_scopes_json, allowed_root_ids_json, authorization_epoch,
          created_at, last_used_at, revoked_at
        ) values (?, ?, ?, null, null, ?, ?, 1, ?, ?, null)
      `).run(
        `grant-${randomUUID()}`,
        clientId,
        targetPrincipalId,
        JSON.stringify(preview.scopes),
        JSON.stringify(preview.allowedRootIds),
        now,
        now,
      );
      this.touchPrincipal(targetPrincipalId);
      return {
        clientId,
        ...(preview.sourcePrincipalId ? { sourcePrincipalId: preview.sourcePrincipalId } : {}),
        targetPrincipalId,
        changed: true,
      };
    });
    return relink.immediate();
  }

  private requirePrincipalSummary(principalId: string): ConnectionPrincipalSummary {
    const principal = this.listConnectionPrincipals().find(
      (candidate) => candidate.principalId === principalId,
    );
    if (!principal) {
      throw new PrincipalReconnectError(
        "connection_principal_not_found",
        "The connection principal does not exist or has been revoked.",
      );
    }
    return principal;
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
    const consume = this.database.sqlite.transaction(() => {
      const client = this.database.sqlite.prepare(
        "select client_id from oauth_clients where client_id = ?",
      ).get(clientId);
      if (!client) {
        throw new PrincipalReconnectError("reconnect_code_invalid", "The reconnect code is invalid or expired.");
      }
      const sourcePrincipals = this.database.sqlite.prepare(`
        select distinct principal_id as principalId
        from oauth_grants
        where client_id = ? and revoked_at is null
      `).all(clientId) as Array<{ principalId: string }>;
      const sourcePrincipalId = sourcePrincipals.length === 1
        ? sourcePrincipals[0]!.principalId
        : undefined;
      const targetPrincipalId = this.consumeReconnectCodeTarget(code);
      if (sourcePrincipalId && sourcePrincipalId !== targetPrincipalId) {
        const sourceUsage = this.database.sqlite.prepare(`
          select
            (select count(*) from oauth_grants
              where principal_id = @principalId and revoked_at is null) as grants,
            (select count(*) from workspace_sessions
              where connection_principal_id = @principalId) as workspaces
        `).get({ principalId: sourcePrincipalId }) as { grants: number; workspaces: number };
        if (sourceUsage.grants !== sourcePrincipals.length || sourceUsage.workspaces !== 0) {
          throw new PrincipalReconnectError(
            "reconnect_source_in_use",
            "This OAuth registration already owns retained state and cannot be relinked.",
          );
        }
      }
      this.database.sqlite
        .prepare("delete from oauth_access_tokens where client_id = ?")
        .run(clientId);
      this.database.sqlite
        .prepare("delete from oauth_refresh_tokens where client_id = ?")
        .run(clientId);
      const now = new Date().toISOString();
      this.database.sqlite.prepare(`
        update oauth_grants
        set revoked_at = ?, last_used_at = ?
        where client_id = ? and revoked_at is null
      `).run(now, now, clientId);
      this.database.sqlite.prepare(`
        insert into oauth_grants (
          grant_id, client_id, principal_id, subject_hash, organization_hash,
          granted_scopes_json, allowed_root_ids_json, authorization_epoch,
          created_at, last_used_at, revoked_at
        ) values (?, ?, ?, null, null, ?, ?, 1, ?, ?, null)
      `).run(
        `grant-${randomUUID()}`,
        clientId,
        targetPrincipalId,
        JSON.stringify([...DEVSPACE_CAPABILITY_SCOPES]),
        JSON.stringify([ALL_AUTHORIZED_ROOTS_ID]),
        now,
        now,
      );
      this.touchPrincipal(targetPrincipalId);
      if (sourcePrincipalId && sourcePrincipalId !== targetPrincipalId) {
        this.database.sqlite.prepare(`
          delete from oauth_grants
          where principal_id = ?
            and revoked_at is not null
            and not exists (
              select 1 from oauth_access_tokens as token
              where token.grant_id = oauth_grants.grant_id
            )
            and not exists (
              select 1 from oauth_refresh_tokens as token
              where token.grant_id = oauth_grants.grant_id
            )
        `).run(sourcePrincipalId);
        this.database.sqlite.prepare(`
          delete from connection_principals
          where principal_id = ?
            and not exists (
              select 1 from oauth_grants
              where principal_id = connection_principals.principal_id
                and revoked_at is null
            )
            and not exists (
              select 1 from workspace_sessions where connection_principal_id = connection_principals.principal_id
            )
        `).run(sourcePrincipalId);
      }
      return {
        clientId,
        ...(sourcePrincipalId ? { sourcePrincipalId } : {}),
        targetPrincipalId,
        changed: sourcePrincipalId !== targetPrincipalId,
      };
    });
    return consume.immediate();
  }

  private consumeReconnectCodeTarget(code: string): string {
    if (!code.startsWith(RECONNECT_CODE_PREFIX) || code.length > 128) {
      throw new PrincipalReconnectError("reconnect_code_invalid", "The reconnect code is invalid or expired.");
    }
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
    if (!target) {
      throw new PrincipalReconnectError("reconnect_code_invalid", "The reconnect code is invalid or expired.");
    }
    this.database.sqlite
      .prepare("delete from oauth_principal_reconnect_codes where code_hash = ?")
      .run(codeHash);
    return target.principalId;
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

  deleteAccessToken(tokenHash: string): void {
    this.database.sqlite.prepare("delete from oauth_access_tokens where token_hash = ?").run(tokenHash);
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
  ): { changed: boolean; connectionPrincipalId: string; grantId: string } {
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
        delete from oauth_refresh_tokens where grant_id = ? or family_id = ?
      `).run(tombstone.grantId, tombstone.familyId);
      return {
        changed: result.changes === 1,
        connectionPrincipalId: tombstone.principalId,
        grantId: tombstone.grantId,
      };
    });
    return revoke.immediate();
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
      const workspaceCleanupJobs = this.database.sqlite.prepare(`
        insert into oauth_revocation_cleanup_jobs (
          connection_principal_id, workspace_id, workspace_root, workspace_mode,
          source_root, managed, dirty_source, status, claim_token,
          lease_expires_at, attempts, last_error, created_at, updated_at,
          completed_at
        )
        select
          workspace.connection_principal_id,
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
        where workspace.connection_principal_id in (
          select principal_id from oauth_grants
        )
          and workspace.status in ('active', 'closed')
        on conflict(connection_principal_id, workspace_id) do nothing
      `).run({ now }).changes;
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
        set revoked_at = @now, last_used_at = @now
        where principal_id in (select principal_id from oauth_grants)
      `).run({ now });
      this.database.sqlite.prepare(`
        update oauth_grants
        set revoked_at = @now, last_used_at = @now,
            authorization_epoch = authorization_epoch + 1
        where revoked_at is null
      `).run({ now });
      this.database.sqlite.prepare("delete from oauth_principal_reconnect_codes").run();
      this.database.sqlite.prepare("delete from oauth_access_tokens").run();
      this.database.sqlite.prepare("delete from oauth_refresh_tokens").run();
      this.database.sqlite.prepare("delete from oauth_refresh_token_tombstones").run();
      this.database.sqlite.prepare("delete from oauth_clients").run();
      return {
        clients: counts.clients,
        grants: counts.grants,
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
          connection_principal_id, workspace_id, workspace_root, workspace_mode,
          source_root, managed, dirty_source, status, claim_token,
          lease_expires_at, attempts, last_error, created_at, updated_at,
          completed_at
        )
        select
          workspace.connection_principal_id,
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
          on principal.principal_id = workspace.connection_principal_id
        where workspace.status in ('active', 'closed')
          and principal.revoked_at is not null
        on conflict(connection_principal_id, workspace_id) do nothing
      `).run({ now }).changes;
      this.database.sqlite.prepare(`
        update workspace_sessions
        set status = 'revoked',
            state_generation = state_generation + 1,
            last_used_at = @now
        where status in ('active', 'closed')
          and connection_principal_id in (
            select principal_id from connection_principals where revoked_at is not null
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
      const reconnectCodes = this.cleanupExpiredReconnectCodes(nowMs);
      const authorizationLimits = this.database.sqlite
        .prepare("delete from oauth_authorization_limits where expires_at <= ?")
        .run(nowMs).changes;
      const unapprovedClients = this.cleanupExpiredUnapprovedClients(nowSeconds);
      const orphanedGrants = this.database.sqlite.prepare(`
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
          order by grant.created_at, grant.grant_id
          limit 1000
        )
      `).run(new Date(nowMs - PENDING_OAUTH_CLIENT_TTL_SECONDS * 1_000).toISOString()).changes;
      const revokedPrincipals = this.database.sqlite.prepare(`
        delete from connection_principals
        where principal_id in (
          select principal.principal_id
          from connection_principals as principal
          where principal.revoked_at is not null
            and not exists (
              select 1 from oauth_grants as grant
              where grant.principal_id = principal.principal_id
            )
            and not exists (
              select 1 from workspace_sessions as workspace
              where workspace.connection_principal_id = principal.principal_id
            )
            and not exists (
              select 1 from oauth_principal_reconnect_codes as reconnect
              where reconnect.principal_id = principal.principal_id
            )
          order by principal.last_used_at, principal.principal_id
          limit 1000
        )
      `).run().changes;
      return {
        accessTokens,
        refreshTokens,
        reconnectCodes,
        authorizationLimits,
        unapprovedClients,
        orphanedGrants,
        revokedPrincipals,
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
        grant.subject_hash as subjectHash,
        grant.organization_hash as organizationHash,
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

  private cleanupExpiredReconnectCodes(nowMs = Date.now()): number {
    return this.database.sqlite
      .prepare("delete from oauth_principal_reconnect_codes where expires_at <= ?")
      .run(nowMs).changes;
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

function rowToOAuthGrantRecord(row: OAuthGrantRow): OAuthGrantRecord {
  return {
    grantId: row.grantId,
    clientId: row.clientId,
    principalId: row.principalId,
    ...(row.subjectHash ? { subjectHash: row.subjectHash } : {}),
    ...(row.organizationHash ? { organizationHash: row.organizationHash } : {}),
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
