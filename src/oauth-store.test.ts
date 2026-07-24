import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Response } from "express";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { databasePath, openDatabase } from "./db/client.js";
import {
  SingleUserOAuthProvider,
  type OAuthAuditEvent,
} from "./oauth-provider.js";
import {
  PrincipalReconnectError,
  SqliteOAuthClientsStore,
  SqliteOAuthStore,
} from "./oauth-store.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import {
  DEFAULT_DEVSPACE_OAUTH_SCOPES,
  DEVSPACE_CAPABILITY_SCOPES,
} from "./oauth-scopes.js";

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
  testConnectionPrincipalReconnect(join(root, "principal-reconnect"));
  testAuthorizationLimitPersistence(join(root, "authorization-limits"));
  testExpiredTokenCleanup(join(root, "expiration"));
  testPendingClientCleanupAndCapacity(join(root, "pending-client-capacity"));
  testTransactionalTokenRotation(join(root, "rotation"));
  testDurableWorkspaceRevocationCleanup(join(root, "workspace-revocation"));
  testOrphanedWorkspaceReconciliation(join(root, "workspace-orphans"));
  testRedirectSchemeValidation(join(root, "redirect-schemes"));
  await testAuthorizationResponseHardening(join(root, "approval-headers"));
  await testDefaultAuthorizationScopes(join(root, "default-scopes"));
  await testAuthorizationThrottling(join(root, "approval-throttling"));
  await testAuditFailuresAreBestEffort(join(root, "audit-failures"));
  await testProviderRestartRotationAndRevocation(join(root, "provider"));
  await testOwnerCredentialChangeAndRevokeAll(join(root, "owner-change"));
} finally {
  await rm(root, { recursive: true, force: true });
}

async function testAuditFailuresAreBestEffort(stateDir: string): Promise<void> {
  const authorizationEpochs: string[] = [];
  const provider = new SingleUserOAuthProvider(
    oauthConfig,
    mcpUrl,
    stateDir,
    () => { throw new Error("audit sink unavailable"); },
    (connectionPrincipalId) => authorizationEpochs.push(connectionPrincipalId),
  );
  try {
    const client = await provider.clientsStore.registerClient?.({
      redirect_uris: [redirectUri],
      client_name: "ChatGPT",
    });
    assert.ok(client, "audit failure must not fail persisted client registration");

    const approval = fakeAuthorizationResponse("POST", { owner_token: oauthConfig.ownerToken });
    await provider.authorize(client, {
      redirectUri,
      codeChallenge: "challenge",
      scopes: ["devspace"],
      resource: mcpUrl,
    }, approval.response);
    assert.equal((approval.response as unknown as { statusCode: number }).statusCode, 302);
    assert.deepEqual(authorizationEpochs, [provider.principalForClient(client.client_id)]);

    const code = "audit-code";
    provider["codes"].set(code, {
      clientId: client.client_id,
      params: {
        redirectUri,
        codeChallenge: "challenge",
        scopes: ["devspace"],
        resource: mcpUrl,
      },
      expiresAtMs: Date.now() + 60_000,
    });
    const issued = await provider.exchangeAuthorizationCode(client, code, undefined, redirectUri, mcpUrl);
    assert.ok(issued.refresh_token);
    const refreshed = await provider.exchangeRefreshToken(
      client,
      issued.refresh_token,
      ["devspace"],
      mcpUrl,
    );
    assert.ok(refreshed.access_token);
    assert.ok(refreshed.refresh_token);
  } finally {
    provider.close();
  }
}

async function testDefaultAuthorizationScopes(stateDir: string): Promise<void> {
  const provider = new SingleUserOAuthProvider(
    { ...oauthConfig, scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES] },
    mcpUrl,
    stateDir,
  );
  try {
    const client = await provider.clientsStore.registerClient?.({
      redirect_uris: [redirectUri],
      client_name: "Default scope client",
    });
    assert.ok(client);
    const approval = fakeAuthorizationResponse("POST", { owner_token: oauthConfig.ownerToken });
    await provider.authorize(client, {
      redirectUri,
      codeChallenge: "default-scope-challenge",
      scopes: [],
      resource: mcpUrl,
    }, approval.response);
    assert.equal((approval.response as unknown as { statusCode: number }).statusCode, 302);
    const [code, record] = [...provider["codes"].entries()][0] ?? [];
    assert.equal(typeof code, "string");
    assert.deepEqual(record?.params.scopes, [...DEVSPACE_CAPABILITY_SCOPES]);
    const tokens = await provider.exchangeAuthorizationCode(client, String(code), undefined, redirectUri, mcpUrl);
    assert.equal(tokens.scope, DEVSPACE_CAPABILITY_SCOPES.join(" "));
    assert.deepEqual(
      (await provider.verifyAccessToken(tokens.access_token)).scopes,
      [...DEVSPACE_CAPABILITY_SCOPES],
    );
  } finally {
    provider.close();
  }
}

async function testAuthorizationThrottling(stateDir: string): Promise<void> {
  const auditEvents: OAuthAuditEvent[] = [];
  const provider = new SingleUserOAuthProvider(
    oauthConfig,
    mcpUrl,
    stateDir,
    (event) => auditEvents.push(event),
  );
  const client = await provider.clientsStore.registerClient?.({
    redirect_uris: [redirectUri],
    client_name: "ChatGPT",
  });
  assert.ok(client);
  const params = {
    redirectUri,
    codeChallenge: "challenge",
    scopes: ["devspace"],
    resource: mcpUrl,
  };
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = fakeAuthorizationResponse("POST", { owner_token: "wrong" });
      await provider.authorize(client, params, failed.response);
      assert.equal((failed.response as unknown as { statusCode: number }).statusCode, 401);
    }
    const limited = fakeAuthorizationResponse("POST", { owner_token: oauthConfig.ownerToken });
    await provider.authorize(client, params, limited.response);
    assert.equal((limited.response as unknown as { statusCode: number }).statusCode, 429);
    assert.match(limited.headers.get("retry-after") ?? "", /^\d+$/u);

    const otherClient = await provider.clientsStore.registerClient?.({
      redirect_uris: [redirectUri],
      client_name: "Other ChatGPT registration",
    });
    assert.ok(otherClient);
    const otherApproval = fakeAuthorizationResponse("POST", { owner_token: oauthConfig.ownerToken });
    await provider.authorize(otherClient, { ...params, codeChallenge: "other-client" }, otherApproval.response);
    assert.equal((otherApproval.response as unknown as { statusCode: number }).statusCode, 302);

    const freshParams = { ...params, codeChallenge: "fresh-session" };
    const freshApproval = fakeAuthorizationResponse("POST", { owner_token: oauthConfig.ownerToken });
    await provider.authorize(client, freshParams, freshApproval.response);
    assert.equal((freshApproval.response as unknown as { statusCode: number }).statusCode, 302);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = fakeAuthorizationResponse("POST", { owner_token: "wrong-again" });
      await provider.authorize(client, { ...params, codeChallenge: "second-failing-session" }, failed.response);
      assert.equal((failed.response as unknown as { statusCode: number }).statusCode, 401);
    }
    const throttledFailure = fakeAuthorizationResponse("POST", { owner_token: "still-wrong" });
    await provider.authorize(
      client,
      { ...params, codeChallenge: "second-failing-session" },
      throttledFailure.response,
    );
    assert.equal((throttledFailure.response as unknown as { statusCode: number }).statusCode, 429);
    assert.match(throttledFailure.headers.get("retry-after") ?? "", /^\d+$/u);
    assert.equal(auditEvents.filter(({ event }) => event === "oauth_client_registered").length, 2);
    assert.equal(auditEvents.filter(({ event }) => event === "oauth_authorization_failed").length, 10);
    assert.equal(auditEvents.filter(({ event }) => event === "oauth_authorization_succeeded").length, 2);
    assert.equal(auditEvents.filter(({ event }) => event === "oauth_authorization_rate_limited").length, 2);
    assert.ok(auditEvents.every(({ clientId }) =>
      clientId === client.client_id || clientId === otherClient.client_id));
  } finally {
    provider.close();
  }
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
      { version: 7, name: "workspace-resume-idempotency" },
      { version: 8, name: "workspace-generation-operation-identity" },
      { version: 9, name: "workspace-worktree-source-state" },
      { version: 10, name: "oauth-revocation-cleanup" },
      { version: 11, name: "connection-principals" },
      { version: 12, name: "oauth-authorization-limits" },
      { version: 13, name: "connection-principal-approval-lifecycle" },
    ]);
  } finally {
    database.close();
  }

  const simulatedOldLifecycle = openDatabase(stateDir);
  simulatedOldLifecycle.sqlite.prepare(
    "delete from devspace_schema_migrations where version = 13",
  ).run();
  simulatedOldLifecycle.sqlite.exec(`
    drop trigger if exists oauth_clients_principal_insert_check;
    drop trigger if exists oauth_clients_principal_update_check;
    drop trigger if exists connection_principals_delete_check;
    create trigger oauth_clients_principal_insert_check
      before insert on oauth_clients
      when new.principal_id is null
      begin
        select raise(abort, 'old trigger required eager principal');
      end;
  `);
  simulatedOldLifecycle.close();

  const upgraded = new SqliteOAuthStore(stateDir);
  try {
    const registration = new SqliteOAuthClientsStore(
      upgraded,
      oauthConfig.allowedRedirectHosts,
    ).registerClient({ redirect_uris: [redirectUri] });
    assert.equal(upgraded.principalForClient(registration.client_id), undefined);
  } finally {
    upgraded.close();
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
  assert.equal(firstStore.principalForClient(client.client_id), undefined);
  assert.throws(
    () => firstStore.saveAccessToken("unapproved-token", {
      clientId: client.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    }),
    /before the registration has an active connection principal/,
  );
  const principalId = firstStore.ensurePrincipalForClient(client.client_id);
  assert.match(principalId, /^principal-[0-9a-f-]{36}$/u);
  assert.notEqual(principalId, client.client_id);

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
    assert.equal(restoredStore.principalForClient(client.client_id), principalId);
    assert.equal(restoredStore.getAccessToken(hashToken(accessToken))?.resource, mcpUrl.href);
    assert.equal(restoredStore.getRefreshToken(hashToken(refreshToken))?.clientId, client.client_id);
  } finally {
    restoredStore.close();
  }
}

function testConnectionPrincipalReconnect(stateDir: string): void {
  const oauth = new SqliteOAuthStore(stateDir);
  const clients = new SqliteOAuthClientsStore(oauth, oauthConfig.allowedRedirectHosts);
  const workspaces = new SqliteWorkspaceStore(stateDir);
  try {
    const first = clients.registerClient({ redirect_uris: [redirectUri], client_name: "First" });
    const second = clients.registerClient({ redirect_uris: [redirectUri], client_name: "Second" });
    const firstPrincipal = oauth.ensurePrincipalForClient(first.client_id);
    assert.equal(oauth.principalForClient(second.client_id), undefined);

    workspaces.createSession({
      id: "principal-reconnect-workspace",
      connectionPrincipalId: firstPrincipal,
      alias: "primary",
      root: "/workspace/principal-reconnect",
    });
    const integrityDatabase = openDatabase(stateDir);
    try {
      assert.throws(
        () => integrityDatabase.sqlite
          .prepare("delete from connection_principals where principal_id = ?")
          .run(firstPrincipal),
        /connection principal still has retained state/,
      );
    } finally {
      integrityDatabase.close();
    }
    const reconnect = oauth.issueReconnectCode(firstPrincipal, 60_000);
    assert.match(reconnect.code, /^reconnect-[A-Za-z0-9_-]+$/u);
    assert.equal(reconnect.principalId, firstPrincipal);
    assert.deepEqual(oauth.consumeReconnectCode(reconnect.code, second.client_id), {
      clientId: second.client_id,
      targetPrincipalId: firstPrincipal,
      changed: true,
    });
    assert.equal(oauth.principalForClient(second.client_id), firstPrincipal);
    assert.throws(
      () => oauth.consumeReconnectCode(reconnect.code, second.client_id),
      (error: unknown) =>
        error instanceof PrincipalReconnectError && error.code === "reconnect_code_invalid",
    );

    const summary = oauth.listConnectionPrincipals();
    assert.equal(summary.length, 1);
    assert.deepEqual(
      summary.find(({ principalId }) => principalId === firstPrincipal),
      {
        principalId: firstPrincipal,
        clientCount: 2,
        activeWorkspaces: 1,
        retainedWorkspaces: 1,
        aliases: ["primary"],
        createdAt: summary.find(({ principalId }) => principalId === firstPrincipal)!.createdAt,
        lastUsedAt: summary.find(({ principalId }) => principalId === firstPrincipal)!.lastUsedAt,
      },
    );

    const samePrincipalCode = oauth.issueReconnectCode(firstPrincipal, 60_000);
    assert.deepEqual(oauth.consumeReconnectCode(samePrincipalCode.code, second.client_id), {
      clientId: second.client_id,
      sourcePrincipalId: firstPrincipal,
      targetPrincipalId: firstPrincipal,
      changed: false,
    });

    const assigned = clients.registerClient({
      redirect_uris: [redirectUri],
      client_name: "Assigned before relink",
    });
    const assignedPrincipal = oauth.ensurePrincipalForClient(assigned.client_id);
    oauth.saveAccessToken("pre-relink-access", {
      clientId: assigned.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    });
    oauth.saveRefreshToken("pre-relink-refresh", {
      clientId: assigned.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    });
    const assignedCode = oauth.issueReconnectCode(firstPrincipal, 60_000);
    assert.deepEqual(oauth.consumeReconnectCode(assignedCode.code, assigned.client_id), {
      clientId: assigned.client_id,
      sourcePrincipalId: assignedPrincipal,
      targetPrincipalId: firstPrincipal,
      changed: true,
    });
    assert.equal(oauth.getAccessToken("pre-relink-access"), undefined);
    assert.equal(oauth.getRefreshToken("pre-relink-refresh"), undefined);

    const inUse = clients.registerClient({ redirect_uris: [redirectUri], client_name: "In use" });
    const inUsePrincipal = oauth.ensurePrincipalForClient(inUse.client_id);
    workspaces.createSession({
      id: "principal-in-use-workspace",
      connectionPrincipalId: inUsePrincipal,
      root: "/workspace/principal-in-use",
    });
    const blockedCode = oauth.issueReconnectCode(firstPrincipal, 60_000);
    assert.throws(
      () => oauth.consumeReconnectCode(blockedCode.code, inUse.client_id),
      (error: unknown) =>
        error instanceof PrincipalReconnectError && error.code === "reconnect_source_in_use",
    );
  } finally {
    workspaces.close();
    oauth.close();
  }
}

function testAuthorizationLimitPersistence(stateDir: string): void {
  const base = Date.now();
  const policy = {
    scope: "session" as const,
    capacity: 2,
    refillIntervalMs: 1_000,
    baseBackoffMs: 100,
    maxBackoffMs: 1_000,
    ttlMs: 5_000,
  };
  const firstKey = { ...policy, key: "ip-a\0client-a\0session-a" };
  const secondKey = { ...policy, key: "ip-a\0client-a\0session-b" };
  const first = new SqliteOAuthStore(stateDir);
  assert.deepEqual(first.checkAuthorizationLimits([firstKey], base), {
    limited: false,
    retryAfterMs: 0,
  });
  assert.deepEqual(first.recordAuthorizationFailure([firstKey], base), {
    limited: false,
    retryAfterMs: 0,
  });
  assert.deepEqual(first.recordAuthorizationFailure([firstKey], base + 1), {
    limited: false,
    retryAfterMs: 0,
  });
  assert.equal(first.checkAuthorizationLimits([firstKey], base + 1).limited, true);
  assert.deepEqual(first.checkAuthorizationLimits([secondKey], base + 1), {
    limited: false,
    retryAfterMs: 0,
  });
  first.close();

  const restored = new SqliteOAuthStore(stateDir);
  try {
    const persisted = restored.checkAuthorizationLimits([firstKey], base + 1);
    assert.equal(persisted.limited, true);
    assert.ok(persisted.retryAfterMs > 0);
    assert.equal(restored.clearAuthorizationLimit("session", firstKey.key), true);
    assert.deepEqual(restored.checkAuthorizationLimits([firstKey], base + 1), {
      limited: false,
      retryAfterMs: 0,
    });
    restored.recordAuthorizationFailure([secondKey], base + 2);
    assert.deepEqual(restored.cleanupExpired(Math.ceil((base + 10_000) / 1_000)), {
      accessTokens: 0,
      refreshTokens: 0,
      reconnectCodes: 0,
      authorizationLimits: 1,
      unapprovedClients: 0,
      revokedPrincipals: 0,
    });
  } finally {
    restored.close();
  }
}

function testExpiredTokenCleanup(stateDir: string): void {
  const store = new SqliteOAuthStore(stateDir);
  const client = new SqliteOAuthClientsStore(store, oauthConfig.allowedRedirectHosts).registerClient({
    redirect_uris: [redirectUri],
  });
  store.ensurePrincipalForClient(client.client_id);
  const expiredAt = Math.floor(Date.now() / 1000) - 1;
  store.saveTokenPair({
    accessTokenHash: "expired-access-hash",
    accessToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt: expiredAt },
    refreshTokenHash: "expired-refresh-hash",
    refreshToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt: expiredAt },
  });
  assert.deepEqual(store.diagnosticSnapshot(expiredAt + 1), {
    clients: 1,
    principals: 1,
    accessTokens: 1,
    refreshTokens: 1,
    workspaceCleanupJobs: 0,
    expiredAccessTokens: 1,
    expiredRefreshTokens: 1,
  });
  assert.deepEqual(store.cleanupExpired(expiredAt + 1), {
    accessTokens: 1,
    refreshTokens: 1,
    reconnectCodes: 0,
    authorizationLimits: 0,
    unapprovedClients: 0,
    revokedPrincipals: 0,
  });
  store.close();

  const reopened = new SqliteOAuthStore(stateDir);
  try {
    assert.equal(reopened.getClient(client.client_id)?.client_id, client.client_id);
    assert.equal(reopened.getAccessToken("expired-access-hash"), undefined);
    assert.equal(reopened.getRefreshToken("expired-refresh-hash"), undefined);
  } finally {
    reopened.close();
  }
}

function testPendingClientCleanupAndCapacity(stateDir: string): void {
  const store = new SqliteOAuthStore(stateDir);
  const clients = new SqliteOAuthClientsStore(store, oauthConfig.allowedRedirectHosts);
  try {
    for (let index = 0; index < 64; index += 1) {
      clients.registerClient({
        redirect_uris: [redirectUri],
        client_name: `Pending ${index}`,
      });
    }
    assert.throws(
      () => clients.registerClient({ redirect_uris: [redirectUri], client_name: "Overflow" }),
      /Too many unapproved OAuth client registrations/,
    );
    const database = openDatabase(stateDir);
    try {
      database.sqlite.prepare(`
        update oauth_clients
        set issued_at = 0
        where client_id = (
          select client_id from oauth_clients
          where principal_id is null
          order by issued_at, client_id
          limit 1
        )
      `).run();
    } finally {
      database.close();
    }
    assert.equal(store.cleanupExpired().unapprovedClients, 1);
    assert.doesNotThrow(() => clients.registerClient({
      redirect_uris: [redirectUri],
      client_name: "Replacement",
    }));
  } finally {
    store.close();
  }
}

function testRedirectSchemeValidation(stateDir: string): void {
  const store = new SqliteOAuthStore(stateDir);
  const clients = new SqliteOAuthClientsStore(store, oauthConfig.allowedRedirectHosts);
  try {
    assert.throws(
      () => clients.registerClient({ redirect_uris: ["http://chatgpt.com/connector/oauth/test"] }),
      /redirect_uri is not allowed/,
    );
    assert.throws(
      () => clients.registerClient({ redirect_uris: ["javascript://chatgpt.com/connector/oauth/test"] }),
      /redirect_uri is not allowed/,
    );
    assert.doesNotThrow(() => clients.registerClient({ redirect_uris: ["http://127.0.0.1:8765/callback"] }));
  } finally {
    store.close();
  }
}

function testDurableWorkspaceRevocationCleanup(stateDir: string): void {
  const oauth = new SqliteOAuthStore(stateDir);
  const client = new SqliteOAuthClientsStore(oauth, oauthConfig.allowedRedirectHosts).registerClient({
    redirect_uris: [redirectUri],
  });
  const workspaces = new SqliteWorkspaceStore(stateDir);
  const principalId = oauth.ensurePrincipalForClient(client.client_id);
  const checkout = workspaces.createSession({
    id: "revoked-checkout",
    connectionPrincipalId: principalId,
    root: "/workspace/revoked-checkout",
  });
  workspaces.createSession({
    id: "revoked-worktree",
    connectionPrincipalId: principalId,
    root: "/workspace/revoked-worktree",
    mode: "worktree",
    sourceRoot: "/workspace/source",
    baseRef: "main",
    baseSha: "abc123",
    managed: true,
  });
  const closed = workspaces.createSession({
    id: "closed-workspace",
    connectionPrincipalId: principalId,
    root: "/workspace/closed",
  });
  assert.equal(workspaces.closeSession(closed.id, principalId), true);

  assert.deepEqual(oauth.revokeAll(), {
    clients: 1,
    accessTokens: 0,
    refreshTokens: 0,
    workspaceCleanupJobs: 3,
  });
  assert.equal(workspaces.getSession(checkout.id, principalId), undefined);
  const database = openDatabase(stateDir);
  try {
    assert.deepEqual(
      database.sqlite.prepare(
        "select id, status from workspace_sessions order by id",
      ).all(),
      [
        { id: "closed-workspace", status: "revoked" },
        { id: "revoked-checkout", status: "revoked" },
        { id: "revoked-worktree", status: "revoked" },
      ],
    );
  } finally {
    database.close();
  }
  oauth.close();
  workspaces.close();

  const restarted = new SqliteWorkspaceStore(stateDir);
  try {
    const jobs = restarted.listRevocationCleanupJobs();
    assert.deepEqual(jobs.map(({ workspaceId, status }) => ({ workspaceId, status }))
      .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId)), [
      { workspaceId: "closed-workspace", status: "pending" },
      { workspaceId: "revoked-checkout", status: "pending" },
      { workspaceId: "revoked-worktree", status: "pending" },
    ]);
    const worktreeJob = jobs.find(({ workspaceId }) => workspaceId === "revoked-worktree")!;
    const firstClaim = restarted.claimRevocationCleanupJob(worktreeJob.id, { now: 1_000, leaseMs: 100 });
    assert.equal(firstClaim?.attempts, 1);
    assert.equal(restarted.claimRevocationCleanupJob(worktreeJob.id, { now: 1_050, leaseMs: 100 }), undefined);
    const reclaimed = restarted.claimRevocationCleanupJob(worktreeJob.id, { now: 1_101, leaseMs: 100 });
    assert.equal(reclaimed?.attempts, 2);
    assert.notEqual(reclaimed?.claimToken, firstClaim?.claimToken);
    assert.equal(restarted.finalizeRevocationCleanupJob({
      id: worktreeJob.id,
      claimToken: firstClaim!.claimToken!,
      retainedDirtyWorktreeReason: "stale worker must not finalize",
      now: 1_102,
    }), false);
    assert.equal(restarted.failRevocationCleanupJob({
      id: worktreeJob.id,
      claimToken: reclaimed!.claimToken!,
      error: "temporary cleanup failure",
      now: 1_103,
    }), true);
    const finalClaim = restarted.claimRevocationCleanupJob(worktreeJob.id, { now: 1_104 });
    assert.equal(finalClaim?.attempts, 3);
    assert.equal(restarted.finalizeRevocationCleanupJob({
      id: worktreeJob.id,
      claimToken: finalClaim!.claimToken!,
      retainedDirtyWorktreeReason: "worktree has uncommitted changes",
      now: 1_105,
    }), true);
    assert.equal(restarted.finalizeRevocationCleanupJob({
      id: worktreeJob.id,
      claimToken: finalClaim!.claimToken!,
      retainedDirtyWorktreeReason: "worktree has uncommitted changes",
      now: 1_105,
    }), true);

    const checkoutJob = restarted.listRevocationCleanupJobs().find(
      ({ workspaceId }) => workspaceId === "revoked-checkout",
    )!;
    const checkoutClaim = restarted.claimRevocationCleanupJob(checkoutJob.id, { now: 1_105 });
    assert.equal(restarted.finalizeRevocationCleanupJob({
      id: checkoutJob.id,
      claimToken: checkoutClaim!.claimToken!,
      now: 1_106,
    }), true);
    const closedJob = restarted.listRevocationCleanupJobs().find(
      ({ workspaceId }) => workspaceId === "closed-workspace",
    )!;
    const closedClaim = restarted.claimRevocationCleanupJob(closedJob.id, { now: 1_106 });
    assert.equal(restarted.finalizeRevocationCleanupJob({
      id: closedJob.id,
      claimToken: closedClaim!.claimToken!,
      now: 1_107,
    }), true);
    assert.deepEqual(restarted.listRevocationCleanupJobs(), []);
    assert.deepEqual(restarted.listRevocationDirtyWorktreeArtifacts().map((artifact) => ({
      workspaceId: artifact.workspaceId,
      reason: artifact.reason,
    })), [{
      workspaceId: "revoked-worktree",
      reason: "worktree has uncommitted changes",
    }]);
    assert.deepEqual(restarted.cleanupRevocationHistory("9999-01-01T00:00:00.000Z", 1), {
      jobs: 1,
      workspaceSessions: 1,
    });
    assert.deepEqual(restarted.cleanupRevocationHistory("9999-01-01T00:00:00.000Z", 10), {
      jobs: 2,
      workspaceSessions: 2,
    });
    assert.equal(restarted.listRevocationDirtyWorktreeArtifacts().length, 1);
  } finally {
    restarted.close();
  }
  const beforePrincipalCleanup = openDatabase(stateDir);
  try {
    assert.equal(beforePrincipalCleanup.sqlite.prepare(`
      select count(*)
      from connection_principals
      where principal_id = ? and revoked_at is not null
    `).pluck().get(principalId), 1);
  } finally {
    beforePrincipalCleanup.close();
  }
  new SqliteOAuthStore(stateDir).close();
  const afterPrincipalCleanup = openDatabase(stateDir);
  try {
    assert.equal(afterPrincipalCleanup.sqlite.prepare(`
      select count(*)
      from connection_principals
      where principal_id = ?
    `).pluck().get(principalId), 0);
  } finally {
    afterPrincipalCleanup.close();
  }
}

function testOrphanedWorkspaceReconciliation(stateDir: string): void {
  const workspaces = new SqliteWorkspaceStore(stateDir);
  workspaces.createSession({
    id: "orphaned-workspace",
    connectionPrincipalId: "devspace-missing-oauth-client",
    root: "/workspace/orphaned",
  });
  workspaces.close();

  const oauth = new SqliteOAuthStore(stateDir);
  try {
    assert.equal(oauth.queueOrphanedWorkspaceCleanup(), 1);
    assert.equal(oauth.queueOrphanedWorkspaceCleanup(), 0, "reconciliation is idempotent");
  } finally {
    oauth.close();
  }
  const restored = new SqliteWorkspaceStore(stateDir);
  try {
    assert.deepEqual(
      restored.listRevocationCleanupJobs().map(({ workspaceId, status }) => ({ workspaceId, status })),
      [{ workspaceId: "orphaned-workspace", status: "pending" }],
    );
    assert.equal(restored.getSession("orphaned-workspace", "devspace-missing-oauth-client"), undefined);
  } finally {
    restored.close();
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
      reconnectCodes: 0,
      authorizationLimits: 0,
      unapprovedClients: 0,
      revokedPrincipals: 0,
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
    store.ensurePrincipalForClient(client.client_id);
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
    principals: 1,
    accessTokens: 1,
    refreshTokens: 1,
    workspaceCleanupJobs: 0,
    expiredAccessTokens: 0,
    expiredRefreshTokens: 0,
  });
  assert.deepEqual(firstProvider.revokeAll(), {
    clients: 1,
    accessTokens: 1,
    refreshTokens: 1,
    workspaceCleanupJobs: 0,
  });
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
    assert.equal(
      (await changedProvider.clientsStore.getClient?.(replacement.client_id))?.client_id,
      replacement.client_id,
    );
    assert.equal(changedProvider.ownerCredentialChanged, true);
    await assert.rejects(changedProvider.verifyAccessToken(replacementTokens.access_token), InvalidTokenError);
    assert.deepEqual(changedProvider.diagnosticSnapshot(), {
      clients: 1,
      principals: 1,
      accessTokens: 0,
      refreshTokens: 0,
      workspaceCleanupJobs: 0,
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
  assert.match(
    headers.get("content-security-policy") ?? "",
    /form-action 'self' https:\/\/chatgpt\.com/,
  );
  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("referrer-policy"), "no-referrer");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
