import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
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
}

export interface OAuthDiagnosticSnapshot extends OAuthRevocationCounts {
  expiredAccessTokens: number;
  expiredRefreshTokens: number;
}

export interface OAuthCleanupCounts {
  accessTokens: number;
  refreshTokens: number;
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

    this.database.sqlite
      .prepare("insert into oauth_clients (client_id, client_json, issued_at) values (?, ?, ?)")
      .run(registered.client_id, JSON.stringify(registered), now);

    return registered;
  }

  saveAccessToken(tokenHash: string, record: PersistedAccessTokenRecord): void {
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
      this.database.sqlite.prepare("delete from oauth_access_tokens").run();
      this.database.sqlite.prepare("delete from oauth_refresh_tokens").run();
      this.database.sqlite.prepare("delete from oauth_clients").run();
      return {
        clients: counts.clients,
        accessTokens: counts.accessTokens,
        refreshTokens: counts.refreshTokens,
      };
    });
    return revoke.immediate();
  }

  diagnosticSnapshot(nowSeconds = Math.floor(Date.now() / 1000)): OAuthDiagnosticSnapshot {
    const row = this.database.sqlite.prepare(`
      select
        (select count(*) from oauth_clients) as clients,
        (select count(*) from oauth_access_tokens) as accessTokens,
        (select count(*) from oauth_refresh_tokens) as refreshTokens,
        (select count(*) from oauth_access_tokens where expires_at < @nowSeconds) as expiredAccessTokens,
        (select count(*) from oauth_refresh_tokens where expires_at < @nowSeconds) as expiredRefreshTokens
    `).get({ nowSeconds }) as OAuthDiagnosticSnapshot;
    return row;
  }

  cleanupExpired(nowSeconds = Math.floor(Date.now() / 1000)): OAuthCleanupCounts {
    const cleanup = this.database.sqlite.transaction(() => ({
      accessTokens: this.database.sqlite
        .prepare("delete from oauth_access_tokens where expires_at < ?")
        .run(nowSeconds).changes,
      refreshTokens: this.database.sqlite
        .prepare("delete from oauth_refresh_tokens where expires_at < ?")
        .run(nowSeconds).changes,
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
