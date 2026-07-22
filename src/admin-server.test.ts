import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPinnedLookup,
  isPublicProbeAddress,
  startAdminServer,
} from "./admin-server.js";
import { deriveInternalAdminToken, redactDiagnosticValue } from "./admin-backend.js";

assert.equal(deriveInternalAdminToken("owner-test").length, 43);
assert.deepEqual(redactDiagnosticValue({ pid: 42, accessToken: "secret", ok: true }), {
  accessToken: "[redacted]",
  ok: true,
});

assert.equal(isPublicProbeAddress("127.0.0.1"), false);
assert.equal(isPublicProbeAddress("10.20.30.40"), false);
assert.equal(isPublicProbeAddress("169.254.169.254"), false);
assert.equal(isPublicProbeAddress("::1"), false);
assert.equal(isPublicProbeAddress("fc00::1"), false);
assert.equal(isPublicProbeAddress("::ffff:127.0.0.1"), false);
assert.equal(isPublicProbeAddress("::ffff:7f00:1"), false);
assert.equal(isPublicProbeAddress("0:0:0:0:0:ffff:7f00:1"), false);
assert.equal(isPublicProbeAddress("0:0:0:0:0:FFFF:169.254.169.254"), false);
assert.equal(isPublicProbeAddress("1.1.1.1"), true);
assert.equal(isPublicProbeAddress("::ffff:1.1.1.1"), true);
assert.equal(isPublicProbeAddress("0:0:0:0:0:ffff:101:101"), true);
assert.equal(isPublicProbeAddress("2606:4700:4700::1111"), true);

const testDir = mkdtempSync(join(tmpdir(), "devspace-admin-server-test-"));
const configDir = join(testDir, "config");
const staticDir = join(testDir, "static");
const allowedRoot = join(testDir, "project");
mkdirSync(configDir);
mkdirSync(staticDir);
mkdirSync(allowedRoot);
writeFileSync(join(staticDir, "admin.html"), "<!doctype html><title>Admin</title>");
writeFileSync(join(testDir, "outside.txt"), "must not be served");
symlinkSync(join(testDir, "outside.txt"), join(staticDir, "outside.txt"));

const mcpServer = createServer((request, response) => {
  response.statusCode = request.url === "/readyz" ? 200 : 404;
  response.end();
});
await listen(mcpServer);
const mcpAddress = mcpServer.address();
assert(mcpAddress && typeof mcpAddress !== "string");
await new Promise<void>((resolvePinned, rejectPinned) => {
  const pinnedRequest = httpRequest({
    hostname: "public-probe.example",
    port: mcpAddress.port,
    path: "/readyz",
    lookup: createPinnedLookup({ address: "127.0.0.1", family: 4 }),
  }, (response) => {
    response.resume();
    response.on("end", () => {
      try {
        assert.equal(response.statusCode, 200);
        resolvePinned();
      } catch (error) {
        rejectPinned(error);
      }
    });
  });
  pinnedRequest.on("error", rejectPinned);
  pinnedRequest.end();
});
let runtimeRestartCount = 0;
const runtimeManager = {
  backendStatus: async () => ({
    managed: true as const,
    state: "running" as const,
    supervisor: "launchd" as const,
    label: "com.keepkeen.devspace.test",
    actions: ["restart" as const],
  }),
  restartBackend: async () => {
    runtimeRestartCount += 1;
    return {
      id: "operation-test",
      target: "backend" as const,
      action: "restart" as const,
      state: "accepted" as const,
      requestedAt: new Date().toISOString(),
    };
  },
};
let revokeCount = 0;
const backendClient = {
  diagnostics: async () => ({
    generatedAt: "2026-07-22T00:00:00.000Z",
    generation: "test-generation",
    pid: 999,
    usage: { mcpSessions: { active: 2, reserved: 1, limit: 10 } },
    recentFailures: [{ at: "2026-07-22T00:00:00.000Z", event: "test_failure", category: "test" }],
    ownerToken: "must-be-redacted",
  }),
  revokeAllClientsAndTokens: async () => {
    revokeCount += 1;
    return { revoked: true };
  },
};

writeFileSync(join(configDir, "auth.json"), JSON.stringify({
  ownerToken: "secret-owner-token-that-must-not-leak",
}));
writeFileSync(join(configDir, "config.json"), JSON.stringify({
  host: "127.0.0.1",
  port: mcpAddress.port,
  allowedRoots: [allowedRoot],
  publicBaseUrl: "https://display-user:display-password@devspace.example.test",
  toolMode: "codex",
  widgets: "full",
}));

const admin = await startAdminServer({
  port: 0,
  env: { DEVSPACE_CONFIG_DIR: configDir, DEVSPACE_WIDGETS: "off" },
  staticDir,
  runtimeManager,
  backendClient,
});
try {
  const url = new URL(admin.url);
  const capability = new URLSearchParams(url.hash.slice(1)).get("capability");
  assert(capability);
  const origin = url.origin;

  const page = await request(url, { path: "/" });
  assert.equal(page.status, 200);
  assert.match(page.body, /Admin/);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.match(String(page.headers["content-security-policy"]), /frame-ancestors 'none'/);
  assert.equal(page.headers["access-control-allow-origin"], undefined);
  assert.equal((await request(url, { path: "/outside.txt" })).status, 404);

  const badOrigin = await request(url, {
    method: "POST",
    path: "/api/session",
    headers: { "x-devspace-admin-capability": capability, origin: "https://evil.test" },
  });
  assert.equal(badOrigin.status, 403);

  const sessionResponse = await request(url, {
    method: "POST",
    path: "/api/session",
    headers: { "x-devspace-admin-capability": capability, origin },
  });
  assert.equal(sessionResponse.status, 200);
  const sessionBody = JSON.parse(sessionResponse.body);
  assert.equal(typeof sessionBody.csrfToken, "string");
  const setCookie = String(sessionResponse.headers["set-cookie"]?.[0]);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(";", 1)[0];
  const replayedCapability = await request(url, {
    method: "POST",
    path: "/api/session",
    headers: { "x-devspace-admin-capability": capability, origin },
  });
  assert.equal(replayedCapability.status, 401);
  const resumedSession = await request(url, {
    method: "POST",
    path: "/api/session",
    headers: { cookie, origin },
  });
  assert.equal(resumedSession.status, 200);
  assert.equal(JSON.parse(resumedSession.body).csrfToken, sessionBody.csrfToken);

  const unauthenticated = await request(url, { path: "/api/config" });
  assert.equal(unauthenticated.status, 401);
  const configResponse = await request(url, {
    path: "/api/config",
    headers: { cookie },
  });
  assert.equal(configResponse.status, 200);
  const configEnvelope = JSON.parse(configResponse.body);
  const config = configEnvelope.config;
  assert.deepEqual(config.allowedRoots, [allowedRoot]);
  assert.equal(config.widgets, "off");
  assert.deepEqual(configEnvelope.overrides, ["widgets"]);
  assert.equal(typeof configEnvelope.revision, "string");
  assert.equal(configResponse.headers.etag, `"${configEnvelope.revision}"`);

  const missingCsrf = await request(url, {
    method: "PUT",
    path: "/api/config",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ config }),
  });
  assert.equal(missingCsrf.status, 403);

  const missingRevision = await request(url, {
    method: "PUT",
    path: "/api/config",
    headers: {
      cookie,
      origin,
      "content-type": "application/json",
      "x-devspace-admin-csrf": sessionBody.csrfToken,
    },
    body: JSON.stringify({ config }),
  });
  assert.equal(missingRevision.status, 428);

  config.resources.maxMcpSessions = 10;
  const update = await request(url, {
    method: "PUT",
    path: "/api/config",
    headers: {
      cookie,
      origin,
      "content-type": "application/json",
      "if-match": `"${configEnvelope.revision}"`,
      "x-devspace-admin-csrf": sessionBody.csrfToken,
    },
    body: JSON.stringify({ config }),
  });
  assert.equal(update.status, 200);
  const updateBody = JSON.parse(update.body);
  assert.equal(updateBody.restartRequired, true);
  assert.equal(typeof updateBody.revision, "string");
  assert.equal(JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")).resources.maxMcpSessions, 10);
  assert.equal(JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")).widgets, "full");

  const attemptedOverride = await request(url, {
    method: "PUT",
    path: "/api/config",
    headers: {
      cookie,
      origin,
      "content-type": "application/json",
      "if-match": `"${updateBody.revision}"`,
      "x-devspace-admin-csrf": sessionBody.csrfToken,
    },
    body: JSON.stringify({ config: { ...config, widgets: "full" } }),
  });
  assert.equal(attemptedOverride.status, 400);
  assert.match(attemptedOverride.body, /environment variable/);

  const staleRevision = await request(url, {
    method: "PUT",
    path: "/api/config",
    headers: {
      cookie,
      origin,
      "content-type": "application/json",
      "if-match": `"${configEnvelope.revision}"`,
      "x-devspace-admin-csrf": sessionBody.csrfToken,
    },
    body: JSON.stringify({ config }),
  });
  assert.equal(staleRevision.status, 412);

  renameSync(allowedRoot, `${allowedRoot}-removed`);
  const staleConfig = await request(url, { path: "/api/config", headers: { cookie } });
  assert.equal(staleConfig.status, 200);
  assert.match(JSON.parse(staleConfig.body).warnings["allowedRoots.0"], /no longer/);

  const status = await request(url, { path: "/api/status", headers: { cookie } });
  assert.equal(status.status, 200);
  const statusBody = JSON.parse(status.body);
  assert.equal(statusBody.admin.ready, true);
  assert.equal(statusBody.admin.version, "1.0.4");
  assert.equal(typeof statusBody.admin.startedAt, "string");
  assert.equal(statusBody.mcp.ready, true);
  assert.equal(statusBody.mcp.status, 200);
  assert.equal(typeof statusBody.mcp.latencyMs, "number");
  assert.equal(typeof statusBody.mcp.checkedAt, "string");
  assert.equal(statusBody.tunnel.configured, true);
  assert.equal(statusBody.tunnel.hostname, "devspace.example.test");
  assert.equal(statusBody.runtime.backend.managed, true);
  assert.deepEqual(statusBody.runtime.backend.actions, ["restart"]);
  assert.equal(typeof statusBody.runtime.backend.confirmationToken, "string");
  assert.equal(statusBody.configPath, join(configDir, "config.json"));
  assert.equal(statusBody.publicBaseUrl, "https://devspace.example.test");
  assert.doesNotMatch(status.body, /secret-owner-token/);
  assert.doesNotMatch(status.body, /display-password/);

  const diagnostics = await request(url, { path: "/api/diagnostics", headers: { cookie } });
  assert.equal(diagnostics.status, 200);
  const diagnosticsBody = JSON.parse(diagnostics.body);
  assert.equal(diagnosticsBody.diagnostics.generation, "test-generation");
  assert.equal(typeof diagnosticsBody.security.confirmationToken, "string");
  assert.doesNotMatch(diagnostics.body, /must-be-redacted|999/);
  const bundle = await request(url, { path: "/api/diagnostics/bundle", headers: { cookie } });
  assert.equal(bundle.status, 200);
  assert.match(String(bundle.headers["content-disposition"]), /attachment/);
  assert.doesNotMatch(bundle.body, /must-be-redacted|999/);

  const revoke = await request(url, {
    method: "POST",
    path: "/api/security/revoke",
    headers: {
      cookie,
      origin,
      "content-type": "application/json",
      "x-devspace-admin-csrf": sessionBody.csrfToken,
    },
    body: JSON.stringify({
      confirmation: "revoke_all_clients_and_tokens",
      confirmationToken: diagnosticsBody.security.confirmationToken,
    }),
  });
  assert.equal(revoke.status, 200);
  assert.equal(revokeCount, 1);

  const privateProbeConfig = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
  privateProbeConfig.publicBaseUrl = `http://127.0.0.1:${mcpAddress.port + 1}`;
  writeFileSync(join(configDir, "config.json"), JSON.stringify(privateProbeConfig));
  const privateProbeStatus = await request(url, { path: "/api/status", headers: { cookie } });
  assert.equal(privateProbeStatus.status, 200);
  assert.equal(JSON.parse(privateProbeStatus.body).tunnel.error, "unsafe_destination");
  privateProbeConfig.publicBaseUrl = "https://display-user:display-password@devspace.example.test";
  writeFileSync(join(configDir, "config.json"), JSON.stringify(privateProbeConfig));

  const missingRestartCsrf = await request(url, {
    method: "POST",
    path: "/api/runtime/backend/restart",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({
      confirmation: "restart",
      confirmationToken: statusBody.runtime.backend.confirmationToken,
    }),
  });
  assert.equal(missingRestartCsrf.status, 403);

  const restart = await request(url, {
    method: "POST",
    path: "/api/runtime/backend/restart",
    headers: {
      cookie,
      origin,
      "content-type": "application/json",
      "x-devspace-admin-csrf": sessionBody.csrfToken,
    },
    body: JSON.stringify({
      confirmation: "restart",
      confirmationToken: statusBody.runtime.backend.confirmationToken,
    }),
  });
  assert.equal(restart.status, 202);
  assert.equal(JSON.parse(restart.body).operation.id, "operation-test");
  assert.equal(runtimeRestartCount, 1);
  const replayedRestart = await request(url, {
    method: "POST",
    path: "/api/runtime/backend/restart",
    headers: {
      cookie,
      origin,
      "content-type": "application/json",
      "x-devspace-admin-csrf": sessionBody.csrfToken,
    },
    body: JSON.stringify({
      confirmation: "restart",
      confirmationToken: statusBody.runtime.backend.confirmationToken,
    }),
  });
  assert.equal(replayedRestart.status, 409);
  assert.equal(runtimeRestartCount, 1);

  const repairableFile = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
  repairableFile.resources = {
    ...repairableFile.resources,
    maxProcessSessions: 4,
    maxProcessSessionsPerWorkspace: 8,
  };
  writeFileSync(join(configDir, "config.json"), JSON.stringify(repairableFile));
  const repairableResponse = await request(url, { path: "/api/config", headers: { cookie } });
  assert.equal(repairableResponse.status, 200);
  assert.match(
    JSON.parse(repairableResponse.body).warnings["resources.maxProcessSessionsPerWorkspace"],
    /exceed/,
  );
  assert.equal((await request(url, { path: "/api/status", headers: { cookie } })).status, 200);

  const wrongHost = await request(url, {
    path: "/api/status",
    headers: { cookie, host: "localhost" },
  });
  assert.equal(wrongHost.status, 403);
} finally {
  await admin.close();
  await close(mcpServer);
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function request(
  baseUrl: URL,
  options: {
    method?: string;
    path: string;
    headers?: IncomingHttpHeaders;
    body?: string;
  },
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: baseUrl.hostname,
      port: baseUrl.port,
      method: options.method ?? "GET",
      path: options.path,
      headers: options.headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}
