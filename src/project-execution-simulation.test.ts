import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

const fixtureRoot = await mkdtemp(join(tmpdir(), "devspace-project-thread-"));
const alphaRoot = join(fixtureRoot, "customer-a", "api");
const betaRoot = join(fixtureRoot, "customer-b", "api");
const stateDir = join(fixtureRoot, "state");
const publicBaseUrl = "http://127.0.0.1:7676";
const accessToken = "project-thread-access-token";
const clients: Client[] = [];
const alphaHostMeta = hostMeta("conversation-a-alpha");
const betaAHostMeta = hostMeta("conversation-a-beta");
const betaBHostMeta = hostMeta("conversation-b-beta");
const resumedAlphaHostMeta = hostMeta("conversation-a-resumed-alpha");
const freshBetaHostMeta = hostMeta("conversation-a-fresh-beta");

await Promise.all([
  mkdir(alphaRoot, { recursive: true }),
  mkdir(betaRoot, { recursive: true }),
]);
await Promise.all([
  writeFile(join(alphaRoot, "AGENTS.md"), "# Alpha Project\n\nRead alpha files only.\n"),
  writeFile(join(alphaRoot, "identity.txt"), "alpha\n"),
  writeFile(join(betaRoot, "AGENTS.md"), "# Beta Project\n\nRead beta files only.\n"),
  writeFile(join(betaRoot, "identity.txt"), "beta\n"),
]);

const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(fixtureRoot, "config"),
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_ALLOWED_ROOTS: `${alphaRoot},${betaRoot}`,
  DEVSPACE_ALLOWED_HOSTS: "*",
  DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
  DEVSPACE_OAUTH_OWNER_TOKEN: "project-thread-owner-token-long-enough",
  DEVSPACE_WIDGETS: "off",
  DEVSPACE_SKILLS: "0",
  DEVSPACE_LOG_LEVEL: "silent",
  DEVSPACE_MCP_HTTP_TRANSPORT: "stateless",
});
seedAccessToken();

const running = createServer(config);
const httpServer = createHttpServer(running.app);
try {
  const origin = await listen(httpServer);
  const conversationA = await connect(origin, "conversation-a");
  const listedProjects = await conversationA.callTool({
    name: "list_projects",
    arguments: {},
  });
  assertSucceeded(listedProjects);
  const projects = (listedProjects.structuredContent as {
    projects?: Array<{ projectRef?: unknown; label?: unknown }>;
  } | undefined)?.projects ?? [];
  assert.equal(projects.length, 2);
  assert.equal(new Set(projects.map((project) => project.label)).size, 2);
  assert.doesNotMatch(
    JSON.stringify(listedProjects.structuredContent),
    new RegExp(`${escapeRegExp(alphaRoot)}|${escapeRegExp(betaRoot)}`, "u"),
  );
  const alphaRef = authorizationRootId(alphaRoot, config.oauth.keys.authorizationRoot);
  const betaRef = authorizationRootId(betaRoot, config.oauth.keys.authorizationRoot);

  assertErrorCode(await conversationA.callTool({
    name: "project_control",
    arguments: { action: "open", operationId: "ambiguous-project" },
    _meta: alphaHostMeta,
  }), "project_selection_required");

  const selectedAlpha = await conversationA.callTool({
    name: "project_control",
    arguments: {
      action: "open",
      projectRef: alphaRef,
      operationId: "conversation-a-alpha",
    },
    _meta: alphaHostMeta,
  });
  assertSucceeded(selectedAlpha);
  assert.doesNotMatch(JSON.stringify(selectedAlpha.structuredContent), /executionRef/u);
  assertReadText(await conversationA.callTool({
    name: "read_files",
    arguments: { files: [{ path: "identity.txt" }] },
    _meta: alphaHostMeta,
  }), "alpha");

  const conversationB = await connect(origin, "conversation-b");
  const selectedBetaB = await conversationB.callTool({
    name: "project_control",
    arguments: {
      action: "open",
      projectRef: betaRef,
      operationId: "conversation-b-beta",
    },
    _meta: betaBHostMeta,
  });
  assertSucceeded(selectedBetaB);
  assert.doesNotMatch(JSON.stringify(selectedBetaB.structuredContent), /executionRef/u);

  const selectedBetaA = await conversationA.callTool({
    name: "project_control",
    arguments: {
      action: "open",
      projectRef: betaRef,
      operationId: "conversation-a-beta",
    },
    _meta: betaAHostMeta,
  });
  assertSucceeded(selectedBetaA);
  assert.doesNotMatch(JSON.stringify(selectedBetaA.structuredContent), /executionRef/u);

  assertSucceeded(await conversationA.callTool({
    name: "apply_patch",
    arguments: {
      operationId: "alpha-patch",
      ifMatch: { "task-note.txt": null },
      patch: "*** Begin Patch\n*** Add File: task-note.txt\n+shared state\n*** End Patch\n",
    },
    _meta: alphaHostMeta,
  }));

  const alphaSave = await conversationA.callTool({
    name: "save_progress",
    arguments: {
      operationId: "save-alpha",
      title: "Alpha task",
      progress: "Created task-note.txt; re-read it before the next edit.",
    },
    _meta: alphaHostMeta,
  });
  assertSucceeded(alphaSave);
  assert.doesNotMatch(JSON.stringify(alphaSave.structuredContent), /Created task-note/u);
  assert.deepEqual(
    Object.keys((alphaSave.structuredContent ?? {}) as Record<string, unknown>).sort(),
    ["operation", "task"],
  );
  assert.deepEqual(
    Object.keys((alphaSave.structuredContent as {
      task?: Record<string, unknown>;
    }).task ?? {}).sort(),
    ["status", "taskRef", "version"],
  );
  const alphaThreadRef = savedThreadRef(alphaSave);
  const alphaTaskRef = savedTaskRef(alphaSave);
  assert.equal(savedThreadVersion(alphaSave), 2);

  const alphaActivity = await conversationA.callTool({
    name: "project_thread_control",
    arguments: {
      action: "activity",
      threadRef: alphaThreadRef,
      cursor: "0",
      limit: 100,
    },
    _meta: alphaHostMeta,
  });
  assertSucceeded(alphaActivity);
  const alphaActivityContent = alphaActivity.structuredContent as {
    events?: Array<{ type?: unknown; sequence?: unknown }>;
    projection?: {
      status?: unknown;
      latestPatch?: { files?: unknown; additions?: unknown; removals?: unknown };
      lastSequence?: unknown;
    };
    nextCursor?: unknown;
  };
  const alphaActivityTypes = new Set(
    (alphaActivityContent.events ?? []).map((event) => event.type),
  );
  assert.equal(alphaActivityTypes.has("patch.validated"), true);
  assert.equal(alphaActivityTypes.has("patch.applied"), true);
  assert.equal(alphaActivityContent.projection?.status, "completed");
  assert.deepEqual(alphaActivityContent.projection?.latestPatch, {
    operationId: "alpha-patch",
    files: 1,
    additions: 1,
    removals: 0,
  });
  assert.equal(
    alphaActivityContent.nextCursor,
    String(alphaActivityContent.projection?.lastSequence),
  );
  assert.equal("hostUnavailable" in alphaActivityContent, false);

  const noNewAlphaActivity = await conversationA.callTool({
    name: "project_thread_control",
    arguments: {
      action: "activity",
      threadRef: alphaThreadRef,
      cursor: String(alphaActivityContent.nextCursor),
      waitMs: 1,
    },
    _meta: alphaHostMeta,
  });
  assertSucceeded(noNewAlphaActivity);
  assert.equal(
    (noNewAlphaActivity.structuredContent as { timedOut?: unknown } | undefined)?.timedOut,
    true,
  );

  const missingVersion = await conversationA.callTool({
    name: "save_progress",
    arguments: {
      operationId: "update-alpha",
      title: "Alpha task",
      progress: "Must provide the current version.",
    },
    _meta: alphaHostMeta,
  });
  assertErrorCode(missingVersion, "if_match_required");
  assert.equal(errorCurrentVersion(missingVersion), 1);

  const alphaUpdate = await conversationA.callTool({
    name: "save_progress",
    arguments: {
      operationId: "update-alpha",
      title: "Alpha task",
      progress: "Created task-note.txt; re-read it before the next edit. Version three.",
      ifMatch: 1,
    },
    _meta: alphaHostMeta,
  });
  assertSucceeded(alphaUpdate);
  assert.equal(savedThreadVersion(alphaUpdate), 3);

  const staleUpdate = await conversationA.callTool({
    name: "save_progress",
    arguments: {
      operationId: "stale-alpha",
      title: "Stale alpha",
      progress: "Must not overwrite version three.",
      ifMatch: 1,
    },
    _meta: alphaHostMeta,
  });
  assertErrorCode(staleUpdate, "project_task_revision_conflict");
  assert.equal(errorCurrentVersion(staleUpdate), 2);

  const betaSaveA = await conversationA.callTool({
    name: "save_progress",
    arguments: {
      operationId: "save-beta-a",
      title: "Beta task A",
      progress: "Context A inspected Beta.",
    },
    _meta: betaAHostMeta,
  });
  const betaSaveB = await conversationB.callTool({
    name: "save_progress",
    arguments: {
      operationId: "save-beta-b",
      title: "Beta task B",
      progress: "Context B inspected Beta independently.",
    },
    _meta: betaBHostMeta,
  });
  assertSucceeded(betaSaveA);
  assertSucceeded(betaSaveB);
  const betaThreadRefA = savedThreadRef(betaSaveA);
  const betaThreadRefB = savedThreadRef(betaSaveB);
  assert.notEqual(betaThreadRefA, betaThreadRefB);

  const globalAfterSaves = await conversationA.callTool({
    name: "list_projects",
    arguments: {},
  });
  assertSucceeded(globalAfterSaves);
  const globalSerialized = JSON.stringify(globalAfterSaves.structuredContent);
  assert.doesNotMatch(globalSerialized, /Alpha task|Beta task|createdAt|updatedAt|taskRef|tasks/u);
  const globalProjects = (globalAfterSaves.structuredContent as {
    projects?: Array<{
      projectRef?: unknown;
      resumableTaskCount?: unknown;
    }>;
  } | undefined)?.projects ?? [];
  assert.equal(
    globalProjects.find((project) => project.projectRef === alphaRef)?.resumableTaskCount,
    1,
  );
  assert.equal(
    globalProjects.find((project) => project.projectRef === betaRef)?.resumableTaskCount,
    2,
  );

  const scopedAlpha = await conversationA.callTool({
    name: "list_projects",
    arguments: { projectRef: alphaRef },
  });
  assertSucceeded(scopedAlpha);
  const scopedAlphaSerialized = JSON.stringify(scopedAlpha.structuredContent);
  assert.match(scopedAlphaSerialized, /Alpha task/u);
  assert.doesNotMatch(
    scopedAlphaSerialized,
    /Beta task|createdAt|"status"\s*:|defaultProjectRef|taskLimits/u,
  );
  const scopedAlphaTasks = (scopedAlpha.structuredContent as {
    projects?: Array<{ tasks?: Array<Record<string, unknown>> }>;
  } | undefined)?.projects?.[0]?.tasks ?? [];
  assert.deepEqual(
    Object.keys(scopedAlphaTasks[0] ?? {}).sort(),
    ["taskRef", "title", "updatedAt", "version"],
  );

  const threadListing = await conversationA.callTool({
    name: "project_thread_control",
    arguments: { action: "list" },
    _meta: alphaHostMeta,
  });
  assertSucceeded(threadListing);
  const threads = listedThreads(threadListing);
  assert.deepEqual(
    new Set(threads.map((thread) => thread.threadRef)),
    new Set([alphaThreadRef, betaThreadRefA, betaThreadRefB]),
  );
  assert.ok(threads.every((thread) =>
    typeof thread.title === "string" &&
    typeof thread.version === "number" &&
    thread.status === "active"
  ));
  assert.doesNotMatch(
    JSON.stringify(threadListing.structuredContent),
    /checkoutRoot|worktreeId|profileId|grantId|executionId|executionRef|modelSummary/u,
  );

  const betaListing = await conversationA.callTool({
    name: "project_thread_control",
    arguments: { action: "list", projectRef: betaRef },
    _meta: alphaHostMeta,
  });
  assertSucceeded(betaListing);
  assert.deepEqual(
    new Set(listedThreads(betaListing).map((thread) => thread.threadRef)),
    new Set([betaThreadRefA, betaThreadRefB]),
  );

  const resumedAlpha = await conversationA.callTool({
    name: "project_control",
    arguments: {
      action: "resume",
      projectRef: alphaRef,
      taskRef: alphaTaskRef,
      operationId: "resume-alpha",
    },
    _meta: resumedAlphaHostMeta,
  });
  assertSucceeded(resumedAlpha);
  assert.doesNotMatch(JSON.stringify(resumedAlpha.structuredContent), /executionRef/u);
  const resumedThread = (resumedAlpha._meta as {
    thread?: {
      threadRef?: unknown;
      title?: unknown;
      version?: unknown;
    };
  }).thread;
  assert.notEqual(resumedThread?.threadRef, alphaThreadRef);
  assert.equal(resumedThread?.title, "Alpha task");
  assert.equal(resumedThread?.version, 1);
  const resumedCheckpoint = (resumedAlpha.structuredContent as {
    checkpoint?: { untrustedSummary?: unknown; serverObserved?: unknown };
  }).checkpoint;
  assert.match(String(resumedCheckpoint?.untrustedSummary), /Version three/u);
  assert.equal(typeof resumedCheckpoint?.serverObserved, "object");
  assert.equal(
    Object.hasOwn(
      (resumedAlpha.structuredContent ?? {}) as Record<string, unknown>,
      "thread",
    ),
    false,
  );
  assertReadText(await conversationA.callTool({
    name: "read_files",
    arguments: { files: [{ path: "task-note.txt" }] },
    _meta: resumedAlphaHostMeta,
  }), "shared state");

  const status = await conversationA.callTool({
    name: "project_thread_control",
    arguments: { action: "status", threadRef: alphaThreadRef },
    _meta: alphaHostMeta,
  });
  assertSucceeded(status);
  assert.equal(
    (status.structuredContent as { thread?: { version?: unknown } } | undefined)?.thread?.version,
    3,
  );

  const freshBeta = await conversationA.callTool({
    name: "project_control",
    arguments: {
      action: "open",
      projectRef: betaRef,
      operationId: "fresh-beta",
    },
    _meta: freshBetaHostMeta,
  });
  assertSucceeded(freshBeta);
  assert.equal(
    (freshBeta.structuredContent as {
      checkpoint?: unknown;
    } | undefined)?.checkpoint,
    undefined,
  );

  const closedBetaA = await conversationA.callTool({
    name: "project_thread_control",
    arguments: {
      action: "close",
      threadRef: betaThreadRefA,
      operationId: "close-beta-a",
    },
    _meta: betaAHostMeta,
  });
  assertSucceeded(closedBetaA);
  const resolvedAfterClose = await conversationA.callTool({
    name: "project_thread_control",
    arguments: { action: "resolve" },
    _meta: betaAHostMeta,
  });
  assertSucceeded(resolvedAfterClose);
  assert.equal(
    (resolvedAfterClose.structuredContent as { binding?: unknown } | undefined)?.binding,
    "none",
    "closing a Thread must release the exact session execution binding immediately",
  );
  assertErrorCode(await conversationA.callTool({
    name: "read_files",
    arguments: { files: [{ path: "beta.txt" }] },
    _meta: betaAHostMeta,
  }), "project_execution_required");
} finally {
  while (clients.length > 0) await closeClient(clients[clients.length - 1]!);
  await closeHttpServer(httpServer);
  await running.close();
  await rm(fixtureRoot, { recursive: true, force: true });
}

function seedAccessToken(): void {
  const store = new SqliteOAuthStore(stateDir);
  try {
    const client = new SqliteOAuthClientsStore(
      store,
      config.oauth.allowedRedirectHosts,
    ).registerClient({
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      client_name: "project-thread",
    });
    const grant = store.createAuthorizationGrant({
      clientId: client.client_id,
      scopes: [...DEVSPACE_CAPABILITY_SCOPES],
      allowedRootIds: [
        authorizationRootId(alphaRoot, config.oauth.keys.authorizationRoot),
        authorizationRootId(betaRoot, config.oauth.keys.authorizationRoot),
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

async function connect(origin: URL, name: string): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", origin), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  }));
  clients.push(client);
  return client;
}

async function closeClient(client: Client): Promise<void> {
  const index = clients.indexOf(client);
  if (index >= 0) clients.splice(index, 1);
  await client.close().catch(() => undefined);
}

function hostMeta(session: string): Readonly<Record<string, string>> {
  return {
    "openai/subject": "project-execution-simulation-subject",
    "openai/session": `project-execution-simulation-${session}`,
  };
}

function savedThreadRef(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const value = String((result._meta as {
    thread?: { threadRef?: unknown };
  } | undefined)?.thread?.threadRef ?? "");
  assert.match(value, /^pth1_/u);
  return value;
}

function savedTaskRef(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const value = (result.structuredContent as {
    task?: { taskRef?: unknown };
  } | undefined)?.task?.taskRef;
  if (typeof value !== "string") throw new Error("Expected saved taskRef");
  return value;
}

function savedThreadVersion(result: Awaited<ReturnType<Client["callTool"]>>): number {
  const value = (result._meta as {
    thread?: { version?: unknown };
  } | undefined)?.thread?.version;
  assert.equal(typeof value, "number");
  return value as number;
}

function errorCurrentVersion(result: Awaited<ReturnType<Client["callTool"]>>): number {
  const value = (result.structuredContent as {
    error?: { currentVersion?: unknown };
  } | undefined)?.error?.currentVersion;
  assert.equal(typeof value, "number");
  return value as number;
}

function listedThreads(result: Awaited<ReturnType<Client["callTool"]>>): Array<{
  threadRef: string;
  title: string;
  status: string;
  version: number;
}> {
  return ((result.structuredContent as { threads?: unknown[] } | undefined)?.threads ?? [])
    .map((value) => value as {
      threadRef: string;
      title: string;
      status: string;
      version: number;
    });
}

function assertReadText(
  result: Awaited<ReturnType<Client["callTool"]>>,
  expected: string,
): void {
  assertSucceeded(result);
  assert.match(JSON.stringify(result.structuredContent), new RegExp(escapeRegExp(expected), "u"));
}

function assertSucceeded(result: Awaited<ReturnType<Client["callTool"]>>): void {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
}

function assertErrorCode(
  result: Awaited<ReturnType<Client["callTool"]>>,
  code: string,
): void {
  assert.equal(result.isError, true, JSON.stringify(result.content));
  assert.equal((result.structuredContent as {
    error?: { code?: unknown };
  } | undefined)?.error?.code, code);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
