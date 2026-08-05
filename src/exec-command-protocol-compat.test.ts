import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { authorizationRootId } from "./authorization-roots.js";
import { loadConfig } from "./config.js";
import { FULL_DEVSPACE_OAUTH_SCOPES } from "./oauth-scopes.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";
import { createServer } from "./server.js";

const execFileAsync = promisify(execFile);
const fixtureRoot = await mkdtemp(join(tmpdir(), "devspace-exec-protocol-"));
const workspaceRoot = join(fixtureRoot, "workspace");
const nestedRoot = join(workspaceRoot, "nested");
const stateDir = join(fixtureRoot, "state");
const accessToken = "exec-protocol-compat-access-token";
const publicBaseUrl = "http://127.0.0.1:7777";
const mainHostMeta = {
  "openai/subject": "exec-protocol-subject",
  "openai/session": "exec-protocol-main-session",
};
const otherHostMeta = {
  "openai/subject": "exec-protocol-subject",
  "openai/session": "exec-protocol-other-session",
};
const replacementHostMeta = {
  "openai/subject": "exec-protocol-replacement-subject",
  "openai/session": "exec-protocol-replacement-session",
};
await mkdir(nestedRoot, { recursive: true });
await writeFile(join(nestedRoot, "fixture.txt"), "fixture\n");
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
  DEVSPACE_CONFIG_DIR: join(fixtureRoot, "config"),
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
  DEVSPACE_ALLOWED_HOSTS: "*",
  DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
  DEVSPACE_OAUTH_OWNER_TOKEN: "exec-protocol-owner-token-long-enough",
  DEVSPACE_SKILLS: "0",
  DEVSPACE_WIDGETS: "off",
  DEVSPACE_LOG_LEVEL: "warn",
  DEVSPACE_LOG_FORMAT: "json",
  DEVSPACE_MCP_HTTP_TRANSPORT: "stateless",
  DEVSPACE_OAUTH_SCOPES: FULL_DEVSPACE_OAUTH_SCOPES.join(","),
});
const oauthClientId = seedClient();

const running = createServer(config);
const httpServer = createHttpServer(running.app);
try {
  const origin = await listen(httpServer);
  const toolsPayload = await rawRequest(origin, 1, "tools/list", {});
  const tools = resultOf(toolsPayload).tools as Array<{
    name?: unknown;
    description?: unknown;
    inputSchema?: {
      required?: unknown;
      properties?: Record<string, unknown>;
    };
  }>;
  const toolsByName = new Map(tools.map((tool) => [String(tool.name), tool]));
  const execTool = toolsByName.get("exec_command");
  const writeStdinTool = toolsByName.get("write_stdin");
  const readProcessOutputTool = toolsByName.get("read_process_output");
  assert.ok(execTool);
  assert.ok(writeStdinTool);
  assert.ok(readProcessOutputTool);
  assert.match(String(execTool.description), /read_process_output/u);
  assert.match(String(execTool.description), /unmanaged background or detach wrappers/u);
  assert.deepEqual(execTool.inputSchema?.required, ["operationId"]);
  assert.deepEqual(
    writeStdinTool.inputSchema?.required,
    ["operationId", "sessionId"],
  );
  assert.equal(writeStdinTool.inputSchema?.properties?.executionRef, undefined);
  assert.equal(readProcessOutputTool.inputSchema?.properties?.executionRef, undefined);
  for (const name of ["poll_process", "write_process_input"]) {
    assert.equal(toolsByName.has(name), false);
  }
  for (const removed of [
    "executionRef", "invocation", "cmd", "workdir", "env", "close_stdin",
    "yield_time_ms", "timeout_ms", "max_output_tokens", "network",
  ]) {
    assert.equal(execTool.inputSchema?.properties?.[removed], undefined, removed);
  }
  for (const current of [
    "program", "args", "shell", "command", "workingDirectory", "stdin",
    "closeStdin", "tty", "environment", "timeoutMs",
  ]) {
    assert.ok(execTool.inputSchema?.properties?.[current], current);
  }

  const opened = resultOf(await rawToolCall(origin, 2, "project_control", {
    action: "open",
    operationId: "exec-protocol-execution",
  }));
  assert.notEqual(opened.isError, true, JSON.stringify(opened));
  assert.doesNotMatch(JSON.stringify(opened.structuredContent), /executionRef/u);

  const marker = join(nestedRoot, "codex-exec.txt");
  const executed = resultOf(await rawToolCall(origin, 3, "exec_command", {
    operationId: "codex-exec",
    shell: true,
    command: "printf '%s' \"$CODEX_TEST_VALUE\" > codex-exec.txt",
    workingDirectory: "nested",
    environment: { CODEX_TEST_VALUE: "codex-style" },
    timeoutMs: 5_000,
  }));
  assert.notEqual(executed.isError, true, JSON.stringify(executed));
  assert.equal(await readFile(marker, "utf8"), "codex-style");
  const sharedRead = resultOf(await rawToolCall(origin, 30, "read_files", {
    files: [{ path: "nested/codex-exec.txt" }],
  }));
  assert.notEqual(sharedRead.isError, true, JSON.stringify(sharedRead));
  assert.match(JSON.stringify(sharedRead.structuredContent), /codex-style/u);

  const replay = resultOf(await rawToolCall(origin, 4, "exec_command", {
    operationId: "codex-exec",
    shell: true,
    command: "printf '%s' \"$CODEX_TEST_VALUE\" > codex-exec.txt",
    workingDirectory: "nested",
    environment: { CODEX_TEST_VALUE: "codex-style" },
    timeoutMs: 5_000,
  }));
  assert.notEqual(replay.isError, true, JSON.stringify(replay));

  const conflictingReplay = resultOf(await rawToolCall(origin, 31, "exec_command", {
    operationId: "codex-exec",
    shell: true,
    command: "printf changed > codex-exec.txt",
    workingDirectory: "nested",
    environment: { CODEX_TEST_VALUE: "codex-style" },
    timeoutMs: 5_000,
  }));
  assert.equal(conflictingReplay.isError, true);
  assert.equal(
    (conflictingReplay.structuredContent as {
      error?: { code?: unknown };
    } | undefined)?.error?.code,
    "operation_id_conflict",
  );
  assert.equal(await readFile(marker, "utf8"), "codex-style");

  const formerlyProtected = join(fixtureRoot, "shell-policy-removed.txt");
  const outsideWrite = resultOf(await rawToolCall(origin, 5, "exec_command", {
    operationId: "outside-write",
    shell: true,
    command: `printf policy-removed > ${shellQuote(formerlyProtected)}`,
  }));
  assert.notEqual(outsideWrite.isError, true, JSON.stringify(outsideWrite));
  assert.equal(await readFile(formerlyProtected, "utf8"), "policy-removed");

  const interactive = resultOf(await rawToolCall(origin, 6, "exec_command", {
    operationId: "interactive",
    shell: true,
    command: "while IFS= read -r line; do printf 'seen:%s\\n' \"$line\"; [ \"$line\" = quit ] && break; done",
    closeStdin: false,
  }));
  assert.notEqual(interactive.isError, true, JSON.stringify(interactive));
  const sessionId = Number(
    (interactive.structuredContent as { sessionId?: unknown } | undefined)?.sessionId,
  );
  assert.ok(Number.isSafeInteger(sessionId) && sessionId > 0);

  const firstWrite = resultOf(await rawToolCall(origin, 7, "write_stdin", {
    operationId: "stdin-1",
    sessionId,
    chars: "hello\n",
    expectedRevision: 0,
  }));
  assert.notEqual(firstWrite.isError, true, JSON.stringify(firstWrite));
  assert.match(
    String(
      (firstWrite.structuredContent as {
        output?: { text?: unknown };
      } | undefined)?.output?.text ?? "",
    ),
    /seen:hello/u,
  );

  const staleWrite = resultOf(await rawToolCall(origin, 8, "write_stdin", {
    operationId: "stdin-stale",
    sessionId,
    chars: "quit\n",
    closeStdin: true,
    expectedRevision: 0,
  }));
  assert.equal(staleWrite.isError, true);
  assert.equal(
    (staleWrite.structuredContent as {
      error?: { code?: unknown };
    } | undefined)?.error?.code,
    "process_revision_conflict",
  );
  const staleStructured = staleWrite.structuredContent as {
    error?: {
      operationId?: unknown;
      safeToRetry?: unknown;
      phase?: unknown;
      effectsKnown?: unknown;
    };
    operation?: {
      id?: unknown;
      safeToRetry?: unknown;
      phase?: unknown;
      effectsKnown?: unknown;
    };
  } | undefined;
  assert.deepEqual(staleStructured?.error, {
    code: "process_revision_conflict",
    operationId: "stdin-stale",
    safeToRetry: true,
    recovery: "read_process_output",
    phase: "not_started",
    effectsKnown: true,
  });
  assert.equal(staleStructured?.operation, undefined);
  const currentProcess = resultOf(await rawToolCall(origin, 80, "read_process_output", {
    sessionId,
  }));
  assert.notEqual(currentProcess.isError, true, JSON.stringify(currentProcess));
  const currentRevision = Number(
    (currentProcess.structuredContent as { inputRevision?: unknown } | undefined)?.inputRevision,
  );
  assert.equal(currentRevision, 1);

  const finalWrite = resultOf(await rawToolCall(origin, 9, "write_stdin", {
    operationId: "stdin-stale",
    sessionId,
    chars: "quit\n",
    closeStdin: true,
    expectedRevision: currentRevision,
  }));
  assert.notEqual(finalWrite.isError, true, JSON.stringify(finalWrite));
  assert.match(
    String(
      (finalWrite.structuredContent as {
        output?: { text?: unknown };
      } | undefined)?.output?.text ?? "",
    ),
    /seen:quit/u,
  );

  const polling = resultOf(await rawToolCall(origin, 10, "exec_command", {
    operationId: "polling",
    program: process.execPath,
    args: ["-e", "setTimeout(() => process.stdout.write('done' + 'x'.repeat(50000)), 1500)"],
  }));
  assert.notEqual(polling.isError, true, JSON.stringify(polling));
  const pollingSessionId = Number(
    (polling.structuredContent as { sessionId?: unknown } | undefined)?.sessionId,
  );
  assert.ok(Number.isSafeInteger(pollingSessionId) && pollingSessionId > 0);
  const emptyInteraction = resultOf(await rawToolCall(origin, 11, "write_stdin", {
    operationId: "poll-empty",
    sessionId: pollingSessionId,
    chars: "",
  }));
  assert.equal(emptyInteraction.isError, true);
  assert.equal(
    (emptyInteraction.structuredContent as {
      error?: { code?: unknown };
    } | undefined)?.error?.code,
    "process_interaction_required",
  );
  const polled = resultOf(await rawToolCall(origin, 12, "read_process_output", {
    sessionId: pollingSessionId,
  }));
  assert.notEqual(polled.isError, true, JSON.stringify(polled));
  assert.equal(
    (polled.structuredContent as {
      provenance?: { source?: unknown };
    } | undefined)?.provenance?.source,
    "process",
  );
  assert.match(
    String(
      (polled.structuredContent as {
        output?: { text?: unknown };
      } | undefined)?.output?.text ?? "",
    ),
    /done/u,
  );
  const pollingOutputId = String(
    (polled.structuredContent as { outputId?: unknown } | undefined)?.outputId ?? "",
  );
  assert.ok(pollingOutputId);
  const polledSerialized = JSON.stringify(polled.structuredContent);
  assert.doesNotMatch(
    polledSerialized,
    /commandExecuted|terminationCoverage|originalTokenCount|stream|"ok"\s*:/u,
  );
  assert.equal(
    (polled.structuredContent as {
      output?: { outputId?: unknown; provenance?: unknown };
    } | undefined)?.output?.outputId,
    undefined,
  );
  assert.equal(
    (polled.structuredContent as {
      output?: { provenance?: unknown };
    } | undefined)?.output?.provenance,
    undefined,
  );
  const retainedSearch = resultOf(await rawToolCall(origin, 199, "read_process_output", {
    outputId: pollingOutputId,
    mode: "search",
    query: "done",
  }));
  assert.notEqual(retainedSearch.isError, true, JSON.stringify(retainedSearch));
  assert.deepEqual(
    Object.keys((retainedSearch.structuredContent ?? {}) as Record<string, unknown>).sort(),
    ["provenance", "search", "status"],
  );
  assert.deepEqual(
    Object.keys(((retainedSearch.structuredContent as {
      search?: Record<string, unknown>;
    } | undefined)?.search) ?? {}).sort(),
    ["matches"],
  );
  const retainedFirstPage = resultOf(await rawToolCall(
    origin,
    13,
    "read_process_output",
    { outputId: pollingOutputId, mode: "page" },
  ));
  const retainedCursor = String(
    (retainedFirstPage.structuredContent as {
      nextCursor?: unknown;
    } | undefined)?.nextCursor ?? "",
  );
  assert.ok(retainedCursor);
  const otherExecutionSelected = resultOf(await rawToolCall(
    origin,
    14,
    "project_control",
    { action: "open", operationId: "exec-protocol-other-execution" },
    { hostMeta: otherHostMeta },
  ));
  assert.notEqual(
    otherExecutionSelected.isError,
    true,
    JSON.stringify(otherExecutionSelected),
  );
  const otherExecutionCursor = resultOf(await rawToolCall(
    origin,
    15,
    "read_process_output",
    { cursor: retainedCursor },
    { hostMeta: otherHostMeta },
  ));
  assert.equal(otherExecutionCursor.isError, true);
  assert.equal(
    (otherExecutionCursor.structuredContent as {
      error?: { code?: unknown };
    } | undefined)?.error?.code,
    "process_cursor_stale",
  );
  const repeatedCursorIdentity = resultOf(await rawToolCall(
    origin,
    16,
    "read_process_output",
    { cursor: retainedCursor, outputId: pollingOutputId },
  ));
  assert.equal(repeatedCursorIdentity.isError, true);
  assert.equal(
    (repeatedCursorIdentity.structuredContent as {
      error?: { code?: unknown };
    } | undefined)?.error?.code,
    "process_cursor_fields_invalid",
  );
  const retainedSecondPage = resultOf(await rawToolCall(
    origin,
    17,
    "read_process_output",
    { cursor: retainedCursor },
  ));
  assert.notEqual(retainedSecondPage.isError, true, JSON.stringify(retainedSecondPage));
  assert.match(
    String(
      (retainedSecondPage.structuredContent as {
        output?: { text?: unknown };
      } | undefined)?.output?.text ?? "",
    ),
    /x/u,
  );

  const escapedWorkdir = resultOf(await rawToolCall(origin, 18, "exec_command", {
    operationId: "escaped-workdir",
    program: "pwd",
    args: [],
    workingDirectory: "..",
  }));
  assert.equal(escapedWorkdir.isError, true);

  const legacyMarker = join(workspaceRoot, "legacy-must-not-exist.txt");
  const legacy = resultOf(await rawToolCall(origin, 19, "exec_command", {
    operationId: "legacy-rejected",
    invocation: {
      mode: "direct",
      program: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(legacyMarker)}, "bad")`],
    },
  }));
  assertInvalidInput(legacy);
  await assertMissing(legacyMarker);

  const networkOption = resultOf(await rawToolCall(origin, 20, "exec_command", {
    operationId: "network-option-removed",
    program: "true",
    args: [],
    network: "inherit",
  }));
  assertInvalidInput(networkOption);

  for (const [id, field, value] of [
    [171, "approvalReason", "removed"],
    [172, "columns", 100],
    [173, "rows", 40],
    [174, "yieldTimeMs", 0],
    [175, "maxOutputTokens", 100],
  ] as const) {
    assertInvalidInput(resultOf(await rawToolCall(origin, id, "exec_command", {
      operationId: `removed-exec-${field}`,
      program: "true",
      args: [],
      [field]: value,
    })));
  }
  for (const [id, tool, args] of [
    [176, "write_stdin", { operationId: "removed-columns", sessionId: 1, columns: 80 }],
    [177, "write_stdin", { operationId: "removed-rows", sessionId: 1, rows: 24 }],
    [178, "write_stdin", { operationId: "removed-yield", sessionId: 1, yieldTimeMs: 0 }],
    [179, "read_process_output", { sessionId: 1, yieldTimeMs: 0 }],
    [180, "read_process_output", { outputId: "x", limit: 1 }],
    [191, "read_process_output", { outputId: "x", tailBytes: 1 }],
    [192, "read_process_output", { outputId: "x", scanBytes: 1 }],
    [193, "read_process_output", { outputId: "x", maxMatches: 1 }],
    [194, "read_process_output", { outputId: "x", maxOutputTokens: 1 }],
  ] as const) {
    assertInvalidInput(resultOf(await rawToolCall(origin, id, tool, args)));
  }

  for (const [id, args] of [
    [181, { action: "search", query: "testing" }],
    [182, { name: "testing" }],
    [183, { cursor: "" }],
    [184, { skillId: "skill_invalid" }],
    [186, { query: "testing", unexpected: true }],
  ] as const) {
    assertInvalidInput(resultOf(await rawToolCall(origin, id, "skills", args)));
  }
  const mixedSkillFields = resultOf(await rawToolCall(origin, 185, "skills", {
    cursor: "not-a-signed-cursor",
    query: "testing",
  }));
  assert.equal(mixedSkillFields.isError, true);
  assert.equal(
    (mixedSkillFields.structuredContent as { error?: { code?: unknown } } | undefined)
      ?.error?.code,
    "skill_cursor_fields_invalid",
  );

  for (const [id, tool, args] of [
    [187, "read_files", { files: [{ path: "complete", ref: "legacy" }] }],
    [188, "read_files", { files: [{ path: "complete", unexpected: true }] }],
    [189, "inspect", { operations: [{ operation: "ls", ref: "legacy" }] }],
    [190, "inspect", { operations: [{ operation: "glob", pattern: "*", unexpected: true }] }],
  ] as const) {
    assertInvalidInput(resultOf(await rawToolCall(origin, id, tool, args)));
  }

  assertInvalidInput(resultOf(await rawToolCall(origin, 195, "show_changes", {
    cursor: "",
  })));
  assertInvalidInput(resultOf(await rawToolCall(origin, 196, "show_changes", {
    source: "repository",
    unexpected: true,
  })));
  for (const [id, args] of [
    [197, {}],
    [198, { source: "repository", cursor: "not-a-signed-cursor" }],
  ] as const) {
    const invalidFields = resultOf(await rawToolCall(origin, id, "show_changes", args));
    assert.equal(invalidFields.isError, true);
    assert.equal(
      (invalidFields.structuredContent as {
        error?: { code?: unknown };
      } | undefined)?.error?.code,
      "diff_fields_invalid",
    );
  }

  const oversizedInput = "x".repeat(1024 * 1024 + 1);
  const oversized = resultOf(await rawToolCall(origin, 21, "exec_command", {
    operationId: "oversized-stdin",
    program: "cat",
    args: [],
    stdin: oversizedInput,
  }));
  assertInvalidInput(oversized);

  const replacementAccessToken = "exec-protocol-replacement-access-token";
  seedReplacementAccessToken(oauthClientId, replacementAccessToken);
  const replacementSelected = resultOf(await rawToolCall(
    origin,
    22,
    "project_control",
    { action: "open", operationId: "exec-protocol-replacement-execution" },
    { accessToken: replacementAccessToken, hostMeta: replacementHostMeta },
  ));
  assert.notEqual(replacementSelected.isError, true, JSON.stringify(replacementSelected));
  const replacementGrantCursor = resultOf(await rawToolCall(
    origin,
    23,
    "read_process_output",
    { cursor: retainedCursor },
    { accessToken: replacementAccessToken, hostMeta: replacementHostMeta },
  ));
  assert.equal(replacementGrantCursor.isError, true);
  assert.equal(
    (replacementGrantCursor.structuredContent as {
      error?: { code?: unknown };
    } | undefined)?.error?.code,
    "process_cursor_stale",
  );

  await writeFile(join(workspaceRoot, "complete"), "done");
} finally {
  await closeHttpServer(httpServer);
  await running.close();
  await rm(fixtureRoot, { recursive: true, force: true });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertInvalidInput(result: Record<string, unknown>): void {
  assert.equal(result.isError, true);
  assert.equal(
    (result.structuredContent as {
      error?: { code?: unknown };
    } | undefined)?.error?.code,
    "invalid_tool_input",
  );
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(access(path), (error: unknown) => (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  ));
}

async function rawToolCall(
  origin: URL,
  id: number,
  name: string,
  args: Record<string, unknown>,
  options: {
    accessToken?: string;
    hostMeta?: Readonly<Record<string, string>>;
  } = {},
): Promise<JsonRpcResponse> {
  return rawRequest(origin, id, "tools/call", {
    name,
    arguments: args,
    _meta: options.hostMeta ?? mainHostMeta,
  }, options.accessToken);
}

async function rawRequest(
  origin: URL,
  id: number,
  method: string,
  params: Record<string, unknown>,
  bearerToken = accessToken,
): Promise<JsonRpcResponse> {
  const response = await fetch(new URL("/mcp", origin), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearerToken}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const data = text
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length))
      .at(-1);
    assert.ok(data);
    return JSON.parse(data) as JsonRpcResponse;
  }
  return JSON.parse(text) as JsonRpcResponse;
}

interface JsonRpcResponse {
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

function resultOf(payload: JsonRpcResponse): Record<string, unknown> {
  assert.equal(payload.error, undefined);
  assert.ok(payload.result);
  return payload.result;
}

function seedClient(): string {
  const store = new SqliteOAuthStore(stateDir);
  try {
    const clientsStore = new SqliteOAuthClientsStore(
      store,
      config.oauth.allowedRedirectHosts,
    );
    const client = clientsStore.registerClient({
      redirect_uris: ["https://chatgpt.com/connector/oauth/exec-protocol"],
      client_name: "exec protocol compatibility",
    });
    const grant = store.createAuthorizationGrant({
      clientId: client.client_id,
      scopes: [...FULL_DEVSPACE_OAUTH_SCOPES],
      allowedRootIds: [
        authorizationRootId(workspaceRoot, config.oauth.keys.authorizationRoot),
      ],
    });
    const resource = new URL("/mcp", publicBaseUrl).href;
    const expiresAt = Math.floor(Date.now() / 1_000) + 3_600;
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
    return client.client_id;
  } finally {
    store.close();
  }
}

function seedReplacementAccessToken(clientId: string, token: string): void {
  const store = new SqliteOAuthStore(stateDir);
  try {
    const grant = store.createAuthorizationGrant({
      clientId,
      scopes: [...FULL_DEVSPACE_OAUTH_SCOPES],
      allowedRootIds: [
        authorizationRootId(workspaceRoot, config.oauth.keys.authorizationRoot),
      ],
    });
    const resource = new URL("/mcp", publicBaseUrl).href;
    const expiresAt = Math.floor(Date.now() / 1_000) + 3_600;
    store.saveTokenPair({
      accessTokenHash: hashToken(token),
      accessToken: {
        grantId: grant.grantId,
        clientId,
        principalId: grant.principalId,
        authorizationEpoch: grant.authorizationEpoch,
        scopes: [...grant.grantedScopes],
        expiresAt,
        resource,
      },
      refreshTokenHash: hashToken(`${token}-refresh`),
      refreshToken: {
        grantId: grant.grantId,
        clientId,
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

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

async function listen(server: HttpServer): Promise<URL> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return new URL(`http://127.0.0.1:${address.port}`);
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
