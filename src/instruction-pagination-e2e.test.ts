import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Database from "better-sqlite3";
import { authorizationRootId } from "./authorization-roots.js";
import { loadConfig } from "./config.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";
import {
  MAX_PROJECT_HANDOFF_MODEL_TEXT_JSON_BYTES,
  MAX_PROJECT_HANDOFF_PROGRESS_UTF8_BYTES,
  projectHandoffModelTextJsonBytes,
} from "./project-handoff-store.js";
import { PROJECT_CONTEXT_SCHEMA_VERSION } from "./project-context-protocol.js";
import { createServer } from "./server.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "devspace-instruction-pagination-e2e-")));
const workspaceRoot = join(root, "workspace");
const nested = join(workspaceRoot, "nested");
const deep = join(nested, "deep");
const stateDir = join(root, "state");
const publicBaseUrl = "http://127.0.0.1:7676";
const ownerToken = "instruction-pagination-owner-token-long-enough";
const accessToken = "instruction-pagination-access-token";
const mainHostMeta = {
  "openai/subject": "instruction-pagination-subject",
  "openai/session": "instruction-pagination-main-session",
};
const mutationHostMeta = {
  "openai/subject": "instruction-pagination-subject",
  "openai/session": "instruction-pagination-mutation-session",
};
const execFileAsync = promisify(execFile);

await mkdir(deep, { recursive: true });
const expectedInstructions = new Map([
  ["AGENTS.md", instruction("ROOT_PAGE", 40_000)],
  ["nested/AGENTS.md", instruction("NESTED_PAGE", 4_000)],
  ["nested/deep/AGENTS.md", instruction("DEEP_PAGE_中文🙂", 4_000)],
]);
await Promise.all([
  writeFile(join(workspaceRoot, "AGENTS.md"), expectedInstructions.get("AGENTS.md")!),
  writeFile(join(nested, "AGENTS.md"), expectedInstructions.get("nested/AGENTS.md")!),
  writeFile(join(deep, "AGENTS.md"), expectedInstructions.get("nested/deep/AGENTS.md")!),
  writeFile(join(deep, "payload.txt"), "before\n"),
]);
await execFileAsync("git", ["init", "-q"], { cwd: workspaceRoot });
await execFileAsync("git", ["add", "."], { cwd: workspaceRoot });
await execFileAsync("git", [
  "-c", "user.name=DevSpace Test",
  "-c", "user.email=devspace@example.invalid",
  "-c", "commit.gpgsign=false",
  "commit", "-qm", "fixture",
], { cwd: workspaceRoot });

const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
  DEVSPACE_ALLOWED_HOSTS: "*",
  DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
  DEVSPACE_OAUTH_OWNER_TOKEN: ownerToken,
  DEVSPACE_WIDGETS: "off",
  DEVSPACE_SKILLS: "0",
  DEVSPACE_LOG_LEVEL: "silent",
  PORT: "1",
});

seedGrant();
const running = createServer(config);
const httpServer = createHttpServer(running.app);
const origin = await listen(httpServer);
const clients: Client[] = [];
const client = new Client({ name: "instruction-pagination", version: "1.0.0" });
clients.push(client);

try {
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", origin), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  }));
  const projects = await client.callTool({
    name: "list_projects",
    arguments: {},
  });
  assertSucceeded(projects);
  const projectRef = (projects.structuredContent as {
    projects?: Array<{ projectRef?: unknown }>;
  } | undefined)?.projects?.[0]?.projectRef;
  assert.equal(typeof projectRef, "string");
  const selected = await client.callTool({
    name: "project_control",
    arguments: { action: "open", projectRef, operationId: "instruction-read-execution" },
    _meta: mainHostMeta,
  });
  assertSucceeded(selected);
  assert.match(JSON.stringify(selected.structuredContent), /ROOT_PAGE/u);
  assert.equal(
    (selected.structuredContent as { schemaVersion?: unknown } | undefined)?.schemaVersion,
    PROJECT_CONTEXT_SCHEMA_VERSION,
  );
  assert.equal(PROJECT_CONTEXT_SCHEMA_VERSION, 8);
  assert.doesNotMatch(JSON.stringify(selected.structuredContent), /executionRef/u);
  assertNoLegacyContextProtocol(selected);
  assert.equal(rootInstructionsComplete(selected), false);
  assert.equal(typeof rootInstructionCursor(selected), "string");
  assert.ok(serializedBytes(selected) < 16_000);

  const stateBeforeInvalidCursor = selectedSessionRuntimeTimestamps();
  await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  const invalidCursor = await client.callTool({
    name: "project_control",
    arguments: {
      action: "hydrate",
      cursor: `${rootInstructionCursor(selected)!}x`,
    },
    _meta: mainHostMeta,
  });
  assert.equal(invalidCursor.isError, true);
  assert.equal(
    (invalidCursor.structuredContent as {
      error?: { code?: unknown };
    } | undefined)?.error?.code,
    "invalid_root_instruction_cursor",
  );
  assert.deepEqual(
    selectedSessionRuntimeTimestamps(),
    stateBeforeInvalidCursor,
    "an invalid hydrate cursor must not touch execution or Thread runtime timestamps",
  );

  const gatedRead = await client.callTool({
    name: "read_files",
    arguments: { files: [{ path: "nested/deep/payload.txt" }] },
    _meta: mainHostMeta,
  });
  assert.equal(gatedRead.isError, true);
  assert.equal(errorCode(gatedRead), "root_instructions_required");
  assert.deepEqual(errorSemantics(gatedRead), {
    retryable: true,
    safeToRetry: true,
    recovery: "continue_or_restart_root_instructions",
  });

  const restarted = await client.callTool({
    name: "project_control",
    arguments: { action: "hydrate" },
    _meta: mainHostMeta,
  });
  assertSucceeded(restarted);
  assert.equal(rootInstructionsComplete(restarted), false);
  assert.equal(typeof rootInstructionCursor(restarted), "string");
  const rootContent = await finishRootInstructions(client, mainHostMeta, restarted);
  assert.equal(rootContent, expectedInstructions.get("AGENTS.md"));

  const read = await client.callTool({
    name: "read_files",
    arguments: { files: [{ path: "nested/deep/payload.txt" }] },
    _meta: mainHostMeta,
  });
  assertSucceeded(read);
  assertInstructionDelta(read);
  assert.doesNotMatch(JSON.stringify(read.content), /NESTED_PAGE|DEEP_PAGE/u);
  const readItems = (read.structuredContent as {
    items?: Array<{ path?: unknown; contentHash?: unknown; content?: unknown }>;
  } | undefined)?.items ?? [];
  const payload = readItems.find((item) => item.path === "nested/deep/payload.txt");
  assert.equal(payload?.content, "before\n");
  assert.equal(typeof payload?.contentHash, "string");
  const escapeHeavyProgress = "\\".repeat(MAX_PROJECT_HANDOFF_PROGRESS_UTF8_BYTES);
  const rejectedProgress = await client.callTool({
    name: "save_progress",
    arguments: {
      operationId: "instruction-save-progress",
      title: "Paged instruction task",
      progress: escapeHeavyProgress,
    },
    _meta: mainHostMeta,
  });
  assert.equal(rejectedProgress.isError, true);
  assert.equal(
    (rejectedProgress.structuredContent as {
      error?: { code?: unknown };
    } | undefined)?.error?.code,
    "task_context_too_large",
  );

  const escapedPrefix = "\\".repeat(3_750);
  const maximumHandoffProgress =
    escapedPrefix +
    "H".repeat(MAX_PROJECT_HANDOFF_PROGRESS_UTF8_BYTES - escapedPrefix.length);
  assert.equal(
    Buffer.byteLength(maximumHandoffProgress, "utf8"),
    MAX_PROJECT_HANDOFF_PROGRESS_UTF8_BYTES,
  );
  assert.ok(
    projectHandoffModelTextJsonBytes(
      "Paged instruction task",
      maximumHandoffProgress,
    ) <= MAX_PROJECT_HANDOFF_MODEL_TEXT_JSON_BYTES,
  );
  const savedProgress = await client.callTool({
    name: "save_progress",
    arguments: {
      operationId: "instruction-save-progress",
      title: "Paged instruction task",
      progress: maximumHandoffProgress,
    },
    _meta: mainHostMeta,
  });
  assertSucceeded(savedProgress);
  const savedThreadRef = String(
    (savedProgress.structuredContent as {
      thread?: { threadRef?: unknown };
    } | undefined)?.thread?.threadRef ?? "",
  );
  assert.match(savedThreadRef, /^pth1_/u);

  const mutationClient = new Client({
    name: "instruction-mutation-gate",
    version: "1.0.0",
  });
  clients.push(mutationClient);
  await mutationClient.connect(new StreamableHTTPClientTransport(new URL("/mcp", origin), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  }));
  const mutationSelection = await mutationClient.callTool({
    name: "project_control",
    arguments: {
      action: "resume",
      projectRef,
      threadRef: savedThreadRef,
      operationId: "instruction-mutation-execution",
    },
    _meta: mutationHostMeta,
  });
  assertSucceeded(mutationSelection);
  assert.ok(
    serializedBytes(mutationSelection) < 16_000,
    "a maximum-size handoff plus root instructions must remain inside the Project-context response budget",
  );
  assert.equal(
    (mutationSelection.structuredContent as {
      thread?: { checkpoint?: { modelSummary?: unknown } };
    }).thread?.checkpoint?.modelSummary,
    maximumHandoffProgress,
  );
  assert.equal(
    (mutationSelection.structuredContent as {
      thread?: { checkpoint?: { modelSummaryTrust?: unknown } };
    }).thread?.checkpoint?.modelSummaryTrust,
    "untrusted",
  );
  assert.equal(
    (mutationSelection.structuredContent as {
      thread?: { checkpoint?: { observedStateTrust?: unknown } };
    }).thread?.checkpoint?.observedStateTrust,
    "server_observed",
  );
  assert.doesNotMatch(JSON.stringify(mutationSelection.structuredContent), /executionRef/u);
  await finishRootInstructions(mutationClient, mutationHostMeta, mutationSelection);
  const patchArguments = {
    operationId: "instruction-delta-patch",
    ifMatch: { "nested/deep/payload.txt": String(payload?.contentHash) },
    patch: "*** Begin Patch\n*** Update File: nested/deep/payload.txt\n@@\n-before\n+after\n*** End Patch",
  };
  const gated = await mutationClient.callTool({
    name: "apply_patch",
    arguments: patchArguments,
    _meta: mutationHostMeta,
  });
  assert.equal(gated.isError, true);
  assert.equal(
    (gated.structuredContent as { error?: { code?: unknown } } | undefined)?.error?.code,
    "instructions_required",
  );
  assertInstructionDelta(gated);
  assertNoLegacyContextProtocol(gated);

  const patched = await mutationClient.callTool({
    name: "apply_patch",
    arguments: patchArguments,
    _meta: mutationHostMeta,
  });
  assertSucceeded(patched);
} finally {
  for (const activeClient of clients.reverse()) {
    await activeClient.close().catch(() => undefined);
  }
  await closeHttpServer(httpServer);
  await running.close();
  await rm(root, { recursive: true, force: true });
}

function instruction(marker: string, bytes: number): string {
  const heading = `# ${marker}\n\n${marker}\n`;
  return `${heading}${"x".repeat(Math.max(0, bytes - Buffer.byteLength(heading, "utf8")))}\n`;
}

function seedGrant(): void {
  const store = new SqliteOAuthStore(stateDir);
  try {
    const clientInfo = new SqliteOAuthClientsStore(
      store,
      config.oauth.allowedRedirectHosts,
    ).registerClient({
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      client_name: "Instruction pagination",
    });
    const grant = store.createAuthorizationGrant({
      clientId: clientInfo.client_id,
      scopes: ["project:read", "project:write"],
      allowedRootIds: [authorizationRootId(workspaceRoot, config.oauth.keys.authorizationRoot)],
    });
    const expiresAt = Math.floor(Date.now() / 1_000) + 3_600;
    const resource = new URL("/mcp", publicBaseUrl).href;
    store.saveTokenPair({
      accessTokenHash: hashToken(accessToken),
      accessToken: {
        grantId: grant.grantId,
        clientId: clientInfo.client_id,
        principalId: grant.principalId,
        authorizationEpoch: grant.authorizationEpoch,
        scopes: [...grant.grantedScopes],
        expiresAt,
        resource,
      },
      refreshTokenHash: hashToken(`${accessToken}-refresh`),
      refreshToken: {
        grantId: grant.grantId,
        clientId: clientInfo.client_id,
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

function assertInstructionDelta(
  result: Awaited<ReturnType<Client["callTool"]>>,
): void {
  const instructions = (result.structuredContent as {
    instructionsDelta?: Array<{
      source?: unknown;
      trust?: unknown;
      scope?: unknown;
      path?: unknown;
      content?: unknown;
    }>;
  } | undefined)?.instructionsDelta ?? [];
  assert.equal(instructions.length, 2);
  const byPath = new Map(instructions.map((item) => [String(item.path), item]));
  for (const [path, expected] of expectedInstructions) {
    if (path === "AGENTS.md") continue;
    const item = byPath.get(path);
    assert.equal(item?.source, "repository");
    assert.equal(item?.trust, "repository_untrusted");
    assert.equal(item?.content, expected);
  }
  assert.doesNotMatch(
    JSON.stringify(instructions),
    /fragment|cursor|hash|bytes|manifest|token|revision/iu,
  );
}

function assertNoLegacyContextProtocol(
  result: Awaited<ReturnType<Client["callTool"]>>,
): void {
  const structuredContent = result.structuredContent as {
    thread?: Record<string, unknown> & { checkpoint?: Record<string, unknown> };
  } | undefined;
  assert.doesNotMatch(
    JSON.stringify(structuredContent ?? {}),
    /"(?:workspace|receipt|continuation|contextChanged|state|instructionToken|handoff|mustRevalidate|provenance|offsetBytes|lengthBytes|totalBytes|complete)"\s*:/iu,
  );
  if (structuredContent?.thread) {
    assert.equal("ref" in structuredContent.thread, false);
  }
}

async function finishRootInstructions(
  activeClient: Client,
  hostMeta: Readonly<Record<string, string>>,
  firstPage: Awaited<ReturnType<Client["callTool"]>>,
): Promise<string> {
  let page = firstPage;
  let combined = "";
  let pages = 0;
  while (true) {
    pages += 1;
    assert.ok(pages < 20, "root instruction paging must make bounded progress");
    assert.ok(serializedBytes(page) < 16_000, "project_control pages must remain below 16 KiB");
    assertNoLegacyContextProtocol(page);
    if (pages > 1) {
      assert.equal(
        (page.structuredContent as {
          thread?: { checkpoint?: unknown };
        } | undefined)?.thread?.checkpoint,
        undefined,
        "saved Thread summary must appear only on the first Project-context page",
      );
    }
    const items = (page.structuredContent as {
      contextDelta?: {
        instructions?: Array<{
          path?: unknown;
          content?: unknown;
          fragment?: {
            partial?: unknown;
          };
        }>;
      };
    } | undefined)?.contextDelta?.instructions ?? [];
    for (const item of items) {
      assert.equal(item.path, "AGENTS.md");
      assert.equal(item.fragment?.partial, true);
      combined += String(item.content ?? "");
    }
    const cursor = rootInstructionCursor(page);
    if (!cursor) {
      assert.equal(rootInstructionsComplete(page), true);
      break;
    }
    assert.equal(rootInstructionsComplete(page), false);
    page = await activeClient.callTool({
      name: "project_control",
      arguments: { action: "hydrate", cursor },
      _meta: hostMeta,
    });
    assertSucceeded(page);
  }
  assert.ok(pages > 1, "the >32 KiB root must require continuation");
  return combined;
}

function rootInstructionCursor(
  result: Awaited<ReturnType<Client["callTool"]>>,
): string | undefined {
  const cursor = (result.structuredContent as {
    contextDelta?: { nextCursor?: unknown };
  } | undefined)?.contextDelta?.nextCursor;
  return typeof cursor === "string" ? cursor : undefined;
}

function rootInstructionsComplete(
  result: Awaited<ReturnType<Client["callTool"]>>,
): unknown {
  return (result.structuredContent as {
    contextDelta?: { rootInstructionsComplete?: unknown };
  } | undefined)?.contextDelta?.rootInstructionsComplete;
}

function errorCode(
  result: Awaited<ReturnType<Client["callTool"]>>,
): unknown {
  return (result.structuredContent as {
    error?: { code?: unknown };
  } | undefined)?.error?.code;
}

function errorSemantics(
  result: Awaited<ReturnType<Client["callTool"]>>,
): Record<string, unknown> {
  const error = (result.structuredContent as {
    error?: Record<string, unknown>;
  } | undefined)?.error ?? {};
  return {
    retryable: error.retryable,
    safeToRetry: error.safeToRetry,
    recovery: error.recovery,
  };
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function selectedSessionRuntimeTimestamps(): {
  executionLastUsedAt: string;
  executionUpdatedAt: string;
  workspaceLastUsedAt: string;
  threadUpdatedAt: string;
  threadLastActivityAt: string;
} {
  const continuity = new Database(join(stateDir, "project-task-continuity.sqlite"), {
    readonly: true,
  });
  const state = new Database(join(stateDir, "devspace.sqlite"), { readonly: true });
  const threads = new Database(join(stateDir, "project-threads.sqlite"), { readonly: true });
  try {
    const binding = continuity.prepare(`
      select execution_id, thread_id
      from project_task_session_bindings
      where binding_status = 'active'
      order by bound_at desc
      limit 1
    `).get() as { execution_id: string; thread_id: string } | undefined;
    assert.ok(binding?.execution_id);
    const execution = state.prepare(`
      select workspace_id, last_used_at, updated_at
      from project_executions where execution_id = ?
    `).get(binding.execution_id) as {
      workspace_id: string;
      last_used_at: string;
      updated_at: string;
    } | undefined;
    const workspace = execution
      ? state.prepare(`
          select last_used_at from workspace_sessions where id = ?
        `).get(execution.workspace_id) as { last_used_at: string } | undefined
      : undefined;
    const thread = threads.prepare(`
      select updated_at, last_activity_at from project_threads where thread_id = ?
    `).get(binding.thread_id) as {
      updated_at: string;
      last_activity_at: string;
    } | undefined;
    assert.ok(execution);
    assert.ok(workspace);
    assert.ok(thread);
    return {
      executionLastUsedAt: execution.last_used_at,
      executionUpdatedAt: execution.updated_at,
      workspaceLastUsedAt: workspace.last_used_at,
      threadUpdatedAt: thread.updated_at,
      threadLastActivityAt: thread.last_activity_at,
    };
  } finally {
    threads.close();
    state.close();
    continuity.close();
  }
}

function assertSucceeded(result: Awaited<ReturnType<Client["callTool"]>>): void {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function listen(server: HttpServer): Promise<URL> {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      resolveListen(new URL(`http://127.0.0.1:${address.port}`));
    });
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}
