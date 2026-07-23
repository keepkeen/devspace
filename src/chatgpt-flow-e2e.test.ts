import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

// This is a server-side simulation of ChatGPT's OAuth/MCP protocol behavior.
// Whether the web model retains workspaceId in its conversation context still
// requires a real ChatGPT acceptance test.
const root = await mkdtemp(join(tmpdir(), "devspace-chatgpt-flow-e2e-"));
const workspaceRoot = join(root, "workspace");
const publicBaseUrl = "https://devspace.chatgpt-flow.test";
const resource = `${publicBaseUrl}/mcp`;
const ownerPassword = "chatgpt-flow-e2e-owner-password-long-enough";
const clients = new Set<Client>();
let active: Awaited<ReturnType<typeof startServer>> | undefined;

try {
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, "payload.txt"), "chatgpt-flow-ready\n");

  active = await startServer(loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, "config"),
    DEVSPACE_STATE_DIR: join(root, "state"),
    DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
    DEVSPACE_ALLOWED_HOSTS: "*",
    DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
    DEVSPACE_OAUTH_OWNER_TOKEN: ownerPassword,
    DEVSPACE_SKILLS: "0",
    DEVSPACE_SUBAGENTS: "0",
    DEVSPACE_WIDGETS: "off",
    DEVSPACE_LOG_LEVEL: "silent",
    DEVSPACE_MAX_MCP_SESSIONS: "8",
    DEVSPACE_MAX_MCP_SESSIONS_PER_CLIENT: "4",
    DEVSPACE_MAX_PROCESS_SESSIONS: "8",
    DEVSPACE_MAX_PROCESS_SESSIONS_PER_CLIENT: "4",
    DEVSPACE_MAX_PROCESS_SESSIONS_PER_WORKSPACE: "4",
    PORT: "1",
  }));

  const metadata = await discoverOAuth(active.origin);
  const [oauthA, oauthB] = await Promise.all([
    registerAndAuthorize(active.origin, metadata, "client-a"),
    registerAndAuthorize(active.origin, metadata, "client-b"),
  ]);
  assert.notEqual(oauthA.clientId, oauthB.clientId);

  const firstRound = await connectClient("same-conversation-round-one", oauthA.accessToken, active.origin);
  const opened = await firstRound.callTool({
    name: "open_workspace",
    arguments: { path: workspaceRoot },
  });
  assertToolSucceeded(opened);
  const workspaceA = workspaceId(opened);

  for (let run = 0; run < 2; run += 1) {
    const executed = await firstRound.callTool({
      name: "exec_command",
      arguments: { workspaceId: workspaceA, cmd: "printf 'safe-run\\n' >> safe-runs.txt" },
    });
    assertToolSucceeded(executed);
    assert.match(JSON.stringify(executed.content), /Process exited with code 0/);
  }
  const repeatedExecution = await firstRound.callTool({
    name: "read",
    arguments: { workspaceId: workspaceA, path: "safe-runs.txt" },
  });
  assertToolSucceeded(repeatedExecution);
  assert.match(JSON.stringify(repeatedExecution.content), /safe-run\\nsafe-run\\n/);

  const denied = await firstRound.callTool({
    name: "exec_command",
    arguments: {
      workspaceId: workspaceA,
      cmd: "sudo sh -c 'printf policy-bypass > denied-marker.txt'",
    },
  });
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied.content), /blocked by command policy/i);
  await assert.rejects(access(join(workspaceRoot, "denied-marker.txt")), { code: "ENOENT" });
  await closeClient(firstRound);

  const secondRound = await connectClient(
    "same-conversation-round-two",
    oauthA.accessToken,
    active.origin,
    "stale-chatgpt-browser-session",
  );
  const continuedRead = await secondRound.callTool({
    name: "read",
    arguments: { workspaceId: workspaceA, path: "payload.txt" },
  });
  assertToolSucceeded(continuedRead);
  assert.match(JSON.stringify(continuedRead.content), /chatgpt-flow-ready/);
  const continuedExec = await secondRound.callTool({
    name: "exec_command",
    arguments: { workspaceId: workspaceA, cmd: "printf 'round-two\\n' >> conversation.txt" },
  });
  assertToolSucceeded(continuedExec);
  await closeClient(secondRound);

  const newSession = await connectClient("same-account-new-session", oauthA.accessToken, active.origin);
  const reopened = await newSession.callTool({
    name: "open_workspace",
    arguments: { path: workspaceRoot },
  });
  assertToolSucceeded(reopened);
  assert.equal(workspaceId(reopened), workspaceA);
  assert.equal(
    (reopened.structuredContent as { reused?: unknown } | undefined)?.reused,
    true,
  );
  const newSessionRead = await newSession.callTool({
    name: "read",
    arguments: { workspaceId: workspaceA, path: "conversation.txt" },
  });
  assertToolSucceeded(newSessionRead);
  assert.match(JSON.stringify(newSessionRead.content), /round-two/);
  const newSessionExec = await newSession.callTool({
    name: "exec_command",
    arguments: { workspaceId: workspaceA, cmd: "printf 'new-session\\n' >> conversation.txt" },
  });
  assertToolSucceeded(newSessionExec);
  await closeClient(newSession);

  const [concurrentA, concurrentB] = await Promise.all([
    connectClient("concurrent-client-a", oauthA.accessToken, active.origin),
    connectClient("concurrent-client-b", oauthB.accessToken, active.origin),
  ]);
  const [concurrentOpenA, concurrentOpenB] = await Promise.all([
    concurrentA.callTool({ name: "open_workspace", arguments: { path: workspaceRoot } }),
    concurrentB.callTool({ name: "open_workspace", arguments: { path: workspaceRoot } }),
  ]);
  assertToolSucceeded(concurrentOpenA);
  assertToolSucceeded(concurrentOpenB);
  const concurrentWorkspaceA = workspaceId(concurrentOpenA);
  const workspaceB = workspaceId(concurrentOpenB);
  assert.equal(concurrentWorkspaceA, workspaceA);
  assert.notEqual(concurrentWorkspaceA, workspaceB);

  const [aReadsB, bReadsA] = await Promise.all([
    concurrentA.callTool({
      name: "read",
      arguments: { workspaceId: workspaceB, path: "payload.txt" },
    }),
    concurrentB.callTool({
      name: "read",
      arguments: { workspaceId: concurrentWorkspaceA, path: "payload.txt" },
    }),
  ]);
  assertToolRejected(aReadsB, /Unknown workspaceId/);
  assertToolRejected(bReadsA, /Unknown workspaceId/);

  const node = JSON.stringify(process.execPath);
  const [backgroundA, backgroundB] = await Promise.all([
    concurrentA.callTool({
      name: "exec_command",
      arguments: {
        workspaceId: concurrentWorkspaceA,
        cmd: `${node} -e "setTimeout(() => console.log('client-a-background'), 250)"`,
        yieldTimeMs: 0,
      },
    }),
    concurrentB.callTool({
      name: "exec_command",
      arguments: {
        workspaceId: workspaceB,
        cmd: `${node} -e "setTimeout(() => console.log('client-b-background'), 250)"`,
        yieldTimeMs: 0,
      },
    }),
  ]);
  assertToolSucceeded(backgroundA);
  assertToolSucceeded(backgroundB);
  const sessionA = processSessionId(backgroundA);
  const sessionB = processSessionId(backgroundB);
  assert.notEqual(sessionA, sessionB);

  const [aPollsB, bPollsA] = await Promise.all([
    concurrentA.callTool({
      name: "write_stdin",
      arguments: { workspaceId: concurrentWorkspaceA, sessionId: sessionB, yieldTimeMs: 0 },
    }),
    concurrentB.callTool({
      name: "write_stdin",
      arguments: { workspaceId: workspaceB, sessionId: sessionA, yieldTimeMs: 0 },
    }),
  ]);
  assertToolRejected(aPollsB, /Unknown process session/);
  assertToolRejected(bPollsA, /Unknown process session/);

  const [finishedA, finishedB] = await Promise.all([
    concurrentA.callTool({
      name: "write_stdin",
      arguments: { workspaceId: concurrentWorkspaceA, sessionId: sessionA, yieldTimeMs: 2_000 },
    }),
    concurrentB.callTool({
      name: "write_stdin",
      arguments: { workspaceId: workspaceB, sessionId: sessionB, yieldTimeMs: 2_000 },
    }),
  ]);
  assertToolSucceeded(finishedA);
  assertToolSucceeded(finishedB);
  assert.match(JSON.stringify(finishedA.content), /client-a-background/);
  assert.match(JSON.stringify(finishedB.content), /client-b-background/);
  await Promise.all([closeClient(concurrentA), closeClient(concurrentB)]);

  assert.equal(await readFile(join(workspaceRoot, "safe-runs.txt"), "utf8"), "safe-run\nsafe-run\n");
  assert.equal(await readFile(join(workspaceRoot, "conversation.txt"), "utf8"), "round-two\nnew-session\n");
} finally {
  const cleanup = await Promise.allSettled([
    ...Array.from(clients, (client) => client.close()),
    ...(active ? [active.close()] : []),
  ]);
  await rm(root, { recursive: true, force: true });
  const failedCleanup = cleanup.find((result) => result.status === "rejected");
  if (failedCleanup?.status === "rejected") throw failedCleanup.reason;
}

interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
}

interface OAuthCredentials {
  clientId: string;
  accessToken: string;
}

async function discoverOAuth(origin: URL): Promise<OAuthMetadata> {
  const unauthorized = await fetch(new URL("/mcp", origin));
  assert.equal(unauthorized.status, 401);
  const challenge = unauthorized.headers.get("www-authenticate") ?? "";
  assert.match(challenge, /^Bearer /);
  const advertisedMetadata = challenge.match(/resource_metadata="([^"]+)"/)?.[1];
  assert.equal(advertisedMetadata, `${publicBaseUrl}/.well-known/oauth-protected-resource/mcp`);

  const resourceMetadataResponse = await fetch(localUrl(origin, advertisedMetadata));
  assert.equal(resourceMetadataResponse.status, 200);
  const resourceMetadata = await resourceMetadataResponse.json() as {
    resource?: unknown;
    authorization_servers?: unknown;
  };
  assert.equal(resourceMetadata.resource, resource);
  assert.deepEqual(resourceMetadata.authorization_servers, [`${publicBaseUrl}/`]);

  const authorizationMetadataResponse = await fetch(
    new URL("/.well-known/oauth-authorization-server", origin),
  );
  assert.equal(authorizationMetadataResponse.status, 200);
  const authorizationMetadata = await authorizationMetadataResponse.json() as Partial<OAuthMetadata>;
  assert.equal(authorizationMetadata.issuer, `${publicBaseUrl}/`);
  assert.equal(authorizationMetadata.authorization_endpoint, `${publicBaseUrl}/authorize`);
  assert.equal(authorizationMetadata.token_endpoint, `${publicBaseUrl}/token`);
  assert.equal(authorizationMetadata.registration_endpoint, `${publicBaseUrl}/register`);
  return authorizationMetadata as OAuthMetadata;
}

async function registerAndAuthorize(
  origin: URL,
  metadata: OAuthMetadata,
  label: string,
): Promise<OAuthCredentials> {
  const redirectUri = `https://chatgpt.com/connector/oauth/chatgpt-flow-e2e-${label}`;
  const verifier = `chatgpt-flow-e2e-${label}-verifier-0123456789-abcdefghijklmnopqrstuvwxyz`;
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const registration = await fetch(localUrl(origin, metadata.registration_endpoint), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: `ChatGPT flow e2e ${label}`,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  assert.equal(registration.status, 201);
  const registered = await registration.json() as { client_id?: unknown; redirect_uris?: unknown };
  assert.equal(typeof registered.client_id, "string");
  assert.deepEqual(registered.redirect_uris, [redirectUri]);
  const clientId = String(registered.client_id);
  const authorization = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "devspace",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
    state: `chatgpt-flow-e2e-${label}`,
    ui_locales: "en-US",
  });

  const authorizeUrl = localUrl(origin, metadata.authorization_endpoint);
  authorizeUrl.search = authorization.toString();
  const authorizePage = await fetch(authorizeUrl, { redirect: "manual" });
  assert.equal(authorizePage.status, 200);
  assert.match(authorizePage.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(await authorizePage.text(), /Owner password/);

  const approval = await fetch(localUrl(origin, metadata.authorization_endpoint), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...Object.fromEntries(authorization), owner_token: ownerPassword }),
    redirect: "manual",
  });
  assert.equal(approval.status, 302);
  const callback = new URL(approval.headers.get("location") ?? "");
  assert.equal(callback.origin, "https://chatgpt.com");
  assert.ok(callback.pathname.startsWith("/connector/oauth/"));
  assert.equal(callback.searchParams.get("state"), `chatgpt-flow-e2e-${label}`);
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const tokenResponse = await fetch(localUrl(origin, metadata.token_endpoint), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json() as { access_token?: unknown; token_type?: unknown };
  assert.equal(typeof tokens.access_token, "string");
  assert.equal(String(tokens.token_type).toLowerCase(), "bearer");
  return { clientId, accessToken: String(tokens.access_token) };
}

async function connectClient(
  name: string,
  accessToken: string,
  origin: URL,
  staleSessionId?: string,
): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  clients.add(client);
  const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
  if (staleSessionId) headers["mcp-session-id"] = staleSessionId;
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", origin), {
    requestInit: { headers },
  }));
  return client;
}

async function closeClient(client: Client): Promise<void> {
  await client.close();
  clients.delete(client);
}

function workspaceId(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const id = (result.structuredContent as { workspaceId?: unknown } | undefined)?.workspaceId;
  assert.equal(typeof id, "string");
  assert.ok(id);
  return String(id);
}

function processSessionId(result: Awaited<ReturnType<Client["callTool"]>>): number {
  const id = (result.structuredContent as { sessionId?: unknown } | undefined)?.sessionId;
  assert.equal(typeof id, "number");
  return Number(id);
}

function assertToolSucceeded(result: Awaited<ReturnType<Client["callTool"]>>): void {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
}

function assertToolRejected(
  result: Awaited<ReturnType<Client["callTool"]>>,
  pattern: RegExp,
): void {
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), pattern);
}

function localUrl(origin: URL, advertisedUrl: string): URL {
  const advertised = new URL(advertisedUrl);
  return new URL(`${advertised.pathname}${advertised.search}`, origin);
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
      const results = await Promise.allSettled([
        closeHttpServer(httpServer),
        running.close(),
      ]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
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
