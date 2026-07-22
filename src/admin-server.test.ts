import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAdminServer } from "./admin-server.js";

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

  const missingCsrf = await request(url, {
    method: "PUT",
    path: "/api/config",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ config }),
  });
  assert.equal(missingCsrf.status, 403);

  config.resources.maxMcpSessions = 10;
  const update = await request(url, {
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
  assert.equal(update.status, 200);
  assert.equal(JSON.parse(update.body).restartRequired, true);
  assert.equal(JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")).resources.maxMcpSessions, 10);
  assert.equal(JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")).widgets, "full");

  const attemptedOverride = await request(url, {
    method: "PUT",
    path: "/api/config",
    headers: {
      cookie,
      origin,
      "content-type": "application/json",
      "x-devspace-admin-csrf": sessionBody.csrfToken,
    },
    body: JSON.stringify({ config: { ...config, widgets: "full" } }),
  });
  assert.equal(attemptedOverride.status, 400);
  assert.match(attemptedOverride.body, /environment variable/);

  renameSync(allowedRoot, `${allowedRoot}-removed`);
  const staleConfig = await request(url, { path: "/api/config", headers: { cookie } });
  assert.equal(staleConfig.status, 200);
  assert.match(JSON.parse(staleConfig.body).warnings["allowedRoots.0"], /no longer/);

  const status = await request(url, { path: "/api/status", headers: { cookie } });
  assert.equal(status.status, 200);
  const statusBody = JSON.parse(status.body);
  assert.deepEqual(statusBody.admin, { ready: true });
  assert.deepEqual(statusBody.mcp, { ready: true, status: 200 });
  assert.equal(statusBody.configPath, join(configDir, "config.json"));
  assert.equal(statusBody.publicBaseUrl, "https://devspace.example.test");
  assert.doesNotMatch(status.body, /secret-owner-token/);
  assert.doesNotMatch(status.body, /display-password/);

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
