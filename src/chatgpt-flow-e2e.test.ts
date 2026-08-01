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

  const selected = await first.callTool({
    name: "project_control",
    arguments: {
      action: "open",
      projectRef: projects[0]?.projectRef,
      operationId: "create-execution-a",
    },
  });
  assertSucceeded(selected);
  assertProjectOnly(selected);
  const executionRef = String(
    (selected.structuredContent as {
      project?: { executionRef?: unknown };
    } | undefined)?.project?.executionRef ?? "",
  );
  assert.match(executionRef, /^pex1_/u);
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
  });
  assert.equal(contextFailure.isError, true);
  const recoveredContext = await first.callTool({
    name: "project_control",
    arguments: {
      action: "open",
      projectRef: projects[0]?.projectRef,
      operationId: "recover-context-failure",
    },
  });
  assertSucceeded(recoveredContext);
  assert.match(
    String((recoveredContext.structuredContent as {
      project?: { executionRef?: unknown };
    } | undefined)?.project?.executionRef ?? ""),
    /^pex1_/u,
    "an instruction-context failure must leave the shared Project context recoverable",
  );
  const replayedSelection = await first.callTool({
    name: "project_control",
    arguments: {
      action: "open",
      projectRef: projects[0]?.projectRef,
      operationId: "create-execution-a",
    },
  });
  assertSucceeded(replayedSelection);
  assert.equal(
    (replayedSelection.structuredContent as {
      project?: { executionRef?: unknown };
    } | undefined)?.project?.executionRef,
    executionRef,
  );

  const read = await first.callTool({
    name: "read_files",
    arguments: { executionRef, files: [{ path: "payload.txt" }] },
  });
  assertSucceeded(read);
  assert.match(JSON.stringify(read.structuredContent), /chatgpt-flow-ready/u);

  const command = await first.callTool({
    name: "exec_command",
    arguments: {
      executionRef,
      operationId: "chatgpt-flow-command",
      program: process.execPath,
      args: [
        "-e",
        "require('node:fs').writeFileSync('execution-a-visible.txt', 'shared-a\\n'); console.log('chatgpt-command-ok')",
      ],
    },
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
      executionRef,
      files: [{ path: "payload.txt" }, { path: "execution-a-visible.txt" }],
    },
  });
  assertSucceeded(readAfterReconnect);

  const newConversation = await connect(active.origin, "parallel-execution");
  const unboundNewConversation = await newConversation.callTool({
    name: "read_files",
    arguments: { files: [{ path: "payload.txt" }] },
  });
  assertErrorCode(unboundNewConversation, "invalid_tool_input");
  const secondSelection = await newConversation.callTool({
    name: "project_control",
    arguments: {
      action: "open",
      projectRef: projects[0]?.projectRef,
      operationId: "create-execution-b",
    },
  });
  assertSucceeded(secondSelection);
  const secondExecutionRef = String(
    (secondSelection.structuredContent as {
      project?: { executionRef?: unknown };
    } | undefined)?.project?.executionRef ?? "",
  );
  assert.match(secondExecutionRef, /^pex1_/u);
  assert.notEqual(secondExecutionRef, executionRef);
  assertSucceeded(await newConversation.callTool({
    name: "read_files",
    arguments: { executionRef: secondExecutionRef, files: [{ path: "payload.txt" }] },
  }));
  const sharedRead = await newConversation.callTool({
    name: "read_files",
    arguments: {
      executionRef: secondExecutionRef,
      files: [{ path: "execution-a-visible.txt" }],
    },
  });
  assertSucceeded(sharedRead);

  const applied = await reconnected.callTool({
    name: "apply_patch",
    arguments: {
      executionRef,
      operationId: "chatgpt-flow-apply",
      patch: "*** Begin Patch\n*** Add File: patched-by-devspace.txt\n+recorded change\n*** End Patch\n",
      ifMatch: { "patched-by-devspace.txt": null },
    },
  });
  assertSucceeded(applied);
  const firstHistory = await reconnected.callTool({
    name: "show_changes",
    arguments: { executionRef },
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

  const secondHistory = await newConversation.callTool({
    name: "show_changes",
    arguments: { executionRef: secondExecutionRef },
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
      executionRef,
      files: [{ path: "payload.txt" }],
    },
  });
  assertErrorCode(gatedAfterRestart, "root_instructions_required");
  const resumed = await afterRestart.callTool({
    name: "project_control",
    arguments: { action: "hydrate", executionRef },
  });
  assertSucceeded(resumed);
  assertProjectOnly(resumed);
  const readAfterRestart = await afterRestart.callTool({
    name: "read_files",
    arguments: {
      executionRef,
      files: [
        { path: "payload.txt" },
        { path: "execution-a-visible.txt" },
        { path: "patched-by-devspace.txt" },
      ],
    },
  });
  assertSucceeded(readAfterRestart);
  const historyAfterRestart = await afterRestart.callTool({
    name: "show_changes",
    arguments: { executionRef },
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
