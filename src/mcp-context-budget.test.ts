import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { authorizationRootId } from "./authorization-roots.js";
import { loadConfig } from "./config.js";
import { DEVSPACE_CAPABILITY_SCOPES } from "./oauth-scopes.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";
import { createServer } from "./server.js";

const root = await mkdtemp(join(tmpdir(), "devspace-context-budget-"));
const projectRoot = join(root, "project");
const stateDir = join(root, "state");
const publicBaseUrl = "http://127.0.0.1:7676";
const accessToken = "context-budget-access-token";
const rootInstruction = "CONTEXT_BUDGET_ROOT_INSTRUCTION";
const nestedInstruction = "CONTEXT_BUDGET_NESTED_INSTRUCTION";
const skillBody = "CONTEXT_BUDGET_SKILL_BODY";
const execFileAsync = promisify(execFile);

await Promise.all([
  mkdir(join(projectRoot, "nested"), { recursive: true }),
  mkdir(join(projectRoot, ".agents", "skills", "context-budget", "references"), {
    recursive: true,
  }),
  mkdir(join(projectRoot, ".agents", "skills", "context-budget-alpha"), {
    recursive: true,
  }),
  mkdir(join(projectRoot, ".agents", "skills", "context-budget-beta"), {
    recursive: true,
  }),
]);
await Promise.all([
  writeFile(join(projectRoot, "AGENTS.md"), `# Project instructions\n\n${rootInstruction}\n`),
  writeFile(join(projectRoot, "payload.txt"), "root payload\n"),
  writeFile(join(projectRoot, "nested", "AGENTS.md"), `${nestedInstruction}\n`),
  writeFile(join(projectRoot, "nested", "payload.txt"), "nested payload\n"),
  writeFile(
    join(projectRoot, ".agents", "skills", "context-budget", "SKILL.md"),
    `---\nname: context-budget\ndescription: Context budget fixture.\n---\n\n${skillBody}\n`,
  ),
  writeFile(
    join(projectRoot, ".agents", "skills", "context-budget", "references", "example.md"),
    "skill reference\n",
  ),
  writeFile(
    join(projectRoot, ".agents", "skills", "context-budget-alpha", "SKILL.md"),
    "---\nname: context-budget-alpha\ndescription: Context budget pagination fixture alpha.\n---\n",
  ),
  writeFile(
    join(projectRoot, ".agents", "skills", "context-budget-beta", "SKILL.md"),
    "---\nname: context-budget-beta\ndescription: Context budget pagination fixture beta.\n---\n",
  ),
]);
await execFileAsync("git", ["init", "-q"], { cwd: projectRoot });
await execFileAsync("git", ["add", "."], { cwd: projectRoot });
await execFileAsync(
  "git",
  [
    "-c", "user.name=DevSpace Test",
    "-c", "user.email=devspace@example.invalid",
    "-c", "commit.gpgsign=false",
    "commit", "-qm", "fixture",
  ],
  { cwd: projectRoot },
);

const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_ALLOWED_ROOTS: projectRoot,
  DEVSPACE_ALLOWED_HOSTS: "*",
  DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
  DEVSPACE_OAUTH_OWNER_TOKEN: "context-budget-owner-token-long-enough",
  DEVSPACE_WIDGETS: "changes",
  DEVSPACE_LOG_LEVEL: "silent",
  PORT: "1",
});

seedAccessToken();
const running = createServer(config);
const httpServer = createHttpServer(running.app);
const clients: Client[] = [];

try {
  const origin = await listen(httpServer);
  const first = await connect(origin, "context-budget-first");
  const toolsList = await first.listTools();
  const toolNames = toolsList.tools.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, [
    "apply_patch",
    "exec_command",
    "inspect",
    "list_projects",
    "project_control",
    "read_files",
    "read_process_output",
    "save_progress",
    "show_changes",
    "skills",
    "write_stdin",
  ].sort());
  assert.ok(
    utf8Bytes(toolsList) < 16_000,
    `ChatGPT Project tools/list must remain under 16000 bytes; got ${utf8Bytes(toolsList)}`,
  );
  assert.doesNotMatch(
    JSON.stringify(toolsList),
    /open_workspace|list_workspaces|resume_workspace|get_workspace_context|close_workspace|revoke_workspace|load_project_instructions|batch_read|batch_inspect|list_skills|load_skill|receipt|workspaceId|workspaceGeneration/iu,
  );
  for (const tool of toolsList.tools) {
    const schemes = (tool._meta as {
      securitySchemes?: Array<{ type?: unknown; scopes?: unknown }>;
    } | undefined)?.securitySchemes;
    assert.equal(schemes?.[0]?.type, "oauth2");
    assert.ok(Array.isArray(schemes?.[0]?.scopes));
  }
  const projectControlSchema = JSON.stringify(
    toolsList.tools.find((tool) => tool.name === "project_control")?.inputSchema,
  );
  for (const field of [
    "action", "projectRef", "operationId", "executionRef", "handoffRef",
    "threadRef", "cursor", "waitMs", "limit", "ifMatch",
  ]) assert.match(projectControlSchema, new RegExp(field, "u"));
  const malformedProjectControl = await first.callTool({
    name: "project_control",
    arguments: { action: "open" },
  });
  assertErrorCode(malformedProjectControl, "invalid_tool_input");
  const saveProgressSchema = JSON.stringify(
    toolsList.tools.find((tool) => tool.name === "save_progress")?.inputSchema,
  );
  assert.match(saveProgressSchema, /operationId/u);
  assert.match(saveProgressSchema, /progress/u);
  assert.match(saveProgressSchema, /ifMatch/u);
  const listProjectsTool = toolsList.tools.find((tool) => tool.name === "list_projects");
  assert.match(
    JSON.stringify(listProjectsTool?.inputSchema),
    /projectRef/u,
    "list_projects must support a Project-scoped recovery listing",
  );
  const showChangesTool = toolsList.tools.find((tool) => tool.name === "show_changes");
  assert.equal(
    (listProjectsTool?._meta as { ui?: unknown } | undefined)?.ui,
    undefined,
    "widgets=changes must not attach the Project picker to list_projects",
  );
  assert.equal(
    (toolsList.tools.find((tool) => tool.name === "project_control")?._meta as {
      ui?: unknown;
    } | undefined)?.ui,
    undefined,
    "project_control must remain unwidgeted so instruction continuation does not remount",
  );
  assert.equal(
    (showChangesTool?._meta as { ui?: { resourceUri?: unknown } } | undefined)
      ?.ui?.resourceUri,
    "ui://devspace/project-app.html",
  );
  assert.match(first.getInstructions() ?? "", /authorized by the current grant/u);
  assert.ok(utf8Bytes(first.getInstructions() ?? "") < 1_000);

  const resources = await first.listResources();
  assert.ok(resources.resources.some((resource) =>
    resource.uri === "ui://devspace/project-app.html"
  ));

  const beforeSelection = await first.callTool({
    name: "read_files",
    arguments: { files: [{ path: "payload.txt" }] },
  });
  assertErrorCode(beforeSelection, "invalid_tool_input");

  const listed = await first.callTool({ name: "list_projects", arguments: {} });
  assertSucceeded(listed);
  assert.equal((listed._meta as { tool?: unknown } | undefined)?.tool, "list_projects");
  const listedSerialized = JSON.stringify(listed.structuredContent);
  assert.doesNotMatch(listedSerialized, new RegExp(escapeRegExp(projectRoot), "u"));
  const projects = (listed.structuredContent as {
    projects?: Array<{ projectRef?: unknown; label?: unknown }>;
  } | undefined)?.projects ?? [];
  assert.equal(projects.length, 1);
  assert.equal(typeof projects[0]?.projectRef, "string");
  assert.deepEqual(
    (projects[0] as { handoffs?: unknown }).handoffs,
    [],
  );

  const selected = await first.callTool({
    name: "project_control",
    arguments: { action: "open", operationId: "context-budget-execution" },
  });
  assertSucceeded(selected);
  assertProjectContext(selected);
  const selectedContent = selected.structuredContent as {
    project?: { ref?: unknown; executionRef?: unknown; writeAccess?: unknown };
    contextDelta?: {
      instructions?: Array<{ path?: unknown; content?: unknown }>;
      rootInstructionsComplete?: unknown;
    };
  };
  assert.equal(selectedContent.project?.ref, projects[0]?.projectRef);
  assert.equal(selectedContent.project?.writeAccess, "read_write");
  const executionRef = String(selectedContent.project?.executionRef ?? "");
  assert.match(executionRef, /^pex1_/u);
  assert.match(
    String(selectedContent.contextDelta?.instructions?.find(
      (item) => item.path === "AGENTS.md",
    )?.content),
    new RegExp(rootInstruction, "u"),
  );
  assert.equal(selectedContent.contextDelta?.rootInstructionsComplete, true);
  assert.doesNotMatch(JSON.stringify(selectedContent), /instructionManifest|projectInstructions|skills/u);

  const read = await first.callTool({
    name: "read_files",
    arguments: { executionRef, files: [{ path: "payload.txt" }] },
  });
  assertSucceeded(read);
  assert.match(JSON.stringify(read.structuredContent), /root payload/u);

  const nestedRead = await first.callTool({
    name: "read_files",
    arguments: { executionRef, files: [{ path: "nested/payload.txt" }] },
  });
  assertSucceeded(nestedRead);
  assert.match(JSON.stringify(nestedRead.structuredContent), new RegExp(nestedInstruction, "u"));
  assert.doesNotMatch(
    JSON.stringify(nestedRead.structuredContent),
    /instructionToken|instructionManifest|fragment|receipt|contextChanged|phase/iu,
  );

  const apply = await first.callTool({
    name: "apply_patch",
    arguments: {
      executionRef,
      operationId: "context-budget-patch",
      ifMatch: { "nested/created.txt": null },
      patch: "*** Begin Patch\n*** Add File: nested/created.txt\n+created\n*** End Patch",
    },
  });
  assertSucceeded(apply);

  const changes = await first.callTool({
    name: "show_changes",
    arguments: { executionRef },
  });
  assertSucceeded(changes);
  assert.equal(
    Object.hasOwn(
      (changes.structuredContent ?? {}) as Record<string, unknown>,
      "effects",
    ),
    false,
  );
  assert.match(
    String((changes.structuredContent as {
      diff?: { patch?: unknown };
    } | undefined)?.diff?.patch),
    /nested\/created\.txt/u,
  );

  const listedSkills = await first.callTool({
    name: "skills",
    arguments: { executionRef, action: "search", query: "context-budget", limit: 1 },
  });
  assertSucceeded(listedSkills);
  const skillCursor = (listedSkills.structuredContent as {
    nextCursor?: unknown;
  } | undefined)?.nextCursor;
  assert.equal(typeof skillCursor, "string");
  const continuedSkills = await first.callTool({
    name: "skills",
    arguments: { executionRef, cursor: skillCursor },
  });
  assertSucceeded(continuedSkills);
  assert.equal(
    (continuedSkills.structuredContent as {
      skills?: unknown[];
    } | undefined)?.skills?.length,
    1,
  );
  const repeatedSkillFields = await first.callTool({
    name: "skills",
    arguments: { executionRef, cursor: skillCursor, action: "search" },
  });
  assertReadCursorRestart(repeatedSkillFields, "skill_cursor_fields_invalid");
  const invalidSkillCursor = await first.callTool({
    name: "skills",
    arguments: { executionRef, cursor: "not-a-signed-cursor" },
  });
  assertReadCursorRestart(invalidSkillCursor, "invalid_skill_cursor");
  const skillId = (listedSkills.structuredContent as {
    skills?: Array<{ skillId?: unknown }>;
  } | undefined)?.skills?.[0]?.skillId;
  assert.equal(typeof skillId, "string");
  const loadedSkill = await first.callTool({
    name: "skills",
    arguments: { executionRef, action: "load", skillId },
  });
  assertSucceeded(loadedSkill);
  assert.match(JSON.stringify(loadedSkill.structuredContent), new RegExp(skillBody, "u"));
  const reference = await first.callTool({
    name: "read_files",
    arguments: {
      executionRef,
      files: [{ path: `skill://${skillId}/references/example.md` }],
    },
  });
  assertSucceeded(reference);
  assert.match(JSON.stringify(reference.structuredContent), /skill reference/u);

  const command = await first.callTool({
    name: "exec_command",
    arguments: {
      executionRef,
      operationId: "context-budget-command",
      program: process.execPath,
      args: ["-e", "console.log('command-ok')"],
    },
  });
  assertSucceeded(command);
  assert.match(processOutputText(command), /command-ok/u);

  const second = await connect(origin, "context-budget-second");
  const unboundSecond = await second.callTool({
    name: "read_files",
    arguments: { files: [{ path: "payload.txt" }] },
  });
  assertErrorCode(unboundSecond, "invalid_tool_input");
  const secondExecution = await second.callTool({
    name: "project_control",
    arguments: { action: "open", operationId: "context-budget-second-execution" },
  });
  assertSucceeded(secondExecution);
  const secondExecutionRef = String((secondExecution.structuredContent as {
    project?: { executionRef?: unknown };
  } | undefined)?.project?.executionRef ?? "");
  assert.match(secondExecutionRef, /^pex1_/u);
  const staleSkillCursor = await second.callTool({
    name: "skills",
    arguments: { executionRef: secondExecutionRef, cursor: skillCursor },
  });
  assertReadCursorRestart(staleSkillCursor, "skill_cursor_stale");
  assertSucceeded(await second.callTool({
    name: "read_files",
    arguments: { executionRef: secondExecutionRef, files: [{ path: "payload.txt" }] },
  }));

  console.log(`CONTEXT_BUDGET ${JSON.stringify({
    toolsListBytes: utf8Bytes(toolsList),
    tools: toolNames.length,
  })}`);
} finally {
  for (const client of clients.reverse()) await client.close().catch(() => undefined);
  await closeHttpServer(httpServer);
  await running.close();
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
      client_name: "context-budget",
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

async function connect(origin: URL, name: string): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", origin), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  }));
  clients.push(client);
  return client;
}

function assertProjectContext(
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
  expected: string,
): void {
  assert.equal(result.isError, true, JSON.stringify(result.content));
  assert.equal(
    (result.structuredContent as {
      error?: { code?: unknown };
    } | undefined)?.error?.code,
    expected,
  );
}

function assertReadCursorRestart(
  result: Awaited<ReturnType<Client["callTool"]>>,
  expectedCode: string,
): void {
  assertErrorCode(result, expectedCode);
  const error = (result.structuredContent as {
    error?: {
      retryable?: unknown;
      safeToRetry?: unknown;
      recovery?: unknown;
    };
  } | undefined)?.error;
  assert.equal(error?.retryable, true);
  assert.equal(error?.safeToRetry, true);
  assert.notEqual(error?.recovery, "user_action_required");
}

function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return ((result.content ?? []) as Array<{ type?: unknown; text?: unknown }>)
    .filter((item): item is { type: "text"; text: string } =>
      item.type === "text" && typeof item.text === "string"
    )
    .map((item) => item.text)
    .join("\n");
}

function processOutputText(
  result: Awaited<ReturnType<Client["callTool"]>>,
): string {
  return String((result.structuredContent as {
    output?: { text?: unknown };
  } | undefined)?.output?.text ?? "");
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(
    typeof value === "string" ? value : JSON.stringify(value),
    "utf8",
  );
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
