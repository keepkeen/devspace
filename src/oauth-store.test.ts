import assert from "node:assert/strict";
import { createHash, scryptSync } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Response } from "express";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { databasePath, openDatabase } from "./db/client.js";
import {
  CURRENT_DATABASE_SCHEMA_NAME,
  CURRENT_DATABASE_SCHEMA_VERSION,
} from "./db/canonical-schema.js";
import {
  SingleUserOAuthProvider,
  type OAuthAuditEvent,
} from "./oauth-provider.js";
import {
  SqliteOAuthClientsStore,
  SqliteOAuthStore,
  type OAuthGrantCreationResult,
} from "./oauth-store.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import {
  ProjectExecutionStore,
  type ProjectExecutionAuthorization,
} from "./project-execution-store.js";
import {
  DEFAULT_AUTHORIZATION_SCOPES,
  DEFAULT_DEVSPACE_OAUTH_SCOPES,
  DEVSPACE_CAPABILITY_SCOPES,
} from "./oauth-scopes.js";
import {
  createSecurityKeyring,
  hashOwnerPassword,
  legacyMasterKeyFromOwnerPassword,
} from "./security-credentials.js";

const root = await mkdtemp(join(tmpdir(), "devspace-oauth-test-"));
const ownerPassword = "test-owner-token-that-is-long-enough";
const oauthConfig = {
  ownerCredential: { password: ownerPassword },
  keys: createSecurityKeyring({
    masterKey: legacyMasterKeyFromOwnerPassword(ownerPassword),
    derivation: "legacy-direct" as const,
    source: "legacy_environment" as const,
  }),
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 2592000,
  scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
  allowedRedirectHosts: ["chatgpt.com"],
};
const mcpUrl = new URL("https://agent.example.com/mcp");
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";

try {
  await testDatabaseConfiguration(join(root, "database-configuration"));
  testPersistenceAndTokenHashing(join(root, "persistence"));
  testAuthorizationGrantCoexistence(join(root, "grant-coexistence"));
  await testProjectCentricRequestAuthorization(join(root, "project-centric-authorization"));
  testAuthorizationLimitPersistence(join(root, "authorization-limits"));
  testExpiredTokenCleanup(join(root, "expiration"));
  testStaleGrantRetainsProjectInventory(join(root, "stale-grant-inventory"));
  testPendingClientCleanupAndCapacity(join(root, "pending-client-capacity"));
  testTransactionalTokenRotation(join(root, "rotation"));
  testDurableWorkspaceRevocationCleanup(join(root, "workspace-revocation"));
  testRedirectSchemeValidation(join(root, "redirect-schemes"));
  await testAuthorizationResponseHardening(join(root, "approval-headers"));
  await testApprovalHidesPrincipalManagementAndPreservesAuthorization(
    join(root, "coexisting-approval"),
  );
  await testDefaultAuthorizationScopes(join(root, "default-scopes"));
  await testDurableAuthorizationArtifacts(join(root, "durable-authorization-artifacts"));
  await testAuthorizationThrottling(join(root, "approval-throttling"));
  await testAuditFailuresAreBestEffort(join(root, "audit-failures"));
  await testProviderRestartRotationAndRevocation(join(root, "provider"));
  await testRefreshReplayRevokesFamily(join(root, "refresh-replay"));
  await testAbsoluteGrantLifetime(join(root, "absolute-grant-lifetime"));
  await testPartialOwnerCredentialMigrationPreservesTokens(join(root, "partial-owner-migration"));
  await testPartialOwnerCredentialMigrationRejectsMismatchedHash(join(root, "partial-owner-mismatch"));
  await testOwnerCredentialChangeAndRevokeAll(join(root, "owner-change"));
} finally {
  await rm(root, { recursive: true, force: true });
}

async function testAuditFailuresAreBestEffort(stateDir: string): Promise<void> {
  const authorizationBoundaryChanges: Array<{
    connectionPrincipalId: string;
    reason: string;
  }> = [];
  const provider = new SingleUserOAuthProvider(
    oauthConfig,
    mcpUrl,
    stateDir,
    () => { throw new Error("audit sink unavailable"); },
    (change) => {
      authorizationBoundaryChanges.push(change);
    },
  );
  try {
    const client = await provider.clientsStore.registerClient?.({
      redirect_uris: [redirectUri],
      client_name: "ChatGPT",
    });
    assert.ok(client, "audit failure must not fail persisted client registration");

    const firstAuthorization = await authorizeAndExchange(provider, client, "challenge");
    const firstContext = provider.authorizeRequest(
      await provider.verifyAccessToken(firstAuthorization.tokens.access_token),
    );
    assert.deepEqual(authorizationBoundaryChanges, []);

    const repeatedAuthorization = await authorizeAndExchange(
      provider,
      client,
      "same-boundary-challenge",
    );
    const repeatedContext = provider.authorizeRequest(
      await provider.verifyAccessToken(repeatedAuthorization.tokens.access_token),
    );
    assert.notEqual(repeatedContext.grantId, firstContext.grantId);
    assert.equal(repeatedContext.connectionPrincipalId, firstContext.connectionPrincipalId);
    assert.deepEqual(authorizationBoundaryChanges, []);

    const issued = firstAuthorization.tokens;
    assert.ok(issued.refresh_token);
    assert.ok((await provider.exchangeRefreshToken(
      client,
      issued.refresh_token,
      [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
      mcpUrl,
    )).refresh_token);
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
    const approval = fakeAuthorizationResponse("POST", { owner_token: ownerPassword });
    await provider.authorize(client, {
      redirectUri,
      codeChallenge: "default-scope-challenge",
      scopes: [],
      resource: mcpUrl,
    }, approval.response);
    assert.equal((approval.response as unknown as { statusCode: number }).statusCode, 302);
    const code = new URL(String(approval.redirectLocation)).searchParams.get("code");
    assert.ok(code);
    const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, redirectUri, mcpUrl);
    assert.equal(tokens.scope, DEFAULT_AUTHORIZATION_SCOPES.join(" "));
    assert.deepEqual(
      (await provider.verifyAccessToken(tokens.access_token)).scopes,
      [...DEFAULT_AUTHORIZATION_SCOPES],
    );
  } finally {
    provider.close();
  }
}

async function testDurableAuthorizationArtifacts(stateDir: string): Promise<void> {
  const authorizationRoot = { id: "root-durable", path: stateDir, label: "Durable root" };
  const config = { ...oauthConfig, resourceRoots: () => [authorizationRoot] };
  const params = {
    redirectUri,
    codeChallenge: "durable-code-challenge",
    scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
    resource: mcpUrl,
  };

  const firstProvider = new SingleUserOAuthProvider(config, mcpUrl, stateDir);
  const client = await firstProvider.clientsStore.registerClient?.({
    redirect_uris: [redirectUri],
    client_name: "Durable authorization client",
    token_endpoint_auth_method: "none",
  });
  assert.ok(client);
  const approval = fakeAuthorizationResponse("POST", { owner_token: ownerPassword });
  await firstProvider.authorize(client, params, approval.response);
  assert.equal((approval.response as unknown as { statusCode: number }).statusCode, 200);
  const selectionToken = approval.sentBody?.match(
    /name="selection_token" value="([A-Za-z0-9_-]+)"/u,
  )?.[1];
  assert.ok(selectionToken);
  firstProvider.close();

  const secondProvider = new SingleUserOAuthProvider(config, mcpUrl, stateDir);
  const selected = fakeAuthorizationResponse("POST", {
    selection_token: selectionToken,
    root_id: authorizationRoot.id,
  });
  await secondProvider.authorize(client, params, selected.response);
  assert.equal((selected.response as unknown as { statusCode: number }).statusCode, 302);
  const authorizationCode = new URL(String(selected.redirectLocation)).searchParams.get("code");
  assert.ok(authorizationCode);
  secondProvider.close();

  const persisted = openDatabase(stateDir);
  try {
    assert.equal(
      persisted.sqlite.prepare(`
        select count(*) from oauth_authorization_selections where token_hash = ?
      `).pluck().get(selectionToken),
      0,
      "the opaque selection token must never be persisted in plaintext",
    );
    assert.equal(
      persisted.sqlite.prepare(`
        select count(*) from oauth_authorization_codes where code_hash = ?
      `).pluck().get(authorizationCode),
      0,
      "the opaque authorization code must never be persisted in plaintext",
    );
    assert.equal(
      persisted.sqlite.prepare(`
        select count(*) from oauth_authorization_codes where code_hash = ?
      `).pluck().get(hashToken(authorizationCode)),
      1,
    );
  } finally {
    persisted.close();
  }

  const thirdProvider = new SingleUserOAuthProvider(config, mcpUrl, stateDir);
  try {
    assert.equal(
      await thirdProvider.challengeForAuthorizationCode(client, authorizationCode),
      params.codeChallenge,
    );
    const tokens = await thirdProvider.exchangeAuthorizationCode(
      client,
      authorizationCode,
      undefined,
      redirectUri,
      mcpUrl,
    );
    assert.ok(tokens.access_token);
    await assert.rejects(
      thirdProvider.exchangeAuthorizationCode(
        client,
        authorizationCode,
        undefined,
        redirectUri,
        mcpUrl,
      ),
      InvalidGrantError,
    );

    const selectionReplay = fakeAuthorizationResponse("POST", {
      selection_token: selectionToken,
      root_id: authorizationRoot.id,
    });
    await thirdProvider.authorize(client, params, selectionReplay.response);
    assert.equal((selectionReplay.response as unknown as { statusCode: number }).statusCode, 400);

    const expiringSelection = fakeAuthorizationResponse("POST", { owner_token: ownerPassword });
    await thirdProvider.authorize(
      client,
      { ...params, codeChallenge: "expiring-selection-challenge" },
      expiringSelection.response,
    );
    assert.equal((expiringSelection.response as unknown as { statusCode: number }).statusCode, 200);
    assert.equal(
      thirdProvider.cleanupExpired(Math.floor(Date.now() / 1_000) + 3_600)
        .authorizationSelections,
      1,
    );
  } finally {
    thirdProvider.close();
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
    scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
    resource: mcpUrl,
  };
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = fakeAuthorizationResponse("POST", { owner_token: "wrong" });
      await provider.authorize(client, params, failed.response);
      assert.equal((failed.response as unknown as { statusCode: number }).statusCode, 401);
    }
    const limited = fakeAuthorizationResponse("POST", { owner_token: ownerPassword });
    await provider.authorize(client, params, limited.response);
    assert.equal((limited.response as unknown as { statusCode: number }).statusCode, 429);
    assert.match(limited.headers.get("retry-after") ?? "", /^\d+$/u);

    const otherClient = await provider.clientsStore.registerClient?.({
      redirect_uris: [redirectUri],
      client_name: "Other ChatGPT registration",
    });
    assert.ok(otherClient);
    const otherApproval = fakeAuthorizationResponse("POST", { owner_token: ownerPassword });
    await provider.authorize(otherClient, { ...params, codeChallenge: "other-client" }, otherApproval.response);
    assert.equal((otherApproval.response as unknown as { statusCode: number }).statusCode, 302);

    const freshParams = { ...params, codeChallenge: "fresh-session" };
    const freshApproval = fakeAuthorizationResponse("POST", { owner_token: ownerPassword });
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
    assert.deepEqual(migrations, [{
      version: CURRENT_DATABASE_SCHEMA_VERSION,
      name: CURRENT_DATABASE_SCHEMA_NAME,
    }]);
  } finally {
    database.close();
  }

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
      scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    }),
    /active authorization grant/,
  );
  const principalId = firstStore.ensurePrincipalForClient(client.client_id);
  assert.equal(principalId, "owner");
  assert.notEqual(principalId, client.client_id);

  firstStore.saveTokenPair({
    accessTokenHash: hashToken(accessToken),
    accessToken: {
      clientId: client.client_id,
      scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      resource: mcpUrl.href,
    },
    refreshTokenHash: hashToken(refreshToken),
    refreshToken: {
      clientId: client.client_id,
      scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
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

function testAuthorizationGrantCoexistence(stateDir: string): void {
  const oauth = new SqliteOAuthStore(stateDir);
  const clients = new SqliteOAuthClientsStore(oauth, oauthConfig.allowedRedirectHosts);
  try {
    const firstClient = clients.registerClient({
      redirect_uris: [redirectUri],
      client_name: "First authorization",
    });
    const secondClient = clients.registerClient({
      redirect_uris: [redirectUri],
      client_name: "Second authorization",
    });
    const firstGrant = oauth.createAuthorizationGrant({
      clientId: firstClient.client_id,
      scopes: ["project:read"],
      allowedRootIds: ["root-first"],
    });
    oauth.saveAccessToken("first-access", {
      clientId: firstClient.client_id,
      grantId: firstGrant.grantId,
      principalId: firstGrant.principalId,
      authorizationEpoch: firstGrant.authorizationEpoch,
      scopes: ["project:read"],
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    });
    oauth.saveRefreshToken("first-refresh", {
      clientId: firstClient.client_id,
      grantId: firstGrant.grantId,
      principalId: firstGrant.principalId,
      authorizationEpoch: firstGrant.authorizationEpoch,
      scopes: ["project:read"],
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    });
    oauth.saveAuthorizationCode("first-code", {
      clientId: firstClient.client_id,
      grantId: firstGrant.grantId,
      principalId: firstGrant.principalId,
      authorizationEpoch: firstGrant.authorizationEpoch,
      redirectUri,
      codeChallenge: "first-code-challenge",
      scopes: ["project:read"],
    });
    oauth.saveAuthorizationSelection("first-selection", {
      clientId: firstClient.client_id,
      authorizationSessionKey: "first-session",
    });
    createActiveProjectExecution(stateDir, {
      principalId: firstGrant.principalId,
      clientId: firstGrant.clientId,
      grantId: firstGrant.grantId,
      authorizationEpoch: firstGrant.authorizationEpoch,
    }, "coexisting-execution");
    const secondGrant = oauth.createAuthorizationGrant({
      clientId: secondClient.client_id,
      scopes: ["project:read", "project:write"],
      allowedRootIds: ["root-second"],
    });
    const reauthorization = oauth.createAuthorizationGrant({
      clientId: firstClient.client_id,
      scopes: ["project:read"],
      allowedRootIds: ["root-reauthorized"],
    });

    assert.equal(firstGrant.principalId, "owner");
    assert.equal(secondGrant.principalId, "owner");
    assert.equal(reauthorization.principalId, "owner");
    for (const created of [secondGrant, reauthorization]) {
      assert.deepEqual(created.revokedAuthorizations, []);
      assert.deepEqual(created.authorizationCleanup, emptyAuthorizationCleanup());
    }
    assert.ok(oauth.getAuthorizationGrant(firstGrant.grantId));
    assert.ok(oauth.getAuthorizationGrant(secondGrant.grantId));
    assert.ok(oauth.getAuthorizationGrant(reauthorization.grantId));
    assert.ok(oauth.getAccessToken("first-access"));
    assert.ok(oauth.getRefreshToken("first-refresh"));
    assert.ok(oauth.getAuthorizationCode("first-code", firstClient.client_id));
    assert.ok(oauth.getAuthorizationSelection(
      "first-selection",
      firstClient.client_id,
      "first-session",
    ));
    assert.equal(oauth.principalForClient(firstClient.client_id), "owner");
    assert.equal(oauth.principalForClient(secondClient.client_id), "owner");

    const database = openDatabase(stateDir);
    try {
      assert.equal(
        database.sqlite.prepare(
          "select count(*) from oauth_grants where revoked_at is null",
        ).pluck().get(),
        3,
      );
      assert.equal(
        database.sqlite.prepare(`
          select status from project_executions where execution_id = 'coexisting-execution'
        `).pluck().get(),
        "active",
      );
      assert.deepEqual(
        database.sqlite.prepare(
          "select principal_id, revoked_at from connection_principals",
        ).all(),
        [{ principal_id: "owner", revoked_at: null }],
      );
      assert.equal(
        database.sqlite.prepare(
          "select count(*) from sqlite_master where type = 'table' and name = 'oauth_principal_reconnect_codes'",
        ).pluck().get(),
        0,
      );
    } finally {
      database.close();
    }
  } finally {
    oauth.close();
  }
}

async function testProjectCentricRequestAuthorization(stateDir: string): Promise<void> {
  const provider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  try {
    const client = await provider.clientsStore.registerClient?.({
      redirect_uris: [redirectUri],
      client_name: "Project-centric authorization",
    });
    assert.ok(client);
    const accessToken = "project-centric-access-token";
    const store = new SqliteOAuthStore(stateDir);
    let grant: OAuthGrantCreationResult;
    try {
      grant = store.createAuthorizationGrant({
        clientId: client.client_id,
        scopes: ["project:read"],
        allowedRootIds: ["root-project-a"],
      });
      store.saveAccessToken(hashToken(accessToken), {
        clientId: client.client_id,
        grantId: grant.grantId,
        principalId: grant.principalId,
        authorizationEpoch: grant.authorizationEpoch,
        scopes: ["project:read"],
        expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
      });
    } finally {
      store.close();
    }

    const authInfo = await provider.verifyAccessToken(accessToken);
    const authorization = provider.authorizeRequest(authInfo);
    assert.deepEqual(authorization, {
      clientId: client.client_id,
      grantId: grant.grantId,
      connectionPrincipalId: grant.principalId,
      authorizationEpoch: grant.authorizationEpoch,
      scopes: ["project:read"],
      allowedRootIds: ["root-project-a"],
    });

    assert.throws(
      () => provider.authorizeRequest({
        ...authInfo,
        clientId: "different-client",
      }),
      InvalidTokenError,
    );
    assert.throws(
      () => provider.authorizeRequest({
        ...authInfo,
        extra: {
          ...authInfo.extra,
          "devspace/principal-id": "different-principal",
        },
      }),
      InvalidTokenError,
    );
    assert.throws(
      () => provider.authorizeRequest({
        ...authInfo,
        extra: {
          ...authInfo.extra,
          "devspace/authorization-epoch": grant.authorizationEpoch + 1,
        },
      }),
      InvalidTokenError,
    );
    assert.throws(
      () => provider.authorizeRequest({
        ...authInfo,
        scopes: ["project:read", "project:write"],
      }),
      InvalidTokenError,
    );

    const replacementStore = new SqliteOAuthStore(stateDir);
    try {
      replacementStore.createAuthorizationGrant({
        clientId: client.client_id,
        scopes: ["project:read"],
        allowedRootIds: ["root-project-b"],
      });
    } finally {
      replacementStore.close();
    }
    assert.equal(provider.authorizeRequest(authInfo).grantId, grant.grantId);
  } finally {
    provider.close();
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
      authorizationLimits: 1,
      authorizationSelections: 0,
      authorizationCodes: 0,
      unapprovedClients: 0,
      staleGrants: 0,
      authorizationCleanup: emptyAuthorizationCleanup(),
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
    accessToken: { clientId: client.client_id, scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES], expiresAt: expiredAt },
    refreshTokenHash: "expired-refresh-hash",
    refreshToken: { clientId: client.client_id, scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES], expiresAt: expiredAt },
  });
  assert.deepEqual(store.diagnosticSnapshot(expiredAt + 1), {
    clients: 1,
    grants: 1,
    principals: 1,
    accessTokens: 1,
    refreshTokens: 1,
    workspaceCleanupJobs: 0,
    expiredAccessTokens: 1,
    expiredRefreshTokens: 1,
    legacyWildcardGrants: 1,
  });
  assert.deepEqual(store.cleanupExpired(expiredAt + 1), {
    accessTokens: 1,
    refreshTokens: 1,
    authorizationLimits: 0,
    authorizationSelections: 0,
    authorizationCodes: 0,
    unapprovedClients: 0,
    staleGrants: 0,
    authorizationCleanup: emptyAuthorizationCleanup(),
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

function testStaleGrantRetainsProjectInventory(stateDir: string): void {
  const oauth = new SqliteOAuthStore(stateDir);
  const clients = new SqliteOAuthClientsStore(oauth, oauthConfig.allowedRedirectHosts);
  const client = clients.registerClient({ redirect_uris: [redirectUri] });
  const grant = oauth.createAuthorizationGrant({
    clientId: client.client_id,
    scopes: ["project:read"],
  });
  const authorization = {
    principalId: grant.principalId,
    clientId: grant.clientId,
    grantId: grant.grantId,
    authorizationEpoch: grant.authorizationEpoch,
  };
  createActiveProjectExecution(stateDir, authorization, "stale-grant-execution");
  const database = openDatabase(stateDir);
  try {
    database.sqlite.prepare(`
      update oauth_grants
      set created_at = '2020-01-01T00:00:00.000Z'
      where grant_id = ?
    `).run(grant.grantId);
  } finally {
    database.close();
  }

  const firstCleanup = oauth.cleanupExpired(Math.floor(Date.now() / 1_000));
  assert.equal(firstCleanup.staleGrants, 0);
  assert.ok(oauth.getAuthorizationGrant(grant.grantId));

  const executions = new ProjectExecutionStore(stateDir);
  try {
    assert.equal(executions.markRevoked(authorization, "test cleanup"), 1);
  } finally {
    executions.close();
  }
  const secondCleanup = oauth.cleanupExpired(Math.floor(Date.now() / 1_000));
  assert.equal(secondCleanup.staleGrants, 1);
  const retained = openDatabase(stateDir);
  try {
    assert.equal(
      retained.sqlite.prepare(`
        select count(*) from project_executions
        where execution_id = 'stale-grant-execution' and status = 'revoked'
      `).pluck().get(),
      1,
    );
  } finally {
    retained.close();
    oauth.close();
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
          where not exists (
            select 1 from oauth_grants as grant
            where grant.client_id = oauth_clients.client_id
          )
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
  const closed = workspaces.createSession({
    id: "closed-workspace",
    connectionPrincipalId: principalId,
    root: "/workspace/closed",
  });
  assert.equal(workspaces.closeSession(closed.id, principalId), true);

  assert.deepEqual(oauth.revokeAll(), {
    clients: 1,
    grants: 1,
    accessTokens: 0,
    refreshTokens: 0,
    workspaceCleanupJobs: 2,
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
    ]);
    const checkoutJob = jobs.find(({ workspaceId }) => workspaceId === "revoked-checkout")!;
    const firstClaim = restarted.claimRevocationCleanupJob(checkoutJob.id, { now: 1_000, leaseMs: 100 });
    assert.equal(firstClaim?.attempts, 1);
    assert.equal(restarted.claimRevocationCleanupJob(checkoutJob.id, { now: 1_050, leaseMs: 100 }), undefined);
    const reclaimed = restarted.claimRevocationCleanupJob(checkoutJob.id, { now: 1_101, leaseMs: 100 });
    assert.equal(reclaimed?.attempts, 2);
    assert.notEqual(reclaimed?.claimToken, firstClaim?.claimToken);
    assert.equal(restarted.finalizeRevocationCleanupJob({
      id: checkoutJob.id,
      claimToken: firstClaim!.claimToken!,
      now: 1_102,
    }), false);
    assert.equal(restarted.failRevocationCleanupJob({
      id: checkoutJob.id,
      claimToken: reclaimed!.claimToken!,
      error: "temporary cleanup failure",
      now: 1_103,
    }), true);
    const finalClaim = restarted.claimRevocationCleanupJob(checkoutJob.id, { now: 1_104 });
    assert.equal(finalClaim?.attempts, 3);
    assert.equal(restarted.finalizeRevocationCleanupJob({
      id: checkoutJob.id,
      claimToken: finalClaim!.claimToken!,
      now: 1_105,
    }), true);
    assert.equal(restarted.finalizeRevocationCleanupJob({
      id: checkoutJob.id,
      claimToken: finalClaim!.claimToken!,
      now: 1_105,
    }), false);

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
    assert.deepEqual(restarted.listRevocationDirtyWorktreeArtifacts(), []);
    assert.deepEqual(restarted.cleanupRevocationHistory("9999-01-01T00:00:00.000Z", 1), {
      jobs: 1,
      workspaceSessions: 1,
    });
    assert.deepEqual(restarted.cleanupRevocationHistory("9999-01-01T00:00:00.000Z", 10), {
      jobs: 1,
      workspaceSessions: 1,
    });
    assert.equal(restarted.listRevocationDirtyWorktreeArtifacts().length, 0);
  } finally {
    restarted.close();
  }
  const beforePrincipalCleanup = openDatabase(stateDir);
  try {
    assert.equal(beforePrincipalCleanup.sqlite.prepare(`
      select count(*)
      from connection_principals
      where principal_id = ? and revoked_at is null
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
    `).pluck().get(principalId), 1);
  } finally {
    afterPrincipalCleanup.close();
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
    scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
    resource: mcpUrl,
  };

  try {
    for (const response of [
      fakeAuthorizationResponse("GET"),
      fakeAuthorizationResponse("POST", { owner_token: "wrong" }),
      fakeAuthorizationResponse("POST", { owner_token: ownerPassword }),
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
      authorizationLimits: 0,
      authorizationSelections: 0,
      unapprovedClients: 0,
      staleGrants: 0,
      authorizationCodes: 1,
      authorizationCleanup: emptyAuthorizationCleanup(),
    });
  } finally {
    provider.close();
  }
}

async function testApprovalHidesPrincipalManagementAndPreservesAuthorization(
  stateDir: string,
): Promise<void> {
  const authorizationRoot = { id: "root-approved", path: stateDir, label: "Approved Project" };
  const boundaryChanges: unknown[] = [];
  const provider = new SingleUserOAuthProvider(
    { ...oauthConfig, resourceRoots: () => [authorizationRoot] },
    mcpUrl,
    stateDir,
    undefined,
    (change) => {
      boundaryChanges.push(change);
    },
  );
  try {
    const oldClient = await provider.clientsStore.registerClient?.({
      redirect_uris: [redirectUri],
      client_name: "Previous authorization",
    });
    const replacementClient = await provider.clientsStore.registerClient?.({
      redirect_uris: [redirectUri],
      client_name: "Replacement authorization",
    });
    assert.ok(oldClient);
    assert.ok(replacementClient);
    const store = new SqliteOAuthStore(stateDir);
    const oldGrant = store.createAuthorizationGrant({
      clientId: oldClient.client_id,
      scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
      allowedRootIds: [authorizationRoot.id],
    });
    store.close();

    const approval = fakeAuthorizationResponse("POST", { owner_token: ownerPassword });
    await provider.authorize(replacementClient, {
      redirectUri,
      codeChallenge: "replacement-approval-challenge",
      scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
      resource: mcpUrl,
    }, approval.response);
    assert.equal((approval.response as unknown as { statusCode: number }).statusCode, 200);
    const html = approval.sentBody ?? "";
    assert.doesNotMatch(
      html,
      /reconnect|transfer|share|target_principal_id|connection_mode|runtime security posture|sandbox/iu,
    );
    const selectionToken = html.match(
      /name="selection_token" value="([A-Za-z0-9_-]+)"/u,
    )?.[1];
    assert.ok(selectionToken);

    const selection = fakeAuthorizationResponse("POST", {
      selection_token: selectionToken,
      root_id: authorizationRoot.id,
    });
    await provider.authorize(replacementClient, {
      redirectUri,
      codeChallenge: "replacement-approval-challenge",
      scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
      resource: mcpUrl,
    }, selection.response);
    assert.equal(
      (selection.response as unknown as { statusCode: number }).statusCode,
      302,
    );
    assert.deepEqual(boundaryChanges, []);
    const restored = new SqliteOAuthStore(stateDir);
    try {
      assert.ok(restored.getAuthorizationGrant(oldGrant.grantId));
    } finally {
      restored.close();
    }
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
      scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
      expiresAt,
    });

    assert.equal(
      store.saveTokenPair(
        {
          accessTokenHash: "new-access-hash",
          accessToken: { clientId: client.client_id, scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES], expiresAt },
          refreshTokenHash: "new-refresh-hash",
          refreshToken: { clientId: client.client_id, scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES], expiresAt },
        },
        "old-refresh-hash",
      ),
      true,
    );
    assert.equal(store.getRefreshToken("old-refresh-hash"), undefined);
    assert.ok(store.getAccessToken("new-access-hash"));
    const rotatedRefresh = store.getRefreshToken("new-refresh-hash");
    assert.ok(rotatedRefresh);
    const tombstone = store.getRefreshTokenTombstone("old-refresh-hash");
    assert.ok(tombstone);
    assert.equal(tombstone.familyId, rotatedRefresh.familyId);

    assert.equal(
      store.saveTokenPair(
        {
          accessTokenHash: "losing-access-hash",
          accessToken: { clientId: client.client_id, scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES], expiresAt },
          refreshTokenHash: "losing-refresh-hash",
          refreshToken: { clientId: client.client_id, scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES], expiresAt },
        },
        "old-refresh-hash",
      ),
      false,
    );
    assert.equal(store.getAccessToken("losing-access-hash"), undefined);
    assert.equal(store.getRefreshToken("losing-refresh-hash"), undefined);

    const firstGrantToken = store.getRefreshToken("new-refresh-hash");
    assert.ok(firstGrantToken);
    const secondGrant = store.createAuthorizationGrant({
      clientId: client.client_id,
      scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
    });
    assert.ok(store.getAccessToken("new-access-hash"));
    assert.ok(store.getRefreshToken("new-refresh-hash"));
    store.saveTokenPair({
      accessTokenHash: "second-grant-access-hash",
      accessToken: {
        clientId: client.client_id,
        grantId: secondGrant.grantId,
        principalId: secondGrant.principalId,
        authorizationEpoch: secondGrant.authorizationEpoch,
        scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
        expiresAt,
      },
      refreshTokenHash: "second-grant-refresh-hash",
      refreshToken: {
        clientId: client.client_id,
        grantId: secondGrant.grantId,
        principalId: secondGrant.principalId,
        authorizationEpoch: secondGrant.authorizationEpoch,
        familyId: tombstone.familyId,
        scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
        expiresAt,
      },
    });
    assert.throws(
      () => store.saveTokenPair({
        accessTokenHash: "cross-grant-access-hash",
        accessToken: {
          clientId: client.client_id,
          grantId: firstGrantToken.grantId,
          principalId: firstGrantToken.principalId,
          authorizationEpoch: firstGrantToken.authorizationEpoch,
          scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
          expiresAt,
        },
        refreshTokenHash: "cross-grant-refresh-hash",
        refreshToken: {
          clientId: client.client_id,
          grantId: secondGrant.grantId,
          principalId: secondGrant.principalId,
          authorizationEpoch: secondGrant.authorizationEpoch,
          scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
          expiresAt,
        },
      }),
      /same authorization grant/,
    );
    assert.equal(store.getAccessToken("cross-grant-access-hash"), undefined);
    assert.equal(store.getRefreshToken("cross-grant-refresh-hash"), undefined);

    const revoked = store.revokeRefreshTokenFamilyOnReplay(tombstone);
    assert.deepEqual(revoked, {
      changed: true,
      connectionPrincipalId: tombstone.principalId,
      grantId: tombstone.grantId,
      authorizationCleanup: {
        ...emptyAuthorizationCleanup(),
        revokedAuthorizations: [{
          principalId: tombstone.principalId,
          grantId: tombstone.grantId,
          authorizationEpoch: tombstone.authorizationEpoch,
        }],
      },
    });
    assert.equal(store.getAccessToken("new-access-hash"), undefined);
    assert.equal(store.getRefreshToken("new-refresh-hash"), undefined);
    assert.ok(store.getAuthorizationGrant(secondGrant.grantId));
    assert.ok(store.getAccessToken("second-grant-access-hash"));
    assert.ok(store.getRefreshToken("second-grant-refresh-hash"));
  } finally {
    store.close();
  }
}

async function testRefreshReplayRevokesFamily(stateDir: string): Promise<void> {
  const auditEvents: OAuthAuditEvent[] = [];
  const boundaryChanges: Array<{ connectionPrincipalId: string; reason: string }> = [];
  const provider = new SingleUserOAuthProvider(
    oauthConfig,
    mcpUrl,
    stateDir,
    (event) => auditEvents.push(event),
    (change) => {
      boundaryChanges.push(change);
    },
  );
  try {
    const client = await provider.clientsStore.registerClient?.({
      redirect_uris: [redirectUri],
      client_name: "Refresh replay client",
    });
    assert.ok(client);
    const issued = (await authorizeAndExchange(provider, client, "refresh-replay-initial")).tokens;
    assert.ok(issued.refresh_token);
    const initialContext = provider.authorizeRequest(await provider.verifyAccessToken(issued.access_token));
    createActiveProjectExecution(stateDir, {
      principalId: initialContext.connectionPrincipalId,
      clientId: client.client_id,
      grantId: initialContext.grantId,
      authorizationEpoch: initialContext.authorizationEpoch,
    }, "replay-execution");
    const refreshed = await provider.exchangeRefreshToken(
      client,
      issued.refresh_token,
      [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
      mcpUrl,
    );
    assert.ok(refreshed.refresh_token);

    await assert.rejects(
      provider.exchangeRefreshToken(
        client,
        issued.refresh_token,
        [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
        mcpUrl,
      ),
      /replay detected/iu,
    );
    assert.equal(
      auditEvents.some((event) =>
        event.event === "oauth_refresh_token_replay_detected" &&
        event.connectionPrincipalId === initialContext.connectionPrincipalId),
      true,
    );
    assert.deepEqual(boundaryChanges.at(-1), {
      connectionPrincipalId: initialContext.connectionPrincipalId,
      reason: "refresh_token_replay",
      revokedAuthorizations: [{
        principalId: initialContext.connectionPrincipalId,
        grantId: initialContext.grantId,
        authorizationEpoch: initialContext.authorizationEpoch,
      }],
    });
    assertProjectExecutionCleanupPersisted(
      stateDir,
      "replay-execution",
      initialContext,
    );
    await assert.rejects(provider.verifyAccessToken(refreshed.access_token), InvalidTokenError);
    await assert.rejects(
      provider.exchangeRefreshToken(
        client,
        refreshed.refresh_token,
        [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
        mcpUrl,
      ),
      InvalidGrantError,
    );
  } finally {
    provider.close();
  }
}

async function testAbsoluteGrantLifetime(stateDir: string): Promise<void> {
  const grantLifetimeSeconds = 120;
  const provider = new SingleUserOAuthProvider(
    { ...oauthConfig, grantMaxLifetimeSeconds: grantLifetimeSeconds },
    mcpUrl,
    stateDir,
  );
  try {
    const client = await provider.clientsStore.registerClient?.({
      redirect_uris: [redirectUri],
      client_name: "Absolute lifetime client",
    });
    assert.ok(client);
    const issued = (await authorizeAndExchange(provider, client, "absolute-lifetime")).tokens;
    assert.ok(issued.refresh_token);
    assert.equal((issued.expires_in ?? 0) > 0, true);
    assert.equal((issued.expires_in ?? 0) <= grantLifetimeSeconds, true);

    const coexistingStore = new SqliteOAuthStore(stateDir);
    const coexistingGrant = coexistingStore.createAuthorizationGrant({
      clientId: client.client_id,
      scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
    });
    coexistingStore.saveAccessToken("coexisting-lifetime-access", {
      clientId: client.client_id,
      grantId: coexistingGrant.grantId,
      principalId: coexistingGrant.principalId,
      authorizationEpoch: coexistingGrant.authorizationEpoch,
      scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    });
    coexistingStore.close();

    const database = openDatabase(stateDir);
    try {
      const grant = database.sqlite.prepare(`
        select grant_id as grantId, absolute_expires_at as absoluteExpiresAt
        from oauth_grants
        where client_id = ? and revoked_at is null and absolute_expires_at is not null
      `).get(client.client_id) as { grantId: string; absoluteExpiresAt: number };
      const now = Math.floor(Date.now() / 1_000);
      assert.equal(grant.absoluteExpiresAt > now, true);
      assert.equal(grant.absoluteExpiresAt <= now + grantLifetimeSeconds, true);
      const tokenExpiries = database.sqlite.prepare(`
        select
          (select expires_at from oauth_access_tokens where grant_id = @grantId) as accessExpiresAt,
          (select expires_at from oauth_refresh_tokens where grant_id = @grantId) as refreshExpiresAt
      `).get({ grantId: grant.grantId }) as { accessExpiresAt: number; refreshExpiresAt: number };
      assert.equal(tokenExpiries.accessExpiresAt <= grant.absoluteExpiresAt, true);
      assert.equal(tokenExpiries.refreshExpiresAt <= grant.absoluteExpiresAt, true);
      createActiveProjectExecution(stateDir, {
        principalId: "owner",
        clientId: client.client_id,
        grantId: grant.grantId,
        authorizationEpoch: 1,
      }, "expired-execution");
      database.sqlite.prepare(
        "update oauth_grants set absolute_expires_at = ? where grant_id = ?",
      ).run(now - 1, grant.grantId);
    } finally {
      database.close();
    }

    const cleanup = provider.cleanupExpired(Math.floor(Date.now() / 1_000));
    assert.deepEqual(
      cleanup.authorizationCleanup.revokedExecutions.map(
        ({ executionId, workspaceRoot }) => ({ executionId, workspaceRoot }),
      ),
      [{
        executionId: "expired-execution",
        workspaceRoot: "/private/tmp/source/expired-execution",
      }],
    );
    assert.equal(cleanup.authorizationCleanup.workspaceCleanupJobs.length, 1);
    await assert.rejects(provider.verifyAccessToken(issued.access_token), InvalidTokenError);
    await assert.rejects(
      provider.exchangeRefreshToken(
        client,
        issued.refresh_token,
        [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
        mcpUrl,
      ),
      InvalidGrantError,
    );
    const survivingStore = new SqliteOAuthStore(stateDir);
    try {
      assert.ok(survivingStore.getAuthorizationGrant(coexistingGrant.grantId));
      assert.ok(survivingStore.getAccessToken("coexisting-lifetime-access"));
    } finally {
      survivingStore.close();
    }
  } finally {
    provider.close();
  }
}

async function testProviderRestartRotationAndRevocation(stateDir: string): Promise<void> {
  const firstProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  const client = await firstProvider.clientsStore.registerClient?.({
    redirect_uris: [redirectUri],
    client_name: "ChatGPT",
  });
  assert.ok(client);

  const issued = (await authorizeAndExchange(firstProvider, client, "challenge")).tokens;
  assert.ok(issued.refresh_token);
  firstProvider.close();

  const secondProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  try {
    const verified = await secondProvider.verifyAccessToken(issued.access_token);
    assert.equal(verified.clientId, client.client_id);

    const refreshed = await secondProvider.exchangeRefreshToken(
      client,
      issued.refresh_token,
      [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
      mcpUrl,
    );
    assert.ok(refreshed.refresh_token);
    assert.notEqual(refreshed.access_token, issued.access_token);

    const foreignClient = await secondProvider.clientsStore.registerClient?.({
      redirect_uris: [redirectUri],
      client_name: "Foreign revocation client",
      token_endpoint_auth_method: "none",
    });
    assert.ok(foreignClient);
    await secondProvider.revokeToken(foreignClient, { token: refreshed.access_token });
    assert.equal(
      (await secondProvider.verifyAccessToken(refreshed.access_token)).clientId,
      client.client_id,
      "a foreign client revocation must not delete the token",
    );
    await secondProvider.revokeToken(foreignClient, { token: refreshed.refresh_token });

    const afterForeignRevocation = await secondProvider.exchangeRefreshToken(
      client,
      refreshed.refresh_token,
      [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
      mcpUrl,
    );
    assert.ok(afterForeignRevocation.refresh_token);

    await secondProvider.revokeToken(client, { token: afterForeignRevocation.access_token });
    await assert.rejects(
      secondProvider.verifyAccessToken(afterForeignRevocation.access_token),
      InvalidTokenError,
    );

    await secondProvider.revokeToken(client, { token: afterForeignRevocation.refresh_token });
    await assert.rejects(
      secondProvider.exchangeRefreshToken(
        client,
        afterForeignRevocation.refresh_token,
        [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
        mcpUrl,
      ),
      InvalidGrantError,
    );

    await assert.rejects(
      secondProvider.exchangeRefreshToken(client, issued.refresh_token, [...DEFAULT_DEVSPACE_OAUTH_SCOPES], mcpUrl),
      InvalidGrantError,
    );
  } finally {
    secondProvider.close();
  }
}

async function testPartialOwnerCredentialMigrationPreservesTokens(stateDir: string): Promise<void> {
  const firstProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  const client = await firstProvider.clientsStore.registerClient?.({
    redirect_uris: [redirectUri],
    client_name: "Partial migration client",
  });
  assert.ok(client);
  const issued = (await authorizeAndExchange(firstProvider, client, "partial-migration")).tokens;
  assert.ok(issued.refresh_token);
  const before = firstProvider.diagnosticSnapshot();
  firstProvider.close();

  downgradeOwnerCredentialToLegacy(stateDir, ownerPassword);
  const passwordHash = hashOwnerPassword(ownerPassword);
  const migratedProvider = new SingleUserOAuthProvider(
    {
      ...oauthConfig,
      ownerCredential: { passwordHash },
      keys: createSecurityKeyring({
        masterKey: legacyMasterKeyFromOwnerPassword(ownerPassword),
        derivation: "legacy-direct",
        source: "auth_file",
      }),
    },
    mcpUrl,
    stateDir,
  );
  try {
    assert.equal(migratedProvider.ownerCredentialChanged, false);
    assert.equal(migratedProvider.ownerCredentialUpgraded, true);
    const verified = await migratedProvider.verifyAccessToken(issued.access_token);
    assert.equal(verified.clientId, client.client_id);
    assert.deepEqual(migratedProvider.diagnosticSnapshot(), before);

    const refreshed = await migratedProvider.exchangeRefreshToken(
      client,
      issued.refresh_token,
      [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
      mcpUrl,
    );
    assert.ok(refreshed.access_token);
    assert.ok(refreshed.refresh_token);
    const afterRefresh = migratedProvider.diagnosticSnapshot();
    assert.equal(afterRefresh.clients, before.clients);
    assert.equal(afterRefresh.grants, before.grants);
    assert.equal(afterRefresh.principals, before.principals);
    assert.equal(afterRefresh.accessTokens, before.accessTokens + 1);
    assert.equal(afterRefresh.refreshTokens, before.refreshTokens);
    assert.equal(afterRefresh.workspaceCleanupJobs, before.workspaceCleanupJobs);
  } finally {
    migratedProvider.close();
  }

  const database = openDatabase(stateDir);
  try {
    const credential = database.sqlite
      .prepare("select salt, verifier from oauth_owner_credential where id = 1")
      .get() as { salt: string; verifier: string };
    assert.equal(credential.salt, "argon2id-v1");
    assert.equal(credential.verifier, passwordHash);
  } finally {
    database.close();
  }
}

async function testPartialOwnerCredentialMigrationRejectsMismatchedHash(
  stateDir: string,
): Promise<void> {
  const firstProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  const client = await firstProvider.clientsStore.registerClient?.({
    redirect_uris: [redirectUri],
    client_name: "Partial migration mismatch client",
  });
  assert.ok(client);
  const issued = (await authorizeAndExchange(firstProvider, client, "partial-mismatch")).tokens;
  firstProvider.close();

  downgradeOwnerCredentialToLegacy(stateDir, ownerPassword);
  const differentPasswordHash = hashOwnerPassword("different-owner-token-that-is-long-enough");
  const changedProvider = new SingleUserOAuthProvider(
    {
      ...oauthConfig,
      ownerCredential: { passwordHash: differentPasswordHash },
      keys: createSecurityKeyring({
        masterKey: legacyMasterKeyFromOwnerPassword(ownerPassword),
        derivation: "legacy-direct",
        source: "auth_file",
      }),
    },
    mcpUrl,
    stateDir,
  );
  try {
    assert.equal(changedProvider.ownerCredentialChanged, true);
    assert.equal(changedProvider.ownerCredentialUpgraded, false);
    await assert.rejects(changedProvider.verifyAccessToken(issued.access_token), InvalidTokenError);
    assert.equal(changedProvider.diagnosticSnapshot().accessTokens, 0);
    assert.equal(changedProvider.diagnosticSnapshot().refreshTokens, 0);
  } finally {
    changedProvider.close();
  }
}

function downgradeOwnerCredentialToLegacy(stateDir: string, password: string): void {
  const salt = Buffer.from("devspace-partial-owner-migration-test", "utf8").toString("base64url");
  const verifier = scryptSync(password, Buffer.from(salt, "base64url"), 32).toString("base64url");
  const database = openDatabase(stateDir);
  try {
    database.sqlite.prepare(`
      update oauth_owner_credential
      set salt = ?, verifier = ?, updated_at = ?
      where id = 1
    `).run(salt, verifier, new Date().toISOString());
  } finally {
    database.close();
  }
}

async function testOwnerCredentialChangeAndRevokeAll(stateDir: string): Promise<void> {
  const firstProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  const client = await firstProvider.clientsStore.registerClient?.({ redirect_uris: [redirectUri] });
  assert.ok(client);
  const tokens = (await authorizeAndExchange(firstProvider, client, "owner-change")).tokens;
  const context = firstProvider.authorizeRequest(
    await firstProvider.verifyAccessToken(tokens.access_token),
  );
  createActiveProjectExecution(stateDir, {
    principalId: context.connectionPrincipalId,
    clientId: client.client_id,
    grantId: context.grantId,
    authorizationEpoch: context.authorizationEpoch,
  }, "revoke-all-execution");
  assert.deepEqual(firstProvider.diagnosticSnapshot(), {
    clients: 1,
    grants: 1,
    principals: 1,
    accessTokens: 1,
    refreshTokens: 1,
    workspaceCleanupJobs: 0,
    expiredAccessTokens: 0,
    expiredRefreshTokens: 0,
    legacyWildcardGrants: 1,
  });
  assert.deepEqual(firstProvider.revokeAll(), {
    clients: 1,
    grants: 1,
    accessTokens: 1,
    refreshTokens: 1,
    workspaceCleanupJobs: 1,
  });
  assert.equal(await firstProvider.clientsStore.getClient?.(client.client_id), undefined);
  assertProjectExecutionCleanupPersisted(
    stateDir,
    "revoke-all-execution",
    context,
  );
  await assert.rejects(firstProvider.verifyAccessToken(tokens.access_token), InvalidTokenError);

  const replacement = await firstProvider.clientsStore.registerClient?.({ redirect_uris: [redirectUri] });
  assert.ok(replacement);
  const replacementTokens = (
    await authorizeAndExchange(firstProvider, replacement, "replacement")
  ).tokens;
  firstProvider.close();

  const changedProvider = new SingleUserOAuthProvider(
    {
      ...oauthConfig,
      ownerCredential: { password: "different-owner-token-that-is-long-enough" },
    },
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
      grants: 1,
      principals: 1,
      accessTokens: 0,
      refreshTokens: 0,
      workspaceCleanupJobs: 1,
      expiredAccessTokens: 0,
      expiredRefreshTokens: 0,
      legacyWildcardGrants: 1,
    });
  } finally {
    changedProvider.close();
  }

  const database = openDatabase(stateDir);
  try {
    const credential = database.sqlite
      .prepare("select salt, verifier from oauth_owner_credential where id = 1")
      .get() as { salt: string; verifier: string };
    assert.equal(credential.salt, "argon2id-v1");
    assert.match(credential.verifier, /^\$argon2id\$/u);
    assert.notEqual(credential.verifier, ownerPassword);
    assert.notEqual(credential.verifier, "different-owner-token-that-is-long-enough");
  } finally {
    database.close();
  }
}

function fakeAuthorizationResponse(method: string, body: Record<string, string> = {}): {
  response: Response;
  headers: Map<string, string>;
  readonly redirectLocation?: string;
  readonly sentBody?: string;
} {
  const headers = new Map<string, string>();
  let redirectLocation: string | undefined;
  let sentBody: string | undefined;
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
    send(body: string) {
      sentBody = body;
      return this;
    },
    redirect(code: number, location: string) {
      this.statusCode = code;
      redirectLocation = location;
    },
  };
  return {
    response: response as unknown as Response,
    headers,
    get redirectLocation() {
      return redirectLocation;
    },
    get sentBody() {
      return sentBody;
    },
  };
}

async function authorizeAndExchange(
  provider: SingleUserOAuthProvider,
  client: OAuthClientInformationFull,
  codeChallenge: string,
): Promise<{ tokens: OAuthTokens; approval: ReturnType<typeof fakeAuthorizationResponse> }> {
  const approval = fakeAuthorizationResponse("POST", {
    owner_token: ownerPassword,
  });
  await provider.authorize(client, {
    redirectUri,
    codeChallenge,
    scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES],
    resource: mcpUrl,
  }, approval.response);
  assert.equal((approval.response as unknown as { statusCode: number }).statusCode, 302);
  assert.ok(approval.redirectLocation);
  const code = new URL(approval.redirectLocation).searchParams.get("code");
  assert.ok(code);
  const tokens = await provider.exchangeAuthorizationCode(
    client,
    code,
    undefined,
    redirectUri,
    mcpUrl,
  );
  return { tokens, approval };
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

function emptyAuthorizationCleanup() {
  return {
    revokedAuthorizations: [],
    revokedExecutions: [],
    workspaceCleanupJobs: [],
  };
}

function createActiveProjectExecution(
  stateDir: string,
  authorization: ProjectExecutionAuthorization,
  executionId: string,
): void {
  const executions = new ProjectExecutionStore(stateDir, {
    createExecutionId: () => executionId,
  });
  const workspaces = new SqliteWorkspaceStore(stateDir);
  try {
    const canonicalSourceRoot = `/private/tmp/source/${executionId}`;
    const workspace = workspaces.createSession({
      id: `workspace-${executionId}`,
      connectionPrincipalId: authorization.principalId,
      alias: `execution-${executionId}`,
      root: canonicalSourceRoot,
      writeAccess: "read_write",
    });
    const reserved = executions.reserve({
      ...authorization,
      projectRef: `project-${executionId}`,
      projectFingerprint: `fingerprint-${executionId}`,
      sourceRoot: canonicalSourceRoot,
      canonicalSourceRoot,
      createOperationId: `create-${executionId}`,
      requestHash: `request-${executionId}`,
    });
    assert.equal(reserved.status, "new");
    if (reserved.status !== "new") return;
    assert.equal(executions.activate(executionId, authorization, {
      workspaceId: workspace.id,
    })?.status, "active");
  } finally {
    workspaces.close();
    executions.close();
  }
}

function assertProjectExecutionCleanupPersisted(
  stateDir: string,
  executionId: string,
  authorization: {
    connectionPrincipalId: string;
    grantId: string;
    authorizationEpoch: number;
  },
): void {
  const database = openDatabase(stateDir);
  try {
    assert.deepEqual(database.sqlite.prepare(`
      select status, principal_id as principalId, grant_id as grantId,
        authorization_epoch as authorizationEpoch
      from project_executions
      where execution_id = ?
    `).get(executionId), {
      status: "revoked",
      principalId: authorization.connectionPrincipalId,
      grantId: authorization.grantId,
      authorizationEpoch: authorization.authorizationEpoch,
    });
    assert.deepEqual(database.sqlite.prepare(`
      select project_execution_id as projectExecutionId,
        workspace_id as workspaceId, workspace_root as workspaceRoot, status
      from oauth_revocation_cleanup_jobs
      where project_execution_id = ?
    `).get(executionId), {
      projectExecutionId: executionId,
      workspaceId: `workspace-${executionId}`,
      workspaceRoot: `/private/tmp/source/${executionId}`,
      status: "pending",
    });
  } finally {
    database.close();
  }
}
