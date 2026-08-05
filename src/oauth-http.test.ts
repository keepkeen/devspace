import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import { internalDiagnosticsToken, internalRevocationToken } from "./internal-auth.js";
import { FULL_DEVSPACE_OAUTH_SCOPES } from "./oauth-scopes.js";
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
const earlierHostMeta = {
  "openai/subject": "oauth-http-earlier-subject",
  "openai/session": "oauth-http-earlier-session",
};
const renewedHostMeta = {
  "openai/subject": "oauth-http-renewed-subject",
  "openai/session": "oauth-http-renewed-session",
};
const execFileAsync = promisify(execFile);
await mkdir(workspaceRoot, { recursive: true });
await writeFile(join(workspaceRoot, "README.md"), "OAuth HTTP fixture\n", "utf8");
await execFileAsync("git", ["init", "-q"], { cwd: workspaceRoot });
await execFileAsync("git", ["add", "."], { cwd: workspaceRoot });
await execFileAsync("git", [
  "-c", "user.name=DevSpace Test",
  "-c", "user.email=devspace@example.invalid",
  "-c", "commit.gpgsign=false",
  "commit", "-qm", "fixture",
], { cwd: workspaceRoot });

const configEnvironment = {
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
  DEVSPACE_ALLOWED_HOSTS: "*",
  DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
  DEVSPACE_OAUTH_SCOPES: FULL_DEVSPACE_OAUTH_SCOPES.join(","),
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
  const selectedProject = await mcpClient.callTool({
    name: "project_control",
    arguments: { action: "open", operationId: "oauth-project-execution" },
    _meta: earlierHostMeta,
  });
  assert.notEqual(selectedProject.isError, true, JSON.stringify(selectedProject.content));
  const projectRef = String(
    (selectedProject.structuredContent as { project?: { ref?: unknown } } | undefined)?.project?.ref ?? "",
  );
  assert.ok(projectRef);
  assert.doesNotMatch(JSON.stringify(selectedProject.structuredContent), /executionRef/u);
  assert.doesNotMatch(
    JSON.stringify(selectedProject.structuredContent),
    /workspace|receipt|continuation|contextChanged|phase/iu,
  );
  const backgroundProcess = await mcpClient.callTool({
    name: "exec_command",
    arguments: {
      operationId: "oauth-background-process",
      program: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    },
    _meta: earlierHostMeta,
  });
  assert.notEqual(backgroundProcess.isError, true, JSON.stringify(backgroundProcess.content));
  assert.equal(
    typeof (backgroundProcess.structuredContent as { sessionId?: unknown } | undefined)?.sessionId,
    "number",
  );

  const renewedTokens = await issueTokens(active.origin, clientId, changedOwnerToken);
  await mcpClient.close().catch(() => undefined);
  const replacementDiagnostics = await fetch(
    new URL("/internal/diagnostics", active.controlOrigin),
    {
      headers: {
        "x-devspace-internal-token": internalDiagnosticsToken(changedOwnerToken),
      },
    },
  );
  assert.equal(replacementDiagnostics.status, 200);
  const replacementDiagnosticBody = await replacementDiagnostics.json() as {
    usage?: {
      processSessions?: { running?: unknown };
      workspaces?: { active?: unknown };
    };
  };
  assert.equal(
    replacementDiagnosticBody.usage?.processSessions?.running,
    1,
    "reauthorizing must preserve the earlier grant's Project execution processes",
  );
  assert.equal(
    replacementDiagnosticBody.usage?.workspaces?.active,
    1,
    "reauthorizing must preserve the earlier grant's Project execution workspaces",
  );
  const replacedGrantAccessToken = await fetch(new URL("/mcp", active.origin), {
    headers: { authorization: `Bearer ${replacementTokens.access_token}` },
  });
  assert.notEqual(replacedGrantAccessToken.status, 401);

  const renewedClient = new Client({
    name: "oauth-renewed-grant-cleanup-test",
    version: "1.0.0",
  });
  await renewedClient.connect(new StreamableHTTPClientTransport(new URL("/mcp", active.origin), {
    requestInit: {
      headers: { authorization: `Bearer ${String(renewedTokens.access_token)}` },
    },
  }));
  const renewedProject = await renewedClient.callTool({
    name: "project_control",
    arguments: { action: "open", operationId: "oauth-renewed-project-execution" },
    _meta: renewedHostMeta,
  });
  assert.notEqual(renewedProject.isError, true, JSON.stringify(renewedProject.content));
  assert.doesNotMatch(JSON.stringify(renewedProject.structuredContent), /executionRef/u);
  const renewedProgress = await renewedClient.callTool({
    name: "save_progress",
    arguments: {
      operationId: "oauth-renewed-save-progress",
      title: "Shared OAuth handoff",
      progress: "Historical progress saved by the renewed grant.",
    },
    _meta: renewedHostMeta,
  });
  assert.notEqual(renewedProgress.isError, true, JSON.stringify(renewedProgress.content));
  const renewedThreadRef = String(
    (renewedProgress._meta as {
      thread?: { threadRef?: unknown };
    } | undefined)?.thread?.threadRef ?? "",
  );
  assert.match(renewedThreadRef, /^pth1_/u);

  const earlierGrantClient = new Client({
    name: "oauth-earlier-grant-isolation-test",
    version: "1.0.0",
  });
  await earlierGrantClient.connect(new StreamableHTTPClientTransport(new URL("/mcp", active.origin), {
    requestInit: {
      headers: { authorization: `Bearer ${String(replacementTokens.access_token)}` },
    },
  }));
  const earlierGrantListing = await earlierGrantClient.callTool({
    name: "project_thread_control",
    arguments: { action: "list" },
    _meta: earlierHostMeta,
  });
  const renewedGrantListing = await renewedClient.callTool({
    name: "project_thread_control",
    arguments: { action: "list" },
    _meta: renewedHostMeta,
  });
  const earlierGrantThreads = (
    earlierGrantListing.structuredContent as {
      threads?: Array<{ threadRef?: unknown; title?: unknown }>;
    } | undefined
  )?.threads ?? [];
  assert.equal(
    earlierGrantThreads.length,
    1,
    "the earlier grant must retain only its own Project Thread",
  );
  assert.equal(earlierGrantThreads[0]?.title, "New task");
  assert.notEqual(
    earlierGrantThreads[0]?.threadRef,
    renewedThreadRef,
    "an earlier grant must not see another grant's private Project Thread",
  );
  assert.equal(
    (renewedGrantListing.structuredContent as { threads?: unknown[] } | undefined)?.threads?.length,
    1,
    "the grant that saved progress must see its own Project Thread",
  );
  const crossGrantHandoffResume = await earlierGrantClient.callTool({
    name: "project_control",
    arguments: {
      action: "resume",
      threadRef: renewedThreadRef,
      operationId: "oauth-earlier-resume-shared-handoff",
    },
    _meta: earlierHostMeta,
  });
  assert.equal(crossGrantHandoffResume.isError, true);
  assert.equal(
    (crossGrantHandoffResume.structuredContent as {
      error?: { code?: unknown };
    } | undefined)?.error?.code,
    "invalid_tool_input",
  );
  await earlierGrantClient.close();

  assert.equal(
    (await fetch(new URL("/internal/security/revoke", active.origin), {
      method: "POST",
      headers: { "x-devspace-internal-token": internalRevocationToken(changedOwnerToken) },
    })).status,
    404,
  );
  let heldToolSettled = false;
  const heldTool = renewedClient.callTool({
    name: "exec_command",
    arguments: {
      operationId: "oauth-revocation-held-command",
      program: process.execPath,
      args: ["-e", "setTimeout(() => {}, 1500)"],
    },
    _meta: renewedHostMeta,
  }).then(
    () => "fulfilled" as const,
    () => "rejected" as const,
  ).finally(() => {
    heldToolSettled = true;
  });
  await delay(50);
  const revocationRequest = fetch(new URL("/internal/security/revoke", active.controlOrigin), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-devspace-internal-token": internalRevocationToken(changedOwnerToken),
    },
    body: JSON.stringify({ scope: "all_clients_and_tokens" }),
  });
  const gatedResponseBody = await waitForRevocationGate(
    active.origin,
    renewedTokens.access_token,
  );
  assert.match(gatedResponseBody, /Global credential revocation is in progress/);
  const revocation = await revocationRequest;
  assert.equal(
    heldToolSettled,
    true,
    "revokeAll must not complete before the admitted tool call settles",
  );
  const heldToolOutcome = await heldTool;
  assert.ok(
    heldToolOutcome === "fulfilled" || heldToolOutcome === "rejected",
    "transport closure may hide the tool result, but the held call must settle before revokeAll",
  );
  assert.equal(revocation.status, 200);
  const revoked = await revocation.json() as {
    revoked?: { clients?: unknown; grants?: unknown; accessTokens?: unknown; refreshTokens?: unknown; workspaceCleanupJobs?: unknown };
  };
  assert.deepEqual(revoked.revoked, {
    clients: 1,
    grants: 3,
    accessTokens: 2,
    refreshTokens: 2,
    workspaceCleanupJobs: 2,
  });
  await renewedClient.close().catch(() => undefined);

  const diagnostics = await fetch(new URL("/internal/diagnostics", active.controlOrigin), {
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
    headers: { authorization: `Bearer ${renewedTokens.access_token}` },
  });
  assert.equal(revokedAccessToken.status, 401);

  const revokedRefreshToken = await fetch(new URL("/token", active.origin), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: renewedTokens.refresh_token,
      resource: `${publicBaseUrl}/mcp`,
    }),
  });
  assert.equal(revokedRefreshToken.status, 400);

  const revokedClient = await fetch(authorizeUrl(active.origin, clientId, "en-US"), {
    redirect: "manual",
  });
  const revokedHtml = await assertStaleResponse(revokedClient);
  assert.equal(revokedHtml.includes(clientId), false);

  const newRegistration = await fetch(new URL("/register", active.origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "ChatGPT OAuth post-revocation test",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  assert.equal(newRegistration.status, 201);
  const newClientId = String(
    (await newRegistration.json() as { client_id?: unknown }).client_id ?? "",
  );
  assert.ok(newClientId);
  const postRevocationTokens = await issueTokens(active.origin, newClientId, changedOwnerToken);
  const reauthorizedClient = new Client({
    name: "oauth-post-revocation-authorization-test",
    version: "1.0.0",
  });
  await reauthorizedClient.connect(new StreamableHTTPClientTransport(new URL("/mcp", active.origin), {
    requestInit: {
      headers: { authorization: `Bearer ${postRevocationTokens.access_token}` },
    },
  }));
  assert.ok((await reauthorizedClient.listTools()).tools.length > 0);
  await reauthorizedClient.close();
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
    scope: FULL_DEVSPACE_OAUTH_SCOPES.join(" "),
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
  let approval = await fetch(new URL("/authorize", origin), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: authorizationParams(clientId, "en-US", { owner_token: ownerToken }),
    redirect: "manual",
  });
  if (approval.status === 200) {
    const selectionPage = await approval.text();
    const selectionToken = selectionPage.match(
      /name="selection_token" value="([^"]+)"/u,
    )?.[1];
    const rootIds = [...selectionPage.matchAll(
      /name="root_id" value="([^"]+)"/gu,
    )].map((match) => match[1]!);
    assert.ok(selectionToken);
    assert.ok(rootIds.length > 0);
    const selection = authorizationParams(clientId, "en-US", {
      selection_token: selectionToken,
    });
    for (const rootId of rootIds) selection.append("root_id", rootId);
    approval = await fetch(new URL("/authorize", origin), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: selection,
      redirect: "manual",
    });
  }
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
  controlOrigin: URL;
  close(): Promise<void>;
}> {
  const running = createServer(config);
  const httpServer = createHttpServer(running.app);
  const controlServer = createHttpServer(running.controlApp);
  const [origin, controlOrigin] = await Promise.all([
    listen(httpServer),
    listen(controlServer),
  ]);
  return {
    origin,
    controlOrigin,
    close: async () => {
      await Promise.all([closeHttpServer(httpServer), closeHttpServer(controlServer)]);
      await running.close();
    },
  };
}

async function waitForRevocationGate(origin: URL, accessToken: string): Promise<string> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const response = await fetch(new URL("/mcp", origin), {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const body = await response.text();
    if (response.status === 503 && body.includes("Global credential revocation is in progress")) {
      return body;
    }
    if (response.status === 401) {
      assert.fail("OAuth revocation completed before the admission gate was observed");
    }
    await delay(10);
  }
  throw new Error("Global revocation admission gate was not observed");
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
