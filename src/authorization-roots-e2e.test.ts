import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { authorizationRootId } from "./authorization-roots.js";
import { loadConfig } from "./config.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";
import { createServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const root = await mkdtemp(join(tmpdir(), "devspace-authorization-roots-e2e-"));
const rootA = join(root, "account-a-root");
const rootB = join(root, "account-b-root");
const stateDir = join(root, "state");
const ownerToken = "authorization-roots-owner-token-long-enough";
const publicBaseUrl = "http://127.0.0.1:7676";
const accessTokenA = "authorization-root-token-a";
const accessTokenB = "authorization-root-token-b";

await Promise.all([
  mkdir(rootA, { recursive: true }),
  mkdir(rootB, { recursive: true }),
]);
await Promise.all([
  writeFile(join(rootA, "payload.txt"), "account-a\n"),
  writeFile(join(rootB, "payload.txt"), "account-b\n"),
]);

const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_ALLOWED_ROOTS: `${rootA},${rootB}`,
  DEVSPACE_ALLOWED_HOSTS: "*",
  DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
  DEVSPACE_OAUTH_OWNER_TOKEN: ownerToken,
  DEVSPACE_WIDGETS: "off",
  DEVSPACE_SKILLS: "0",
  DEVSPACE_LOG_LEVEL: "silent",
  PORT: "1",
});

const principalA = seedGrant(accessTokenA, rootA, "Account A");
seedGrant(accessTokenB, rootB, "Account B");
const workspaceStore = new SqliteWorkspaceStore(stateDir);
try {
  workspaceStore.createSession({
    id: "account-a-hidden-root-b",
    connectionPrincipalId: principalA,
    alias: "hidden-root-b",
    root: rootB,
    mode: "checkout",
    writeAccess: "read_only",
  });
} finally {
  workspaceStore.close();
}

const running = createServer(config);
const httpServer = createHttpServer(running.app);
const origin = await listen(httpServer);
const clients: Client[] = [];

try {
  const accountA = await connect("authorization-root-a", accessTokenA);
  const initialListA = await accountA.callTool({ name: "list_workspaces", arguments: {} });
  assertSucceeded(initialListA);
  assert.equal(
    JSON.stringify(initialListA.structuredContent).includes("hidden-root-b"),
    false,
  );
  const openA = await accountA.callTool({
    name: "open_workspace",
    arguments: { path: rootA, alias: "account-a", contextMode: "full" },
  });
  assertSucceeded(openA);
  assertSucceeded(await accountA.callTool({
    name: "read",
    arguments: { receipt: receipt(openA), path: "payload.txt" },
  }));
  assertRootDenied(await accountA.callTool({
    name: "open_workspace",
    arguments: { path: rootB, alias: "account-a-denied", contextMode: "full" },
  }));
  assertRootDenied(await accountA.callTool({
    name: "resume_workspace",
    arguments: { alias: "hidden-root-b", contextMode: "full" },
  }));

  const accountB = await connect("authorization-root-b", accessTokenB);
  const openB = await accountB.callTool({
    name: "open_workspace",
    arguments: { path: rootB, alias: "account-b", contextMode: "full" },
  });
  assertSucceeded(openB);
  assertSucceeded(await accountB.callTool({
    name: "read",
    arguments: { receipt: receipt(openB), path: "payload.txt" },
  }));
  assertRootDenied(await accountB.callTool({
    name: "open_workspace",
    arguments: { path: rootA, alias: "account-b-denied", contextMode: "full" },
  }));
} finally {
  for (const client of clients.reverse()) await client.close().catch(() => undefined);
  await closeHttpServer(httpServer);
  await running.close();
  await rm(root, { recursive: true, force: true });
}

function seedGrant(accessToken: string, authorizedRoot: string, clientName: string): string {
  const store = new SqliteOAuthStore(stateDir);
  try {
    const client = new SqliteOAuthClientsStore(
      store,
      config.oauth.allowedRedirectHosts,
    ).registerClient({
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      client_name: clientName,
    });
    const grant = store.createAuthorizationGrant({
      clientId: client.client_id,
      scopes: ["workspace:read"],
      allowedRootIds: [authorizationRootId(authorizedRoot, ownerToken)],
    });
    const expiresAt = Math.floor(Date.now() / 1_000) + 3_600;
    const resource = new URL("/mcp", publicBaseUrl).href;
    store.saveTokenPair({
      accessTokenHash: hashToken(accessToken),
      accessToken: {
        grantId: grant.grantId,
        clientId: client.client_id,
        principalId: grant.principalId,
        authorizationEpoch: grant.authorizationEpoch,
        scopes: [...grant.grantedScopes],
        expiresAt,
        resource,
      },
      refreshTokenHash: hashToken(`${accessToken}-refresh`),
      refreshToken: {
        grantId: grant.grantId,
        clientId: client.client_id,
        principalId: grant.principalId,
        authorizationEpoch: grant.authorizationEpoch,
        scopes: [...grant.grantedScopes],
        expiresAt,
        resource,
      },
    });
    return grant.principalId;
  } finally {
    store.close();
  }
}

async function connect(name: string, accessToken: string): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", origin), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  }));
  clients.push(client);
  return client;
}

function receipt(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const value = (result.structuredContent as {
    continuation?: { receipt?: unknown };
  } | undefined)?.continuation?.receipt;
  assert.equal(typeof value, "string");
  return String(value);
}

function assertSucceeded(result: Awaited<ReturnType<Client["callTool"]>>): void {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
}

function assertRootDenied(result: Awaited<ReturnType<Client["callTool"]>>): void {
  assert.equal(result.isError, true, JSON.stringify(result.content));
  const code = (result.structuredContent as {
    error?: { code?: unknown };
  } | undefined)?.error?.code;
  assert.ok(
    code === "path_not_allowed" ||
      code === "path_denied" ||
      code === "unknown_workspace_alias",
    `unexpected root denial code: ${String(code)}`,
  );
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function listen(server: HttpServer): Promise<URL> {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      resolveListen(new URL(`http://127.0.0.1:${address.port}`));
    });
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}
