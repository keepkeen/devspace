import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import {
  internalConfigReloadToken,
  internalDiagnosticsToken,
  internalRevocationToken,
} from "./internal-auth.js";
import {
  createRuntimeControlPlane,
  createRuntimeReadinessPlane,
  type RuntimeControlPlaneOptions,
} from "./runtime-control-plane.js";
import { RuntimeDiagnostics } from "./runtime-diagnostics.js";

const ownerToken = "runtime-control-plane-owner-token";
const diagnostics = new RuntimeDiagnostics();
diagnostics.recordFailure("test_failure", new TypeError("not exposed"));
let revocationCount = 0;
let loggedRevocationCount = 0;
let rootsReloadCount = 0;
let rootsCleanupPending = 0;
const options: RuntimeControlPlaneOptions = {
  internalAuth: {
    diagnostics: ownerToken,
    configReload: ownerToken,
    revocation: ownerToken,
  },
  generation: "runtime-generation",
  runtimeConfig: { widgets: "changes" },
  allowedRootsRevision: () => "roots-revision-test",
  allowedRootsCleanupPending: () => rootsCleanupPending,
  isClosing: () => false,
  workspaceDatabaseReady: () => true,
  oauthDatabaseReady: () => true,
  mcpUsage: () => ({
    sessions: 2,
    reservations: 1,
    statelessRequests: 1,
    statelessLeases: {
      agesMs: [1_250],
      byOwner: [{
        principalRef: "conn_test",
        clientRef: "oauth_test",
        active: 1,
        oldestLeaseAgeMs: 1_250,
      }],
    },
    limit: 8,
  }),
  processUsage: () => ({ sessions: 3, running: 1, limit: 16 }),
  processOutputUsage: () => ({ outputs: 4, activeOutputs: 1, storedBytes: 1024, droppedBytes: 12, maxStorageBytes: 4096 }),
  workspaceUsage: () => ({ activePersisted: 4, resident: 2, closing: 0, leased: 1, maxResident: 32 }),
  oauthUsage: () => ({
    clients: 1,
    principals: 1,
    accessTokens: 2,
    refreshTokens: 2,
    workspaceCleanupJobs: 0,
    expiredAccessTokens: 1,
    expiredRefreshTokens: 0,
    legacyWildcardGrants: 2,
  }),
  auditWriteHealth: () => ({
    auditWriteFailures: 3,
    lastAuditWriteFailureAt: "2026-07-26T00:00:00.000Z",
  }),
  reloadAllowedRoots: async () => {
    rootsReloadCount += 1;
    return {
      changed: true,
      added: 1,
      removed: 0,
      invalidatedWorkspaces: 0,
      terminatedProcesses: 0,
      cleanupFailures: 0,
      cleanupPending: rootsCleanupPending,
    };
  },
  beforeGlobalRevocation: () => undefined,
  revokeAll: () => {
    revocationCount += 1;
    return { clients: 1, accessTokens: 2, refreshTokens: 2, workspaceCleanupJobs: 0 };
  },
  runtimeDiagnostics: diagnostics,
  onGlobalRevocation: ({ clients }) => {
    loggedRevocationCount += clients;
  },
};
const publicApp = express();
publicApp.use(createRuntimeReadinessPlane(options));
const controlApp = express();
controlApp.use(createRuntimeReadinessPlane(options));
controlApp.use(createRuntimeControlPlane(options));

const publicServer = createServer(publicApp);
const controlServer = createServer(controlApp);
const listen = (server: ReturnType<typeof createServer>) => new Promise<string>((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    assert(address && typeof address !== "string");
    resolveListen(`http://127.0.0.1:${address.port}`);
  });
});

try {
  const [publicOrigin, controlOrigin] = await Promise.all([
    listen(publicServer),
    listen(controlServer),
  ]);
  assert.equal((await fetch(`${publicOrigin}/readyz`)).status, 200);
  assert.equal((await fetch(`${controlOrigin}/readyz`)).status, 200);

  const headers = { "x-devspace-internal-token": internalDiagnosticsToken(ownerToken) };
  assert.equal(
    (await fetch(`${publicOrigin}/internal/diagnostics`, { headers })).status,
    404,
    "the public listener must not register internal control routes even with a valid token",
  );
  const diagnosticsResponse = await fetch(`${controlOrigin}/internal/diagnostics`, { headers });
  assert.equal(diagnosticsResponse.status, 200);
  assert.equal(diagnosticsResponse.headers.get("cache-control"), "no-store");
  const body = await diagnosticsResponse.json() as any;
  assert.equal(body.generation, "runtime-generation");
  assert.deepEqual(body.runtimeConfig, {
    widgets: "changes",
    allowedRootsRevision: "roots-revision-test",
    allowedRootsCleanupPending: 0,
  });
  assert.deepEqual(body.usage.mcpSessions, {
    active: 3,
    stateful: 2,
    statelessRequests: 1,
    reserved: 1,
    limit: 8,
    statelessLeases: {
      agesMs: [1_250],
      byOwner: [{
        principalRef: "conn_test",
        clientRef: "oauth_test",
        active: 1,
        oldestLeaseAgeMs: 1_250,
      }],
    },
  });
  assert.deepEqual(body.usage.processOutput, {
    active: 1024,
    used: 1024,
    limit: 4096,
    outputs: 4,
    activeOutputs: 1,
    droppedBytes: 12,
  });
  assert.deepEqual(body.observability.audit, {
    auditWriteFailures: 3,
    lastAuditWriteFailureAt: "2026-07-26T00:00:00.000Z",
  });
  assert.deepEqual(body.recentFailures, [{
    at: body.recentFailures[0].at,
    event: "test_failure",
    category: "TypeError",
  }]);
  assert.equal(JSON.stringify(body).includes("not exposed"), false);

  assert.equal((await fetch(`${controlOrigin}/internal/config/reload-roots`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`${controlOrigin}/internal/config/reload-roots`, {
    method: "POST",
    headers,
  })).status, 404);
  const rootsReloadResponse = await fetch(`${controlOrigin}/internal/config/reload-roots`, {
    method: "POST",
    headers: { "x-devspace-internal-token": internalConfigReloadToken(ownerToken) },
  });
  assert.equal(rootsReloadResponse.status, 200);
  assert.equal((await rootsReloadResponse.json() as any).reload.changed, true);
  assert.equal(rootsReloadCount, 1);
  rootsCleanupPending = 1;
  assert.equal((await fetch(`${controlOrigin}/internal/config/reload-roots`, {
    method: "POST",
    headers: { "x-devspace-internal-token": internalConfigReloadToken(ownerToken) },
  })).status, 409);

  assert.equal((await fetch(`${controlOrigin}/internal/security/revoke`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ scope: "all_clients_and_tokens" }),
  })).status, 404);
  const revocationHeaders = {
    "x-devspace-internal-token": internalRevocationToken(ownerToken),
    "content-type": "application/json",
  };
  assert.equal((await fetch(`${controlOrigin}/internal/security/revoke`, {
    method: "POST",
    headers: revocationHeaders,
    body: JSON.stringify({ scope: "invalid" }),
  })).status, 400);
  const revokeResponse = await fetch(`${controlOrigin}/internal/security/revoke`, {
    method: "POST",
    headers: revocationHeaders,
    body: JSON.stringify({ scope: "all_clients_and_tokens" }),
  });
  assert.equal(revokeResponse.status, 200);
  assert.equal(revocationCount, 1);
  assert.equal(loggedRevocationCount, 1);
} finally {
  await new Promise<void>((resolveClose, rejectClose) => {
    let remaining = 2;
    let settled = false;
    const complete = (error?: Error) => {
      if (settled) return;
      if (error) {
        settled = true;
        rejectClose(error);
        return;
      }
      remaining -= 1;
      if (remaining === 0) {
        settled = true;
        resolveClose();
      }
    };
    publicServer.close(complete);
    controlServer.close(complete);
  });
}
