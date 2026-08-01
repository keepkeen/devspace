import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { probeBackendReadiness } from "./admin-runtime.js";
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
let publicListenerBound = true;
let controlListenerBound = true;
let activeRevocationGates = 0;
const revocationEvents: string[] = [];
const options: RuntimeControlPlaneOptions = {
  internalAuth: {
    diagnostics: ownerToken,
    configReload: ownerToken,
    revocation: ownerToken,
  },
  generation: "runtime-generation",
  runtimeConfig: { widgets: "changes", maxRequestBodyBytes: 33_554_432 },
  allowedRootsRevision: () => "roots-revision-test",
  allowedRootsCleanupPending: () => rootsCleanupPending,
  isClosing: () => false,
  publicListenerBound: () => publicListenerBound,
  controlListenerBound: () => controlListenerBound,
  backendPid: () => 4321,
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
  projectExecutionUsage: () => ({
    total: 5,
    provisioning: 0,
    active: 2,
    revoked: 1,
    quarantined: 1,
    closed: 1,
  }),
  auditWriteHealth: () => ({
    auditWriteFailures: 3,
    lastAuditWriteFailureAt: "2026-07-26T00:00:00.000Z",
  }),
  auditStatus: () => ({
    enabled: true,
    stateDirRef: "state_test",
    eventCount: 42,
    firstEventAt: "2026-07-25T00:00:00.000Z",
    lastEventAt: "2026-07-27T00:00:00.000Z",
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
  beforeGlobalRevocation: () => {
    activeRevocationGates += 1;
    revocationEvents.push("before");
    return () => {
      activeRevocationGates -= 1;
      revocationEvents.push("release");
    };
  },
  revokeAll: () => {
    revocationEvents.push("revoke");
    revocationCount += 1;
    return { clients: 1, accessTokens: 2, refreshTokens: 2, workspaceCleanupJobs: 0 };
  },
  runtimeDiagnostics: diagnostics,
  onGlobalRevocation: ({ clients }) => {
    revocationEvents.push("after");
    loggedRevocationCount += clients;
  },
};
const publicApp = express();
publicApp.use(createRuntimeReadinessPlane(options));
const controlApp = express();
controlApp.use(createRuntimeReadinessPlane(options));
controlApp.use(createRuntimeControlPlane(options));
controlApp.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: "test_error" });
});

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
  const publicReadiness = await (await fetch(`${publicOrigin}/readyz`)).json() as any;
  assert.equal(publicReadiness.pid, undefined, "the public readiness response must not expose the backend PID");

  controlListenerBound = false;
  const controlBindFailure = await fetch(`${publicOrigin}/readyz`);
  assert.equal(controlBindFailure.status, 503);
  assert.equal((await controlBindFailure.json() as any).checks.controlListener, false);
  controlListenerBound = true;

  const headers = { "x-devspace-internal-token": internalDiagnosticsToken(ownerToken) };
  assert.equal((await fetch(`${controlOrigin}/internal/readiness`)).status, 404);
  const internalReadinessResponse = await fetch(`${controlOrigin}/internal/readiness`, { headers });
  assert.equal(internalReadinessResponse.status, 200);
  assert.equal(internalReadinessResponse.headers.get("cache-control"), "no-store");
  const internalReadiness = await internalReadinessResponse.json() as any;
  assert.equal(internalReadiness.pid, 4321);
  assert.equal(internalReadiness.generation, "runtime-generation");
  assert.equal(internalReadiness.checks.publicListener, true);
  assert.equal(internalReadiness.checks.controlListener, true);
  const controlUrl = new URL(controlOrigin);
  assert.deepEqual(
    await probeBackendReadiness("127.0.0.1", Number(controlUrl.port), ownerToken),
    { ready: true, generation: "runtime-generation", pid: 4321 },
  );
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
  assert.equal(body.pid, 4321);
  assert.equal(body.buildRevision, null);
  assert.deepEqual(body.runtimeConfig, {
    widgets: "changes",
    maxRequestBodyBytes: 33_554_432,
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
    enabled: true,
    stateDirRef: "state_test",
    eventCount: 42,
    firstEventAt: "2026-07-25T00:00:00.000Z",
    lastEventAt: "2026-07-27T00:00:00.000Z",
    auditWriteFailures: 3,
    lastAuditWriteFailureAt: "2026-07-26T00:00:00.000Z",
  });
  assert.deepEqual(body.recentFailures, [{
    at: body.recentFailures[0].at,
    event: "test_failure",
    category: "TypeError",
  }]);
  assert.equal(JSON.stringify(body).includes("not exposed"), false);
  assert.deepEqual(body.usage.projectExecutions, {
    total: 5,
    provisioning: 0,
    active: 2,
    revoked: 1,
    quarantined: 1,
    closed: 1,
  });

  assert.equal((await fetch(`${controlOrigin}/internal/project-worktrees`)).status, 404);
  assert.equal((await fetch(
    `${controlOrigin}/internal/project-worktrees`,
    { headers },
  )).status, 404);

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
  assert.equal((await fetch(`${controlOrigin}/internal/project-worktrees/cleanup`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      candidates: [{
        executionId: "execution-clean",
        candidateRevision: "a".repeat(43),
      }],
    }),
  })).status, 404);
  assert.equal((await fetch(`${controlOrigin}/internal/project-worktrees/cleanup`, {
    method: "POST",
    headers: revocationHeaders,
    body: JSON.stringify({ candidates: [] }),
  })).status, 404);
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
  assert.equal(activeRevocationGates, 0);
  assert.deepEqual(revocationEvents, ["before", "revoke", "after", "release"]);

  options.onGlobalRevocation = async () => {
    revocationEvents.push("after_error");
    throw new Error("expected revocation cleanup failure");
  };
  const failedRevokeResponse = await fetch(`${controlOrigin}/internal/security/revoke`, {
    method: "POST",
    headers: revocationHeaders,
    body: JSON.stringify({ scope: "all_clients_and_tokens" }),
  });
  assert.equal(failedRevokeResponse.status, 500);
  assert.equal(activeRevocationGates, 0);
  assert.deepEqual(
    revocationEvents.slice(-4),
    ["before", "revoke", "after_error", "release"],
  );
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
