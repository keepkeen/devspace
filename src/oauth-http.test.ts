import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import { internalDiagnosticsToken, internalRevocationToken } from "./internal-auth.js";
import { createServer } from "./server.js";

const root = await mkdtemp(join(tmpdir(), "devspace-oauth-http-test-"));
const workspaceRoot = join(root, "workspace");
const stateDir = join(root, "state");
const publicBaseUrl = "https://agent.example.com";
const originalOwnerToken = "oauth-http-test-owner-token-long-enough";
const changedOwnerToken = "oauth-http-test-changed-owner-token-long-enough";
const redirectUri = "https://chatgpt.com/connector/oauth/devspace-test";
const codeVerifier = "oauth-http-test-verifier-0123456789-abcdefghijklmnopqrstuvwxyz";
const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
await mkdir(workspaceRoot, { recursive: true });

const configEnvironment = {
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
  DEVSPACE_ALLOWED_HOSTS: "*",
  DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
  DEVSPACE_LOG_LEVEL: "silent",
  PORT: "1",
};

let active: Awaited<ReturnType<typeof startServer>> | undefined;
try {
  active = await startServer(loadConfig({
    ...configEnvironment,
    DEVSPACE_OAUTH_OWNER_TOKEN: originalOwnerToken,
  }));

  const initialStale = await fetch(
    authorizeUrl(active.origin, "devspace-stale-client", "zh-CN"),
    { redirect: "manual" },
  );
  const initialStaleHtml = await assertStaleResponse(initialStale);
  assert.match(initialStaleHtml, /连接注册已失效/);
  assert.match(initialStaleHtml, /删除当前 DevSpace 连接或插件/);
  assert.doesNotMatch(initialStaleHtml, /devspace-stale-client/);

  const registration = await fetch(new URL("/register", active.origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "ChatGPT OAuth HTTP test",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  assert.equal(registration.status, 201);
  const registered = await registration.json() as { client_id?: unknown };
  assert.equal(typeof registered.client_id, "string");
  const clientId = String(registered.client_id);

  const authorize = await fetch(authorizeUrl(active.origin, clientId, "en-US"), {
    redirect: "manual",
  });
  assert.equal(authorize.status, 200);
  assert.match(authorize.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(await authorize.text(), /Owner password/);

  const tokens = await issueTokens(active.origin, clientId, originalOwnerToken);

  await active.close();
  active = undefined;
  active = await startServer(loadConfig({
    ...configEnvironment,
    DEVSPACE_OAUTH_OWNER_TOKEN: changedOwnerToken,
  }));

  const preservedClient = await fetch(authorizeUrl(active.origin, clientId, "en-US"), {
    redirect: "manual",
  });
  assert.equal(preservedClient.status, 200, "password rotation must preserve the DCR client");

  const rejectedAccessToken = await fetch(new URL("/mcp", active.origin), {
    headers: { authorization: `Bearer ${String(tokens.access_token)}` },
  });
  assert.equal(rejectedAccessToken.status, 401, "password rotation must revoke old access tokens");

  const rejectedRefreshToken = await fetch(new URL("/token", active.origin), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: String(tokens.refresh_token),
      resource: `${publicBaseUrl}/mcp`,
    }),
  });
  assert.equal(rejectedRefreshToken.status, 400, "password rotation must revoke old refresh tokens");

  const replacementTokens = await issueTokens(active.origin, clientId, changedOwnerToken);
  const mcpClient = new Client({ name: "oauth-revocation-cleanup-test", version: "1.0.0" });
  await mcpClient.connect(new StreamableHTTPClientTransport(new URL("/mcp", active.origin), {
    requestInit: {
      headers: { authorization: `Bearer ${String(replacementTokens.access_token)}` },
    },
  }));
  const openedWorkspace = await mcpClient.callTool({
    name: "open_workspace",
    arguments: { path: workspaceRoot, contextMode: "full", writeAccess: "read_write" },
  });
  assert.notEqual(openedWorkspace.isError, true, JSON.stringify(openedWorkspace.content));
  const workspaceId = String(
    (openedWorkspace.structuredContent as { workspace?: { ref?: unknown } } | undefined)?.workspace?.ref ?? "",
  );
  const receipt = String(
    (openedWorkspace.structuredContent as { receipt?: unknown } | undefined)?.receipt ?? "",
  );
  assert.ok(workspaceId);
  assert.match(receipt, /^wctx3\./);
  const backgroundProcess = await mcpClient.callTool({
    name: "exec_command",
    arguments: {
      receipt,
      program: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      yieldTimeMs: 0,
    },
  });
  assert.notEqual(backgroundProcess.isError, true, JSON.stringify(backgroundProcess.content));
  assert.equal(
    typeof (backgroundProcess.structuredContent as { sessionId?: unknown } | undefined)?.sessionId,
    "number",
  );

  const revocation = await fetch(new URL("/internal/security/revoke", active.origin), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-devspace-internal-token": internalRevocationToken(changedOwnerToken),
    },
    body: JSON.stringify({ scope: "all_clients_and_tokens" }),
  });
  assert.equal(revocation.status, 200);
  const revoked = await revocation.json() as {
    revoked?: { clients?: unknown; accessTokens?: unknown; refreshTokens?: unknown; workspaceCleanupJobs?: unknown };
  };
  assert.deepEqual(revoked.revoked, {
    clients: 1,
    accessTokens: 1,
    refreshTokens: 1,
    workspaceCleanupJobs: 1,
  });
  await mcpClient.close().catch(() => undefined);

  const diagnostics = await fetch(new URL("/internal/diagnostics", active.origin), {
    headers: { "x-devspace-internal-token": internalDiagnosticsToken(changedOwnerToken) },
  });
  assert.equal(diagnostics.status, 200);
  const diagnosticBody = await diagnostics.json() as {
    usage?: {
      processSessions?: { running?: unknown };
      workspaces?: { active?: unknown };
    };
  };
  assert.equal(diagnosticBody.usage?.processSessions?.running, 0);
  assert.equal(diagnosticBody.usage?.workspaces?.active, 0);

  const revokedAccessToken = await fetch(new URL("/mcp", active.origin), {
    headers: { authorization: `Bearer ${replacementTokens.access_token}` },
  });
  assert.equal(revokedAccessToken.status, 401);

  const revokedRefreshToken = await fetch(new URL("/token", active.origin), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: replacementTokens.refresh_token,
      resource: `${publicBaseUrl}/mcp`,
    }),
  });
  assert.equal(revokedRefreshToken.status, 400);

  const revokedClient = await fetch(authorizeUrl(active.origin, clientId, "en-US"), {
    redirect: "manual",
  });
  const revokedHtml = await assertStaleResponse(revokedClient);
  assert.equal(revokedHtml.includes(clientId), false);
} finally {
  await active?.close();
  await rm(root, { recursive: true, force: true });
}

function authorizeUrl(origin: URL, clientId: string, uiLocales: string): URL {
  const url = new URL("/authorize", origin);
  url.search = authorizationParams(clientId, uiLocales).toString();
  return url;
}

function authorizationParams(
  clientId: string,
  uiLocales: string,
  extra: Record<string, string> = {},
): URLSearchParams {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "devspace",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    resource: `${publicBaseUrl}/mcp`,
    state: "oauth-http-test-state",
    ui_locales: uiLocales,
    ...extra,
  });
}

async function assertStaleResponse(response: Response): Promise<string> {
  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  return response.text();
}

async function issueTokens(
  origin: URL,
  clientId: string,
  ownerToken: string,
): Promise<{ access_token: string; refresh_token: string }> {
  const approval = await fetch(new URL("/authorize", origin), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: authorizationParams(clientId, "en-US", { owner_token: ownerToken }),
    redirect: "manual",
  });
  assert.equal(approval.status, 302);
  const callback = new URL(approval.headers.get("location") ?? "");
  const authorizationCode = callback.searchParams.get("code");
  assert.ok(authorizationCode);

  const tokenResponse = await fetch(new URL("/token", origin), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code: authorizationCode,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      resource: `${publicBaseUrl}/mcp`,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json() as { access_token?: unknown; refresh_token?: unknown };
  assert.equal(typeof tokens.access_token, "string");
  assert.equal(typeof tokens.refresh_token, "string");
  return {
    access_token: String(tokens.access_token),
    refresh_token: String(tokens.refresh_token),
  };
}

async function startServer(config: ReturnType<typeof loadConfig>): Promise<{
  origin: URL;
  close(): Promise<void>;
}> {
  const running = createServer(config);
  const httpServer = createHttpServer(running.app);
  const origin = await listen(httpServer);
  return {
    origin,
    close: async () => {
      await closeHttpServer(httpServer);
      await running.close();
    },
  };
}

function listen(server: HttpServer): Promise<URL> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      resolve(new URL(`http://127.0.0.1:${address.port}`));
    });
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
