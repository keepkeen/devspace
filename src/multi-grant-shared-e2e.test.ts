import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { authorizationRootId } from "./authorization-roots.js";
import { loadConfig } from "./config.js";
import { DEVSPACE_CAPABILITY_SCOPES } from "./oauth-scopes.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";
import { createServer } from "./server.js";

const fixtureRoot = await mkdtemp(join(tmpdir(), "devspace-multi-grant-shared-"));
const projectRoot = join(fixtureRoot, "shared-project");
const otherProjectRoot = join(fixtureRoot, "other-project");
const stateDir = join(fixtureRoot, "state");
const publicBaseUrl = "http://127.0.0.1:7676";
const tokens = {
  accountA: "multi-grant-shared-account-a-token",
  accountB: "multi-grant-shared-account-b-token",
  accountC: "multi-grant-shared-account-c-token",
};
const clients: Client[] = [];

await Promise.all([
  mkdir(projectRoot, { recursive: true }),
  mkdir(otherProjectRoot, { recursive: true }),
]);
await writeFile(join(projectRoot, "shared.txt"), "before account A\n");
await writeFile(join(otherProjectRoot, "other.txt"), "other Project\n");

const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(fixtureRoot, "config"),
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_ALLOWED_ROOTS: `${projectRoot},${otherProjectRoot}`,
  DEVSPACE_ALLOWED_HOSTS: "*",
  DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
  DEVSPACE_OAUTH_OWNER_TOKEN: "multi-grant-shared-owner-token-long-enough",
  DEVSPACE_WIDGETS: "off",
  DEVSPACE_SKILLS: "0",
  DEVSPACE_LOG_LEVEL: "silent",
  DEVSPACE_MCP_HTTP_TRANSPORT: "stateless",
  PORT: "1",
});

const authorizationA = seedAuthorization("Account A", tokens.accountA, projectRoot);
const authorizationB = seedAuthorization("Account B", tokens.accountB, projectRoot);
const authorizationC = seedAuthorization("Account C", tokens.accountC, otherProjectRoot);
assert.notEqual(authorizationA.clientId, authorizationB.clientId);
assert.notEqual(authorizationA.grantId, authorizationB.grantId);
assert.notEqual(authorizationB.grantId, authorizationC.grantId);

const running = createServer(config);
const httpServer = createHttpServer(running.app);

try {
  const origin = await listen(httpServer);
  const accountA = await connect(origin, "account-a", tokens.accountA);
  const accountB = await connect(origin, "account-b", tokens.accountB);
  const accountC = await connect(origin, "account-c", tokens.accountC);

  const projectRef = authorizationRootId(
    projectRoot,
    config.oauth.keys.authorizationRoot,
  );
  const otherProjectRef = authorizationRootId(
    otherProjectRoot,
    config.oauth.keys.authorizationRoot,
  );
  const selectedA = await accountA.callTool({
    name: "project_control",
    arguments: {
      action: "open",
      projectRef,
      operationId: "account-a-shared-project",
    },
  });
  const selectedB = await accountB.callTool({
    name: "project_control",
    arguments: {
      action: "open",
      projectRef,
      operationId: "account-b-shared-project",
    },
  });
  assertSucceeded(selectedA);
  assertSucceeded(selectedB);
  const executionRefA = projectExecutionRef(selectedA);
  const executionRefB = projectExecutionRef(selectedB);
  assert.notEqual(executionRefA, executionRefB);

  assertErrorCode(
    await accountB.callTool({
      name: "read_files",
      arguments: {
        executionRef: executionRefA,
        files: [{ path: "shared.txt" }],
      },
    }),
    "project_execution_not_found",
  );

  const savedByA = await accountA.callTool({
    name: "save_progress",
    arguments: {
      executionRef: executionRefA,
      operationId: "account-a-save-shared-progress",
      title: "Shared Project task",
      progress: "Account A prepared the shared Project; revalidate shared.txt.",
    },
  });
  assertSucceeded(savedByA);
  const threadRef = String(
    (savedByA.structuredContent as {
      thread?: { ref?: unknown };
    } | undefined)?.thread?.ref ?? "",
  );
  assert.match(threadRef, /^pth1_/u);

  const listedByB = await accountB.callTool({
    name: "project_control",
    arguments: { action: "list", projectRef },
  });
  assertSucceeded(listedByB);
  const threadsVisibleToB = (
    listedByB.structuredContent as {
      threads?: Array<{
        threadRef?: unknown;
        title?: unknown;
        version?: unknown;
      }>;
    } | undefined
  )?.threads ?? [];
  assert.equal(
    threadsVisibleToB.length,
    1,
    "Account B should see only the Thread created by its own project_control open",
  );
  assert.equal(threadsVisibleToB[0]?.title, "New task");
  assert.equal(threadsVisibleToB[0]?.version, 1);
  assert.notEqual(
    threadsVisibleToB[0]?.threadRef,
    threadRef,
    "Account A's saved Thread must remain private to Account A without host Actor metadata",
  );
  const resumedByB = await accountB.callTool({
    name: "project_control",
    arguments: {
      action: "resume",
      projectRef,
      threadRef,
      operationId: "account-b-resume-shared-progress",
    },
  });
  assertErrorCode(resumedByB, "project_thread_not_found");

  const listedByC = await accountC.callTool({
    name: "project_control",
    arguments: { action: "list", projectRef: otherProjectRef },
  });
  assertSucceeded(listedByC);
  assert.deepEqual(
    (listedByC.structuredContent as { threads?: unknown[] } | undefined)?.threads,
    [],
  );
  assertErrorCode(
    await accountC.callTool({
      name: "project_control",
      arguments: {
        action: "resume",
        projectRef: otherProjectRef,
        threadRef,
        operationId: "account-c-reject-foreign-handoff",
      },
    }),
    "project_thread_not_found",
  );

  assertSucceeded(await accountA.callTool({
    name: "apply_patch",
    arguments: {
      executionRef: executionRefA,
      operationId: "account-a-patch",
      ifMatch: { "shared-from-a.txt": null },
      patch:
        "*** Begin Patch\n" +
        "*** Add File: shared-from-a.txt\n" +
        "+written by account A\n" +
        "*** End Patch\n",
    },
  }));
  assert.equal(
    await readFile(join(projectRoot, "shared-from-a.txt"), "utf8"),
    "written by account A\n",
  );
  assertReadText(
    await accountB.callTool({
      name: "read_files",
      arguments: {
        executionRef: executionRefB,
        files: [{ path: "shared-from-a.txt" }],
      },
    }),
    "written by account A",
  );

  const changesA = await accountA.callTool({
    name: "show_changes",
    arguments: { executionRef: executionRefA },
  });
  assertSucceeded(changesA);
  assert.equal(changeSource(changesA), "apply_patch_history");
  assert.equal(changeFileCount(changesA), 1);
  assert.match(JSON.stringify(changesA.structuredContent), /shared-from-a\.txt/u);

  const changesB = await accountB.callTool({
    name: "show_changes",
    arguments: { executionRef: executionRefB },
  });
  assertSucceeded(changesB);
  assert.equal(changeSource(changesB), "apply_patch_history");
  assert.equal(changeFileCount(changesB), 0);
  assert.doesNotMatch(JSON.stringify(changesB.structuredContent), /shared-from-a\.txt/u);

  const revocationStore = new SqliteOAuthStore(stateDir);
  try {
    assert.equal(
      revocationStore.deleteAccessToken(
        hashToken(tokens.accountA),
        authorizationA.clientId,
      ),
      true,
    );
    assert.equal(
      revocationStore.deleteRefreshToken(
        hashToken(`${tokens.accountA}-refresh`),
        authorizationA.clientId,
      ),
      true,
    );
  } finally {
    revocationStore.close();
  }

  await assert.rejects(accountA.callTool({
    name: "read_files",
    arguments: {
      executionRef: executionRefA,
      files: [{ path: "shared-from-a.txt" }],
    },
  }));
  assertReadText(
    await accountB.callTool({
      name: "read_files",
      arguments: {
        executionRef: executionRefB,
        files: [{ path: "shared-from-a.txt" }],
      },
    }),
    "written by account A",
  );
} finally {
  for (const client of clients.reverse()) {
    await client.close().catch(() => undefined);
  }
  await closeHttpServer(httpServer);
  await running.close();
  await rm(fixtureRoot, { recursive: true, force: true });
}

function seedAuthorization(
  clientName: string,
  accessToken: string,
  authorizedProjectRoot: string,
): {
  clientId: string;
  grantId: string;
} {
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
      scopes: [...DEVSPACE_CAPABILITY_SCOPES],
      allowedRootIds: [
        authorizationRootId(authorizedProjectRoot, config.oauth.keys.authorizationRoot),
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
    return {
      clientId: client.client_id,
      grantId: grant.grantId,
    };
  } finally {
    store.close();
  }
}

async function connect(
  origin: URL,
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

function changeSource(
  result: Awaited<ReturnType<Client["callTool"]>>,
): unknown {
  return (result.structuredContent as {
    changeSource?: unknown;
  } | undefined)?.changeSource;
}

function changeFileCount(
  result: Awaited<ReturnType<Client["callTool"]>>,
): unknown {
  return (result.structuredContent as {
    summary?: { files?: unknown };
  } | undefined)?.summary?.files;
}

function listedHandoffRefs(structuredContent: unknown): string[] {
  const projects = (structuredContent as {
    projects?: Array<{
      handoffs?: Array<{ handoffRef?: unknown }>;
    }>;
  } | undefined)?.projects ?? [];
  return projects.flatMap((project) =>
    project.handoffs?.flatMap((handoff) =>
      typeof handoff.handoffRef === "string" ? [handoff.handoffRef] : []
    ) ?? []
  );
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
