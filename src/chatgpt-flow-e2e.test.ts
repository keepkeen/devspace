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
import { DEVSPACE_CAPABILITY_SCOPES } from "./oauth-scopes.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";
import { createServer } from "./server.js";

const root = await mkdtemp(join(tmpdir(), "devspace-chatgpt-flow-"));
const projectRoot = join(root, "project");
const stateDir = join(root, "state");
const publicBaseUrl = "http://127.0.0.1:7676";
const accessToken = "chatgpt-flow-access-token";
const clients: Client[] = [];
let failNextInstructionContextRead = false;

await mkdir(projectRoot, { recursive: true });
await writeFile(
  join(projectRoot, "AGENTS.md"),
  "# ChatGPT flow\n\nKeep changes scoped to the selected Project.\n",
);
await writeFile(join(projectRoot, "payload.txt"), "chatgpt-flow-ready\n");

const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_ALLOWED_ROOTS: projectRoot,
  DEVSPACE_ALLOWED_HOSTS: "*",
  DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
  DEVSPACE_OAUTH_OWNER_TOKEN: "chatgpt-flow-owner-password-long-enough",
  DEVSPACE_OAUTH_SCOPES: DEVSPACE_CAPABILITY_SCOPES.join(","),
  DEVSPACE_WIDGETS: "off",
  DEVSPACE_LOG_LEVEL: "silent",
  PORT: "1",
});
const auditEntries: Array<Readonly<Record<string, unknown>>> = [];
config.logging.auditSink = (entry) => auditEntries.push(entry);
(config as typeof config & {
  instructionIoHooksForTests: {
    beforeFileOpen(path: string): void;
  };
}).instructionIoHooksForTests = {
  beforeFileOpen() {
    if (!failNextInstructionContextRead) return;
    failNextInstructionContextRead = false;
    throw new Error("injected instruction context read failure");
  },
};
seedAccessToken();

let active: Awaited<ReturnType<typeof startServer>> | undefined;
try {
  active = await startServer();

  const first = await connect(active.origin, "sessionless-first");
  const listed = await first.callTool({
    name: "list_projects",
    arguments: {},
  });
  assertSucceeded(listed);
  const projects = (listed.structuredContent as {
    projects?: Array<{ projectRef?: unknown; label?: unknown }>;
  } | undefined)?.projects ?? [];
  assert.equal(projects.length, 1);
  assert.equal(typeof projects[0]?.projectRef, "string");
  assert.doesNotMatch(
    JSON.stringify(listed.structuredContent),
    new RegExp(escapeRegExp(projectRoot), "u"),
  );

  const subjectMeta = {
    "openai/subject": "stable-project-thread-subject",
    "openai/session": "stable-project-thread-session",
  };
  const mainMeta = {
    "openai/subject": "chatgpt-flow-subject",
    "openai/session": "chatgpt-flow-main-session",
  };
  const parallelMeta = {
    "openai/subject": "chatgpt-flow-subject",
    "openai/session": "chatgpt-flow-parallel-session",
  };
  const subjectSelection = await first.callTool({
    name: "project_control",
    arguments: {
      action: "open",
      projectRef: projects[0]?.projectRef,
      operationId: "subject-create-execution",
    },
    _meta: subjectMeta,
  });
  assertSucceeded(subjectSelection);
  const subjectThreadRef = String(
    (subjectSelection.structuredContent as {
      thread?: { threadRef?: unknown };
    } | undefined)?.thread?.threadRef ?? "",
  );
  assert.match(subjectThreadRef, /^pth1_/u);

  assertSucceeded(await first.callTool({
    name: "exec_command",
    arguments: {
      operationId: "subject-command-checkpoint",
      program: process.execPath,
      args: ["-e", "console.log('subject-command-ok')"],
    },
    _meta: subjectMeta,
  }));
  assertThreadCheckpoint(
    await first.callTool({
      name: "project_thread_control",
      arguments: { action: "status", threadRef: subjectThreadRef },
      _meta: subjectMeta,
    }),
    subjectThreadRef,
    "command_completed",
  );

  assertSucceeded(await first.callTool({
    name: "apply_patch",
    arguments: {
      operationId: "subject-patch-checkpoint",
      patch: "*** Begin Patch\n*** Add File: subject-patched.txt\n+subject patch\n*** End Patch\n",
      ifMatch: { "subject-patched.txt": null },
    },
    _meta: subjectMeta,
  }));
  assertThreadCheckpoint(
    await first.callTool({
      name: "project_thread_control",
      arguments: { action: "status", threadRef: subjectThreadRef },
      _meta: subjectMeta,
    }),
    subjectThreadRef,
    "patch_applied",
  );

  const subjectThreads = await first.callTool({
    name: "project_thread_control",
    arguments: { action: "list", projectRef: projects[0]?.projectRef },
    _meta: subjectMeta,
  });
  assertSucceeded(subjectThreads);
  assert.deepEqual(
    (subjectThreads.structuredContent as {
      threads?: Array<{ threadRef?: unknown }>;
    } | undefined)?.threads?.map((thread) => thread.threadRef),
    [subjectThreadRef],
    "leased calls with a stable host subject must retain one execution-to-Thread binding",
  );
  assert.equal(
    auditEntries.some((entry) => entry.event === "project_thread_checkpoint_failed"),
    false,
    "automatic checkpoints must not emit profile-mismatch warnings",
  );

  const selected = await first.callTool({
    name: "project_control",
    arguments: {
      action: "open",
      projectRef: projects[0]?.projectRef,
      operationId: "create-execution-a",
    },
    _meta: mainMeta,
  });
  assertSucceeded(selected);
  assertProjectOnly(selected);
  assert.doesNotMatch(JSON.stringify(selected.structuredContent), /executionRef/u);
  assert.equal(
    (selected.structuredContent as {
      project?: { ref?: unknown; writeAccess?: unknown };
    } | undefined)?.project?.ref,
    projects[0]?.projectRef,
  );
  assert.match(JSON.stringify(selected.structuredContent), /ChatGPT flow/u);
  failNextInstructionContextRead = true;
  const contextFailure = await first.callTool({
    name: "project_control",
    arguments: {
      action: "open",
      projectRef: projects[0]?.projectRef,
      operationId: "recover-context-failure",
    },
    _meta: mainMeta,
  });
  assert.equal(contextFailure.isError, true);
  const recoveredContext = await first.callTool({
    name: "project_control",
    arguments: {
      action: "open",
      projectRef: projects[0]?.projectRef,
      operationId: "recover-context-failure",
    },
    _meta: mainMeta,
  });
  assertSucceeded(recoveredContext);
  assert.doesNotMatch(
    JSON.stringify(recoveredContext.structuredContent),
    /executionRef/u,
    "an instruction-context failure must leave the shared Project context recoverable without exposing its execution",
  );
  const replayedSelection = await first.callTool({
    name: "project_control",
    arguments: {
      action: "open",
      projectRef: projects[0]?.projectRef,
      operationId: "create-execution-a",
    },
    _meta: mainMeta,
  });
  assertSucceeded(replayedSelection);
  assert.deepEqual(replayedSelection.structuredContent, selected.structuredContent);

  const read = await first.callTool({
    name: "read_files",
    arguments: { files: [{ path: "payload.txt" }] },
    _meta: mainMeta,
  });
  assertSucceeded(read);
  assert.match(JSON.stringify(read.structuredContent), /chatgpt-flow-ready/u);

  const command = await first.callTool({
    name: "exec_command",
    arguments: {
      operationId: "chatgpt-flow-command",
      program: process.execPath,
      args: [
        "-e",
        "require('node:fs').writeFileSync('execution-a-visible.txt', 'shared-a\\n'); console.log('chatgpt-command-ok')",
      ],
    },
    _meta: mainMeta,
  });
  assertSucceeded(command);
  assert.match(
    String((command.structuredContent as {
      output?: { text?: unknown };
    } | undefined)?.output?.text),
    /chatgpt-command-ok/u,
  );
  assert.doesNotMatch(JSON.stringify(command.structuredContent), /workspaceAlias|contextChanged/iu);

  await closeClient(first);
  const reconnected = await connect(active.origin, "sessionless-reconnected");
  const readAfterReconnect = await reconnected.callTool({
    name: "read_files",
    arguments: {
      files: [{ path: "payload.txt" }, { path: "execution-a-visible.txt" }],
    },
    _meta: mainMeta,
  });
  assertSucceeded(readAfterReconnect);

  const newConversation = await connect(active.origin, "parallel-execution");
  const unboundNewConversation = await newConversation.callTool({
    name: "read_files",
    arguments: { files: [{ path: "payload.txt" }] },
    _meta: parallelMeta,
  });
  assertErrorCode(unboundNewConversation, "project_execution_required");
  const secondSelection = await newConversation.callTool({
    name: "project_control",
    arguments: {
      action: "open",
      projectRef: projects[0]?.projectRef,
      operationId: "create-execution-b",
    },
    _meta: parallelMeta,
  });
  assertSucceeded(secondSelection);
  assert.doesNotMatch(JSON.stringify(secondSelection.structuredContent), /executionRef/u);
  assertSucceeded(await newConversation.callTool({
    name: "read_files",
    arguments: {
      executionRef: "pex1_caller-supplied-override-must-be-ignored",
      files: [{ path: "payload.txt" }],
    },
    _meta: parallelMeta,
  }));
  const sharedRead = await newConversation.callTool({
    name: "read_files",
    arguments: {
      files: [{ path: "execution-a-visible.txt" }],
    },
    _meta: parallelMeta,
  });
  assertSucceeded(sharedRead);

  const applied = await reconnected.callTool({
    name: "apply_patch",
    arguments: {
      operationId: "chatgpt-flow-apply",
      patch: "*** Begin Patch\n*** Add File: patched-by-devspace.txt\n+recorded change\n*** End Patch\n",
      ifMatch: { "patched-by-devspace.txt": null },
    },
    _meta: mainMeta,
  });
  assertSucceeded(applied);
  const largeHistoryPatch =
    "*** Begin Patch\n*** Add File: paged-history.txt\n" +
    Array.from({ length: 2_000 }, (_, index) => `+history line ${index.toString().padStart(4, "0")} payload\n`).join("") +
    "*** End Patch\n";
  assertSucceeded(await reconnected.callTool({
    name: "apply_patch",
    arguments: {
      operationId: "chatgpt-flow-paged-apply",
      patch: largeHistoryPatch,
      ifMatch: { "paged-history.txt": null },
    },
    _meta: mainMeta,
  }));
  const missingSource = await reconnected.callTool({
    name: "show_changes",
    arguments: {},
    _meta: mainMeta,
  });
  assertErrorCode(missingSource, "invalid_tool_input");
  const unavailableRepository = await reconnected.callTool({
    name: "show_changes",
    arguments: { source: "repository" },
    _meta: mainMeta,
  });
  assertErrorCode(unavailableRepository, "repository_review_unavailable");
  assert.match(
    JSON.stringify(unavailableRepository.structuredContent),
    /apply_patch_history/u,
  );
  const firstHistory = await reconnected.callTool({
    name: "show_changes",
    arguments: { source: "apply_patch_history" },
    _meta: mainMeta,
  });
  assertSucceeded(firstHistory);
  assert.equal(
    (firstHistory.structuredContent as { changeSource?: unknown }).changeSource,
    "apply_patch_history",
  );
  const firstHistorySerialized = JSON.stringify(firstHistory.structuredContent);
  assert.match(firstHistorySerialized, /patched-by-devspace\.txt/u);
  assert.match(
    firstHistorySerialized,
    /\*\*\* Begin Patch/u,
    "non-Git review returns the successful apply_patch operation log",
  );
  assert.doesNotMatch(firstHistorySerialized, /execution-a-visible\.txt/u);
  const historyCursor = String(
    (firstHistory.structuredContent as {
      diff?: { nextCursor?: unknown };
    }).diff?.nextCursor ?? "",
  );
  assert.ok(historyCursor, "the large apply-patch history must produce a continuation cursor");
  const changedSourceContinuation = await reconnected.callTool({
    name: "show_changes",
    arguments: { source: "repository", cursor: historyCursor },
    _meta: mainMeta,
  });
  assertErrorCode(changedSourceContinuation, "diff_cursor_stale");
  assertSucceeded(await reconnected.callTool({
    name: "show_changes",
    arguments: { source: "apply_patch_history", cursor: historyCursor },
    _meta: mainMeta,
  }));

  const secondHistory = await newConversation.callTool({
    name: "show_changes",
    arguments: { source: "apply_patch_history" },
    _meta: parallelMeta,
  });
  assertSucceeded(secondHistory);
  assert.equal(
    (secondHistory.structuredContent as {
      summary?: { files?: unknown };
    }).summary?.files,
    0,
    "non-Git history is scoped to the current logical Project context",
  );

  await closeClient(reconnected);
  await closeClient(newConversation);
  await active.close();
  active = undefined;

  active = await startServer();
  const afterRestart = await connect(active.origin, "sessionless-after-restart");
  const gatedAfterRestart = await afterRestart.callTool({
    name: "read_files",
    arguments: {
      files: [{ path: "payload.txt" }],
    },
    _meta: mainMeta,
  });
  assertErrorCode(gatedAfterRestart, "root_instructions_required");
  const resumed = await afterRestart.callTool({
    name: "project_control",
    arguments: { action: "hydrate" },
    _meta: mainMeta,
  });
  assertSucceeded(resumed);
  assertProjectOnly(resumed);
  const readAfterRestart = await afterRestart.callTool({
    name: "read_files",
    arguments: {
      files: [
        { path: "payload.txt" },
        { path: "execution-a-visible.txt" },
        { path: "patched-by-devspace.txt" },
      ],
    },
    _meta: mainMeta,
  });
  assertSucceeded(readAfterRestart);
  const historyAfterRestart = await afterRestart.callTool({
    name: "show_changes",
    arguments: { source: "apply_patch_history" },
    _meta: mainMeta,
  });
  assertSucceeded(historyAfterRestart);
  assert.match(
    JSON.stringify(historyAfterRestart.structuredContent),
    /patched-by-devspace\.txt/u,
  );
} finally {
  for (const client of clients.reverse()) await closeClient(client);
  await active?.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

function seedAccessToken(): void {
  const store = new SqliteOAuthStore(stateDir);
  try {
    const client = new SqliteOAuthClientsStore(
      store,
      config.oauth.allowedRedirectHosts,
    ).registerClient({
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      client_name: "chatgpt-flow",
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
        expiresAt,
        resource,
      },
    });
  } finally {
    store.close();
  }
}

async function startServer(): Promise<{
  origin: URL;
  close: () => Promise<void>;
}> {
  const running = createServer(config);
  const httpServer = createHttpServer(running.app);
  const origin = await listen(httpServer);
  return {
    origin,
    close: async () => {
      await closeHttpServer(httpServer);
      await running.close();
    },
  };
}

async function connect(
  origin: URL,
  name: string,
): Promise<Client> {
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

function assertProjectOnly(
  result: Awaited<ReturnType<Client["callTool"]>>,
): void {
  const serialized = JSON.stringify(result.structuredContent ?? {});
  assert.match(serialized, /"project"/u);
  assert.doesNotMatch(
    serialized,
    /"(?:workspace|receipt|continuation|contextChanged|state|phase)"\s*:/iu,
  );
  assert.doesNotMatch(serialized, new RegExp(escapeRegExp(projectRoot), "u"));
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

function assertThreadCheckpoint(
  result: Awaited<ReturnType<Client["callTool"]>>,
  threadRef: string,
  cause: string,
): void {
  assertSucceeded(result);
  const thread = (result.structuredContent as {
    thread?: {
      threadRef?: unknown;
      checkpoint?: { cause?: unknown };
    };
  } | undefined)?.thread;
  assert.equal(thread?.threadRef, threadRef);
  assert.equal(thread?.checkpoint?.cause, cause);
}

function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return ((result.content ?? []) as Array<{ type?: unknown; text?: unknown }>)
    .filter((item): item is { type: "text"; text: string } =>
      item.type === "text" && typeof item.text === "string"
    )
    .map((item) => item.text)
    .join("\n");
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
