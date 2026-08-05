import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { authorizationRootId } from "./authorization-roots.js";
import { AuditEventStore, type AuditEventQuery } from "./audit-events.js";
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
    (subjectSelection._meta as {
      thread?: { threadRef?: unknown };
    } | undefined)?.thread?.threadRef ?? "",
  );
  assert.match(subjectThreadRef, /^pth1_/u);

  const subjectCommand = await first.callTool({
    name: "exec_command",
    arguments: {
      operationId: "subject-command-checkpoint",
      program: process.execPath,
      args: ["-e", "console.log('subject-command-ok')"],
    },
    _meta: subjectMeta,
  });
  assertSucceeded(subjectCommand);
  const subjectToolCall = queryAudit({ event: "tool_call", tool: "exec_command" })[0];
  assert.equal(subjectToolCall?.details.commandMode, "program");
  assert.equal(subjectToolCall?.details.outcome, "exited");
  assert.equal(subjectToolCall?.details.exitCode, 0);
  assert.equal(subjectToolCall?.details.timedOut, false);
  assert.equal(typeof subjectToolCall?.details.durationMs, "number");
  const subjectTerminal = queryAudit({
    event: "command_execution_terminal",
    tool: "exec_command",
  })[0];
  assert.equal(subjectTerminal?.details.commandMode, "program");
  assert.equal(subjectTerminal?.details.outcome, "exited");
  assert.equal(subjectTerminal?.details.exitCode, 0);
  assert.equal(subjectTerminal?.details.timedOut, false);
  assert.equal(typeof subjectTerminal?.details.durationMs, "number");
  assert.equal("sessionId" in (subjectTerminal ?? {}), false);
  assert.equal("outputId" in (subjectTerminal ?? {}), false);
  assert.equal("operationId" in (subjectTerminal ?? {}), false);

  const asyncSubjectCommand = await first.callTool({
    name: "exec_command",
    arguments: {
      operationId: "subject-async-terminal-checkpoint",
      program: process.execPath,
      args: ["-e", "console.log('async-output'); setInterval(() => {}, 1000)"],
      timeoutMs: 1_300,
    },
    _meta: subjectMeta,
  });
  assertSucceeded(asyncSubjectCommand);
  assert.equal(
    (asyncSubjectCommand.structuredContent as { status?: unknown } | undefined)?.status,
    "running",
  );
  let asyncCheckpoint: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await first.callTool({
      name: "project_thread_control",
      arguments: { action: "status", threadRef: subjectThreadRef },
      _meta: subjectMeta,
    });
    assertSucceeded(status);
    const checkpoint = (status.structuredContent as {
      thread?: { checkpoint?: { observedState?: Record<string, unknown> } };
    } | undefined)?.thread?.checkpoint?.observedState;
    if (checkpoint?.outcome === "timed_out") {
      asyncCheckpoint = checkpoint;
      break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.equal(asyncCheckpoint?.commandMode, "program");
  assert.equal(asyncCheckpoint?.workingDirectory, ".");
  assert.equal(asyncCheckpoint?.outcome, "timed_out");
  assert.equal(asyncCheckpoint?.timedOut, true);
  assert.equal(typeof asyncCheckpoint?.wallTimeMs, "number");
  assert.equal(asyncCheckpoint?.outputRetained, true);
  assert.equal(asyncCheckpoint?.outputPartiallyLost, false);
  assert.equal(asyncCheckpoint?.outputUnavailable, false);
  const resumedTransport = await connect(active.origin, "subject-async-resume");
  const resumedAfterAsyncTerminal = await resumedTransport.callTool({
    name: "project_control",
    arguments: { action: "hydrate" },
    _meta: subjectMeta,
  });
  assertSucceeded(resumedAfterAsyncTerminal);
  const resumedObservedState = (resumedAfterAsyncTerminal.structuredContent as {
    checkpoint?: { serverObserved?: Record<string, unknown> };
  } | undefined)?.checkpoint?.serverObserved;
  assert.equal(resumedObservedState?.outcome, "timed_out");
  assert.equal(resumedObservedState?.timedOut, true);
  assert.equal(resumedObservedState?.outputRetained, true);
  assert.doesNotMatch(
    JSON.stringify(resumedObservedState),
    /sessionId|outputId|eventKey|itemId|threadId|profileId/u,
  );

  const spawnCanary = "devspace-e2e-spawn-canary-2c81b7";
  const capturedConsole: string[] = [];
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  config.logging.level = "info";
  console.log = (...values: unknown[]) => capturedConsole.push(values.join(" "));
  console.warn = (...values: unknown[]) => capturedConsole.push(values.join(" "));
  console.error = (...values: unknown[]) => capturedConsole.push(values.join(" "));
  let spawnFailure: Awaited<ReturnType<Client["callTool"]>>;
  try {
    spawnFailure = await first.callTool({
      name: "exec_command",
      arguments: {
        operationId: "subject-command-spawn-failure",
        program: spawnCanary,
        args: ["--canary-secret-argument"],
      },
      _meta: subjectMeta,
    });
  } finally {
    config.logging.level = "silent";
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  }
  assert.equal(spawnFailure.isError, true);
  const spawnStructured = spawnFailure.structuredContent as {
    status?: unknown;
    commandExecuted?: unknown;
    error?: { code?: unknown; operationId?: unknown; phase?: unknown; effectsKnown?: unknown };
    operation?: { phase?: unknown; effectsKnown?: unknown };
  } | undefined;
  assert.equal(spawnStructured?.status, "exited");
  assert.equal(spawnStructured?.commandExecuted, false);
  assert.equal(spawnStructured?.error?.code, "command_spawn_failed");
  assert.equal(spawnStructured?.error?.operationId, "subject-command-spawn-failure");
  assert.equal(spawnStructured?.error?.phase, "not_started");
  assert.equal(spawnStructured?.error?.effectsKnown, true);
  assert.equal(spawnStructured?.operation, undefined);
  const spawnToolCall = queryAudit({ event: "tool_call", tool: "exec_command" })[0];
  assert.equal(spawnToolCall?.errorCode, "ENOENT");
  assert.equal(spawnToolCall?.errorCategory, "process_spawn");
  assert.equal(spawnToolCall?.details.success, false);
  assert.equal(spawnToolCall?.details.phase, "spawn");
  assert.equal(spawnToolCall?.details.outcome, "spawn_failed");
  const spawnTerminal = queryAudit({
    event: "command_execution_terminal",
    tool: "exec_command",
  })[0];
  assert.equal(spawnTerminal?.errorCode, "ENOENT");
  assert.equal(spawnTerminal?.errorCategory, "process_spawn");
  assert.equal(spawnTerminal?.details.success, false);
  assert.equal(spawnTerminal?.details.phase, "spawn");
  assert.equal(spawnTerminal?.details.outcome, "spawn_failed");
  assert.equal(
    queryAudit({ event: "command_execution_terminal", tool: "exec_command" })
      .filter((entry) => entry.errorCode === "ENOENT").length,
    1,
  );
  assert.doesNotMatch(JSON.stringify(queryAudit({ limit: 1_000 })), /2c81b7|canary-secret-argument/u);
  assert.doesNotMatch(capturedConsole.join("\n"), /2c81b7|canary-secret-argument/u);
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
  assertErrorCode(await newConversation.callTool({
    name: "read_files",
    arguments: {
      executionRef: "pex1_caller-supplied-override-must-be-ignored",
      files: [{ path: "payload.txt" }],
    },
    _meta: parallelMeta,
  }), "invalid_tool_input");
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
  assertErrorCode(missingSource, "diff_fields_invalid");
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
  const invalidHistoryCursor = await reconnected.callTool({
    name: "show_changes",
    arguments: { cursor: "not-a-signed-diff-cursor" },
    _meta: mainMeta,
  });
  assertDiffRestart(invalidHistoryCursor, "invalid_diff_cursor");
  assertSucceeded(await reconnected.callTool({
    name: "show_changes",
    arguments: { source: "apply_patch_history" },
    _meta: mainMeta,
  }));
  const firstHistory = await reconnected.callTool({
    name: "show_changes",
    arguments: { source: "apply_patch_history" },
    _meta: mainMeta,
  });
  assertSucceeded(firstHistory);
  assert.equal(
    ((firstHistory._meta as { card?: { changeSource?: unknown } } | undefined)?.card)
      ?.changeSource,
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
  const repeatedSourceContinuation = await reconnected.callTool({
    name: "show_changes",
    arguments: { source: "repository", cursor: historyCursor },
    _meta: mainMeta,
  });
  assertErrorCode(repeatedSourceContinuation, "diff_fields_invalid");
  assertSucceeded(await reconnected.callTool({
    name: "show_changes",
    arguments: { cursor: historyCursor },
    _meta: mainMeta,
  }));

  const staleHistoryCursor = await newConversation.callTool({
    name: "show_changes",
    arguments: { cursor: historyCursor },
    _meta: parallelMeta,
  });
  assertDiffRestart(staleHistoryCursor, "diff_cursor_stale", "apply_patch_history");
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

function assertDiffRestart(
  result: Awaited<ReturnType<Client["callTool"]>>,
  code: string,
  source?: "repository" | "apply_patch_history",
): void {
  assertErrorCode(result, code);
  const error = (result.structuredContent as {
    error?: {
      recovery?: unknown;
      source?: unknown;
      requiresSource?: unknown;
      omitCursor?: unknown;
    };
  } | undefined)?.error;
  assert.equal(error?.recovery, "restart_diff_paging_with_source");
  assert.equal(error?.omitCursor, true);
  if (source) {
    assert.equal(error?.source, source);
    assert.match(toolText(result), new RegExp(`source=${source}`, "u"));
  } else {
    assert.equal(error?.requiresSource, true);
    assert.match(toolText(result), /explicit source and no cursor/u);
  }
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

function queryAudit(query: AuditEventQuery) {
  const store = new AuditEventStore(stateDir);
  try {
    return store.query(query);
  } finally {
    store.close();
  }
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
