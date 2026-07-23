import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";
import { createServer } from "./server.js";

const root = await mkdtemp(join(tmpdir(), "devspace-context-budget-"));
const workspaceRoot = join(root, "workspace");
const stateDir = join(root, "state");
const configDir = join(root, "config");
const agentDir = join(root, "agent");
const worktreeRoot = join(root, "worktrees");
const publicBaseUrl = "http://127.0.0.1:7676";
const accessToken = "context-budget-test-access-token";
const openWorkspaceNeedle = `CONTEXT_BUDGET_OPEN_WORKSPACE_${"o".repeat(256)}`;
const readNeedle = `CONTEXT_BUDGET_READ_${"r".repeat(256)}`;
const batchNeedle = `CONTEXT_BUDGET_BATCH_${"b".repeat(256)}`;
const skillNeedle = `CONTEXT_BUDGET_SKILL_${"s".repeat(256)}`;
const processNeedle = `CONTEXT_BUDGET_PROCESS_${"p".repeat(256)}`;
const httpResponses: Array<{ method: string; status: number }> = [];

await Promise.all([
  mkdir(workspaceRoot, { recursive: true }),
  mkdir(configDir, { recursive: true }),
  mkdir(agentDir, { recursive: true }),
  mkdir(worktreeRoot, { recursive: true }),
  mkdir(join(workspaceRoot, ".agents", "skills", "context-budget"), { recursive: true }),
]);
await writeFile(join(workspaceRoot, "AGENTS.md"), `# Test instructions\n\n${openWorkspaceNeedle}\n`);
await writeFile(join(workspaceRoot, "payload.txt"), `${readNeedle}\n`);
await writeFile(join(workspaceRoot, "batch.txt"), `${batchNeedle}\n`);
await writeFile(
  join(workspaceRoot, ".agents", "skills", "context-budget", "SKILL.md"),
  `---\nname: context-budget\ndescription: Context budget fixture.\n---\n\n${skillNeedle}\n`,
);

const configEnvironment = {
  DEVSPACE_CONFIG_DIR: configDir,
  DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
  DEVSPACE_ALLOWED_HOSTS: "*",
  DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_WORKTREE_ROOT: worktreeRoot,
  DEVSPACE_AGENT_DIR: agentDir,
  DEVSPACE_OAUTH_OWNER_TOKEN: "context-budget-owner-token-long-enough",
  DEVSPACE_WIDGETS: "changes",
  DEVSPACE_LOG_LEVEL: "silent",
};
const config = loadConfig({ ...configEnvironment, DEVSPACE_TOOL_MODE: "codex" });

seedAccessToken(config, stateDir);

const running = createServer(config);
const httpServer = createHttpServer(running.app);
let client: Client | undefined;

try {
  const origin = await listen(httpServer);
  client = new Client({ name: "context-budget-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", origin), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      httpResponses.push({ method: init?.method ?? "GET", status: response.status });
      return response;
    },
  }));

  const instructions = client.getInstructions() ?? "";
  const toolsList = await client.listTools();
  const resourcesList = await client.listResources();
  const openWorkspace = await client.callTool({
    name: "open_workspace",
    arguments: { path: workspaceRoot },
  });
  const workspaceId = String(
    (openWorkspace.structuredContent as { workspaceId?: unknown } | undefined)?.workspaceId ?? "",
  );
  assert.ok(workspaceId, "open_workspace must return a structured workspaceId");
  const read = await client.callTool({
    name: "read",
    arguments: { workspaceId, path: "payload.txt" },
  });
  const staleWorkspaceResponseStart = httpResponses.length;
  const staleWorkspace = await client.callTool({
    name: "read",
    arguments: { workspaceId: "ws_stale_context_budget", path: "payload.txt" },
  });
  const staleWorkspaceResponses = httpResponses.slice(staleWorkspaceResponseStart);
  assert.equal(staleWorkspace.isError, true);
  const staleWorkspaceContent = (
    staleWorkspace as { content?: Array<{ type?: unknown; text?: unknown }> }
  ).content ?? [];
  assert.match(
    staleWorkspaceContent[0]?.type === "text" && typeof staleWorkspaceContent[0].text === "string"
      ? staleWorkspaceContent[0].text
      : "",
    /Unknown workspaceId: ws_stale_context_budget\..*open_workspace with the original exact project path.*replace the old ID/i,
  );
  assert.ok(
    staleWorkspaceResponses.some(({ method, status }) => method === "POST" && status === 200),
    "stale workspace tool errors must remain successful HTTP exchanges",
  );
  const batchRead = await client.callTool({
    name: "batch_read",
    arguments: { workspaceId, files: [{ path: "batch.txt" }] },
  });
  const batchInspect = await client.callTool({
    name: "batch_inspect",
    arguments: { workspaceId, operations: [{ operation: "grep", pattern: batchNeedle, path: "batch.txt" }] },
  });
  const advertisedSkill = (openWorkspace.structuredContent as {
    skills?: Array<{ skillId?: unknown; name?: unknown }>;
  } | undefined)?.skills?.find((skill) => skill.name === "context-budget");
  assert.ok(advertisedSkill?.skillId);
  const loadSkill = await client.callTool({
    name: "load_skill",
    arguments: { workspaceId, skillId: advertisedSkill.skillId },
  });
  const execCommand = await client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: `${JSON.stringify(process.execPath)} -e "process.stdin.pipe(process.stdout)"`,
      stdin: `${processNeedle}\n`,
    },
  });
  const outputId = (execCommand.structuredContent as { outputId?: unknown } | undefined)?.outputId;
  assert.equal(typeof outputId, "string");
  const readProcessOutput = await client.callTool({
    name: "read_process_output",
    arguments: { workspaceId, outputId, offset: 0 },
  });

  const toolCategories = toolsList.tools.reduce(
    (totals, tool) => ({
      descriptions: totals.descriptions + utf8Bytes(tool.description ?? ""),
      inputSchemas: totals.inputSchemas + utf8Bytes(tool.inputSchema),
      outputSchemas: totals.outputSchemas + utf8Bytes(tool.outputSchema),
      remainingDefinition: totals.remainingDefinition + utf8Bytes({
        ...tool,
        description: undefined,
        inputSchema: undefined,
        outputSchema: undefined,
      }),
    }),
    { descriptions: 0, inputSchemas: 0, outputSchemas: 0, remainingDefinition: 0 },
  );
  const measurements = {
    initialize: { instructionsBytes: Buffer.byteLength(instructions, "utf8") },
    toolsList: {
      totalBytes: utf8Bytes(toolsList),
      toolCount: toolsList.tools.length,
      ...toolCategories,
      perTool: Object.fromEntries(toolsList.tools.map((tool) => [tool.name, {
        total: utf8Bytes(tool),
        input: utf8Bytes(tool.inputSchema),
        output: utf8Bytes(tool.outputSchema),
      }])),
    },
    resourcesList: {
      totalBytes: utf8Bytes(resourcesList),
      resourceCount: resourcesList.resources.length,
    },
    openWorkspace: responseMeasurements(openWorkspace, openWorkspaceNeedle),
    read: responseMeasurements(read, readNeedle),
    batchRead: responseMeasurements(batchRead, batchNeedle),
    batchInspect: responseMeasurements(batchInspect, batchNeedle),
    loadSkill: responseMeasurements(loadSkill, skillNeedle),
    execCommand: responseMeasurements(execCommand, processNeedle),
    readProcessOutput: responseMeasurements(readProcessOutput, processNeedle),
  };

  console.log(`MCP context budget: ${JSON.stringify(measurements)}`);

  assert.ok(
    measurements.initialize.instructionsBytes >= 1_300 &&
      measurements.initialize.instructionsBytes <= 1_700,
    `initialize instructions must be 1300-1700 UTF-8 bytes; received ${measurements.initialize.instructionsBytes}`,
  );
  assert.ok(
    measurements.toolsList.totalBytes <= 16_000,
    `tools/list must be at most 16000 UTF-8 bytes; received ${measurements.toolsList.totalBytes}`,
  );
  assert.equal(
    measurements.openWorkspace.heavyFieldCopies,
    1,
    "open_workspace instructions must appear in exactly one of content, structuredContent, or _meta.card.payload",
  );
  assert.equal(
    measurements.read.heavyFieldCopies,
    1,
    "read output must appear in exactly one of content, structuredContent, or _meta.card.payload",
  );
  for (const [name, measurement] of Object.entries({
    batchRead: measurements.batchRead,
    batchInspect: measurements.batchInspect,
    loadSkill: measurements.loadSkill,
    execCommand: measurements.execCommand,
    readProcessOutput: measurements.readProcessOutput,
  })) {
    assert.equal(
      measurement.heavyFieldCopies,
      1,
      `${name} heavy output must appear in exactly one model-visible field`,
    );
  }
  for (const batchResult of [batchRead, batchInspect]) {
    const structured = batchResult.structuredContent as { result?: unknown; items?: unknown } | undefined;
    assert.equal(structured?.result, undefined);
    assert.ok(Array.isArray(structured?.items));
  }
  assert.equal((loadSkill.structuredContent as { content?: unknown } | undefined)?.content, undefined);
  assert.equal((loadSkill._meta as { tool?: unknown } | undefined)?.tool, "load_skill");
  assert.equal((execCommand.structuredContent as { result?: unknown } | undefined)?.result, undefined);
  assert.equal((execCommand._meta as { tool?: unknown } | undefined)?.tool, "exec_command");
  assert.equal((readProcessOutput.structuredContent as { content?: unknown } | undefined)?.content, undefined);

  const fullStateDir = join(root, "state-full");
  const fullConfig = loadConfig({
    ...configEnvironment,
    DEVSPACE_STATE_DIR: fullStateDir,
    DEVSPACE_TOOL_MODE: "full",
  });
  seedAccessToken(fullConfig, fullStateDir);
  const fullDiscovery = await measureDiscovery(fullConfig);
  console.log(`MCP full discovery budget: ${JSON.stringify({ ...fullDiscovery, instructions: undefined })}`);
  assert.ok(
    fullDiscovery.instructionsBytes >= 1_300 && fullDiscovery.instructionsBytes <= 1_700,
    `full initialize instructions must be 1300-1700 UTF-8 bytes; received ${fullDiscovery.instructionsBytes}`,
  );
  assert.ok(
    fullDiscovery.toolsListBytes <= 20_000,
    `full tools/list must be at most 20000 UTF-8 bytes; received ${fullDiscovery.toolsListBytes}`,
  );

  const skillsOffStateDir = join(root, "state-skills-off");
  const skillsOffConfig = loadConfig({
    ...configEnvironment,
    DEVSPACE_STATE_DIR: skillsOffStateDir,
    DEVSPACE_TOOL_MODE: "codex",
    DEVSPACE_SKILLS: "0",
  });
  seedAccessToken(skillsOffConfig, skillsOffStateDir);
  const skillsOffDiscovery = await measureDiscovery(skillsOffConfig);
  assert.equal("load_skill" in skillsOffDiscovery.perTool, false);
  assert.doesNotMatch(skillsOffDiscovery.instructions, /load_skill|matching skill|explicit-only/);
} finally {
  await client?.close().catch(() => undefined);
  await closeHttpServer(httpServer);
  await running.close();
  await rm(root, { recursive: true, force: true });
}

async function measureDiscovery(testConfig: ReturnType<typeof loadConfig>): Promise<{
  instructionsBytes: number;
  instructions: string;
  toolsListBytes: number;
  toolCount: number;
  perTool: Record<string, number>;
}> {
  const testRunning = createServer(testConfig);
  const testHttpServer = createHttpServer(testRunning.app);
  let testClient: Client | undefined;
  try {
    const origin = await listen(testHttpServer);
    testClient = new Client({ name: "context-budget-full-test", version: "1.0.0" });
    await testClient.connect(new StreamableHTTPClientTransport(new URL("/mcp", origin), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    }));
    const tools = await testClient.listTools();
    const instructions = testClient.getInstructions() ?? "";
    return {
      instructions,
      instructionsBytes: Buffer.byteLength(instructions, "utf8"),
      toolsListBytes: utf8Bytes(tools),
      toolCount: tools.tools.length,
      perTool: Object.fromEntries(tools.tools.map((tool) => [tool.name, utf8Bytes(tool)])),
    };
  } finally {
    await testClient?.close().catch(() => undefined);
    await closeHttpServer(testHttpServer);
    await testRunning.close();
  }
}

function seedAccessToken(
  targetConfig: ReturnType<typeof loadConfig>,
  targetStateDir: string,
): void {
  const store = new SqliteOAuthStore(targetStateDir);
  try {
    const oauthClients = new SqliteOAuthClientsStore(store, targetConfig.oauth.allowedRedirectHosts);
    const oauthClient = oauthClients.registerClient({
      redirect_uris: ["http://127.0.0.1/context-budget-callback"],
      client_name: "Context budget test",
    });
    const expiresAt = Math.floor(Date.now() / 1_000) + 3_600;
    const resource = new URL("/mcp", publicBaseUrl).href;
    store.saveTokenPair({
      accessTokenHash: hashToken(accessToken),
      accessToken: {
        clientId: oauthClient.client_id,
        scopes: ["devspace"],
        expiresAt,
        resource,
      },
      refreshTokenHash: hashToken("context-budget-test-refresh-token"),
      refreshToken: {
        clientId: oauthClient.client_id,
        scopes: ["devspace"],
        expiresAt,
        resource,
      },
    });
  } finally {
    store.close();
  }
}

function responseMeasurements(response: unknown, needle: string) {
  const result = response as {
    content?: unknown;
    structuredContent?: unknown;
    _meta?: { card?: { payload?: unknown } };
  };
  const fields = {
    content: result.content,
    structuredContent: result.structuredContent,
    metaPayload: result._meta?.card?.payload,
  };
  return {
    totalBytes: utf8Bytes(response),
    contentBytes: utf8Bytes(fields.content),
    structuredContentBytes: utf8Bytes(fields.structuredContent),
    metaPayloadBytes: utf8Bytes(fields.metaPayload),
    heavyFieldCopies: Object.values(fields).filter((field) => serialized(field).includes(needle)).length,
  };
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(typeof value === "string" ? value : serialized(value), "utf8");
}

function serialized(value: unknown): string {
  if (value === undefined) return "";
  return JSON.stringify(value) ?? "";
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
