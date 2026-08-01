import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { authorizationRootId } from "./authorization-roots.js";
import { loadConfig, type McpHttpTransportMode } from "./config.js";
import { DEVSPACE_CAPABILITY_SCOPES } from "./oauth-scopes.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";
import { createServer } from "./server.js";

const execFileAsync = promisify(execFile);
const fixtureRoot = await mkdtemp(join(tmpdir(), "devspace-transport-mode-"));
try {
  await runMode("stateless", 0);
  await runMode("stateful", 1);
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

async function runMode(mode: McpHttpTransportMode, index: number): Promise<void> {
  const modeRoot = join(fixtureRoot, mode);
  const projectRoot = join(modeRoot, "project");
  const stateDir = join(modeRoot, "state");
  const publicBaseUrl = `http://127.0.0.1:${7676 + index}`;
  const accessToken = `transport-${mode}-access-token`;
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    join(projectRoot, "AGENTS.md"),
    `# ${mode} Project\n\nExercise the ${mode} MCP transport.\n`,
  );
  await writeFile(join(projectRoot, "payload.txt"), `${mode}-ready\n`);
  await execFileAsync("git", ["init", "-q"], { cwd: projectRoot });
  await execFileAsync("git", ["add", "."], { cwd: projectRoot });
  await execFileAsync(
    "git",
    [
      "-c", "user.name=DevSpace Test",
      "-c", "user.email=devspace@example.invalid",
      "-c", "commit.gpgsign=false",
      "commit", "-qm", "fixture",
    ],
    { cwd: projectRoot },
  );

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(modeRoot, "config"),
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_ALLOWED_HOSTS: "*",
    DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
    DEVSPACE_OAUTH_OWNER_TOKEN: `transport-${mode}-owner-token-long-enough`,
    DEVSPACE_OAUTH_SCOPES: DEVSPACE_CAPABILITY_SCOPES.join(","),
    DEVSPACE_WIDGETS: "off",
    DEVSPACE_LOG_LEVEL: "silent",
    DEVSPACE_MCP_HTTP_TRANSPORT: mode,
  });
  seedAccessToken(config, stateDir, projectRoot, publicBaseUrl, accessToken, mode);
  const running = createServer(config);
  const httpServer = createHttpServer(running.app);
  const clients: Client[] = [];
  try {
    const origin = await listen(httpServer);
    const first = await connect(
      origin,
      accessToken,
      `${mode}-first`,
      clients,
    );
    const tools = await first.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        "apply_patch",
        "exec_command",
        "inspect",
        "list_projects",
        "project_control",
        "read_files",
        "read_process_output",
        "save_progress",
        "show_changes",
        "skills",
        "write_stdin",
      ].sort(),
    );
    assert.doesNotMatch(
      JSON.stringify(tools),
      /open_workspace|list_workspaces|resume_workspace|receipt|workspaceId|workspaceGeneration/iu,
    );

    const selected = await first.callTool({
      name: "project_control",
      arguments: { action: "open", operationId: `${mode}-first-execution` },
    });
    assertSucceeded(selected);
    assert.match(JSON.stringify(selected.structuredContent), new RegExp(`${mode} Project`, "u"));
    assertProjectOnly(selected);
    const executionRef = projectExecutionRef(selected);
    assertReadText(
      await first.callTool({
        name: "read_files",
        arguments: { executionRef, files: [{ path: "payload.txt" }] },
      }),
      `${mode}-ready`,
    );

    await closeClient(first, clients);
    const reconnected = await connect(
      origin,
      accessToken,
      `${mode}-reconnected`,
      clients,
    );
    assertReadText(
      await reconnected.callTool({
        name: "read_files",
        arguments: { executionRef, files: [{ path: "payload.txt" }] },
      }),
      `${mode}-ready`,
    );

    const otherConversation = await connect(
      origin,
      accessToken,
      `${mode}-other`,
      clients,
    );
    assertErrorCode(
      await otherConversation.callTool({
        name: "read_files",
        arguments: { files: [{ path: "payload.txt" }] },
      }),
      "invalid_tool_input",
    );
    const otherSelected = await otherConversation.callTool({
      name: "project_control",
      arguments: { action: "open", operationId: `${mode}-other-execution` },
    });
    assertSucceeded(otherSelected);
    const otherExecutionRef = projectExecutionRef(otherSelected);
    assert.notEqual(otherExecutionRef, executionRef);
    assertReadText(
      await otherConversation.callTool({
        name: "read_files",
        arguments: { executionRef: otherExecutionRef, files: [{ path: "payload.txt" }] },
      }),
      `${mode}-ready`,
    );
  } finally {
    while (clients.length > 0) {
      await closeClient(clients[clients.length - 1]!, clients);
    }
    await closeHttpServer(httpServer);
    await running.close();
  }
}

function seedAccessToken(
  config: ReturnType<typeof loadConfig>,
  stateDir: string,
  projectRoot: string,
  publicBaseUrl: string,
  accessToken: string,
  mode: McpHttpTransportMode,
): void {
  const store = new SqliteOAuthStore(stateDir);
  try {
    const client = new SqliteOAuthClientsStore(
      store,
      config.oauth.allowedRedirectHosts,
    ).registerClient({
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      client_name: `transport-${mode}`,
    });
    const grant = store.createAuthorizationGrant({
      clientId: client.client_id,
      scopes: [...DEVSPACE_CAPABILITY_SCOPES],
      allowedRootIds: [
        authorizationRootId(projectRoot, config.oauth.keys.authorizationRoot),
      ],
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
        expiresAt: expiresAt + 3_600,
        resource,
      },
    });
  } finally {
    store.close();
  }
}

async function connect(
  origin: URL,
  accessToken: string,
  name: string,
  clients: Client[],
): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", origin), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  }));
  clients.push(client);
  return client;
}

async function closeClient(client: Client, clients: Client[]): Promise<void> {
  const index = clients.indexOf(client);
  if (index >= 0) clients.splice(index, 1);
  await client.close().catch(() => undefined);
}

function assertProjectOnly(
  result: Awaited<ReturnType<Client["callTool"]>>,
): void {
  const serialized = JSON.stringify(result.structuredContent ?? {});
  assert.match(serialized, /"project"/u);
  assert.doesNotMatch(
    serialized,
    /"(?:workspace|receipt|continuation|contextChanged|state|phase|instructionToken)"\s*:/iu,
  );
}

function projectExecutionRef(
  result: Awaited<ReturnType<Client["callTool"]>>,
): string {
  const executionRef = String(
    (result.structuredContent as {
      project?: { executionRef?: unknown };
    } | undefined)?.project?.executionRef ?? "",
  );
  assert.match(executionRef, /^pex1_/u);
  return executionRef;
}

function assertReadText(
  result: Awaited<ReturnType<Client["callTool"]>>,
  expected: string,
): void {
  assertSucceeded(result);
  assert.match(JSON.stringify(result.structuredContent), new RegExp(expected, "u"));
}

function assertSucceeded(result: Awaited<ReturnType<Client["callTool"]>>): void {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
}

function assertErrorCode(
  result: Awaited<ReturnType<Client["callTool"]>>,
  code: string,
): void {
  assert.equal(result.isError, true, JSON.stringify(result.content));
  assert.equal(
    (result.structuredContent as {
      error?: { code?: unknown };
    } | undefined)?.error?.code,
    code,
  );
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
