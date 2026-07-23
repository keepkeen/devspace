import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import { connectionRef, workspaceActivityRef } from "./logger.js";
import { createServer } from "./server.js";

// This is a server-side simulation of ChatGPT's OAuth/MCP protocol behavior.
// Whether the web model retains workspaceId in its conversation context still
// requires a real ChatGPT acceptance test.
const root = await mkdtemp(join(tmpdir(), "devspace-chatgpt-flow-e2e-"));
const workspaceRoot = join(root, "workspace");
const publicBaseUrl = "https://devspace.chatgpt-flow.test";
const resource = `${publicBaseUrl}/mcp`;
const ownerPassword = "chatgpt-flow-e2e-owner-password-long-enough";
const clients = new Set<Client>();
const trackedWorkspaceGenerations = new Map<string, number>();
let active: Awaited<ReturnType<typeof startServer>> | undefined;
const capturedLogs: string[] = [];
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};
const captureLog = (...values: unknown[]): void => {
  capturedLogs.push(values.map(String).join(" "));
};
console.log = captureLog;
console.warn = captureLog;
console.error = captureLog;

try {
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, "payload.txt"), "chatgpt-flow-ready\n");

  const mainConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, "config"),
    DEVSPACE_STATE_DIR: join(root, "state"),
    DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
    DEVSPACE_ALLOWED_HOSTS: "*",
    DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
    DEVSPACE_OAUTH_OWNER_TOKEN: ownerPassword,
    DEVSPACE_SKILLS: "0",
    DEVSPACE_SUBAGENTS: "0",
    DEVSPACE_WIDGETS: "off",
    DEVSPACE_LOG_LEVEL: "info",
    DEVSPACE_LOG_FORMAT: "json",
    DEVSPACE_MAX_MCP_SESSIONS: "8",
    DEVSPACE_MAX_MCP_SESSIONS_PER_CLIENT: "4",
    DEVSPACE_MAX_PROCESS_SESSIONS: "8",
    DEVSPACE_MAX_PROCESS_SESSIONS_PER_CLIENT: "4",
    DEVSPACE_MAX_PROCESS_SESSIONS_PER_WORKSPACE: "4",
    PORT: "1",
  });
  active = await startServer(mainConfig);

  const metadata = await discoverOAuth(active.origin);
  const [oauthA, oauthB] = await Promise.all([
    registerAndAuthorize(active.origin, metadata, "client-a"),
    registerAndAuthorize(active.origin, metadata, "client-b"),
  ]);
  assert.notEqual(oauthA.clientId, oauthB.clientId);
  const originalAccessTokenA = oauthA.accessToken;
  const originalRefreshTokenA = oauthA.refreshToken;
  const refreshedA = await refreshTokens(active.origin, oauthA);
  oauthA.accessToken = refreshedA.accessToken;
  oauthA.refreshToken = refreshedA.refreshToken;

  const firstRound = await connectClient("same-conversation-round-one", oauthA.accessToken, active.origin);
  const opened = await firstRound.callTool({
    name: "open_workspace",
    arguments: {
      path: workspaceRoot,
      alias: "primary",
      writeAccess: "read_write",
      contextMode: "full",
    },
  });
  assertToolSucceeded(opened);
  const workspaceA = workspaceId(opened);
  const generationA = Number(
    (opened.structuredContent as { workspaceGeneration?: unknown } | undefined)?.workspaceGeneration,
  );
  assert.ok(generationA > 0);
  const staleGenerationRead = await firstRound.callTool({
    name: "read",
    arguments: {
      workspaceId: workspaceA,
      workspaceGeneration: generationA + 1,
      path: "payload.txt",
    },
  });
  assertToolRejected(staleGenerationRead, /stale_workspace_generation/);

  const directArgv = await firstRound.callTool({
    name: "exec_command",
    arguments: {
      workspaceId: workspaceA,
      program: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1])", "literal * $HOME ; &&"],
    },
  });
  assertToolSucceeded(directArgv);
  assert.match(JSON.stringify(directArgv.content), /literal \* \$HOME ; &&/);
  const unavailableNetworkDeny = await firstRound.callTool({
    name: "exec_command",
    arguments: { workspaceId: workspaceA, program: "true", network: "deny" },
  });
  assertToolRejected(unavailableNetworkDeny, /network_control_unavailable/);

  for (let run = 0; run < 2; run += 1) {
    const executed = await firstRound.callTool({
      name: "exec_command",
      arguments: { workspaceId: workspaceA, cmd: "printf 'safe-run\\n' >> safe-runs.txt" },
    });
    assertToolSucceeded(executed);
    assert.match(JSON.stringify(executed.content), /Process exited \(code 0\)/);
  }
  const repeatedExecution = await firstRound.callTool({
    name: "read",
    arguments: { workspaceId: workspaceA, path: "safe-runs.txt" },
  });
  assertToolSucceeded(repeatedExecution);
  assert.match(JSON.stringify(repeatedExecution.content), /safe-run\\nsafe-run\\n/);

  assertToolSucceeded(await firstRound.callTool({
    name: "exec_command",
    arguments: { workspaceId: workspaceA, cmd: "printf 'one\\n' > optimistic.txt" },
  }));
  const optimisticRead = await firstRound.callTool({
    name: "read",
    arguments: { workspaceId: workspaceA, path: "optimistic.txt" },
  });
  const optimisticHash = String(
    (optimisticRead.structuredContent as { contentHash?: unknown } | undefined)?.contentHash ?? "",
  );
  assert.match(optimisticHash, /^sha256:[a-f0-9]{64}$/);
  const optimisticOperationId = "optimistic-update";
  const optimisticPatch = await firstRound.callTool({
    name: "apply_patch",
    arguments: {
      workspaceId: workspaceA,
      operationId: optimisticOperationId,
      ifMatch: { "optimistic.txt": optimisticHash },
      patch: "*** Begin Patch\n*** Update File: optimistic.txt\n@@\n-one\n+two\n*** End Patch",
    },
  });
  assertToolSucceeded(optimisticPatch);
  const operationStatus = await firstRound.callTool({
    name: "get_operation_status",
    arguments: { operationId: optimisticOperationId },
  });
  assert.deepEqual(operationStatus.structuredContent, {
    ok: true,
    state: "settled",
    tool: "apply_patch",
    workspaceGeneration: generationA,
    resultAvailable: true,
    safeToRetry: false,
  });
  const staleOptimisticPatch = await firstRound.callTool({
    name: "apply_patch",
    arguments: {
      workspaceId: workspaceA,
      operationId: "optimistic-stale",
      ifMatch: optimisticHash,
      patch: "*** Begin Patch\n*** Update File: optimistic.txt\n@@\n-two\n+three\n*** End Patch",
    },
  });
  assertToolRejected(staleOptimisticPatch, /file_version_conflict/);
  const staleOperationStatus = await firstRound.callTool({
    name: "get_operation_status",
    arguments: { operationId: "optimistic-stale" },
  });
  assert.equal(
    (staleOperationStatus.structuredContent as { state?: unknown } | undefined)?.state,
    "settled",
  );
  assert.equal(await readFile(join(workspaceRoot, "optimistic.txt"), "utf8"), "two\n");

  const idempotentArguments = {
    workspaceId: workspaceA,
    operationId: "append-once",
    cmd: "printf 'once\\n' >> idempotent.txt",
  };
  const firstIdempotent = await firstRound.callTool({
    name: "exec_command",
    arguments: idempotentArguments,
  });
  const replayedIdempotent = await firstRound.callTool({
    name: "exec_command",
    arguments: idempotentArguments,
  });
  assertToolSucceeded(firstIdempotent);
  assertToolSucceeded(replayedIdempotent);
  assert.equal(await readFile(join(workspaceRoot, "idempotent.txt"), "utf8"), "once\n");
  const patchArguments = {
    workspaceId: workspaceA,
    operationId: "patch-once",
    patch: "*** Begin Patch\n*** Add File: patch-once.txt\n+once\n*** End Patch",
  };
  const firstPatch = await firstRound.callTool({ name: "apply_patch", arguments: patchArguments });
  const replayedPatch = await firstRound.callTool({ name: "apply_patch", arguments: patchArguments });
  assertToolSucceeded(firstPatch);
  assertToolSucceeded(replayedPatch);
  assert.equal(await readFile(join(workspaceRoot, "patch-once.txt"), "utf8"), "once\n");

  const stdinProcess = await firstRound.callTool({
    name: "exec_command",
    arguments: {
      workspaceId: workspaceA,
      cmd: `${JSON.stringify(process.execPath)} -e "process.stdin.on('data', d => require('fs').appendFileSync('stdin-once.txt', d)); setTimeout(() => process.exit(0), 300)"`,
      yieldTimeMs: 0,
    },
  });
  assertToolSucceeded(stdinProcess);
  const stdinSessionId = processSessionId(stdinProcess);
  const stdinArguments = {
    workspaceId: workspaceA,
    sessionId: stdinSessionId,
    operationId: "stdin-once",
    chars: "once\n",
    yieldTimeMs: 0,
  };
  assertToolSucceeded(await firstRound.callTool({ name: "write_stdin", arguments: stdinArguments }));
  await firstRound.callTool({
    name: "write_stdin",
    arguments: { workspaceId: workspaceA, sessionId: stdinSessionId, yieldTimeMs: 1_000 },
  });
  const replayedStdinAfterExit = await firstRound.callTool({
    name: "write_stdin",
    arguments: stdinArguments,
  });
  assert.notEqual(
    replayedStdinAfterExit.isError,
    true,
    "a settled stdin mutation must replay after its process session has exited",
  );
  assert.equal(await readFile(join(workspaceRoot, "stdin-once.txt"), "utf8"), "once\n");
  const conflictingOperation = await firstRound.callTool({
    name: "exec_command",
    arguments: {
      workspaceId: workspaceA,
      operationId: "append-once",
      cmd: "printf 'twice\\n' >> idempotent.txt",
    },
  });
  assertToolRejected(conflictingOperation, /operation_id_conflict/);

  const nonzero = await firstRound.callTool({
    name: "exec_command",
    arguments: { workspaceId: workspaceA, cmd: "exit 7" },
  });
  assert.notEqual(nonzero.isError, true);
  assert.deepEqual(nonzero.structuredContent, {
    ok: false,
    status: "exited",
    commandExecuted: true,
    exitCode: 7,
  });

  const denied = await firstRound.callTool({
    name: "exec_command",
    arguments: {
      workspaceId: workspaceA,
      cmd: "sudo sh -c 'printf policy-bypass > denied-marker.txt'",
    },
  });
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied.content), /blocked by command policy/i);
  await assert.rejects(access(join(workspaceRoot, "denied-marker.txt")), { code: "ENOENT" });
  await closeClient(firstRound);

  const secondRound = await connectClient(
    "same-conversation-round-two",
    oauthA.accessToken,
    active.origin,
    "stale-chatgpt-browser-session",
  );
  const continuedRead = await secondRound.callTool({
    name: "read",
    arguments: { workspaceId: workspaceA, path: "payload.txt" },
  });
  assertToolSucceeded(continuedRead);
  assert.match(JSON.stringify(continuedRead.content), /chatgpt-flow-ready/);
  const continuedExec = await secondRound.callTool({
    name: "exec_command",
    arguments: { workspaceId: workspaceA, cmd: "printf 'round-two\\n' >> conversation.txt" },
  });
  assertToolSucceeded(continuedExec);
  await closeClient(secondRound);

  const newSession = await connectClient("same-account-new-session", oauthA.accessToken, active.origin);
  const listed = await newSession.callTool({ name: "list_workspaces", arguments: {} });
  assertToolSucceeded(listed);
  assert.doesNotMatch(JSON.stringify(listed.structuredContent), new RegExp(workspaceRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.match(JSON.stringify(listed.structuredContent), /primary/);
  const reopened = await newSession.callTool({
    name: "resume_workspace",
    arguments: { alias: "primary", contextMode: "full" },
  });
  assertToolSucceeded(reopened);
  assert.equal(workspaceId(reopened), workspaceA);
  assert.equal(
    (reopened.structuredContent as { reused?: unknown } | undefined)?.reused,
    true,
  );
  const newSessionRead = await newSession.callTool({
    name: "read",
    arguments: { workspaceId: workspaceA, path: "conversation.txt" },
  });
  assertToolSucceeded(newSessionRead);
  assert.match(JSON.stringify(newSessionRead.content), /round-two/);
  const newSessionExec = await newSession.callTool({
    name: "exec_command",
    arguments: { workspaceId: workspaceA, cmd: "printf 'new-session\\n' >> conversation.txt" },
  });
  assertToolSucceeded(newSessionExec);
  await closeClient(newSession);

  const [concurrentA, concurrentB] = await Promise.all([
    connectClient("concurrent-client-a", oauthA.accessToken, active.origin),
    connectClient("concurrent-client-b", oauthB.accessToken, active.origin),
  ]);
  const [concurrentOpenA, concurrentOpenB] = await Promise.all([
    concurrentA.callTool({
      name: "resume_workspace",
      arguments: { alias: "primary", contextMode: "full" },
    }),
    concurrentB.callTool({
      name: "open_workspace",
      arguments: {
        path: workspaceRoot,
        alias: "primary",
        writeAccess: "read_write",
        contextMode: "full",
      },
    }),
  ]);
  assertToolSucceeded(concurrentOpenA);
  assertToolSucceeded(concurrentOpenB);
  const concurrentWorkspaceA = workspaceId(concurrentOpenA);
  const workspaceB = workspaceId(concurrentOpenB);
  assert.equal(concurrentWorkspaceA, workspaceA);
  assert.notEqual(concurrentWorkspaceA, workspaceB);

  const [aReadsB, bReadsA] = await Promise.all([
    concurrentA.callTool({
      name: "read",
      arguments: { workspaceId: workspaceB, path: "payload.txt" },
    }),
    concurrentB.callTool({
      name: "read",
      arguments: { workspaceId: concurrentWorkspaceA, path: "payload.txt" },
    }),
  ]);
  assertToolRejected(aReadsB, /unknown_workspace/);
  assertToolRejected(bReadsA, /unknown_workspace/);

  const node = JSON.stringify(process.execPath);
  const [backgroundA, backgroundB] = await Promise.all([
    concurrentA.callTool({
      name: "exec_command",
      arguments: {
        workspaceId: concurrentWorkspaceA,
        cmd: `${node} -e "setTimeout(() => console.log('client-a-background'), 250)"`,
        yieldTimeMs: 0,
      },
    }),
    concurrentB.callTool({
      name: "exec_command",
      arguments: {
        workspaceId: workspaceB,
        cmd: `${node} -e "setTimeout(() => console.log('client-b-background'), 250)"`,
        yieldTimeMs: 0,
      },
    }),
  ]);
  assertToolSucceeded(backgroundA);
  assertToolSucceeded(backgroundB);
  const sessionA = processSessionId(backgroundA);
  const sessionB = processSessionId(backgroundB);
  assert.notEqual(sessionA, sessionB);

  const [aPollsB, bPollsA] = await Promise.all([
    concurrentA.callTool({
      name: "write_stdin",
      arguments: { workspaceId: concurrentWorkspaceA, sessionId: sessionB, yieldTimeMs: 0 },
    }),
    concurrentB.callTool({
      name: "write_stdin",
      arguments: { workspaceId: workspaceB, sessionId: sessionA, yieldTimeMs: 0 },
    }),
  ]);
  assertToolRejected(aPollsB, /unknown_process_session/);
  assertToolRejected(bPollsA, /unknown_process_session/);

  const [finishedA, finishedB] = await Promise.all([
    concurrentA.callTool({
      name: "write_stdin",
      arguments: { workspaceId: concurrentWorkspaceA, sessionId: sessionA, yieldTimeMs: 2_000 },
    }),
    concurrentB.callTool({
      name: "write_stdin",
      arguments: { workspaceId: workspaceB, sessionId: sessionB, yieldTimeMs: 2_000 },
    }),
  ]);
  assertToolSucceeded(finishedA);
  assertToolSucceeded(finishedB);
  assert.match(JSON.stringify(finishedA.content), /client-a-background/);
  assert.match(JSON.stringify(finishedB.content), /client-b-background/);
  const revokedB = await concurrentB.callTool({
    name: "revoke_workspace",
    arguments: { workspaceId: workspaceB },
  });
  assertToolSucceeded(revokedB);
  const revokedResume = await concurrentB.callTool({
    name: "resume_workspace",
    arguments: { alias: "primary", contextMode: "full" },
  });
  assertToolRejected(revokedResume, /unknown_workspace_alias/);
  await Promise.all([closeClient(concurrentA), closeClient(concurrentB)]);

  assert.equal(await readFile(join(workspaceRoot, "safe-runs.txt"), "utf8"), "safe-run\nsafe-run\n");
  assert.equal(await readFile(join(workspaceRoot, "conversation.txt"), "utf8"), "round-two\nnew-session\n");

  const initialGeneration = Number(
    (opened.structuredContent as { workspaceGeneration?: unknown } | undefined)?.workspaceGeneration,
  );
  assert.ok(initialGeneration >= 1);
  await active.close();
  active = await startServer(mainConfig);
  const afterRestart = await connectClient("same-account-after-restart", oauthA.accessToken, active.origin);
  const coldRead = await afterRestart.callTool({
    name: "read",
    arguments: { workspaceId: workspaceA, path: "payload.txt" },
  });
  assertToolRejected(coldRead, /workspace_resume_required/);
  assert.equal(
    (coldRead.structuredContent as { error?: { recovery?: unknown } } | undefined)?.error?.recovery,
    "resume_workspace",
  );
  const afterRestartList = await afterRestart.callTool({ name: "list_workspaces", arguments: {} });
  assertToolSucceeded(afterRestartList);
  assert.match(JSON.stringify(afterRestartList.structuredContent), /requires_resume/);
  const afterRestartResume = await afterRestart.callTool({
    name: "resume_workspace",
    arguments: { alias: "primary", contextMode: "full" },
  });
  assertToolSucceeded(afterRestartResume);
  assert.equal(workspaceId(afterRestartResume), workspaceA);
  assert.ok(
    Number((afterRestartResume.structuredContent as { workspaceGeneration?: unknown }).workspaceGeneration)
      > initialGeneration,
  );
  const resumedRead = await afterRestart.callTool({
    name: "read",
    arguments: { workspaceId: workspaceA, path: "conversation.txt" },
  });
  assertToolSucceeded(resumedRead);
  assert.match(JSON.stringify(resumedRead.content), /new-session/);
  const resumedGeneration = Number(
    (afterRestartResume.structuredContent as { workspaceGeneration?: unknown }).workspaceGeneration,
  );
  const closedWorkspace = await afterRestart.callTool({
    name: "close_workspace",
    arguments: { workspaceId: workspaceA },
  });
  assertToolSucceeded(closedWorkspace);
  const reopenedWorkspace = await afterRestart.callTool({
    name: "open_workspace",
    arguments: {
      path: workspaceRoot,
      alias: "primary",
      writeAccess: "read_write",
      contextMode: "full",
    },
  });
  assertToolSucceeded(reopenedWorkspace);
  assert.equal(workspaceId(reopenedWorkspace), workspaceA);
  assert.equal(
    Number((reopenedWorkspace.structuredContent as { workspaceGeneration?: unknown }).workspaceGeneration),
    resumedGeneration + 2,
  );
  await closeClient(afterRestart);

  const quietServer = await startServer(loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, "quiet-config"),
    DEVSPACE_STATE_DIR: join(root, "quiet-state"),
    DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
    DEVSPACE_ALLOWED_HOSTS: "*",
    DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
    DEVSPACE_OAUTH_OWNER_TOKEN: ownerPassword,
    DEVSPACE_SKILLS: "0",
    DEVSPACE_SUBAGENTS: "0",
    DEVSPACE_WIDGETS: "off",
    DEVSPACE_LOG_LEVEL: "info",
    DEVSPACE_LOG_FORMAT: "json",
    DEVSPACE_LOG_TOOL_CALLS: "0",
    PORT: "1",
  }));
  let quietCredentials: OAuthCredentials | undefined;
  let quietWorkspaceId: string | undefined;
  try {
    const quietMetadata = await discoverOAuth(quietServer.origin);
    quietCredentials = await registerAndAuthorize(quietServer.origin, quietMetadata, "quiet-client");
    const quietClient = await connectClient("quiet-tool-logs", quietCredentials.accessToken, quietServer.origin);
    const quietOpen = await quietClient.callTool({
      name: "open_workspace",
      arguments: { path: workspaceRoot, contextMode: "full" },
    });
    assertToolSucceeded(quietOpen);
    quietWorkspaceId = workspaceId(quietOpen);
    await closeClient(quietClient);
  } finally {
    await quietServer.close();
  }

  const logText = capturedLogs.join("\n");
  const connectionA = connectionRef(oauthA.clientId);
  const connectionB = connectionRef(oauthB.clientId);
  const activityA = workspaceActivityRef(oauthA.clientId, workspaceA);
  const activityB = workspaceActivityRef(oauthB.clientId, workspaceB);
  const quietConnection = connectionRef(quietCredentials?.clientId);
  const quietActivity = workspaceActivityRef(quietCredentials?.clientId, quietWorkspaceId);
  assert.ok(connectionA && connectionB && activityA && activityB && quietCredentials && quietConnection && quietActivity);
  assert.notEqual(connectionA, connectionB);
  assert.notEqual(activityA, activityB);
  assert.match(logText, new RegExp(`"connectionRef":"${connectionA}"`));
  assert.match(logText, new RegExp(`"connectionRef":"${connectionB}"`));
  assert.match(logText, new RegExp(`"workspaceActivityRef":"${activityA}"`));
  assert.match(logText, new RegExp(`"workspaceActivityRef":"${activityB}"`));
  assert.match(logText, new RegExp(`"event":"oauth_client_registered"[^\n]*"connectionRef":"${connectionA}"`));
  assert.match(logText, new RegExp(`"event":"oauth_authorization_succeeded"[^\n]*"connectionRef":"${connectionA}"`));
  assert.match(logText, new RegExp(`"event":"oauth_token_issued"[^\n]*"connectionRef":"${connectionA}"`));
  assert.match(logText, new RegExp(`"event":"oauth_token_refreshed"[^\n]*"connectionRef":"${connectionA}"`));
  const parsedLogs = capturedLogs.flatMap((line): Array<Record<string, unknown>> => {
    try {
      const value = JSON.parse(line) as unknown;
      return value && typeof value === "object" && !Array.isArray(value)
        ? [value as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });
  assert.ok(parsedLogs.some((entry) =>
    entry.event === "tool_call" &&
    entry.connectionRef === connectionA &&
    entry.workspaceActivityRef === activityA &&
    entry.workspaceId === workspaceA
  ));
  assert.ok(parsedLogs.some((entry) =>
    entry.event === "http_request" &&
    entry.connectionRef === connectionA &&
    entry.workspaceActivityRef === activityA &&
    entry.path === "/mcp"
  ));
  assert.equal(parsedLogs.some((entry) =>
    entry.event === "tool_call" && entry.connectionRef === quietConnection
  ), false);
  assert.ok(parsedLogs.some((entry) =>
    entry.event === "http_request" &&
    entry.connectionRef === quietConnection &&
    entry.workspaceActivityRef === quietActivity &&
    entry.path === "/mcp"
  ));
  assert.doesNotMatch(logText, new RegExp(oauthA.clientId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.doesNotMatch(logText, new RegExp(oauthB.clientId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.doesNotMatch(logText, new RegExp(oauthA.accessToken.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.doesNotMatch(logText, new RegExp(oauthB.accessToken.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.doesNotMatch(logText, new RegExp(originalAccessTokenA.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.doesNotMatch(logText, new RegExp(originalRefreshTokenA.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.doesNotMatch(logText, new RegExp(oauthA.refreshToken.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.doesNotMatch(logText, new RegExp(oauthB.refreshToken.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.doesNotMatch(logText, new RegExp(quietCredentials.accessToken.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.doesNotMatch(logText, new RegExp(quietCredentials.refreshToken.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.doesNotMatch(logText, new RegExp(ownerPassword.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
} finally {
  const cleanup = await Promise.allSettled([
    ...Array.from(clients, (client) => client.close()),
    ...(active ? [active.close()] : []),
  ]);
  await rm(root, { recursive: true, force: true });
  console.log = originalConsole.log;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  const failedCleanup = cleanup.find((result) => result.status === "rejected");
  if (failedCleanup?.status === "rejected") throw failedCleanup.reason;
}

interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
}

interface OAuthCredentials {
  clientId: string;
  accessToken: string;
  refreshToken: string;
}

async function discoverOAuth(origin: URL): Promise<OAuthMetadata> {
  const unauthorized = await fetch(new URL("/mcp", origin));
  assert.equal(unauthorized.status, 401);
  const challenge = unauthorized.headers.get("www-authenticate") ?? "";
  assert.match(challenge, /^Bearer /);
  const advertisedMetadata = challenge.match(/resource_metadata="([^"]+)"/)?.[1];
  assert.equal(advertisedMetadata, `${publicBaseUrl}/.well-known/oauth-protected-resource/mcp`);

  const resourceMetadataResponse = await fetch(localUrl(origin, advertisedMetadata));
  assert.equal(resourceMetadataResponse.status, 200);
  const resourceMetadata = await resourceMetadataResponse.json() as {
    resource?: unknown;
    authorization_servers?: unknown;
  };
  assert.equal(resourceMetadata.resource, resource);
  assert.deepEqual(resourceMetadata.authorization_servers, [`${publicBaseUrl}/`]);

  const authorizationMetadataResponse = await fetch(
    new URL("/.well-known/oauth-authorization-server", origin),
  );
  assert.equal(authorizationMetadataResponse.status, 200);
  const authorizationMetadata = await authorizationMetadataResponse.json() as Partial<OAuthMetadata>;
  assert.equal(authorizationMetadata.issuer, `${publicBaseUrl}/`);
  assert.equal(authorizationMetadata.authorization_endpoint, `${publicBaseUrl}/authorize`);
  assert.equal(authorizationMetadata.token_endpoint, `${publicBaseUrl}/token`);
  assert.equal(authorizationMetadata.registration_endpoint, `${publicBaseUrl}/register`);
  return authorizationMetadata as OAuthMetadata;
}

async function registerAndAuthorize(
  origin: URL,
  metadata: OAuthMetadata,
  label: string,
): Promise<OAuthCredentials> {
  const redirectUri = `https://chatgpt.com/connector/oauth/chatgpt-flow-e2e-${label}`;
  const verifier = `chatgpt-flow-e2e-${label}-verifier-0123456789-abcdefghijklmnopqrstuvwxyz`;
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const registration = await fetch(localUrl(origin, metadata.registration_endpoint), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: `ChatGPT flow e2e ${label}`,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  assert.equal(registration.status, 201);
  const registered = await registration.json() as { client_id?: unknown; redirect_uris?: unknown };
  assert.equal(typeof registered.client_id, "string");
  assert.deepEqual(registered.redirect_uris, [redirectUri]);
  const clientId = String(registered.client_id);
  const authorization = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "devspace",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
    state: `chatgpt-flow-e2e-${label}`,
    ui_locales: "en-US",
  });

  const authorizeUrl = localUrl(origin, metadata.authorization_endpoint);
  authorizeUrl.search = authorization.toString();
  const authorizePage = await fetch(authorizeUrl, { redirect: "manual" });
  assert.equal(authorizePage.status, 200);
  assert.match(authorizePage.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(await authorizePage.text(), /Owner password/);

  const approval = await fetch(localUrl(origin, metadata.authorization_endpoint), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...Object.fromEntries(authorization), owner_token: ownerPassword }),
    redirect: "manual",
  });
  assert.equal(approval.status, 302);
  const callback = new URL(approval.headers.get("location") ?? "");
  assert.equal(callback.origin, "https://chatgpt.com");
  assert.ok(callback.pathname.startsWith("/connector/oauth/"));
  assert.equal(callback.searchParams.get("state"), `chatgpt-flow-e2e-${label}`);
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const tokenResponse = await fetch(localUrl(origin, metadata.token_endpoint), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json() as {
    access_token?: unknown;
    refresh_token?: unknown;
    token_type?: unknown;
  };
  assert.equal(typeof tokens.access_token, "string");
  assert.equal(typeof tokens.refresh_token, "string");
  assert.equal(String(tokens.token_type).toLowerCase(), "bearer");
  return {
    clientId,
    accessToken: String(tokens.access_token),
    refreshToken: String(tokens.refresh_token),
  };
}

async function refreshTokens(origin: URL, credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const response = await fetch(new URL("/token", origin), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: credentials.clientId,
      refresh_token: credentials.refreshToken,
      scope: "devspace",
      resource,
    }),
  });
  assert.equal(response.status, 200);
  const tokens = await response.json() as { access_token?: unknown; refresh_token?: unknown };
  assert.equal(typeof tokens.access_token, "string");
  assert.equal(typeof tokens.refresh_token, "string");
  return {
    clientId: credentials.clientId,
    accessToken: String(tokens.access_token),
    refreshToken: String(tokens.refresh_token),
  };
}

async function connectClient(
  name: string,
  accessToken: string,
  origin: URL,
  staleSessionId?: string,
): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  clients.add(client);
  const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
  if (staleSessionId) headers["mcp-session-id"] = staleSessionId;
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", origin), {
    requestInit: { headers },
  }));
  enableWorkspaceGenerationTracking(client);
  return client;
}

function enableWorkspaceGenerationTracking(client: Client): void {
  const original = client.callTool.bind(client);
  client.callTool = (async (...callArgs: Parameters<Client["callTool"]>) => {
    const request = callArgs[0];
    const requestArguments = request.arguments as Record<string, unknown> | undefined;
    const workspaceId = typeof requestArguments?.workspaceId === "string"
      ? requestArguments.workspaceId
      : undefined;
    if (workspaceId && requestArguments?.workspaceGeneration === undefined) {
      const generation = trackedWorkspaceGenerations.get(workspaceId);
      if (generation !== undefined) {
        callArgs[0] = { ...request, arguments: { ...requestArguments, workspaceGeneration: generation } };
      }
    }
    const result = await original(...callArgs);
    const structured = result.structuredContent as Record<string, unknown> | undefined;
    if (typeof structured?.workspaceId === "string" && typeof structured.workspaceGeneration === "number") {
      trackedWorkspaceGenerations.set(structured.workspaceId, structured.workspaceGeneration);
    }
    return result;
  }) as Client["callTool"];
}

async function closeClient(client: Client): Promise<void> {
  await client.close();
  clients.delete(client);
}

function workspaceId(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const id = (result.structuredContent as { workspaceId?: unknown } | undefined)?.workspaceId;
  assert.equal(typeof id, "string");
  assert.ok(id);
  return String(id);
}

function processSessionId(result: Awaited<ReturnType<Client["callTool"]>>): number {
  const id = (result.structuredContent as { sessionId?: unknown } | undefined)?.sessionId;
  assert.equal(typeof id, "number");
  return Number(id);
}

function assertToolSucceeded(result: Awaited<ReturnType<Client["callTool"]>>): void {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
}

function assertToolRejected(
  result: Awaited<ReturnType<Client["callTool"]>>,
  pattern: RegExp,
): void {
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), pattern);
}

function localUrl(origin: URL, advertisedUrl: string): URL {
  const advertised = new URL(advertisedUrl);
  return new URL(`${advertised.pathname}${advertised.search}`, origin);
}

async function startServer(config: ReturnType<typeof loadConfig>): Promise<{
  origin: URL;
  close(): Promise<void>;
}> {
  const running = createServer(config);
  const httpServer = createHttpServer(running.app);
  const origin = await listen(httpServer);
  return {
    origin,
    close: async () => {
      const results = await Promise.allSettled([
        closeHttpServer(httpServer),
        running.close(),
      ]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
  };
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
