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
import { authorizationRootId } from "./authorization-roots.js";
import { loadConfig } from "./config.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";
import { createServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-authorization-roots-e2e-"));
const rootA = join(root, "authorized-root");
const rootB = join(root, "ungranted-root");
const stateDir = join(root, "state");
const ownerToken = "authorization-roots-owner-token-long-enough";
const publicBaseUrl = "http://127.0.0.1:7676";
const accessToken = "authorization-root-token";

await Promise.all([
  mkdir(rootA, { recursive: true }),
  mkdir(rootB, { recursive: true }),
]);
await Promise.all([
  writeFile(join(rootA, "payload.txt"), "authorized\n"),
  writeFile(join(rootB, "payload.txt"), "ungranted\n"),
]);
await execFileAsync("git", ["init", "-q"], { cwd: rootA });
await execFileAsync("git", ["add", "."], { cwd: rootA });
await execFileAsync(
  "git",
  [
    "-c", "user.name=DevSpace Test",
    "-c", "user.email=devspace@example.invalid",
    "-c", "commit.gpgsign=false",
    "commit", "-qm", "fixture",
  ],
  { cwd: rootA },
);

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

const principal = seedGrant(accessToken, rootA, "Owner");
const workspaceStore = new SqliteWorkspaceStore(stateDir);
try {
  workspaceStore.createSession({
    id: "account-a-hidden-root-b",
    connectionPrincipalId: principal,
    alias: "hidden-root-b",
    root: rootB,
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
  const client = await connect("authorization-root", accessToken);
  const hostMeta = {
    "openai/subject": "authorization-root-subject",
    "openai/session": "authorization-root-session",
  };
  const initialList = await client.callTool({ name: "list_projects", arguments: {} });
  assertSucceeded(initialList);
  assert.equal(
    JSON.stringify(initialList.structuredContent).includes("hidden-root-b"),
    false,
  );
  const projectRef = onlyProjectRef(initialList);
  assert.equal(
    JSON.stringify(initialList.structuredContent).includes("ungranted-root"),
    false,
  );
  const selected = await client.callTool({
    name: "project_control",
    arguments: { action: "open", operationId: "authorization-root-execution" },
    _meta: hostMeta,
  });
  assertSucceeded(selected);
  assert.doesNotMatch(
    JSON.stringify(selected.structuredContent),
    /workspace|receipt|continuation|contextChanged|phase/iu,
  );
  const read = await client.callTool({
    name: "read_files",
    arguments: { files: [{ path: "payload.txt" }] },
    _meta: hostMeta,
  });
  assertSucceeded(read);
  assert.match(JSON.stringify(read.structuredContent), /authorized/u);
  const ungrantedProjectRef = authorizationRootId(
    rootB,
    config.oauth.keys.authorizationRoot,
  );
  assert.notEqual(projectRef, ungrantedProjectRef);
  assertProjectDenied(await client.callTool({
    name: "project_control",
    arguments: {
      action: "open",
      projectRef: ungrantedProjectRef,
      operationId: "ungranted-root-execution",
    },
    _meta: hostMeta,
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
      scopes: ["project:read"],
      allowedRootIds: [authorizationRootId(authorizedRoot, config.oauth.keys.authorizationRoot)],
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

function onlyProjectRef(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const projects = (result.structuredContent as {
    projects?: Array<{ projectRef?: unknown }>;
  } | undefined)?.projects;
  assert.equal(projects?.length, 1);
  assert.equal(typeof projects?.[0]?.projectRef, "string");
  return String(projects?.[0]?.projectRef);
}

function assertSucceeded(result: Awaited<ReturnType<Client["callTool"]>>): void {
  assert.notEqual(
    result.isError,
    true,
    JSON.stringify({ content: result.content, structuredContent: result.structuredContent }),
  );
}

function assertProjectDenied(result: Awaited<ReturnType<Client["callTool"]>>): void {
  assert.equal(result.isError, true, JSON.stringify(result.content));
  const code = (result.structuredContent as {
    error?: { code?: unknown };
  } | undefined)?.error?.code;
  assert.equal(code, "project_not_authorized");
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
