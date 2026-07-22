import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { internalDiagnosticsToken, internalRevocationToken } from "./internal-auth.js";
import { createRuntimeControlPlane } from "./runtime-control-plane.js";
import { RuntimeDiagnostics } from "./runtime-diagnostics.js";

const ownerToken = "runtime-control-plane-owner-token";
const diagnostics = new RuntimeDiagnostics();
diagnostics.recordFailure("test_failure", new TypeError("not exposed"));
let revocationCount = 0;
let loggedRevocationCount = 0;
const app = express();
app.use(createRuntimeControlPlane({
  ownerToken,
  generation: "runtime-generation",
  isClosing: () => false,
  workspaceDatabaseReady: () => true,
  oauthDatabaseReady: () => true,
  mcpUsage: () => ({ sessions: 2, reservations: 1, limit: 8 }),
  processUsage: () => ({ sessions: 3, running: 1, limit: 16 }),
  workspaceUsage: () => ({ activePersisted: 4, resident: 2, closing: 0, leased: 1, maxResident: 32 }),
  oauthUsage: () => ({ clients: 1, accessTokens: 2, refreshTokens: 2, expiredAccessTokens: 1, expiredRefreshTokens: 0 }),
  revokeAll: () => {
    revocationCount += 1;
    return { clients: 1, accessTokens: 2, refreshTokens: 2 };
  },
  runtimeDiagnostics: diagnostics,
  onGlobalRevocation: ({ clients }) => {
    loggedRevocationCount += clients;
  },
}));

const server = createServer(app);
await new Promise<void>((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(0, "127.0.0.1", () => resolveListen());
});

try {
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${origin}/readyz`)).status, 200);
  assert.equal((await fetch(`${origin}/internal/diagnostics`)).status, 404);

  const headers = { "x-devspace-internal-token": internalDiagnosticsToken(ownerToken) };
  const diagnosticsResponse = await fetch(`${origin}/internal/diagnostics`, { headers });
  assert.equal(diagnosticsResponse.status, 200);
  assert.equal(diagnosticsResponse.headers.get("cache-control"), "no-store");
  const body = await diagnosticsResponse.json() as any;
  assert.equal(body.generation, "runtime-generation");
  assert.equal(body.usage.mcpSessions.active, 2);
  assert.deepEqual(body.recentFailures, [{
    at: body.recentFailures[0].at,
    event: "test_failure",
    category: "TypeError",
  }]);
  assert.equal(JSON.stringify(body).includes("not exposed"), false);

  assert.equal((await fetch(`${origin}/internal/security/revoke`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ scope: "all_clients_and_tokens" }),
  })).status, 404);
  const revocationHeaders = {
    "x-devspace-internal-token": internalRevocationToken(ownerToken),
    "content-type": "application/json",
  };
  assert.equal((await fetch(`${origin}/internal/security/revoke`, {
    method: "POST",
    headers: revocationHeaders,
    body: JSON.stringify({ scope: "invalid" }),
  })).status, 400);
  const revokeResponse = await fetch(`${origin}/internal/security/revoke`, {
    method: "POST",
    headers: revocationHeaders,
    body: JSON.stringify({ scope: "all_clients_and_tokens" }),
  });
  assert.equal(revokeResponse.status, 200);
  assert.equal(revocationCount, 1);
  assert.equal(loggedRevocationCount, 1);
} finally {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}
