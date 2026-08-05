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
const accountAHostMeta = hostMeta("account-a", "main");
const accountBHostMeta = hostMeta("account-b", "main");
const accountCHostMeta = hostMeta("account-c", "main");

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
    _meta: accountAHostMeta,
  });
  const selectedB = await accountB.callTool({
    name: "project_control",
    arguments: {
      action: "open",
      projectRef,
      operationId: "account-b-shared-project",
    },
    _meta: accountBHostMeta,
  });
  assertSucceeded(selectedA);
  assertSucceeded(selectedB);
  assert.doesNotMatch(JSON.stringify(selectedA.structuredContent), /executionRef/u);
  assert.doesNotMatch(JSON.stringify(selectedB.structuredContent), /executionRef/u);

  const savedByA = await accountA.callTool({
    name: "save_progress",
    arguments: {
      operationId: "account-a-save-shared-progress",
      title: "Shared Project task",
      progress: "Account A prepared the shared Project; revalidate shared.txt.",
    },
    _meta: accountAHostMeta,
  });
  assertSucceeded(savedByA);
  const threadRef = String(
    (savedByA.structuredContent as {
      thread?: { threadRef?: unknown };
    } | undefined)?.thread?.threadRef ?? "",
  );
  assert.match(threadRef, /^pth1_/u);
  const savedTaskRef = String(
    (savedByA.structuredContent as {
      task?: { taskRef?: unknown };
    } | undefined)?.task?.taskRef ?? "",
  );
  assert.match(savedTaskRef, /^phf1_/u);
  const updatedByA = await accountA.callTool({
    name: "save_progress",
    arguments: {
      operationId: "account-a-update-shared-progress",
      title: "Shared Project task",
      progress: "Account A updated the Project handoff; revalidate shared.txt.",
      ifMatch: 1,
    },
    _meta: accountAHostMeta,
  });
  assertSucceeded(updatedByA);
  assert.equal(
    String(
      (updatedByA.structuredContent as {
        task?: { taskRef?: unknown; version?: unknown };
      } | undefined)?.task?.taskRef ?? "",
    ),
    savedTaskRef,
  );
  assert.equal(
    (updatedByA.structuredContent as {
      task?: { version?: unknown };
    } | undefined)?.task?.version,
    2,
  );

  const projectHandoffsVisibleToB = await accountB.callTool({
    name: "list_projects",
    arguments: { projectRef },
  });
  assertSucceeded(projectHandoffsVisibleToB);
  assert.deepEqual(
    listedTaskRefs(projectHandoffsVisibleToB.structuredContent),
    [savedTaskRef],
  );
  const listedByB = await accountB.callTool({
    name: "project_thread_control",
    arguments: { action: "list", projectRef },
    _meta: accountBHostMeta,
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
    _meta: accountBHostMeta,
  });
  assertErrorCode(resumedByB, "project_thread_not_found");
  const resumedHandoffByB = await accountB.callTool({
    name: "project_control",
    arguments: {
      action: "resume",
      projectRef,
      taskRef: savedTaskRef,
      operationId: "account-b-resume-project-handoff",
    },
    _meta: accountBHostMeta,
  });
  assertSucceeded(resumedHandoffByB);
  assert.doesNotMatch(JSON.stringify(resumedHandoffByB.structuredContent), /executionRef/u);
  const resumedThreadRefB = String(
    (resumedHandoffByB.structuredContent as {
      thread?: { threadRef?: unknown };
    } | undefined)?.thread?.threadRef ?? "",
  );
  assert.match(resumedThreadRefB, /^pth1_/u);
  const resumedThreadBeforeConflict = await accountB.callTool({
    name: "project_thread_control",
    arguments: { action: "status", threadRef: resumedThreadRefB },
    _meta: accountBHostMeta,
  });
  assertSucceeded(resumedThreadBeforeConflict);
  const resumedThreadVersionBeforeConflict = threadVersion(
    resumedThreadBeforeConflict.structuredContent,
  );
  const advancedByA = await accountA.callTool({
    name: "save_progress",
    arguments: {
      operationId: "account-a-advance-shared-progress",
      title: "Shared Project task",
      progress: "Account A advanced the Project handoff beyond Account B's snapshot.",
      ifMatch: 2,
    },
    _meta: accountAHostMeta,
  });
  assertSucceeded(advancedByA);
  const staleSaveByB = await accountB.callTool({
    name: "save_progress",
    arguments: {
      operationId: "account-b-stale-project-handoff",
      title: "Stale shared task",
      progress: "This stale writer must not overwrite Account A's newer handoff.",
      ifMatch: 2,
    },
    _meta: accountBHostMeta,
  });
  assertErrorCode(staleSaveByB, "project_task_revision_conflict");
  assert.equal(errorCurrentVersion(staleSaveByB.structuredContent), 3);
  assert.doesNotMatch(JSON.stringify(staleSaveByB.structuredContent), /requiresNewOperationId/u);
  const resumedThreadAfterConflict = await accountB.callTool({
    name: "project_thread_control",
    arguments: { action: "status", threadRef: resumedThreadRefB },
    _meta: accountBHostMeta,
  });
  assertSucceeded(resumedThreadAfterConflict);
  assert.equal(
    threadVersion(resumedThreadAfterConflict.structuredContent),
    resumedThreadVersionBeforeConflict,
    "a rejected shared-Handoff update must not mutate the private Thread projection",
  );
  const reconciledSaveByB = await accountB.callTool({
    name: "save_progress",
    arguments: {
      operationId: "account-b-stale-project-handoff",
      title: "Reconciled shared task",
      progress: "Account B reconciled Account A's newer handoff before updating.",
      ifMatch: 3,
    },
    _meta: accountBHostMeta,
  });
  assertSucceeded(reconciledSaveByB);
  assert.equal(
    (reconciledSaveByB.structuredContent as {
      task?: { version?: unknown };
    } | undefined)?.task?.version,
    4,
    "a preflight conflict must release the operationId for a corrected retry",
  );

  const capacityHostMetas = Array.from(
    { length: 19 },
    (_, index) => hostMeta("account-b", `capacity-${index}`),
  );
  for (const [index, capacityHostMeta] of capacityHostMetas.entries()) {
    const opened = await accountB.callTool({
      name: "project_control",
      arguments: {
        action: "open",
        projectRef,
        operationId: `account-b-capacity-open-${index}`,
      },
      _meta: capacityHostMeta,
    });
    assertSucceeded(opened);
    assert.doesNotMatch(JSON.stringify(opened.structuredContent), /executionRef/u);
  }
  for (const [index, capacityHostMeta] of capacityHostMetas.entries()) {
    assertSucceeded(await accountB.callTool({
      name: "save_progress",
      arguments: {
        operationId: `account-b-capacity-save-${index}`,
        title: `Capacity task ${index}`,
        progress: `Bounded capacity fixture ${index}.`,
      },
      _meta: capacityHostMeta,
    }));
  }
  const overflowHostMeta = hostMeta("account-b", "capacity-overflow");
  const overflowExecution = await accountB.callTool({
    name: "project_control",
    arguments: {
      action: "open",
      projectRef,
      operationId: "account-b-capacity-overflow-open",
    },
    _meta: overflowHostMeta,
  });
  assertSucceeded(overflowExecution);
  const overflowThreadRef = String(
    (overflowExecution.structuredContent as {
      thread?: { threadRef?: unknown };
    } | undefined)?.thread?.threadRef ?? "",
  );
  const overflowThreadBefore = await accountB.callTool({
    name: "project_thread_control",
    arguments: { action: "status", threadRef: overflowThreadRef },
    _meta: accountBHostMeta,
  });
  assertSucceeded(overflowThreadBefore);
  const capacityRejected = await accountB.callTool({
    name: "save_progress",
    arguments: {
      operationId: "account-b-capacity-overflow-save",
      title: "Overflow task",
      progress: "This save must wait for Project handoff capacity.",
    },
    _meta: overflowHostMeta,
  });
  assertErrorCode(capacityRejected, "project_task_capacity");
  const overflowThreadAfter = await accountB.callTool({
    name: "project_thread_control",
    arguments: { action: "status", threadRef: overflowThreadRef },
    _meta: accountBHostMeta,
  });
  assertSucceeded(overflowThreadAfter);
  assert.equal(
    threadVersion(overflowThreadAfter.structuredContent),
    threadVersion(overflowThreadBefore.structuredContent),
    "a capacity rejection must not mutate the private Thread projection",
  );
  assertSucceeded(await accountA.callTool({
    name: "save_progress",
    arguments: {
      operationId: "account-a-complete-shared-progress",
      title: "Shared Project task",
      progress: "The shared handoff is complete and can release one capacity slot.",
      ifMatch: 4,
      status: "completed",
    },
    _meta: accountAHostMeta,
  }));
  const capacityRetry = await accountB.callTool({
    name: "save_progress",
    arguments: {
      operationId: "account-b-capacity-overflow-save",
      title: "Overflow task",
      progress: "This save must wait for Project handoff capacity.",
    },
    _meta: overflowHostMeta,
  });
  assertSucceeded(capacityRetry);

  const listedByC = await accountC.callTool({
    name: "project_thread_control",
    arguments: { action: "list", projectRef: otherProjectRef },
    _meta: accountCHostMeta,
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
      _meta: accountCHostMeta,
    }),
    "project_thread_not_found",
  );
  assertErrorCode(
    await accountC.callTool({
      name: "read_files",
      arguments: { files: [{ path: "other.txt" }] },
      _meta: accountCHostMeta,
    }),
    "project_execution_required",
  );

  assertSucceeded(await accountA.callTool({
    name: "apply_patch",
    arguments: {
      operationId: "account-a-patch",
      ifMatch: { "shared-from-a.txt": null },
      patch:
        "*** Begin Patch\n" +
        "*** Add File: shared-from-a.txt\n" +
        "+written by account A\n" +
        "*** End Patch\n",
    },
    _meta: accountAHostMeta,
  }));
  assert.equal(
    await readFile(join(projectRoot, "shared-from-a.txt"), "utf8"),
    "written by account A\n",
  );
  assertReadText(
    await accountB.callTool({
      name: "read_files",
      arguments: {
        files: [{ path: "shared-from-a.txt" }],
      },
      _meta: accountBHostMeta,
    }),
    "written by account A",
  );

  const changesA = await accountA.callTool({
    name: "show_changes",
    arguments: { source: "apply_patch_history" },
    _meta: accountAHostMeta,
  });
  assertSucceeded(changesA);
  assert.equal(changeSource(changesA), "apply_patch_history");
  assert.equal(changeFileCount(changesA), 1);
  assert.match(JSON.stringify(changesA.structuredContent), /shared-from-a\.txt/u);

  const changesB = await accountB.callTool({
    name: "show_changes",
    arguments: { source: "apply_patch_history" },
    _meta: accountBHostMeta,
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
      files: [{ path: "shared-from-a.txt" }],
    },
    _meta: accountAHostMeta,
  }));
  assertReadText(
    await accountB.callTool({
      name: "read_files",
      arguments: {
        files: [{ path: "shared-from-a.txt" }],
      },
      _meta: accountBHostMeta,
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

function hostMeta(account: string, session: string): Readonly<Record<string, string>> {
  return {
    "openai/subject": `multi-grant-${account}-subject`,
    "openai/session": `multi-grant-${account}-${session}-session`,
  };
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

function listedTaskRefs(structuredContent: unknown): string[] {
  const projects = (structuredContent as {
    projects?: Array<{
      tasks?: Array<{ taskRef?: unknown }>;
    }>;
  } | undefined)?.projects ?? [];
  return projects.flatMap((project) =>
    project.tasks?.flatMap((task) =>
      typeof task.taskRef === "string" ? [task.taskRef] : []
    ) ?? []
  );
}

function threadVersion(structuredContent: unknown): unknown {
  return (structuredContent as {
    thread?: { version?: unknown };
  } | undefined)?.thread?.version;
}

function errorCurrentVersion(structuredContent: unknown): unknown {
  return (structuredContent as {
    error?: { currentVersion?: unknown };
  } | undefined)?.error?.currentVersion;
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
