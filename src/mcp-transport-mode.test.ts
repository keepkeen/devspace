import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import { internalDiagnosticsToken } from "./internal-auth.js";
import { DEFAULT_DEVSPACE_OAUTH_SCOPES } from "./oauth-scopes.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";
import { createServer } from "./server.js";

const root = await mkdtemp(join(tmpdir(), "devspace-mcp-transport-mode-"));
const workspaceRoot = join(root, "workspace");
const stateDir = join(root, "state");
const publicBaseUrl = "http://127.0.0.1:7676";
const chatGptToken = "chatgpt-stateless-access-token";
const statefulToken = "stateful-access-token";
const clients: Client[] = [];
await mkdir(workspaceRoot, { recursive: true });
await mkdir(join(workspaceRoot, "nested"), { recursive: true });
await writeFile(join(workspaceRoot, "AGENTS.md"), "# Transport test instructions\n\nKeep this fixture read-only.\n");
await writeFile(
  join(workspaceRoot, "nested", "AGENTS.md"),
  "# Nested transport instructions\n\nAcknowledge this context before entering nested.\n",
);
await writeFile(join(workspaceRoot, "payload.txt"), "transport-mode-ok\n");

const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
  DEVSPACE_ALLOWED_HOSTS: "*",
  DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
  DEVSPACE_OAUTH_OWNER_TOKEN: "mcp-transport-owner-token-long-enough",
  DEVSPACE_SKILLS: "0",
  DEVSPACE_WIDGETS: "off",
  DEVSPACE_LOG_LEVEL: "warn",
  DEVSPACE_LOG_FORMAT: "json",
  DEVSPACE_MAX_MCP_SESSIONS: "2",
  DEVSPACE_MAX_MCP_SESSIONS_PER_CLIENT: "1",
  DEVSPACE_MCP_HTTP_TRANSPORT: "stateless",
});
seedClient(chatGptToken, "https://chatgpt.com/connector/oauth/transport-test", "chatgpt", stateDir, config);

const running = createServer(config);
const httpServer = createHttpServer(running.app);
try {
  const origin = await listen(httpServer);
  const firstObserved: ObservedResponse[] = [];
  const firstChatGpt = await connectClient("chatgpt-one", chatGptToken, origin, firstObserved);
  clients.push(firstChatGpt);
  assert.equal(firstObserved.some((entry) => entry.sessionId !== null), false);
  await firstChatGpt.listTools();
  const opened = await firstChatGpt.callTool({
    name: "open_workspace",
    arguments: {
      path: workspaceRoot,
      alias: "transport",
      writeAccess: "read_write",
      contextMode: "full",
    },
  });
  const workspaceId = String(
    (opened.structuredContent as { workspace?: { ref?: unknown } } | undefined)?.workspace?.ref ?? "",
  );
  assert.ok(workspaceId);
  let receipt = String(
    (opened.structuredContent as {
      continuation?: { receipt?: unknown };
    } | undefined)?.continuation?.receipt ?? "",
  );
  const firstContextReceipt = receipt;
  assert.match(receipt, /^wctx5\./);
  const instructionRevision = String(
    (opened.structuredContent as {
      instructionManifest?: { revision?: unknown };
    } | undefined)?.instructionManifest?.revision ?? "",
  );
  assert.ok(instructionRevision);
  const unverifiedRetainedOpen = await firstChatGpt.callTool({
    name: "open_workspace",
    arguments: {
      path: workspaceRoot,
      contextMode: "retained",
      knownInstructionRevision: instructionRevision,
    },
  });
  assert.equal(unverifiedRetainedOpen.isError, true);
  assert.equal(
    (unverifiedRetainedOpen.structuredContent as {
      error?: { code?: unknown };
    } | undefined)?.error?.code,
    "retained_context_unverified",
  );
  const compactReopen = await firstChatGpt.callTool({
    name: "get_workspace_context",
    arguments: {
      receipt,
      contextMode: "retained",
      knownInstructionRevision: instructionRevision,
    },
  });
  const compactStructured = compactReopen.structuredContent as {
    instructionManifest?: { files?: unknown };
  } | undefined;
  assert.deepEqual(compactStructured?.instructionManifest?.files, []);

  const getResponse = await fetch(new URL("/mcp", origin), {
    headers: { authorization: `Bearer ${chatGptToken}` },
  });
  assert.equal(getResponse.status, 405);
  assert.equal(getResponse.headers.get("allow"), "POST");
  const deleteResponse = await fetch(new URL("/mcp", origin), {
    method: "DELETE",
    headers: { authorization: `Bearer ${chatGptToken}` },
  });
  assert.equal(deleteResponse.status, 405);

  const staleStatelessResponse = await rawMcpPost(origin, chatGptToken, "stale-chatgpt-session");
  assert.equal(staleStatelessResponse.status, 200);

  const loadedInstructions = await firstChatGpt.callTool({
    name: "load_workspace_instructions",
    arguments: { receipt, paths: ["."] },
  });
  const instructionToken = String(
    (loadedInstructions.structuredContent as { instructionToken?: unknown } | undefined)?.instructionToken ?? "",
  );
  assert.match(instructionToken, /^instructions_/);
  const nestedInstructions = await firstChatGpt.callTool({
    name: "load_workspace_instructions",
    arguments: { receipt, paths: ["nested"] },
  });
  const firstContextNestedToken = String(
    (nestedInstructions.structuredContent as { instructionToken?: unknown } | undefined)
      ?.instructionToken ?? "",
  );
  assert.match(firstContextNestedToken, /^instructions_/);

  const heldCommand = firstChatGpt.callTool({
    name: "exec_command",
    arguments: {
      receipt,
      instructionToken,
      shell: true,
      command: "sleep 0.25",
      yieldTimeMs: 1_000,
    },
  });
  await delay(50);
  const overCapacity = await rawMcpPost(origin, chatGptToken, "concurrent-chatgpt-session");
  assert.equal(overCapacity.status, 503);
  assert.match(await overCapacity.text(), /MCP request capacity reached/);
  await heldCommand;
  const afterCapacityRelease = await rawMcpPost(origin, chatGptToken, "released-chatgpt-session");
  assert.equal(afterCapacityRelease.status, 200);

  const disconnectProcess = await firstChatGpt.callTool({
    name: "exec_command",
    arguments: {
      receipt,
      program: process.execPath,
      args: [
        "-e",
        "process.stdin.once('data', () => process.exit(0)); setInterval(() => {}, 1000);",
      ],
      closeStdin: false,
      yieldTimeMs: 0,
    },
  });
  const disconnectSessionId = (disconnectProcess.structuredContent as {
    sessionId?: unknown;
  } | undefined)?.sessionId;
  assert.equal(typeof disconnectSessionId, "number");

  await firstChatGpt.close();

  for (let index = 0; index < 8; index += 1) {
    await abortStatelessToolCallAfterLease({
      origin,
      accessToken: chatGptToken,
      ownerToken: config.oauth.keys.internalDiagnostics,
      requestId: 200 + index,
      body: {
        jsonrpc: "2.0",
        id: 200 + index,
        method: "tools/call",
        params: {
          name: "write_stdin",
          _meta: {
            "openai/subject": `subject-${chatGptToken}`,
            "openai/session": "chatgpt-one",
          },
          arguments: {
            receipt,
            sessionId: disconnectSessionId,
            yieldTimeMs: 5_000,
          },
        },
      },
    });
  }

  const listAfterEightDisconnects = await fetch(new URL("/mcp", origin), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${chatGptToken}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 300,
      method: "tools/call",
      params: {
        name: "list_workspaces",
        _meta: {
          "openai/subject": `subject-${chatGptToken}`,
          "openai/session": "chatgpt-one",
        },
        arguments: {},
      },
    }),
  });
  assert.equal(
    listAfterEightDisconnects.status,
    200,
    "eight canceled stateless polls must not exhaust the client request limit",
  );
  assert.doesNotMatch(await listAfterEightDisconnects.text(), /MCP request capacity reached/);

  const secondObserved: ObservedResponse[] = [];
  const secondChatGpt = await connectClient("chatgpt-two", chatGptToken, origin, secondObserved);
  clients.push(secondChatGpt);
  assert.equal(secondObserved.some((entry) => entry.sessionId !== null), false);
  const processAfterDisconnects = await secondChatGpt.callTool({
    name: "write_stdin",
    arguments: { receipt, sessionId: disconnectSessionId, yieldTimeMs: 0 },
  });
  assert.notEqual(
    processAfterDisconnects.isError,
    true,
    "releasing a disconnected HTTP lease must not cancel the tracked process",
  );
  const stopDisconnectProcess = await secondChatGpt.callTool({
    name: "write_stdin",
    arguments: {
      receipt,
      sessionId: disconnectSessionId,
      chars: "x",
      yieldTimeMs: 1_000,
    },
  });
  assert.notEqual(stopDisconnectProcess.isError, true);
  const directReuseAfterTransportClose = await secondChatGpt.callTool({
    name: "read",
    arguments: { receipt, path: "payload.txt" },
  });
  assert.match(JSON.stringify(directReuseAfterTransportClose.content), /transport-mode-ok/);
  const freshConversationOpen = await secondChatGpt.callTool({
    name: "resume_workspace",
    arguments: { alias: "transport", contextMode: "full" },
  });
  const freshStructured = freshConversationOpen.structuredContent as {
    continuation?: { receipt?: unknown };
    instructionManifest?: { files?: unknown[] };
  } | undefined;
  assert.ok((freshStructured?.instructionManifest?.files?.length ?? 0) > 0);
  receipt = String(freshStructured?.continuation?.receipt ?? "");
  assert.match(receipt, /^wctx5\./);
  const resumedMutationWithoutReload = await secondChatGpt.callTool({
    name: "exec_command",
    arguments: { receipt, shell: true, command: "pwd" },
  });
  assert.equal(resumedMutationWithoutReload.isError, true);
  assert.equal(
    (resumedMutationWithoutReload.structuredContent as {
      error?: { code?: unknown };
    } | undefined)?.error?.code,
    "instructions_required",
  );
  const freshRootInstructions = await secondChatGpt.callTool({
    name: "load_workspace_instructions",
    arguments: { receipt, paths: ["."] },
  });
  const freshRootToken = String(
    (freshRootInstructions.structuredContent as { instructionToken?: unknown } | undefined)
      ?.instructionToken ?? "",
  );
  assert.match(freshRootToken, /^instructions_/);
  const resumedMutationAfterLoad = await secondChatGpt.callTool({
    name: "exec_command",
    arguments: { receipt, instructionToken: freshRootToken, shell: true, command: "pwd" },
  });
  assert.notEqual(resumedMutationAfterLoad.isError, true);
  const originalContextStillAcknowledged = await secondChatGpt.callTool({
    name: "exec_command",
    arguments: { receipt: firstContextReceipt, shell: true, command: "pwd" },
  });
  assert.notEqual(
    originalContextStillAcknowledged.isError,
    true,
    "resuming a new context must not clear acknowledgement state owned by an older receipt",
  );
  const crossContextInstructionToken = await secondChatGpt.callTool({
    name: "exec_command",
    arguments: {
      receipt,
      instructionToken: firstContextNestedToken,
      shell: true, command: "pwd",
      workingDirectory: "nested",
    },
  });
  assert.equal(
    (crossContextInstructionToken.structuredContent as {
      error?: { code?: unknown };
    } | undefined)?.error?.code,
    "instruction_token_invalid",
  );
  const originalContextConsumesItsToken = await secondChatGpt.callTool({
    name: "exec_command",
    arguments: {
      receipt: firstContextReceipt,
      instructionToken: firstContextNestedToken,
      shell: true, command: "pwd",
      workingDirectory: "nested",
    },
  });
  assert.notEqual(originalContextConsumesItsToken.isError, true);
  const reusedRead = await secondChatGpt.callTool({
    name: "read",
    arguments: { receipt, path: "payload.txt" },
  });
  assert.match(JSON.stringify(reusedRead.content), /transport-mode-ok/);

} finally {
  for (const client of clients.reverse()) await client.close().catch(() => undefined);
  await closeHttpServer(httpServer);
  await running.close();
}

const statefulStateDir = join(root, "stateful-state");
const statefulConfig = loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, "stateful-config"),
  DEVSPACE_STATE_DIR: statefulStateDir,
  DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
  DEVSPACE_ALLOWED_HOSTS: "*",
  DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
  DEVSPACE_OAUTH_OWNER_TOKEN: "mcp-transport-owner-token-long-enough",
  DEVSPACE_SKILLS: "0",
  DEVSPACE_WIDGETS: "off",
  DEVSPACE_LOG_LEVEL: "warn",
  DEVSPACE_LOG_FORMAT: "json",
  DEVSPACE_MCP_HTTP_TRANSPORT: "stateful",
});
seedClient(
  statefulToken,
  "http://127.0.0.1/stateful-callback",
  "stateful",
  statefulStateDir,
  statefulConfig,
);
const statefulRunning = createServer(statefulConfig);
const statefulHttpServer = createHttpServer(statefulRunning.app);
try {
  const statefulOrigin = await listen(statefulHttpServer);
  const statefulObserved: ObservedResponse[] = [];
  const stateful = await connectClient(
    "stateful-client",
    statefulToken,
    statefulOrigin,
    statefulObserved,
  );
  const statefulSessionId = statefulObserved.find((entry) => entry.sessionId)?.sessionId;
  assert.equal(typeof statefulSessionId, "string");
  await stateful.listTools();

  const warningLines: string[] = [];
  const originalWarn = console.warn;
  let staleStatefulResponse: Response;
  console.warn = (...values: unknown[]) => {
    warningLines.push(values.map(String).join(" "));
  };
  try {
    staleStatefulResponse = await rawMcpPost(
      statefulOrigin,
      statefulToken,
      "stale-stateful-session",
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(staleStatefulResponse.status, 404);
  assert.match(await staleStatefulResponse.text(), /Unknown MCP session/);
  const unknownSessionLog = warningLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((entry) => entry.event === "unknown_mcp_session");
  assert.ok(unknownSessionLog);
  assert.equal(unknownSessionLog.sessionIdPrefix, "stale-st");
  assert.equal(unknownSessionLog.reason, "not_found_or_not_owned");
  const serializedLog = JSON.stringify(unknownSessionLog);
  assert.doesNotMatch(serializedLog, /stale-stateful-session/);
  assert.doesNotMatch(serializedLog, new RegExp(statefulToken));
  await stateful.close();
} finally {
  await closeHttpServer(statefulHttpServer);
  await statefulRunning.close();
  await rm(root, { recursive: true, force: true });
}

interface ObservedResponse {
  method: string;
  status: number;
  sessionId: string | null;
}

async function connectClient(
  name: string,
  accessToken: string,
  origin: URL,
  observed: ObservedResponse[],
): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", origin), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      observed.push({
        method: init?.method ?? "GET",
        status: response.status,
        sessionId: response.headers.get("mcp-session-id"),
      });
      return response;
    },
  }));
  let operationSequence = 0;
  const originalCallTool = client.callTool.bind(client);
  client.callTool = (async (...callArgs: Parameters<Client["callTool"]>) => {
    const request = callArgs[0];
    const requestArguments = {
      ...(request.arguments as Record<string, unknown> | undefined ?? {}),
    };
    const mutatingWriteStdin = request.name === "write_stdin" && (
      requestArguments.chars !== undefined ||
      requestArguments.closeStdin === true ||
      requestArguments.columns !== undefined ||
      requestArguments.rows !== undefined
    );
    if (
      requestArguments.operationId === undefined &&
      (new Set([
        "exec_command", "apply_patch", "close_workspace", "revoke_workspace", "show_changes",
      ]).has(request.name) || mutatingWriteStdin)
    ) {
      operationSequence += 1;
      requestArguments.operationId = `${name}-auto-${operationSequence}`;
    }
    callArgs[0] = {
      ...request,
      _meta: {
        ...(request._meta ?? {}),
        "openai/subject": `subject-${accessToken}`,
        "openai/session": name,
      },
      arguments: requestArguments,
    };
    return originalCallTool(...callArgs);
  }) as Client["callTool"];
  return client;
}

function rawMcpPost(origin: URL, accessToken: string, sessionId: string): Promise<Response> {
  return fetch(new URL("/mcp", origin), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
  });
}

async function abortStatelessToolCallAfterLease(options: {
  origin: URL;
  accessToken: string;
  ownerToken: string | Uint8Array;
  requestId: number;
  body: Record<string, unknown>;
}): Promise<void> {
  await waitForStatelessRequestCount(options.origin, options.ownerToken, 0);
  const controller = new AbortController();
  const request = fetch(new URL("/mcp", options.origin), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${options.accessToken}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify(options.body),
    signal: controller.signal,
  });

  await waitForStatelessRequestCount(options.origin, options.ownerToken, 1);
  controller.abort();
  const abortError = await request.then(
    async (response) => {
      try {
        await response.text();
        return undefined;
      } catch (error) {
        return error;
      }
    },
    (error: unknown) => error,
  );
  assert.equal(
    abortError instanceof Error ? abortError.name : undefined,
    "AbortError",
    `request ${options.requestId} must observe the client abort`,
  );
  await waitForStatelessRequestCount(options.origin, options.ownerToken, 0);
}

async function waitForStatelessRequestCount(
  origin: URL,
  ownerToken: string | Uint8Array,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const response = await fetch(new URL("/internal/diagnostics", origin), {
      headers: { "x-devspace-internal-token": internalDiagnosticsToken(ownerToken) },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      usage?: { mcpSessions?: { statelessRequests?: unknown } };
    };
    if (body.usage?.mcpSessions?.statelessRequests === expected) return;
    await delay(10);
  }
  assert.fail(`stateless request count did not reach ${expected}`);
}

function seedClient(
  accessToken: string,
  redirectUri: string,
  name: string,
  targetStateDir: string,
  targetConfig: ReturnType<typeof loadConfig>,
): void {
  const store = new SqliteOAuthStore(targetStateDir);
  try {
    const clientsStore = new SqliteOAuthClientsStore(
      store,
      targetConfig.oauth.allowedRedirectHosts,
    );
    const client = clientsStore.registerClient({
      redirect_uris: [redirectUri],
      client_name: name,
    });
    store.ensurePrincipalForClient(client.client_id);
    const resource = new URL("/mcp", publicBaseUrl).href;
    const expiresAt = Math.floor(Date.now() / 1_000) + 3_600;
    store.saveTokenPair({
      accessTokenHash: hashToken(accessToken),
      accessToken: { clientId: client.client_id, scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES], expiresAt, resource },
      refreshTokenHash: hashToken(`${accessToken}-refresh`),
      refreshToken: { clientId: client.client_id, scopes: [...DEFAULT_DEVSPACE_OAUTH_SCOPES], expiresAt, resource },
    });
  } finally {
    store.close();
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
