import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import { DEVSPACE_CAPABILITY_SCOPES } from "./oauth-scopes.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";
import { createServer } from "./server.js";

const root = await mkdtemp(join(tmpdir(), "devspace-tool-profile-e2e-"));
const workspaceRoot = join(root, "workspace");
const stateDir = join(root, "state");
const publicBaseUrl = "http://127.0.0.1:7676";
const accessToken = "tool-profile-browse-access-token";

await mkdir(workspaceRoot, { recursive: true });
await writeFile(join(workspaceRoot, "payload.txt"), "browse-profile-ready\n");

const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
  DEVSPACE_ALLOWED_HOSTS: "*",
  DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
  DEVSPACE_OAUTH_OWNER_TOKEN: "tool-profile-owner-token-long-enough",
  DEVSPACE_TOOL_PROFILE: "browse",
  DEVSPACE_WIDGETS: "off",
  DEVSPACE_LOG_LEVEL: "silent",
  PORT: "1",
});

seedGrant();

const running = createServer(config);
const httpServer = createHttpServer(running.app);
const origin = await listen(httpServer);
const client = new Client({ name: "tool-profile-e2e", version: "1.0.0" });

try {
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", origin), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  }));
  const toolsList = await client.listTools();
  const names = toolsList.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "batch_inspect",
    "batch_read",
    "get_workspace_context",
    "list_workspaces",
    "load_workspace_instructions",
    "open_workspace",
    "read",
    "resume_workspace",
    "show_changes",
  ]);
  const bytes = Buffer.byteLength(JSON.stringify(toolsList), "utf8");
  assert.ok(bytes < 12_000, `browse-profile tools/list must be under 12000 bytes; got ${bytes}`);
  assert.ok(toolsList.tools.find((tool) => tool.name === "open_workspace")?.outputSchema);
  assert.ok(toolsList.tools.find((tool) => tool.name === "read")?.outputSchema);
  for (const tool of toolsList.tools) {
    if (tool.name === "open_workspace" || tool.name === "read") continue;
    assert.equal(tool.outputSchema, undefined, `${tool.name} should omit redundant output schema`);
  }

  const opened = await client.callTool({
    name: "open_workspace",
    arguments: { path: workspaceRoot, alias: "browse-profile", contextMode: "full" },
  });
  assert.notEqual(opened.isError, true, JSON.stringify(opened.content));
  const receipt = String((opened.structuredContent as {
    continuation?: { receipt?: unknown };
  } | undefined)?.continuation?.receipt ?? "");
  assert.match(receipt, /^wctx5\./u);
  const read = await client.callTool({
    name: "read",
    arguments: { receipt, path: "payload.txt" },
  });
  assert.notEqual(read.isError, true, JSON.stringify(read.content));
  assert.match(JSON.stringify(read.content), /browse-profile-ready/u);
  await assertToolUnavailable(client.callTool({
    name: "apply_patch",
    arguments: {
      receipt,
      operationId: "browse-profile-write-denied",
      ifMatch: { "denied.txt": null },
      patch: "*** Begin Patch\n*** Add File: denied.txt\n+denied\n*** End Patch",
    },
  }), "apply_patch");

  console.log(`TOOL_PROFILE_BUDGET ${JSON.stringify({ profile: "browse", bytes, tools: names.length })}`);
} finally {
  await client.close().catch(() => undefined);
  await closeHttpServer(httpServer);
  await running.close();
  await rm(root, { recursive: true, force: true });
}

function seedGrant(): void {
  const store = new SqliteOAuthStore(stateDir);
  try {
    const client = new SqliteOAuthClientsStore(
      store,
      config.oauth.allowedRedirectHosts,
    ).registerClient({
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      client_name: "browse-profile",
    });
    const grant = store.createAuthorizationGrant({
      clientId: client.client_id,
      scopes: [...DEVSPACE_CAPABILITY_SCOPES],
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
  } finally {
    store.close();
  }
}

async function assertToolUnavailable(
  resultPromise: Promise<Awaited<ReturnType<Client["callTool"]>>>,
  toolName: string,
): Promise<void> {
  try {
    const result = await resultPromise;
    assert.equal(result.isError, true, JSON.stringify(result.content));
    assert.match(JSON.stringify(result.content), new RegExp(`Tool ${toolName} not found`, "u"));
  } catch (error) {
    assert.match(String(error), /Method not found/u);
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
