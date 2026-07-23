import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";
import { createServer, isChatGptOAuthClient } from "./server.js";

assert.equal(isChatGptOAuthClient({
  redirect_uris: ["https://chatgpt.com/connector/oauth/test"],
}), true);
assert.equal(isChatGptOAuthClient({
  redirect_uris: ["https://chatgpt.com.evil.example/connector/oauth/test"],
}), false);
assert.equal(isChatGptOAuthClient({
  redirect_uris: [
    "https://chatgpt.com/connector/oauth/test",
    "http://127.0.0.1/callback",
  ],
}), false);
assert.equal(isChatGptOAuthClient({ redirect_uris: [] }), false);
assert.equal(isChatGptOAuthClient({
  redirect_uris: ["http://127.0.0.1/callback"],
}), false);
assert.equal(isChatGptOAuthClient({
  redirect_uris: ["http://chatgpt.com/connector/oauth/test"],
}), false);
assert.equal(isChatGptOAuthClient({ redirect_uris: ["not-a-url"] }), false);

const root = await mkdtemp(join(tmpdir(), "devspace-mcp-transport-mode-"));
const workspaceRoot = join(root, "workspace");
const stateDir = join(root, "state");
const publicBaseUrl = "http://127.0.0.1:7676";
const chatGptToken = "chatgpt-stateless-access-token";
const statefulToken = "stateful-access-token";
const clients: Client[] = [];
await mkdir(workspaceRoot, { recursive: true });
await writeFile(join(workspaceRoot, "AGENTS.md"), "# Transport test instructions\n\nKeep this fixture read-only.\n");
await writeFile(join(workspaceRoot, "payload.txt"), "transport-mode-ok\n");

const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
  DEVSPACE_ALLOWED_HOSTS: "*",
  DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
  DEVSPACE_OAUTH_OWNER_TOKEN: "mcp-transport-owner-token-long-enough",
  DEVSPACE_SKILLS: "0",
  DEVSPACE_WIDGETS: "off",
  DEVSPACE_LOG_LEVEL: "warn",
  DEVSPACE_LOG_FORMAT: "json",
  DEVSPACE_MAX_MCP_SESSIONS: "2",
  DEVSPACE_MAX_MCP_SESSIONS_PER_CLIENT: "1",
});
seedClient(chatGptToken, "https://chatgpt.com/connector/oauth/transport-test", "chatgpt");
seedClient(statefulToken, "http://127.0.0.1/stateful-callback", "stateful");

const running = createServer(config);
const httpServer = createHttpServer(running.app);
try {
  const origin = await listen(httpServer);
  const firstObserved: ObservedResponse[] = [];
  const firstChatGpt = await connectClient("chatgpt-one", chatGptToken, origin, firstObserved);
  clients.push(firstChatGpt);
  assert.equal(firstObserved.some((entry) => entry.sessionId !== null), false);
  await firstChatGpt.listTools();
  const opened = await firstChatGpt.callTool({
    name: "open_workspace",
    arguments: { path: workspaceRoot },
  });
  const workspaceId = String(
    (opened.structuredContent as { workspaceId?: unknown } | undefined)?.workspaceId ?? "",
  );
  assert.ok(workspaceId);
  const instructionRevision = String(
    (opened.structuredContent as { instructionRevision?: unknown } | undefined)?.instructionRevision ?? "",
  );
  assert.ok(instructionRevision);
  const compactReopen = await firstChatGpt.callTool({
    name: "open_workspace",
    arguments: { path: workspaceRoot, knownInstructionRevision: instructionRevision },
  });
  const compactStructured = compactReopen.structuredContent as {
    instructionsIncluded?: unknown;
    agentsFiles?: unknown;
  } | undefined;
  assert.equal(compactStructured?.instructionsIncluded, false);
  assert.deepEqual(compactStructured?.agentsFiles, []);

  const getResponse = await fetch(new URL("/mcp", origin), {
    headers: { authorization: `Bearer ${chatGptToken}` },
  });
  assert.equal(getResponse.status, 405);
  assert.equal(getResponse.headers.get("allow"), "POST");
  const deleteResponse = await fetch(new URL("/mcp", origin), {
    method: "DELETE",
    headers: { authorization: `Bearer ${chatGptToken}` },
  });
  assert.equal(deleteResponse.status, 405);

  const staleStatelessResponse = await rawMcpPost(origin, chatGptToken, "stale-chatgpt-session");
  assert.equal(staleStatelessResponse.status, 200);

  const heldCommand = firstChatGpt.callTool({
    name: "exec_command",
    arguments: { workspaceId, cmd: "sleep 0.25", yieldTimeMs: 1_000 },
  });
  await delay(50);
  const overCapacity = await rawMcpPost(origin, chatGptToken, "concurrent-chatgpt-session");
  assert.equal(overCapacity.status, 503);
  assert.match(await overCapacity.text(), /MCP request capacity reached/);
  await heldCommand;
  const afterCapacityRelease = await rawMcpPost(origin, chatGptToken, "released-chatgpt-session");
  assert.equal(afterCapacityRelease.status, 200);

  await firstChatGpt.close();

  const secondObserved: ObservedResponse[] = [];
  const secondChatGpt = await connectClient("chatgpt-two", chatGptToken, origin, secondObserved);
  clients.push(secondChatGpt);
  assert.equal(secondObserved.some((entry) => entry.sessionId !== null), false);
  const directReuseAfterTransportClose = await secondChatGpt.callTool({
    name: "read",
    arguments: { workspaceId, path: "payload.txt" },
  });
  assert.match(JSON.stringify(directReuseAfterTransportClose.content), /transport-mode-ok/);
  const freshConversationOpen = await secondChatGpt.callTool({
    name: "open_workspace",
    arguments: { path: workspaceRoot },
  });
  const freshStructured = freshConversationOpen.structuredContent as {
    instructionsIncluded?: unknown;
    agentsFiles?: unknown[];
  } | undefined;
  assert.equal(freshStructured?.instructionsIncluded, true);
  assert.ok((freshStructured?.agentsFiles?.length ?? 0) > 0);
  const reusedRead = await secondChatGpt.callTool({
    name: "read",
    arguments: { workspaceId, path: "payload.txt" },
  });
  assert.match(JSON.stringify(reusedRead.content), /transport-mode-ok/);

  const statefulObserved: ObservedResponse[] = [];
  const stateful = await connectClient("stateful-client", statefulToken, origin, statefulObserved);
  clients.push(stateful);
  const statefulSessionId = statefulObserved.find((entry) => entry.sessionId)?.sessionId;
  assert.equal(typeof statefulSessionId, "string");
  await stateful.listTools();

  const warningLines: string[] = [];
  const originalWarn = console.warn;
  let staleStatefulResponse: Response;
  console.warn = (...values: unknown[]) => {
    warningLines.push(values.map(String).join(" "));
  };
  try {
    staleStatefulResponse = await rawMcpPost(origin, statefulToken, "stale-stateful-session");
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(staleStatefulResponse.status, 404);
  assert.match(await staleStatefulResponse.text(), /Unknown MCP session/);
  const unknownSessionLog = warningLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((entry) => entry.event === "unknown_mcp_session");
  assert.ok(unknownSessionLog);
  assert.equal(unknownSessionLog.sessionIdPrefix, "stale-st");
  assert.equal(unknownSessionLog.reason, "not_found_or_not_owned");
  const serializedLog = JSON.stringify(unknownSessionLog);
  assert.doesNotMatch(serializedLog, /stale-stateful-session/);
  assert.doesNotMatch(serializedLog, new RegExp(statefulToken));
} finally {
  for (const client of clients.reverse()) await client.close().catch(() => undefined);
  await closeHttpServer(httpServer);
  await running.close();
  await rm(root, { recursive: true, force: true });
}

interface ObservedResponse {
  method: string;
  status: number;
  sessionId: string | null;
}

async function connectClient(
  name: string,
  accessToken: string,
  origin: URL,
  observed: ObservedResponse[],
): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", origin), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      observed.push({
        method: init?.method ?? "GET",
        status: response.status,
        sessionId: response.headers.get("mcp-session-id"),
      });
      return response;
    },
  }));
  return client;
}

function rawMcpPost(origin: URL, accessToken: string, sessionId: string): Promise<Response> {
  return fetch(new URL("/mcp", origin), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
  });
}

function seedClient(accessToken: string, redirectUri: string, name: string): void {
  const store = new SqliteOAuthStore(stateDir);
  try {
    const clientsStore = new SqliteOAuthClientsStore(store, config.oauth.allowedRedirectHosts);
    const client = clientsStore.registerClient({
      redirect_uris: [redirectUri],
      client_name: name,
    });
    const resource = new URL("/mcp", publicBaseUrl).href;
    const expiresAt = Math.floor(Date.now() / 1_000) + 3_600;
    store.saveTokenPair({
      accessTokenHash: hashToken(accessToken),
      accessToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt, resource },
      refreshTokenHash: hashToken(`${accessToken}-refresh`),
      refreshToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt, resource },
    });
  } finally {
    store.close();
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
