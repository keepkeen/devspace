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
import {
  DEVSPACE_CAPABILITY_SCOPES,
  oauthScopeAllows,
} from "./oauth-scopes.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";
import { createServer, requiredOAuthScopesForTool } from "./server.js";

const root = await mkdtemp(join(tmpdir(), "devspace-oauth-scope-e2e-"));
const workspaceRoot = join(root, "workspace");
const stateDir = join(root, "state");
const publicBaseUrl = "http://127.0.0.1:7676";
const tokens = {
  read: "oauth-scope-read-token",
  write: "oauth-scope-write-token",
  process: "oauth-scope-process-token",
  full: "oauth-scope-full-token",
};
const execFileAsync = promisify(execFile);
const readHostMeta = hostMeta("read");
const writeHostMeta = hostMeta("write");
const processHostMeta = hostMeta("process");
const fullHostMeta = hostMeta("full");

await mkdir(workspaceRoot, { recursive: true });
await writeFile(join(workspaceRoot, "payload.txt"), "scope-ready\n");
await execFileAsync("git", ["init", "-q"], { cwd: workspaceRoot });
await execFileAsync("git", ["add", "."], { cwd: workspaceRoot });
await execFileAsync(
  "git",
  [
    "-c", "user.name=DevSpace Test",
    "-c", "user.email=devspace@example.invalid",
    "-c", "commit.gpgsign=false",
    "commit", "-qm", "fixture",
  ],
  { cwd: workspaceRoot },
);

const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
  DEVSPACE_ALLOWED_HOSTS: "*",
  DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
  DEVSPACE_OAUTH_OWNER_TOKEN: "oauth-scope-test-owner-token-long-enough",
  DEVSPACE_OAUTH_SCOPES: DEVSPACE_CAPABILITY_SCOPES.join(","),
  DEVSPACE_WIDGETS: "off",
  DEVSPACE_LOG_LEVEL: "silent",
  PORT: "1",
});

assert.deepEqual(DEVSPACE_CAPABILITY_SCOPES, [
  "project:read",
  "project:write",
  "process:execute",
]);
assert.equal(oauthScopeAllows(["project:read"], "project:write"), false);
assert.deepEqual(requiredOAuthScopesForTool("exec_command"), [
  "project:read",
  "project:write",
  "process:execute",
]);

const running = createServer(config);
const httpServer = createHttpServer(running.app);
const origin = await listen(httpServer);
const clients: Client[] = [];

try {
  seedToken(tokens.read, ["project:read"]);
  const readClient = await connect("scope-read", tokens.read);
  const readToolsList = await readClient.listTools();
  const readTools = new Set(readToolsList.tools.map((tool) => tool.name));
  for (const name of [
    "list_projects",
    "project_control",
    "project_thread_control",
    "skills",
    "read_files",
    "inspect",
    "show_changes",
  ]) {
    assert.equal(readTools.has(name), true, `${name} must be visible to project:read grants`);
  }
  const showChangesMeta = readToolsList.tools.find(
    (tool) => tool.name === "show_changes",
  )?._meta as {
    ui?: unknown;
    securitySchemes?: unknown;
  } | undefined;
  assert.equal(
    showChangesMeta?.ui,
    undefined,
    "widgets=off must expose show_changes without widget metadata",
  );
  assert.deepEqual(showChangesMeta?.securitySchemes, [{
    type: "oauth2",
    scopes: ["project:read"],
  }]);
  const showChangesInput = readToolsList.tools.find(
    (tool) => tool.name === "show_changes",
  )?.inputSchema as { properties?: Record<string, unknown> } | undefined;
  assert.ok(showChangesInput?.properties?.cursor);
  for (const removedInput of ["advanceCheckpoint", "reviewToken", "operationId"]) {
    assert.equal(showChangesInput?.properties?.[removedInput], undefined);
  }
  for (const name of [
    "get_operation_status",
    "resolve_operation",
    "apply_patch",
    "exec_command",
    "poll_process",
    "write_process_input",
    "read_process_output",
    "close_workspace",
    "revoke_workspace",
  ]) {
    assert.equal(readTools.has(name), false, `${name} must be hidden from project:read grants`);
  }
  const malformedUnavailableTool = await readClient.callTool({
    name: "exec_command",
    arguments: { program: 123 as unknown as string, args: "not-an-array" as unknown as string[] },
  });
  assert.equal(malformedUnavailableTool.isError, true);
  assert.equal(
    (malformedUnavailableTool.structuredContent as {
      error?: { code?: unknown };
    } | undefined)?.error?.code,
    "tool_unavailable",
  );
  assert.doesNotMatch(JSON.stringify(malformedUnavailableTool.content), /invalid_tool_input|Expected string|Expected array/u);
  const readOpen = await readClient.callTool({
    name: "project_control",
    arguments: { action: "open", operationId: "read-scope-execution" },
    _meta: readHostMeta,
  });
  assertSucceeded(readOpen);
  assertNoWorkspaceProtocol(readOpen);
  assertSucceeded(await readClient.callTool({
    name: "read_files",
    arguments: { files: [{ path: "payload.txt" }] },
    _meta: readHostMeta,
  }));
  const readOnlyChangePreview = await readClient.callTool({
    name: "show_changes",
    arguments: { source: "repository" },
    _meta: readHostMeta,
  });
  assertSucceeded(readOnlyChangePreview);
  assert.ok(
    Array.isArray(readOnlyChangePreview.content) && readOnlyChangePreview.content.length > 0,
    "widgets=off must still return ordinary model-visible change text",
  );
  assert.equal(
    Object.hasOwn(
      (readOnlyChangePreview.structuredContent ?? {}) as Record<string, unknown>,
      "effects",
    ),
    false,
  );
  await assertToolUnavailable(readClient.callTool({
    name: "apply_patch",
    arguments: {
      operationId: "read-scope-patch",
      ifMatch: { "read-denied.txt": null },
      patch: "*** Begin Patch\n*** Add File: read-denied.txt\n+denied\n*** End Patch",
    },
    _meta: readHostMeta,
  }), "apply_patch");
  assertInvalidInput(await readClient.callTool({
    name: "project_control",
    arguments: { legacyWorkspaceChoice: "unsupported" },
    _meta: readHostMeta,
  }));
  seedToken(tokens.write, ["project:read", "project:write"]);
  const writeClient = await connect("scope-write", tokens.write);
  const writeTools = new Set((await writeClient.listTools()).tools.map((tool) => tool.name));
  assert.equal(writeTools.has("apply_patch"), true);
  assert.equal(writeTools.has("show_changes"), true);
  assert.equal(writeTools.has("exec_command"), false);
  assert.equal(writeTools.has("close_workspace"), false);
  const writeOpen = await writeClient.callTool({
    name: "project_control",
    arguments: { action: "open", operationId: "write-scope-execution" },
    _meta: writeHostMeta,
  });
  assertSucceeded(writeOpen);
  assertNoWorkspaceProtocol(writeOpen);
  assertSucceeded(await writeClient.callTool({
    name: "apply_patch",
    arguments: {
      operationId: "write-scope-patch",
      ifMatch: { "write-ok.txt": null },
      patch: "*** Begin Patch\n*** Add File: write-ok.txt\n+ok\n*** End Patch",
    },
    _meta: writeHostMeta,
  }));
  const writePreview = await writeClient.callTool({
    name: "show_changes",
    arguments: { source: "repository" },
    _meta: writeHostMeta,
  });
  assertSucceeded(writePreview);
  assert.equal(
    Object.hasOwn(
      (writePreview.structuredContent ?? {}) as Record<string, unknown>,
      "effects",
    ),
    false,
  );
  assert.equal(
    (writePreview.structuredContent as {
      diff?: { eof?: unknown };
    } | undefined)?.diff?.eof,
    true,
  );
  await assertToolUnavailable(writeClient.callTool({
    name: "exec_command",
    arguments: {
      operationId: "write-exec-denied",
      program: process.execPath,
      args: ["-e", "console.log('denied')"],
    },
    _meta: writeHostMeta,
  }), "exec_command");

  seedToken(tokens.process, [
    "project:read",
    "process:execute",
  ]);
  const processClient = await connect("scope-process", tokens.process);
  const processTools = new Set((await processClient.listTools()).tools.map((tool) => tool.name));
  assert.equal(processTools.has("write_stdin"), true, JSON.stringify([...processTools]));
  assert.equal(processTools.has("read_process_output"), true, JSON.stringify([...processTools]));
  assert.equal(processTools.has("exec_command"), false);
  const processOpen = await processClient.callTool({
    name: "project_control",
    arguments: { action: "open", operationId: "process-scope-execution" },
    _meta: processHostMeta,
  });
  assertSucceeded(processOpen);
  await assertToolUnavailable(processClient.callTool({
    name: "exec_command",
    arguments: {
      operationId: "write-scope-required",
      program: process.execPath,
      args: ["-e", "console.log('write required')"],
    },
    _meta: processHostMeta,
  }), "exec_command");

  seedToken(tokens.full, [...DEVSPACE_CAPABILITY_SCOPES]);
  for (const [name, token] of [["scope-full", tokens.full]] as const) {
    const client = await connect(name, token);
    const opened = await client.callTool({
      name: "project_control",
      arguments: { action: "open", operationId: `${name}-execution` },
      _meta: fullHostMeta,
    });
    assertSucceeded(opened);
    assertNoWorkspaceProtocol(opened);
    assertSucceeded(await client.callTool({
      name: "exec_command",
      arguments: {
        operationId: `${name}-exec`,
        program: process.execPath,
        args: ["-e", "console.log('scope-ok')"],
      },
      _meta: fullHostMeta,
    }));
  }
} finally {
  for (const client of clients.reverse()) await client.close().catch(() => undefined);
  await closeHttpServer(httpServer);
  await running.close();
  await rm(root, { recursive: true, force: true });
}

function seedToken(accessToken: string, scopes: string[]): void {
  const store = new SqliteOAuthStore(stateDir);
  try {
    const client = new SqliteOAuthClientsStore(store, config.oauth.allowedRedirectHosts).registerClient({
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      client_name: accessToken,
    });
    const grant = store.createAuthorizationGrant({
      clientId: client.client_id,
      scopes,
      allowedRootIds: [
        authorizationRootId(workspaceRoot, config.oauth.keys.authorizationRoot),
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
        expiresAt,
        resource,
      },
    });
  } finally {
    store.close();
  }
}

async function connect(
  name: string,
  accessToken: string,
): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", origin), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  }));
  clients.push(client);
  return client;
}

function assertNoWorkspaceProtocol(
  result: Awaited<ReturnType<Client["callTool"]>>,
): void {
  const serialized = JSON.stringify(result.structuredContent ?? {});
  assert.doesNotMatch(serialized, /workspace|receipt|continuation|contextChanged|phase/iu);
  assert.doesNotMatch(serialized, /executionRef/u);
  assert.match(serialized, /"project"/u);
}

function hostMeta(scope: string): Readonly<Record<string, string>> {
  return {
    "openai/subject": `oauth-scope-${scope}-subject`,
    "openai/session": `oauth-scope-${scope}-session`,
  };
}

function assertSucceeded(result: Awaited<ReturnType<Client["callTool"]>>): void {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
}

function assertInvalidInput(
  result: Awaited<ReturnType<Client["callTool"]>>,
): void {
  assert.equal(result.isError, true, JSON.stringify(result.content));
  const error = (result.structuredContent as {
    error?: { code?: unknown; recovery?: unknown };
  } | undefined)?.error;
  assert.equal(error?.code, "invalid_tool_input");
}

async function assertToolUnavailable(
  resultPromise: Promise<Awaited<ReturnType<Client["callTool"]>>>,
  toolName: string,
): Promise<void> {
  let result: Awaited<ReturnType<Client["callTool"]>>;
  try {
    result = await resultPromise;
  } catch (error) {
    assert.match(String(error), /Method not found/u);
    return;
  }
  assert.equal(result.isError, true, JSON.stringify(result.content));
  const error = (result.structuredContent as {
    error?: { code?: unknown; recovery?: unknown };
  } | undefined)?.error;
  if (error) {
    assert.equal(error.code, "tool_unavailable");
    assert.equal(error.recovery, "refresh_tools_or_reauthorize");
    assert.match(JSON.stringify(result.content), new RegExp(toolName));
  } else {
    assert.match(JSON.stringify(result.content), new RegExp(`Tool ${toolName} not found`));
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
