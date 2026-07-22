import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Response } from "express";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { databasePath, openDatabase } from "./db/client.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";

const root = await mkdtemp(join(tmpdir(), "devspace-oauth-test-"));
const oauthConfig = {
  ownerToken: "test-owner-token-that-is-long-enough",
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 2592000,
  scopes: ["devspace"],
  allowedRedirectHosts: ["chatgpt.com"],
};
const mcpUrl = new URL("https://agent.example.com/mcp");
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";

try {
  await testDatabaseConfiguration(join(root, "database-configuration"));
  testPersistenceAndTokenHashing(join(root, "persistence"));
  testExpiredTokenCleanup(join(root, "expiration"));
  testTransactionalTokenRotation(join(root, "rotation"));
  await testAuthorizationResponseHardening(join(root, "approval-headers"));
  await testProviderRestartRotationAndRevocation(join(root, "provider"));
  await testOwnerCredentialChangeAndRevokeAll(join(root, "owner-change"));
} finally {
  await rm(root, { recursive: true, force: true });
}

async function testDatabaseConfiguration(stateDir: string): Promise<void> {
  const database = openDatabase(stateDir);
  try {
    assert.equal(database.sqlite.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(database.sqlite.pragma("synchronous", { simple: true }), 1);
    assert.equal(database.sqlite.pragma("busy_timeout", { simple: true }), 5000);
    assert.equal(database.sqlite.pragma("foreign_keys", { simple: true }), 1);

    const migrations = database.sqlite
      .prepare("select version, name from devspace_schema_migrations order by version")
      .all();
    assert.deepEqual(migrations, [
      { version: 1, name: "workspace-state" },
      { version: 2, name: "oauth-state" },
      { version: 3, name: "local-agent-sessions" },
      { version: 4, name: "workspace-oauth-ownership" },
      { version: 5, name: "workspace-checkout-reuse" },
      { version: 6, name: "oauth-owner-credential" },
    ]);
  } finally {
    database.close();
  }

  if (process.platform !== "win32") {
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
    assert.equal((await stat(databasePath(stateDir))).mode & 0o777, 0o600);
  }
}

function testPersistenceAndTokenHashing(stateDir: string): void {
  const accessToken = "access-token-example";
  const refreshToken = "refresh-token-example";
  const firstStore = new SqliteOAuthStore(stateDir);
  const firstClients = new SqliteOAuthClientsStore(firstStore, oauthConfig.allowedRedirectHosts);
  const client = firstClients.registerClient({
    redirect_uris: [redirectUri],
    client_name: "ChatGPT",
  });

  firstStore.saveTokenPair({
    accessTokenHash: hashToken(accessToken),
    accessToken: {
      clientId: client.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      resource: mcpUrl.href,
    },
    refreshTokenHash: hashToken(refreshToken),
    refreshToken: {
      clientId: client.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 2592000,
      resource: mcpUrl.href,
    },
  });
  firstStore.close();

  const database = openDatabase(stateDir);
  try {
    const accessHashes = database.sqlite
      .prepare("select token_hash from oauth_access_tokens")
      .pluck()
      .all() as string[];
    const refreshHashes = database.sqlite
      .prepare("select token_hash from oauth_refresh_tokens")
      .pluck()
      .all() as string[];
    assert.deepEqual(accessHashes, [hashToken(accessToken)]);
    assert.deepEqual(refreshHashes, [hashToken(refreshToken)]);
    assert.equal(accessHashes.includes(accessToken), false);
    assert.equal(refreshHashes.includes(refreshToken), false);
  } finally {
    database.close();
  }

  const restoredStore = new SqliteOAuthStore(stateDir);
  try {
    const restoredClient = restoredStore.getClient(client.client_id);
    assert.equal(restoredClient?.client_id, client.client_id);
    assert.equal(restoredStore.getAccessToken(hashToken(accessToken))?.resource, mcpUrl.href);
    assert.equal(restoredStore.getRefreshToken(hashToken(refreshToken))?.clientId, client.client_id);
  } finally {
    restoredStore.close();
  }
}

function testExpiredTokenCleanup(stateDir: string): void {
  const store = new SqliteOAuthStore(stateDir);
  const client = new SqliteOAuthClientsStore(store, oauthConfig.allowedRedirectHosts).registerClient({
    redirect_uris: [redirectUri],
  });
  const expiredAt = Math.floor(Date.now() / 1000) - 1;
  store.saveTokenPair({
    accessTokenHash: "expired-access-hash",
    accessToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt: expiredAt },
    refreshTokenHash: "expired-refresh-hash",
    refreshToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt: expiredAt },
  });
  assert.deepEqual(store.diagnosticSnapshot(expiredAt + 1), {
    clients: 1,
    accessTokens: 1,
    refreshTokens: 1,
    expiredAccessTokens: 1,
    expiredRefreshTokens: 1,
  });
  assert.deepEqual(store.cleanupExpired(expiredAt + 1), {
    accessTokens: 1,
    refreshTokens: 1,
  });
  store.close();

  const reopened = new SqliteOAuthStore(stateDir);
  try {
    assert.equal(reopened.getAccessToken("expired-access-hash"), undefined);
    assert.equal(reopened.getRefreshToken("expired-refresh-hash"), undefined);
  } finally {
    reopened.close();
  }
}

async function testAuthorizationResponseHardening(stateDir: string): Promise<void> {
  const provider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  const client = await provider.clientsStore.registerClient?.({
    redirect_uris: [redirectUri],
    client_name: "<Unsafe client>",
  });
  assert.ok(client);
  const params = {
    redirectUri,
    codeChallenge: "challenge",
    scopes: ["devspace"],
    resource: mcpUrl,
  };

  try {
    for (const response of [
      fakeAuthorizationResponse("GET"),
      fakeAuthorizationResponse("POST", { owner_token: "wrong" }),
      fakeAuthorizationResponse("POST", { owner_token: oauthConfig.ownerToken }),
    ]) {
      await provider.authorize(client, params, response.response);
      assertAuthorizationHeaders(response.headers);
    }

    const invalid = fakeAuthorizationResponse("GET");
    await assert.rejects(
      provider.authorize(client, { ...params, resource: undefined }, invalid.response),
      /Invalid or missing OAuth resource/,
    );
    assertAuthorizationHeaders(invalid.headers);
    assert.deepEqual(provider.cleanupExpired(Math.floor(Date.now() / 1_000) + 3_600), {
      accessTokens: 0,
      refreshTokens: 0,
      authorizationCodes: 1,
    });
  } finally {
    provider.close();
  }
}

function testTransactionalTokenRotation(stateDir: string): void {
  const store = new SqliteOAuthStore(stateDir);
  try {
    const client = new SqliteOAuthClientsStore(store, oauthConfig.allowedRedirectHosts).registerClient({
      redirect_uris: [redirectUri],
    });
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    store.saveRefreshToken("old-refresh-hash", {
      clientId: client.client_id,
      scopes: ["devspace"],
      expiresAt,
    });

    assert.equal(
      store.saveTokenPair(
        {
          accessTokenHash: "new-access-hash",
          accessToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
          refreshTokenHash: "new-refresh-hash",
          refreshToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
        },
        "old-refresh-hash",
      ),
      true,
    );
    assert.equal(store.getRefreshToken("old-refresh-hash"), undefined);
    assert.ok(store.getAccessToken("new-access-hash"));
    assert.ok(store.getRefreshToken("new-refresh-hash"));

    assert.equal(
      store.saveTokenPair(
        {
          accessTokenHash: "losing-access-hash",
          accessToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
          refreshTokenHash: "losing-refresh-hash",
          refreshToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
        },
        "old-refresh-hash",
      ),
      false,
    );
    assert.equal(store.getAccessToken("losing-access-hash"), undefined);
    assert.equal(store.getRefreshToken("losing-refresh-hash"), undefined);
  } finally {
    store.close();
  }
}

async function testProviderRestartRotationAndRevocation(stateDir: string): Promise<void> {
  const firstProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  const client = await firstProvider.clientsStore.registerClient?.({
    redirect_uris: [redirectUri],
    client_name: "ChatGPT",
  });
  assert.ok(client);

  const code = "code-test-123";
  firstProvider["codes"].set(code, {
    clientId: client.client_id,
    params: {
      redirectUri,
      codeChallenge: "challenge",
      scopes: ["devspace"],
      resource: mcpUrl,
    },
    expiresAtMs: Date.now() + 60_000,
  });
  const issued = await firstProvider.exchangeAuthorizationCode(
    client,
    code,
    undefined,
    redirectUri,
    mcpUrl,
  );
  assert.ok(issued.refresh_token);
  firstProvider.close();

  const secondProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  try {
    const verified = await secondProvider.verifyAccessToken(issued.access_token);
    assert.equal(verified.clientId, client.client_id);

    const refreshed = await secondProvider.exchangeRefreshToken(
      client,
      issued.refresh_token,
      ["devspace"],
      mcpUrl,
    );
    assert.ok(refreshed.refresh_token);
    assert.notEqual(refreshed.access_token, issued.access_token);

    await assert.rejects(
      secondProvider.exchangeRefreshToken(client, issued.refresh_token, ["devspace"], mcpUrl),
      InvalidGrantError,
    );

    await secondProvider.revokeToken(client, { token: refreshed.access_token });
    await assert.rejects(secondProvider.verifyAccessToken(refreshed.access_token), InvalidTokenError);

    await secondProvider.revokeToken(client, { token: refreshed.refresh_token });
    await assert.rejects(
      secondProvider.exchangeRefreshToken(client, refreshed.refresh_token, ["devspace"], mcpUrl),
      InvalidGrantError,
    );
  } finally {
    secondProvider.close();
  }
}

async function testOwnerCredentialChangeAndRevokeAll(stateDir: string): Promise<void> {
  const firstProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  const client = await firstProvider.clientsStore.registerClient?.({ redirect_uris: [redirectUri] });
  assert.ok(client);
  const code = "owner-change-code";
  firstProvider["codes"].set(code, {
    clientId: client.client_id,
    params: { redirectUri, codeChallenge: "challenge", scopes: ["devspace"], resource: mcpUrl },
    expiresAtMs: Date.now() + 60_000,
  });
  const tokens = await firstProvider.exchangeAuthorizationCode(client, code, undefined, redirectUri, mcpUrl);
  assert.deepEqual(firstProvider.diagnosticSnapshot(), {
    clients: 1,
    accessTokens: 1,
    refreshTokens: 1,
    expiredAccessTokens: 0,
    expiredRefreshTokens: 0,
  });
  assert.deepEqual(firstProvider.revokeAll(), { clients: 1, accessTokens: 1, refreshTokens: 1 });
  assert.equal(await firstProvider.clientsStore.getClient?.(client.client_id), undefined);
  await assert.rejects(firstProvider.verifyAccessToken(tokens.access_token), InvalidTokenError);

  const replacement = await firstProvider.clientsStore.registerClient?.({ redirect_uris: [redirectUri] });
  assert.ok(replacement);
  const replacementCode = "replacement-code";
  firstProvider["codes"].set(replacementCode, {
    clientId: replacement.client_id,
    params: { redirectUri, codeChallenge: "challenge", scopes: ["devspace"], resource: mcpUrl },
    expiresAtMs: Date.now() + 60_000,
  });
  const replacementTokens = await firstProvider.exchangeAuthorizationCode(
    replacement,
    replacementCode,
    undefined,
    redirectUri,
    mcpUrl,
  );
  firstProvider.close();

  const changedProvider = new SingleUserOAuthProvider(
    { ...oauthConfig, ownerToken: "different-owner-token-that-is-long-enough" },
    mcpUrl,
    stateDir,
  );
  try {
    assert.equal(await changedProvider.clientsStore.getClient?.(replacement.client_id), undefined);
    await assert.rejects(changedProvider.verifyAccessToken(replacementTokens.access_token), InvalidTokenError);
    assert.deepEqual(changedProvider.diagnosticSnapshot(), {
      clients: 0,
      accessTokens: 0,
      refreshTokens: 0,
      expiredAccessTokens: 0,
      expiredRefreshTokens: 0,
    });
  } finally {
    changedProvider.close();
  }

  const database = openDatabase(stateDir);
  try {
    const credential = database.sqlite
      .prepare("select salt, verifier from oauth_owner_credential where id = 1")
      .get() as { salt: string; verifier: string };
    assert.notEqual(credential.salt, oauthConfig.ownerToken);
    assert.notEqual(credential.verifier, oauthConfig.ownerToken);
    assert.notEqual(credential.verifier, "different-owner-token-that-is-long-enough");
  } finally {
    database.close();
  }
}

function fakeAuthorizationResponse(method: string, body: Record<string, string> = {}): {
  response: Response;
  headers: Map<string, string>;
} {
  const headers = new Map<string, string>();
  const response = {
    req: { method, body },
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    send(_body: string) {
      return this;
    },
    redirect(code: number, _location: string) {
      this.statusCode = code;
    },
  };
  return { response: response as unknown as Response, headers };
}

function assertAuthorizationHeaders(headers: Map<string, string>): void {
  assert.equal(headers.get("cache-control"), "no-store");
  assert.equal(headers.get("pragma"), "no-cache");
  assert.match(headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("referrer-policy"), "no-referrer");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
