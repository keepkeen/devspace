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
  processNoNetwork: "oauth-scope-process-no-network-token",
  sharedFull: "oauth-scope-shared-full-token",
  sharedNoNetwork: "oauth-scope-shared-no-network-token",
  sharedNoRead: "oauth-scope-shared-no-read-token",
  full: "oauth-scope-full-token",
  legacy: "oauth-scope-legacy-token",
};
const execFileAsync = promisify(execFile);

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
  DEVSPACE_WIDGETS: "changes",
  DEVSPACE_LOG_LEVEL: "silent",
  PORT: "1",
});

seedToken(tokens.read, ["workspace:read"]);
seedToken(tokens.write, ["workspace:read", "workspace:write"]);
seedToken(tokens.processNoNetwork, [
  "workspace:read",
  "workspace:write",
  "process:execute",
]);
seedToken(tokens.full, [...DEVSPACE_CAPABILITY_SCOPES]);
seedToken(tokens.legacy, ["devspace"]);
seedSharedPrincipalTokens();

assert.equal(oauthScopeAllows(["devspace"], "workspace:revoke"), true);
assert.equal(oauthScopeAllows(["workspace:read"], "workspace:write"), false);
assert.deepEqual(requiredOAuthScopesForTool("exec_command"), [
  "workspace:read",
  "workspace:write",
  "process:execute",
  "network:access",
]);

const running = createServer(config);
const httpServer = createHttpServer(running.app);
const origin = await listen(httpServer);
const clients: Client[] = [];

try {
  const readClient = await connect("scope-read", tokens.read);
  const readOpen = await readClient.callTool({
    name: "open_workspace",
    arguments: { path: workspaceRoot, alias: "read", contextMode: "full" },
  });
  assertSucceeded(readOpen);
  const readReceipt = receipt(readOpen);
  assertSucceeded(await readClient.callTool({
    name: "read",
    arguments: { receipt: readReceipt, path: "payload.txt" },
  }));
  const readOnlyChangePreview = await readClient.callTool({
    name: "show_changes",
    arguments: { receipt: readReceipt },
  });
  assertSucceeded(readOnlyChangePreview);
  assert.equal(
    (readOnlyChangePreview.structuredContent as {
      effects?: { reviewCheckpoint?: { advanced?: unknown } };
    } | undefined)?.effects?.reviewCheckpoint?.advanced,
    false,
  );
  assertScopeDenied(await readClient.callTool({
    name: "show_changes",
    arguments: {
      receipt: readReceipt,
      advanceCheckpoint: true,
      operationId: "read-scope-review-advance",
    },
  }), "workspace:write");
  assertScopeDenied(await readClient.callTool({
    name: "apply_patch",
    arguments: {
      receipt: readReceipt,
      operationId: "read-scope-patch",
      ifMatch: { "read-denied.txt": null },
      patch: "*** Begin Patch\n*** Add File: read-denied.txt\n+denied\n*** End Patch",
    },
  }), "workspace:write");
  assertScopeDenied(await readClient.callTool({
    name: "open_workspace",
    arguments: {
      path: workspaceRoot,
      alias: "read-write-denied",
      writeAccess: "read_write",
    },
  }), "workspace:write");
  assertScopeDenied(await readClient.callTool({
    name: "open_workspace",
    arguments: { path: workspaceRoot, alias: "worktree-denied", mode: "worktree" },
  }), "workspace:write");
  assertScopeDenied(await readClient.callTool({
    name: "close_workspace",
    arguments: { receipt: readReceipt, operationId: "read-close-denied" },
  }), "workspace:revoke");

  const writeClient = await connect("scope-write", tokens.write);
  const writeOpen = await writeClient.callTool({
    name: "open_workspace",
    arguments: {
      path: workspaceRoot,
      alias: "write",
      writeAccess: "read_write",
      contextMode: "full",
    },
  });
  assertSucceeded(writeOpen);
  const writeReceipt = receipt(writeOpen);
  assertSucceeded(await writeClient.callTool({
    name: "apply_patch",
    arguments: {
      receipt: writeReceipt,
      operationId: "write-scope-patch",
      ifMatch: { "write-ok.txt": null },
      patch: "*** Begin Patch\n*** Add File: write-ok.txt\n+ok\n*** End Patch",
    },
  }));
  const writePreview = await writeClient.callTool({
    name: "show_changes",
    arguments: { receipt: writeReceipt },
  });
  assertSucceeded(writePreview);
  assert.equal(
    (writePreview.structuredContent as {
      effects?: { reviewCheckpoint?: { advanced?: unknown } };
    } | undefined)?.effects?.reviewCheckpoint?.advanced,
    false,
  );
  const writeAdvance = await writeClient.callTool({
    name: "show_changes",
    arguments: {
      receipt: writeReceipt,
      advanceCheckpoint: true,
      operationId: "write-scope-review-advance",
    },
  });
  assertSucceeded(writeAdvance);
  assert.equal(
    (writeAdvance.structuredContent as {
      effects?: { reviewCheckpoint?: { advanced?: unknown } };
    } | undefined)?.effects?.reviewCheckpoint?.advanced,
    true,
  );
  assertScopeDenied(await writeClient.callTool({
    name: "exec_command",
    arguments: {
      receipt: writeReceipt,
      operationId: "write-exec-denied",
      program: process.execPath,
      args: ["-e", "console.log('denied')"],
    },
  }), "process:execute");
  assertScopeDenied(await writeClient.callTool({
    name: "open_workspace",
    arguments: { path: workspaceRoot, alias: "worktree-create-denied", mode: "worktree" },
  }), "worktree:create");

  const processClient = await connect("scope-process", tokens.processNoNetwork);
  const processOpen = await processClient.callTool({
    name: "open_workspace",
    arguments: {
      path: workspaceRoot,
      alias: "process",
      writeAccess: "read_write",
      contextMode: "full",
    },
  });
  assertSucceeded(processOpen);
  assertScopeDenied(await processClient.callTool({
    name: "exec_command",
    arguments: {
      receipt: receipt(processOpen),
      operationId: "network-denied",
      program: process.execPath,
      args: ["-e", "console.log('network capability required')"],
    },
  }), "network:access");

  const sharedFullClient = await connect("scope-shared-full", tokens.sharedFull);
  const sharedNoNetworkClient = await connect(
    "scope-shared-no-network",
    tokens.sharedNoNetwork,
  );
  const sharedNoReadClient = await connect("scope-shared-no-read", tokens.sharedNoRead);
  const sharedOpen = await sharedFullClient.callTool({
    name: "open_workspace",
    arguments: {
      path: workspaceRoot,
      alias: "shared-process",
      writeAccess: "read_write",
      contextMode: "full",
    },
  });
  assertSucceeded(sharedOpen);
  const sharedReceipt = receipt(sharedOpen);
  const sharedProcess = await sharedFullClient.callTool({
    name: "exec_command",
    arguments: {
      receipt: sharedReceipt,
      operationId: "shared-process-start",
      program: process.execPath,
      args: [
        "-e",
        "console.log('shared-output'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0))",
      ],
      closeStdin: false,
      yieldTimeMs: 0,
    },
  });
  assertSucceeded(sharedProcess);
  const sharedSessionId = (sharedProcess.structuredContent as {
    sessionId?: unknown;
  } | undefined)?.sessionId;
  assert.equal(typeof sharedSessionId, "number");
  assertScopeDenied(await sharedNoReadClient.callTool({
    name: "exec_command",
    arguments: {
      receipt: sharedReceipt,
      operationId: "shared-no-read-exec-denied",
      program: process.execPath,
      args: ["-e", "console.log('denied')"],
    },
  }), "workspace:read");
  assertScopeDenied(await sharedNoReadClient.callTool({
    name: "read_process_output",
    arguments: {
      receipt: sharedReceipt,
      outputId: "scope-denied-output",
      offset: 0,
    },
  }), "workspace:read");
  assertScopeDenied(await sharedNoReadClient.callTool({
    name: "write_stdin",
    arguments: {
      receipt: sharedReceipt,
      operationId: "shared-no-read-input-denied",
      sessionId: sharedSessionId,
      chars: "input",
    },
  }), "workspace:read");
  assertScopeDenied(await sharedNoNetworkClient.callTool({
    name: "write_stdin",
    arguments: {
      receipt: sharedReceipt,
      operationId: "shared-process-input-denied",
      sessionId: sharedSessionId,
      chars: "network-capable-input",
    },
  }), "network:access");
  assertSucceeded(await sharedFullClient.callTool({
    name: "write_stdin",
    arguments: {
      receipt: sharedReceipt,
      operationId: "shared-process-close-stdin",
      sessionId: sharedSessionId,
      closeStdin: true,
      yieldTimeMs: 1_000,
    },
  }));

  for (const [name, token] of [["scope-full", tokens.full], ["scope-legacy", tokens.legacy]] as const) {
    const client = await connect(name, token);
    const opened = await client.callTool({
      name: "open_workspace",
      arguments: {
        path: workspaceRoot,
        alias: name,
        writeAccess: "read_write",
        contextMode: "full",
      },
    });
    assertSucceeded(opened);
    const currentReceipt = receipt(opened);
    assertSucceeded(await client.callTool({
      name: "exec_command",
      arguments: {
        receipt: currentReceipt,
        operationId: `${name}-exec`,
        program: process.execPath,
        args: ["-e", "console.log('scope-ok')"],
      },
    }));
    assertSucceeded(await client.callTool({
      name: "close_workspace",
      arguments: { receipt: currentReceipt, operationId: `${name}-close` },
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
    store.ensurePrincipalForClient(client.client_id);
    const expiresAt = Math.floor(Date.now() / 1_000) + 3_600;
    const resource = new URL("/mcp", publicBaseUrl).href;
    store.saveTokenPair({
      accessTokenHash: hashToken(accessToken),
      accessToken: { clientId: client.client_id, scopes, expiresAt, resource },
      refreshTokenHash: hashToken(`${accessToken}-refresh`),
      refreshToken: { clientId: client.client_id, scopes, expiresAt, resource },
    });
  } finally {
    store.close();
  }
}

function seedSharedPrincipalTokens(): void {
  const store = new SqliteOAuthStore(stateDir);
  try {
    const clientsStore = new SqliteOAuthClientsStore(
      store,
      config.oauth.allowedRedirectHosts,
    );
    const fullClient = clientsStore.registerClient({
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      client_name: "shared-full",
    });
    const principalId = store.ensurePrincipalForClient(fullClient.client_id);
    const limitedClient = clientsStore.registerClient({
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      client_name: "shared-no-network",
    });
    const reconnectCode = store.issueReconnectCode(principalId!);
    assert.equal(
      store.consumeReconnectCode(reconnectCode.code, limitedClient.client_id).changed,
      true,
    );
    const noReadClient = clientsStore.registerClient({
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      client_name: "shared-no-read",
    });
    const noReadReconnectCode = store.issueReconnectCode(principalId!);
    assert.equal(
      store.consumeReconnectCode(noReadReconnectCode.code, noReadClient.client_id).changed,
      true,
    );
    const expiresAt = Math.floor(Date.now() / 1_000) + 3_600;
    const resource = new URL("/mcp", publicBaseUrl).href;
    for (const [client, accessToken, scopes] of [
      [fullClient, tokens.sharedFull, [...DEVSPACE_CAPABILITY_SCOPES]],
      [
        limitedClient,
        tokens.sharedNoNetwork,
        ["workspace:read", "workspace:write", "process:execute"],
      ],
      [
        noReadClient,
        tokens.sharedNoRead,
        ["workspace:write", "process:execute", "network:access"],
      ],
    ] as const) {
      store.saveTokenPair({
        accessTokenHash: hashToken(accessToken),
        accessToken: { clientId: client.client_id, scopes: [...scopes], expiresAt, resource },
        refreshTokenHash: hashToken(`${accessToken}-refresh`),
        refreshToken: { clientId: client.client_id, scopes: [...scopes], expiresAt, resource },
      });
    }
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
  const value = (result.structuredContent as { receipt?: unknown } | undefined)?.receipt;
  assert.equal(typeof value, "string");
  return String(value);
}

function assertSucceeded(result: Awaited<ReturnType<Client["callTool"]>>): void {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
}

function assertScopeDenied(
  result: Awaited<ReturnType<Client["callTool"]>>,
  expectedScope: string,
): void {
  assert.equal(result.isError, true, JSON.stringify(result.content));
  const error = (result.structuredContent as {
    error?: { code?: unknown; recovery?: unknown };
  } | undefined)?.error;
  assert.equal(error?.code, "insufficient_scope");
  assert.equal(error?.recovery, "reauthorize_oauth");
  assert.match(JSON.stringify(result.content), new RegExp(expectedScope.replace(":", "\\:")));
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
