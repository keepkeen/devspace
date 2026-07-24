import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Database from "better-sqlite3";
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
const skillReferenceNeedle = `CONTEXT_BUDGET_SKILL_REFERENCE_${"f".repeat(128)}`;
const processNeedle = `CONTEXT_BUDGET_PROCESS_${"p".repeat(256)}`;
const scopedInstructionNeedle = "CONTEXT_BUDGET_SCOPED_INSTRUCTION";
const scopedPayloadNeedle = "CONTEXT_BUDGET_SCOPED_PAYLOAD";
const httpResponses: Array<{ method: string; status: number }> = [];
const execFileAsync = promisify(execFile);

await Promise.all([
  mkdir(workspaceRoot, { recursive: true }),
  mkdir(configDir, { recursive: true }),
  mkdir(agentDir, { recursive: true }),
  mkdir(worktreeRoot, { recursive: true }),
  mkdir(join(workspaceRoot, "nested"), { recursive: true }),
  mkdir(join(workspaceRoot, "read-scope"), { recursive: true }),
  mkdir(join(workspaceRoot, "readonly-project"), { recursive: true }),
  mkdir(join(workspaceRoot, ".agents", "skills", "context-budget", "references"), { recursive: true }),
]);
await writeFile(join(workspaceRoot, "AGENTS.md"), `# Test instructions\n\n${openWorkspaceNeedle}\n`);
await writeFile(join(workspaceRoot, "nested", "AGENTS.md"), "# Nested instructions\n\nKeep nested commands scoped.\n");
await writeFile(join(workspaceRoot, "read-scope", "AGENTS.md"), `${scopedInstructionNeedle}\n`);
await writeFile(join(workspaceRoot, "read-scope", "payload.txt"), `${scopedPayloadNeedle}\n`);
await writeFile(join(workspaceRoot, "payload.txt"), `${readNeedle}\n`);
await writeFile(join(workspaceRoot, "batch.txt"), `${batchNeedle}\n`);
await writeFile(join(workspaceRoot, "readonly-project", "payload.txt"), "readonly payload\n");
await writeFile(join(configDir, "internal.txt"), "private DevSpace state\n");
await writeFile(
  join(workspaceRoot, ".agents", "skills", "context-budget", "SKILL.md"),
  `---\nname: context-budget\ndescription: Context budget fixture.\n---\n\n${skillNeedle}\n`,
);
await writeFile(
  join(workspaceRoot, ".agents", "skills", "context-budget", "references", "example.md"),
  `${skillReferenceNeedle}\n`,
);
await execFileAsync("git", ["init", "-q"], { cwd: workspaceRoot });
await execFileAsync("git", ["add", "."], { cwd: workspaceRoot });
await execFileAsync(
  "git",
  ["-c", "user.name=DevSpace Test", "-c", "user.email=devspace@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"],
  { cwd: workspaceRoot },
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
  DEVSPACE_MAX_COMMAND_RUNTIME_SECONDS: "1",
  DEVSPACE_MAX_MANAGED_WORKTREES: "1",
  DEVSPACE_WIDGETS: "changes",
  DEVSPACE_LOG_LEVEL: "silent",
};
const config = loadConfig(configEnvironment);

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
  enableWorkspaceGenerationTracking(client);

  const instructions = client.getInstructions() ?? "";
  const toolsList = await client.listTools();
  assert.deepEqual(
    toolsList.tools.map((tool) => tool.name).sort(),
    [
      "apply_patch",
      "batch_inspect",
      "batch_read",
      "close_workspace",
      "exec_command",
      "get_operation_status",
      "get_workspace_context",
      "list_skills",
      "list_workspaces",
      "load_skill",
      "load_workspace_instructions",
      "open_workspace",
      "read",
      "read_process_output",
      "resume_workspace",
      "revoke_workspace",
      "show_changes",
      "write_stdin",
    ],
    "tools/list must expose only the fixed DevSpace surface",
  );
  const toolsByName = new Map(toolsList.tools.map((tool) => [tool.name, tool]));
  assert.equal(toolsByName.get("open_workspace")?.outputSchema, undefined);
  assert.doesNotMatch(toolsByName.get("write_stdin")?.description ?? "", /rerun/i);
  for (const tool of toolsList.tools) {
    assert.match(
      tool.description ?? "",
      /^Use when .+ Avoid .+ Needs .+ Returns .+$/,
      `${tool.name} must use the compact routing-description template`,
    );
  }
  const readProcessOutputSchema = JSON.stringify(toolsByName.get("read_process_output")?.outputSchema);
  assert.match(readProcessOutputSchema, /unknown/);
  assert.match(readProcessOutputSchema, /active/);
  assert.doesNotMatch(readProcessOutputSchema, /completed|storedBytes|totalBytes|outputId/);
  const readOutputSchema = JSON.stringify(toolsByName.get("read")?.outputSchema);
  assert.match(readOutputSchema, /contentHash/);
  assert.match(readOutputSchema, /mtimeNs/);
  assert.match(readOutputSchema, /scopedInstructionsAvailable/);
  assert.doesNotMatch(readOutputSchema, /content[^H]/);
  for (const name of [
    "read", "batch_read", "batch_inspect", "load_workspace_instructions", "list_skills",
    "load_skill", "exec_command", "write_stdin", "read_process_output", "apply_patch",
    "close_workspace", "revoke_workspace", "show_changes",
  ]) {
    const schema = toolsByName.get(name)?.inputSchema as { required?: unknown } | undefined;
    assert.ok(Array.isArray(schema?.required) && schema.required.includes("receipt"), `${name} must require receipt`);
    assert.equal(JSON.stringify(schema).includes("workspaceGeneration"), false);
    assert.equal(JSON.stringify(schema).includes("workspaceId"), false);
  }
  const execInputSchema = JSON.stringify(toolsByName.get("exec_command")?.inputSchema);
  assert.match(execInputSchema, /program/);
  assert.match(execInputSchema, /args/);
  assert.match(execInputSchema, /shell/);
  assert.match(execInputSchema, /command/);
  const applyPatchInputSchema = JSON.stringify(toolsByName.get("apply_patch")?.inputSchema);
  assert.match(applyPatchInputSchema, /ifMatch/);
  assert.doesNotMatch(applyPatchInputSchema, /preconditionMode|blindWriteReason/);
  for (const name of [
    "exec_command", "apply_patch", "close_workspace", "revoke_workspace", "show_changes",
  ]) {
    const schema = toolsByName.get(name)?.inputSchema as { required?: unknown } | undefined;
    assert.ok(
      Array.isArray(schema?.required) && schema.required.includes("operationId"),
      `${name} must require operationId`,
    );
  }
  for (const name of ["load_skill", "close_workspace", "apply_patch", "show_changes"]) {
    assert.equal(toolsByName.get(name)?.outputSchema, undefined, `${name} should not advertise a redundant output schema`);
  }
  for (const name of [
    "read",
    "load_skill",
    "batch_read",
    "batch_inspect",
    "apply_patch",
    "exec_command",
    "write_stdin",
    "read_process_output",
  ]) {
    assert.equal(toolsByName.get(name)?._meta, undefined, `${name} should omit empty widget metadata`);
  }
  assert.ok(
    utf8Bytes(toolsList) < 19_000,
    `tools/list must be under 19000 UTF-8 bytes; received ${utf8Bytes(toolsList)} (${toolsList.tools.map((tool) => `${tool.name}=${utf8Bytes(tool)}/${utf8Bytes(tool.inputSchema)}/${utf8Bytes(tool.outputSchema)}`).join(", ")})`,
  );
  const resourcesList = await client.listResources();
  const openMetadata = await client.callTool({
    name: "open_workspace",
    arguments: { path: workspaceRoot, alias: "context-budget", writeAccess: "read_write" },
  });
  assert.equal((openMetadata.structuredContent as { schemaVersion?: unknown } | undefined)?.schemaVersion, 3);
  const metadataWorkspace = (openMetadata.structuredContent as {
    workspace?: { ref?: unknown; generation?: unknown; mode?: unknown; writeAccess?: unknown };
  } | undefined)?.workspace;
  assert.equal(typeof metadataWorkspace?.ref, "string");
  assert.equal(typeof metadataWorkspace?.generation, "number");
  assert.equal(metadataWorkspace?.writeAccess, "read_write");
  const metadataReceipt = String(
    (openMetadata.structuredContent as { receipt?: unknown })?.receipt ?? "",
  );
  assert.match(metadataReceipt, /^wctx3\./);
  assert.deepEqual(
    (openMetadata.structuredContent as { context?: unknown } | undefined)?.context,
    { phase: "metadata" },
  );
  assert.deepEqual(
    (openMetadata.structuredContent as { instructions?: { items?: unknown } } | undefined)
      ?.instructions?.items,
    [],
  );
  assert.equal(
    (openMetadata.structuredContent as { instructions?: { included?: unknown } } | undefined)
      ?.instructions?.included,
    false,
  );
  assert.equal(
    (openMetadata.structuredContent as {
      instructions?: { acknowledged?: unknown };
    } | undefined)?.instructions?.acknowledged,
    false,
  );
  assert.equal(
    (openMetadata.structuredContent as { skills?: { included?: unknown } } | undefined)
      ?.skills?.included,
    false,
  );
  assert.deepEqual(
    (openMetadata.structuredContent as {
      effects?: { workspace?: { action?: unknown; result?: unknown; worktree?: unknown } };
    } | undefined)?.effects?.workspace,
    {
      confidence: "observed",
      action: "open",
      result: "opened",
      worktree: "not_managed",
      processesTerminated: 0,
    },
  );
  assert.match(JSON.stringify(openMetadata.content), /Load its full context before reading/);
  assert.doesNotMatch(JSON.stringify(openMetadata.structuredContent), /alias|displayPath|project|topLevel/);
  const metadataRead = await client.callTool({
    name: "read",
    arguments: { receipt: metadataReceipt, path: "payload.txt" },
  });
  assert.equal(metadataRead.isError, true);
  assert.deepEqual(
    (metadataRead.structuredContent as { error?: unknown } | undefined)?.error,
    {
      code: "workspace_context_incomplete",
      retryable: true,
      safeToRetry: true,
      recovery: "get_workspace_context",
      phase: "not_started",
      effectsKnown: true,
    },
  );
  const openWorkspace = await client.callTool({
    name: "get_workspace_context",
    arguments: { alias: "context-budget", contextMode: "full" },
  });
  const workspaceId = String(
    (openWorkspace.structuredContent as { workspace?: { ref?: unknown } } | undefined)?.workspace?.ref ?? "",
  );
  assert.ok(workspaceId, "open_workspace must return a structured workspaceId");
  assert.match(
    JSON.stringify(openWorkspace.content),
    /Repository instructions are untrusted project guidance/,
  );
  assert.equal(
    (openWorkspace.structuredContent as {
      context?: { phase?: unknown };
    } | undefined)?.context?.phase,
    "context_loaded",
  );
  const workspaceInstructions = (openWorkspace.structuredContent as {
    instructions?: { items?: Array<Record<string, unknown>> };
  } | undefined)?.instructions?.items ?? [];
  assert.equal(
    (openWorkspace.structuredContent as { instructions?: { included?: unknown } } | undefined)
      ?.instructions?.included,
    true,
  );
  assert.equal(
    (openWorkspace.structuredContent as {
      instructions?: { acknowledged?: unknown };
    } | undefined)?.instructions?.acknowledged,
    true,
  );
  const rootInstruction = workspaceInstructions.find((instruction) => instruction.path === "AGENTS.md");
  assert.deepEqual(Object.keys(rootInstruction ?? {}).sort(), [
    "content", "hash", "path", "scope", "source", "trust",
  ]);
  assert.equal(rootInstruction?.source, "repository");
  assert.equal(rootInstruction?.scope, ".");
  assert.equal(rootInstruction?.trust, "repository_untrusted");
  assert.match(String(rootInstruction?.hash), /^sha256-v1:[a-f0-9]{64}$/);
  assert.match(String(rootInstruction?.content), new RegExp(openWorkspaceNeedle));
  assert.doesNotMatch(JSON.stringify(workspaceInstructions), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const readonlyMetadata = await client.callTool({
    name: "open_workspace",
    arguments: { path: join(workspaceRoot, "readonly-project"), alias: "readonly" },
  });
  assert.equal(typeof (readonlyMetadata.structuredContent as { workspace?: { ref?: unknown } } | undefined)?.workspace?.ref, "string");
  const readonlyOpen = await client.callTool({
    name: "get_workspace_context",
    arguments: { alias: "readonly", contextMode: "full" },
  });
  const readonlyWorkspaceId = String(
    (readonlyOpen.structuredContent as { workspace?: { ref?: unknown } } | undefined)?.workspace?.ref ?? "",
  );
  assert.ok(readonlyWorkspaceId);
  assert.equal(
    (readonlyOpen.structuredContent as { workspace?: { writeAccess?: unknown } } | undefined)?.workspace?.writeAccess,
    "read_only",
  );
  const readonlyRead = await client.callTool({
    name: "read",
    arguments: { workspaceId: readonlyWorkspaceId, path: "payload.txt" },
  });
  assert.notEqual(readonlyRead.isError, true);
  const readonlyExec = await client.callTool({
    name: "exec_command",
    arguments: { workspaceId: readonlyWorkspaceId, cmd: "touch denied.txt" },
  });
  assert.equal(readonlyExec.isError, true);
  assert.equal(
    (readonlyExec.structuredContent as { error?: { code?: unknown } } | undefined)?.error?.code,
    "workspace_read_only",
  );
  await assert.rejects(access(join(workspaceRoot, "readonly-project", "denied.txt")), { code: "ENOENT" });
  const advertisedSkill = (openWorkspace.structuredContent as {
    skills?: { items?: Array<Record<string, unknown> & { skillId?: unknown; name?: unknown }> };
  } | undefined)?.skills?.items?.find((skill) => skill.name === "context-budget");
  assert.ok(advertisedSkill?.skillId);
  const unloadedSkillRead = await client.callTool({
    name: "read",
    arguments: { workspaceId, path: ".agents/skills/context-budget/SKILL.md" },
  });
  assert.equal(unloadedSkillRead.isError, true);
  assert.equal(
    toolText(unloadedSkillRead),
    "skill_not_loaded: Call load_skill for this workspace, then retry.",
  );
  const unloadedSkillBatchRead = await client.callTool({
    name: "batch_read",
    arguments: {
      workspaceId,
      files: [{ path: ".agents/skills/context-budget/SKILL.md" }],
    },
  });
  assert.equal(unloadedSkillBatchRead.isError, true);
  assert.equal(
    (unloadedSkillBatchRead.structuredContent as {
      items?: Array<{ result?: unknown }>;
    } | undefined)?.items?.[0]?.result,
    "skill_not_loaded: Call load_skill for this workspace, then retry.",
  );
  const instructionRevision = String(
    (openWorkspace.structuredContent as { instructions?: { revision?: unknown } } | undefined)
      ?.instructions?.revision ?? "",
  );
  assert.ok(instructionRevision, "open_workspace must return an instructionRevision");
  const skillRevision = String(
    (openWorkspace.structuredContent as { skills?: { revision?: unknown } } | undefined)?.skills?.revision ?? "",
  );
  assert.ok(skillRevision, "open_workspace must return a skillRevision");
  const defaultFullReopen = await client.callTool({
    name: "get_workspace_context",
    arguments: {
      alias: "context-budget",
      knownInstructionRevision: instructionRevision,
      knownSkillRevision: skillRevision,
    },
  });
  assert.ok(
    ((defaultFullReopen.structuredContent as { instructions?: { items?: unknown[] } } | undefined)
      ?.instructions?.items?.length ?? 0) > 0,
    "revision hints must not suppress context unless retained mode is explicit",
  );
  const repeatedOpenWorkspace = await client.callTool({
    name: "get_workspace_context",
    arguments: {
      alias: "context-budget",
      contextMode: "retained",
      knownInstructionRevision: instructionRevision,
      knownSkillRevision: skillRevision,
    },
  });
  assert.equal(
    (repeatedOpenWorkspace.structuredContent as { workspace?: { ref?: unknown } } | undefined)?.workspace?.ref,
    workspaceId,
    "reopening the same path must reuse its workspace",
  );
  assert.deepEqual(
    (repeatedOpenWorkspace.structuredContent as { instructions?: { items?: unknown } } | undefined)?.instructions?.items,
    [],
  );
  assert.deepEqual(
    (repeatedOpenWorkspace.structuredContent as { skills?: { items?: unknown } } | undefined)?.skills?.items,
    [],
  );
  const instructionsOnlySuppressed = await client.callTool({
    name: "get_workspace_context",
    arguments: {
      alias: "context-budget",
      contextMode: "retained",
      knownInstructionRevision: instructionRevision,
    },
  });
  assert.deepEqual(
    (instructionsOnlySuppressed.structuredContent as { instructions?: { items?: unknown } } | undefined)?.instructions?.items,
    [],
  );
  assert.ok(((instructionsOnlySuppressed.structuredContent as { skills?: { items?: unknown[] } } | undefined)?.skills?.items?.length ?? 0) > 0);
  const skillsOnlySuppressed = await client.callTool({
    name: "get_workspace_context",
    arguments: {
      alias: "context-budget",
      contextMode: "retained",
      knownSkillRevision: skillRevision,
    },
  });
  assert.ok(((skillsOnlySuppressed.structuredContent as { instructions?: { items?: unknown[] } } | undefined)?.instructions?.items?.length ?? 0) > 0);
  assert.deepEqual(
    (skillsOnlySuppressed.structuredContent as { skills?: { items?: unknown } } | undefined)?.skills?.items,
    [],
  );
  const firstOpenText = toolText(openWorkspace);
  assert.equal(firstOpenText.match(/nested instructions load/gi)?.length, undefined);
  assert.match(firstOpenText, /^Workspace context loaded\./);
  assert.doesNotMatch(firstOpenText, new RegExp(workspaceId));
  assert.doesNotMatch(firstOpenText, new RegExp(workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const repeatedOpenText = toolText(repeatedOpenWorkspace);
  assert.equal(repeatedOpenText, firstOpenText);
  const deniedWorkspaceOpen = await client.callTool({
    name: "open_workspace",
    arguments: { path: configDir },
  });
  assert.equal(deniedWorkspaceOpen.isError, true);
  assert.match(toolText(deniedWorkspaceOpen), /^path_not_allowed:/);
  assert.doesNotMatch(toolText(deniedWorkspaceOpen), new RegExp(configDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const failedWorkspaceOpen = await client.callTool({
    name: "open_workspace",
    arguments: { path: join(workspaceRoot, "payload.txt") },
  });
  assert.equal(failedWorkspaceOpen.isError, true);
  assert.match(toolText(failedWorkspaceOpen), /^tool_failed:/);
  assert.doesNotMatch(toolText(failedWorkspaceOpen), /payload\.txt/);
  const read = await client.callTool({
    name: "read",
    arguments: { workspaceId, path: "payload.txt" },
  });
  const scopedRead = await client.callTool({
    name: "read",
    arguments: { workspaceId, path: "read-scope/payload.txt" },
  });
  assert.notEqual(scopedRead.isError, true);
  const scopedReadBlocks = textBlocks(scopedRead);
  assert.equal(scopedReadBlocks.length, 1);
  assert.match(scopedReadBlocks[0]?.text ?? "", new RegExp(scopedPayloadNeedle));
  assert.doesNotMatch(toolText(scopedRead), new RegExp(scopedInstructionNeedle));
  assert.equal(
    (scopedRead.structuredContent as { scopedInstructionsAvailable?: unknown } | undefined)
      ?.scopedInstructionsAvailable,
    true,
  );
  assert.doesNotMatch(toolText(scopedRead), /instructionToken=/);
  const repeatedScopedRead = await client.callTool({
    name: "read",
    arguments: { workspaceId, path: "read-scope/payload.txt" },
  });
  assert.equal(
    (repeatedScopedRead.structuredContent as { scopedInstructionsAvailable?: unknown } | undefined)
      ?.scopedInstructionsAvailable,
    true,
  );
  const loadedScopedInstructions = await client.callTool({
    name: "load_workspace_instructions",
    arguments: { workspaceId, paths: ["read-scope/payload.txt"] },
  });
  assert.match(JSON.stringify(loadedScopedInstructions.structuredContent), new RegExp(scopedInstructionNeedle));
  assert.match(
    String((loadedScopedInstructions.structuredContent as { instructionToken?: unknown }).instructionToken),
    /^instructions_/,
  );
  const staleWorkspaceResponseStart = httpResponses.length;
  const staleWorkspace = await client.callTool({
    name: "read",
    arguments: { receipt: `wctx3.${"A".repeat(43)}`, path: "payload.txt" },
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
    /^workspace_context_required:/i,
  );
  assert.doesNotMatch(toolText(staleWorkspace), /ws_stale_context_budget/);
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
  const partialBatchRead = await client.callTool({
    name: "batch_read",
    arguments: { workspaceId, files: [{ ref: "present", path: "batch.txt" }, { ref: "missing", path: "missing-partial.txt" }] },
  });
  assert.notEqual(partialBatchRead.isError, true);
  assert.match(toolText(partialBatchRead), /partial: 1 failed/i);
  const partialReadStructured = partialBatchRead.structuredContent as {
    status?: unknown;
    succeeded?: unknown;
    failed?: unknown;
    items?: Array<{ ref?: unknown; ok?: unknown; result?: unknown }>;
  };
  assert.equal(partialReadStructured.status, "partial");
  assert.equal(partialReadStructured.succeeded, 1);
  assert.equal(partialReadStructured.failed, 1);
  assert.deepEqual(partialReadStructured.items?.map(({ ref, ok }) => ({ ref, ok })), [
    { ref: "present", ok: true },
    { ref: "missing", ok: false },
  ]);
  assert.match(String(partialReadStructured.items?.[1]?.result), /\[workspace\]\/missing-partial\.txt/);
  const failedBatchRead = await client.callTool({
    name: "batch_read",
    arguments: { workspaceId, files: [{ path: "missing-one.txt" }, { path: "missing-two.txt" }] },
  });
  assert.equal(failedBatchRead.isError, true);
  assert.match(toolText(failedBatchRead), /Batch read failed/i);
  assert.doesNotMatch(JSON.stringify(failedBatchRead.structuredContent), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const partialBatchInspect = await client.callTool({
    name: "batch_inspect",
    arguments: {
      workspaceId,
      operations: [
        { operation: "grep", ref: "match", pattern: batchNeedle, path: "batch.txt" },
        { operation: "ls", ref: "missing", path: "missing-partial-dir" },
      ],
    },
  });
  assert.notEqual(partialBatchInspect.isError, true);
  assert.match(toolText(partialBatchInspect), /partial: 1 failed/i);
  assert.equal(
    (partialBatchInspect.structuredContent as { status?: unknown } | undefined)?.status,
    "partial",
  );
  assert.deepEqual(
    (partialBatchInspect.structuredContent as { items?: Array<{ ref?: unknown }> } | undefined)
      ?.items?.map((item) => item.ref),
    ["match", "missing"],
  );
  const failedBatchInspect = await client.callTool({
    name: "batch_inspect",
    arguments: {
      workspaceId,
      operations: [
        { operation: "ls", path: "missing-one-dir" },
        { operation: "ls", path: "missing-two-dir" },
      ],
    },
  });
  assert.equal(failedBatchInspect.isError, true);
  assert.match(toolText(failedBatchInspect), /Batch inspection failed/i);
  assert.deepEqual(Object.keys(advertisedSkill).sort(), ["description", "name", "skillId"]);
  assert.doesNotMatch(JSON.stringify(advertisedSkill), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const listedSkills = await client.callTool({
    name: "list_skills",
    arguments: { workspaceId, query: "context-budget", limit: 10 },
  });
  assert.equal(
    (listedSkills.structuredContent as { total?: unknown } | undefined)?.total,
    1,
  );
  assert.equal(
    (listedSkills.structuredContent as { skills?: Array<{ skillId?: unknown }> } | undefined)
      ?.skills?.[0]?.skillId,
    advertisedSkill.skillId,
  );
  assert.doesNotMatch(JSON.stringify(listedSkills.structuredContent), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const loadSkill = await client.callTool({
    name: "load_skill",
    arguments: { workspaceId, skillId: advertisedSkill.skillId },
  });
  assert.match(toolText(loadSkill), new RegExp(`skill://${advertisedSkill.skillId}/<relative-path>`));
  const skillReferenceRead = await client.callTool({
    name: "read",
    arguments: {
      workspaceId,
      path: `skill://${advertisedSkill.skillId}/references/example.md`,
    },
  });
  assert.notEqual(skillReferenceRead.isError, true);
  assert.match(toolText(skillReferenceRead), new RegExp(skillReferenceNeedle));
  const skillReferenceBatchRead = await client.callTool({
    name: "batch_read",
    arguments: {
      workspaceId,
      files: [{ path: `skill://${advertisedSkill.skillId}/references/example.md` }],
    },
  });
  assert.notEqual(skillReferenceBatchRead.isError, true);
  assert.match(
    String((skillReferenceBatchRead.structuredContent as {
      items?: Array<{ result?: unknown }>;
    } | undefined)?.items?.[0]?.result ?? ""),
    new RegExp(skillReferenceNeedle),
  );
  const skillManifestPath = join(workspaceRoot, ".agents", "skills", "context-budget", "SKILL.md");
  await writeFile(
    skillManifestPath,
    "---\nname: context-budget\ndescription: Changed after discovery.\n---\n",
  );
  const changedSkill = await client.callTool({
    name: "load_skill",
    arguments: { workspaceId, skillId: advertisedSkill.skillId },
  });
  assert.equal(changedSkill.isError, true);
  assert.equal(
    ((changedSkill.structuredContent as { error?: { code?: unknown } } | undefined)?.error?.code),
    "skill_manifest_changed",
  );
  await writeFile(
    skillManifestPath,
    `---\nname: context-budget\ndescription: Context budget fixture.\n---\n\n${skillNeedle}\n`,
  );
  const rootInstructionLoad = await client.callTool({
    name: "load_workspace_instructions",
    arguments: { workspaceId, paths: ["."] },
  });
  assert.equal(
    (rootInstructionLoad.structuredContent as { instructionToken?: unknown } | undefined)
      ?.instructionToken,
    undefined,
  );
  assert.deepEqual(
    (rootInstructionLoad.structuredContent as {
      instructions?: { items?: unknown[] };
    } | undefined)?.instructions?.items,
    [],
  );
  const execCommand = await client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: `${JSON.stringify(process.execPath)} -e "process.stdin.pipe(process.stdout)"`,
      stdin: `${processNeedle}\n`,
    },
  });
  assert.equal((execCommand.structuredContent as { ok?: unknown })?.ok, true);
  assert.equal((execCommand.structuredContent as { status?: unknown })?.status, "exited");
  assert.equal((execCommand.structuredContent as { commandExecuted?: unknown })?.commandExecuted, true);
  assert.equal(
    (execCommand.structuredContent as { effects?: { process?: { action?: unknown } } })?.effects?.process?.action,
    "start",
  );
  const heredocShellInput = await client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: "bash",
      stdin: "cat <<'EOF'\ncd \"$TARGET\"\nEOF\n",
    },
  });
  assert.notEqual(heredocShellInput.isError, true);
  assert.match(toolText(heredocShellInput), /cd "\$TARGET"/);
  assert.match(toolText(heredocShellInput), /Process exited \(code 0\)/);
  const deniedCommand = await client.callTool({
    name: "exec_command",
    arguments: { workspaceId, cmd: "sudo true" },
  });
  assert.equal(deniedCommand.isError, true);
  assert.match(toolText(deniedCommand), /^No command was executed\./);
  assert.match(JSON.stringify(deniedCommand.content), /blocked by command policy/i);
  assert.equal(
    (deniedCommand.structuredContent as { error?: { phase?: unknown } } | undefined)
      ?.error?.phase,
    "not_started",
  );
  assert.equal(
    (deniedCommand.structuredContent as { operation?: { phase?: unknown } } | undefined)
      ?.operation?.phase,
    "not_started",
  );
  assert.equal(
    (deniedCommand.structuredContent as { operation?: { effectsKnown?: unknown } } | undefined)
      ?.operation?.effectsKnown,
    true,
  );

  for (const [args, expected] of [
    [["sudo", "id"], /sudo|command_blocked/i],
    [["rm", "-rf", root], /outside the workspace|command_write_outside_workspace/i],
  ] as const) {
    const wrappedDenial = await client.callTool({
      name: "exec_command",
      arguments: { workspaceId, program: "env", args },
    });
    assert.equal(wrappedDenial.isError, true);
    assert.match(toolText(wrappedDenial), expected);
  }
  const wrappedOutsideDirectory = await client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      program: "env",
      args: ["--chdir", root, "touch", "argv-wrapper-outside.txt"],
    },
  });
  assert.equal(wrappedOutsideDirectory.isError, true);
  assert.match(toolText(wrappedOutsideDirectory), /wrapper path leaves the workspace/i);
  for (const [program, args, expected] of [
    ["env", [`-C${root}`, "touch", "argv-wrapper-attached.txt"], /wrapper path leaves/i],
    ["time", [`-o${join(root, "time.txt")}`, "true"], /wrapper path leaves/i],
    ["cp", [`-t${root}`, "nested/fixture.txt"], /outside the workspace|target directory leaves/i],
    ["mv", [`--target-directory=${root}`, "nested/fixture.txt"], /outside the workspace|target directory leaves/i],
  ] as const) {
    const attachedPathDenial = await client.callTool({
      name: "exec_command",
      arguments: { workspaceId, program, args },
    });
    assert.equal(attachedPathDenial.isError, true);
    assert.match(toolText(attachedPathDenial), expected);
  }

  for (const directShell of [
    { program: "bash", args: [] },
    { program: "ash", args: [] },
    { program: "fish", args: [] },
    { program: "env", args: ["bash"] },
    { program: "env", args: ["fish"] },
    { program: "busybox", args: ["sh"] },
    { program: "busybox", args: ["env", "sh"] },
    { program: "toybox", args: ["ash"] },
    { program: "toybox", args: ["env", "fish"] },
  ]) {
    const directShellDenial = await client.callTool({
      name: "exec_command",
      arguments: { workspaceId, ...directShell },
    });
    assert.equal(directShellDenial.isError, true);
    assert.match(toolText(directShellDenial), /explicit_shell_required|interactive shell programs/i);
    assert.equal(
      (directShellDenial._meta as { error?: { phase?: unknown } } | undefined)?.error?.phase,
      "not_started",
    );
  }

  const timedOutCommand = await client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`,
      timeoutMs: 50,
      yieldTimeMs: 2_000,
    },
  });
  assert.notEqual(timedOutCommand.isError, true);
  assert.equal(
    (timedOutCommand.structuredContent as { timedOut?: unknown } | undefined)?.timedOut,
    true,
  );
  assert.match(JSON.stringify(timedOutCommand.content), /runtime limit/i);

  const activeCommand = await client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: `${JSON.stringify(process.execPath)} -e "process.stdout.write('active-status'); setTimeout(() => {}, 500)"`,
      yieldTimeMs: 100,
    },
  });
  assert.equal(
    (activeCommand.structuredContent as { running?: unknown } | undefined)?.running,
    undefined,
  );
  const activeSessionId = (activeCommand.structuredContent as { sessionId?: unknown } | undefined)
    ?.sessionId;
  assert.equal(typeof activeSessionId, "number");
  const initialActiveKeys = Object.keys(
    (activeCommand.structuredContent ?? {}) as Record<string, unknown>,
  ).sort();
  assert.deepEqual(
    initialActiveKeys,
    [
      "commandExecuted", "context", "effects", "ok", "operation",
      ...(
        typeof (activeCommand.structuredContent as { outputId?: unknown } | undefined)?.outputId === "string"
          ? ["outputId"]
          : []
      ),
      "sessionId", "status", "workspace",
    ].sort(),
  );
  let currentActiveProcess = activeCommand;
  const activeOutputDeadline = Date.now() + 2_000;
  while (
    typeof (currentActiveProcess.structuredContent as { outputId?: unknown } | undefined)?.outputId !== "string" &&
    Date.now() < activeOutputDeadline
  ) {
    currentActiveProcess = await client.callTool({
      name: "write_stdin",
      arguments: { workspaceId, sessionId: activeSessionId, yieldTimeMs: 50 },
    });
  }
  const activeOutputId = (currentActiveProcess.structuredContent as { outputId?: unknown } | undefined)
    ?.outputId;
  assert.equal(typeof activeOutputId, "string");
  const activeProcessOutput = await client.callTool({
    name: "read_process_output",
    arguments: { workspaceId, outputId: activeOutputId, offset: 0 },
  });
  assert.equal(
    (activeProcessOutput.structuredContent as { status?: unknown } | undefined)?.status,
    "active",
  );
  assert.deepEqual(
    Object.keys((activeProcessOutput.structuredContent ?? {}) as Record<string, unknown>).sort(),
    ["context", "nextOffset", "ok", "status", "workspace"],
  );
  assert.match(toolText(activeProcessOutput), /active-status/s);
  assert.doesNotMatch(toolText(activeProcessOutput), /current end|poll offset|more: offset/i);
  await client.callTool({
    name: "write_stdin",
    arguments: { workspaceId, sessionId: activeSessionId, yieldTimeMs: 1_000 },
  });
  const unknownProcessSession = await client.callTool({
    name: "write_stdin",
    arguments: { workspaceId, sessionId: activeSessionId },
  });
  assert.equal(unknownProcessSession.isError, true);
  assert.match(toolText(unknownProcessSession), /^unknown_process_session:/);
  assert.doesNotMatch(toolText(unknownProcessSession), new RegExp(String(activeSessionId)));
  assert.equal(
    (unknownProcessSession._meta as { error?: { code?: unknown } } | undefined)?.error?.code,
    "unknown_process_session",
  );

  const missingProcessOutput = await client.callTool({
    name: "read_process_output",
    arguments: { workspaceId, outputId: "output_missing_context_budget", offset: 0 },
  });
  assert.equal(missingProcessOutput.isError, true);
  assert.match(toolText(missingProcessOutput), /^process_output_not_found:/);
  assert.doesNotMatch(toolText(missingProcessOutput), /output_missing_context_budget/);

  const overLimitCommand = await client.callTool({
    name: "exec_command",
    arguments: { workspaceId, cmd: "echo should-not-run", timeoutMs: 1_001 },
  });
  assert.equal(overLimitCommand.isError, true);
  assert.match(JSON.stringify(overLimitCommand.content), /1000|maximum|too_big/i);

  const outsideWrite = await client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: `printf blocked > ${JSON.stringify(join(root, "outside.txt"))}`,
    },
  });
  assert.equal(outsideWrite.isError, true);
  assert.match(toolText(outsideWrite), /^No command was executed\./);
  assert.match(JSON.stringify(outsideWrite.content), /outside the workspace/i);
  assert.match(toolText(outsideWrite), /inside the workspace|stdout.*outputId/is);
  assert.match(toolText(outsideWrite), /Splitting the command will not/is);

  const protectedRead = await client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: `cat ${JSON.stringify(join(configDir, "internal.txt"))}`,
    },
  });
  assert.equal(protectedRead.isError, true);
  assert.match(toolText(protectedRead), /protected DevSpace internal state/i);
  assert.match(toolText(protectedRead), /workspaceId.*do not inspect/is);

  const protectedInitialStdin = await client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: "bash",
      stdin: `cat ${JSON.stringify(join(configDir, "internal.txt"))}\n`,
      closeStdin: true,
    },
  });
  assert.equal(protectedInitialStdin.isError, true);
  assert.match(toolText(protectedInitialStdin), /protected DevSpace internal state/i);

  const interactiveShell = await client.callTool({
    name: "exec_command",
    arguments: { workspaceId, cmd: "bash", yieldTimeMs: 0 },
  });
  const interactiveSessionId = (interactiveShell.structuredContent as { sessionId?: unknown } | undefined)
    ?.sessionId;
  assert.equal(typeof interactiveSessionId, "number");
  const missingWriteStdinOperationId = await client.callTool({
    name: "write_stdin",
    arguments: {
      workspaceId,
      sessionId: interactiveSessionId,
      chars: "printf should-not-run\\n",
      __skipAutoOperationId: true,
    },
  });
  assert.equal(missingWriteStdinOperationId.isError, true);
  assert.equal(
    (missingWriteStdinOperationId.structuredContent as {
      error?: { code?: unknown; phase?: unknown; effectsKnown?: unknown };
    } | undefined)?.error?.code,
    "operation_id_required",
  );
  assert.equal(
    (missingWriteStdinOperationId.structuredContent as {
      error?: { phase?: unknown };
    } | undefined)?.error?.phase,
    "not_started",
  );
  assert.equal(
    (missingWriteStdinOperationId.structuredContent as {
      error?: { effectsKnown?: unknown };
    } | undefined)?.error?.effectsKnown,
    true,
  );
  const protectedInteractiveInput = await client.callTool({
    name: "write_stdin",
    arguments: {
      workspaceId,
      sessionId: interactiveSessionId,
      chars: `cat ${JSON.stringify(join(configDir, "internal.txt"))}\n`,
    },
  });
  assert.equal(protectedInteractiveInput.isError, true);
  assert.match(toolText(protectedInteractiveInput), /protected DevSpace internal state/i);
  await client.callTool({
    name: "write_stdin",
    arguments: { workspaceId, sessionId: interactiveSessionId, chars: "exit\n", yieldTimeMs: 1_000 },
  });

  const nestedGate = await client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      operationId: "nested-instruction-once",
      cmd: "pwd",
      workingDirectory: "nested",
    },
  });
  assert.equal(nestedGate.isError, true);
  const nestedGateText = JSON.stringify(nestedGate.content);
  assert.match(
    nestedGateText,
    /Call load_workspace_instructions/,
  );
  assert.doesNotMatch(nestedGateText, /Nested instructions/);
  const nestedInstructionLoad = await client.callTool({
    name: "load_workspace_instructions",
    arguments: { workspaceId, paths: ["nested"] },
  });
  const instructionToken = String(
    (nestedInstructionLoad.structuredContent as { instructionToken?: unknown } | undefined)?.instructionToken ?? "",
  );
  assert.ok(instructionToken, "nested instruction gate must return an acknowledgement token");
  const nestedRetry = await client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      instructionToken,
      operationId: "nested-instruction-once",
      cmd: "pwd",
      workingDirectory: "nested",
    },
  });
  assert.notEqual(nestedRetry.isError, true);
  assert.match(JSON.stringify(nestedRetry.content), /nested/);
  const nestedReplay = await client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      instructionToken,
      operationId: "nested-instruction-once",
      cmd: "pwd",
      workingDirectory: "nested",
    },
  });
  assert.notEqual(nestedReplay.isError, true, "a consumed instruction token must not block operation replay");
  const strictPatchOperationId = "strict-precondition-add";
  const strictPatchText =
    "*** Begin Patch\n*** Add File: strict-precondition.txt\n+strict\n*** End Patch";
  const missingStrictPrecondition = await client.callTool({
    name: "apply_patch",
    arguments: {
      workspaceId,
      operationId: strictPatchOperationId,
      patch: strictPatchText,
    },
  });
  assert.equal(missingStrictPrecondition.isError, true);
  assert.equal(
    (missingStrictPrecondition.structuredContent as {
      error?: { code?: unknown; effectsKnown?: unknown };
    } | undefined)?.error?.code,
    "if_match_required",
  );
  assert.equal(
    (missingStrictPrecondition.structuredContent as {
      error?: { effectsKnown?: unknown };
    } | undefined)?.error?.effectsKnown,
    true,
  );
  assert.deepEqual(
    (missingStrictPrecondition.structuredContent as { operation?: unknown } | undefined)?.operation,
    {
      id: strictPatchOperationId,
      phase: "not_started",
      safeToRetry: true,
      effectsKnown: true,
    },
  );
  await assert.rejects(access(join(workspaceRoot, "strict-precondition.txt")), /ENOENT/);
  const strictPatchArguments = {
    workspaceId,
    operationId: strictPatchOperationId,
    ifMatch: { "strict-precondition.txt": null },
    patch: strictPatchText,
  };
  const strictPatch = await client.callTool({
    name: "apply_patch",
    arguments: strictPatchArguments,
  });
  assert.notEqual(strictPatch.isError, true);
  assert.deepEqual(
    (strictPatch.structuredContent as { preconditions?: unknown } | undefined)?.preconditions,
    { complete: true },
  );
  assert.deepEqual(
    (strictPatch.structuredContent as { operation?: unknown } | undefined)?.operation,
    {
      id: strictPatchOperationId,
      phase: "committed",
      safeToRetry: false,
      effectsKnown: true,
    },
  );
  const strictPatchReplay = await client.callTool({
    name: "apply_patch",
    arguments: strictPatchArguments,
  });
  assert.notEqual(strictPatchReplay.isError, true);
  assert.equal(await readFile(join(workspaceRoot, "strict-precondition.txt"), "utf8"), "strict\n");

  const invalidPatch = await client.callTool({
    name: "apply_patch",
    arguments: {
      workspaceId,
      ifMatch: String(
        (read.structuredContent as { contentHash?: unknown } | undefined)?.contentHash ?? "",
      ),
      patch: "*** Begin Patch\n*** Update File: payload.txt\n@@\n-context that is absent\n+replacement\n*** End Patch",
    },
  });
  assert.equal(invalidPatch.isError, true);
  assert.match(toolText(invalidPatch), /^invalid_patch: could not find hunk context in payload\.txt/);
  assert.equal(
    (invalidPatch.structuredContent as { error?: { recovery?: unknown } } | undefined)?.error?.recovery,
    "read",
  );
  assert.equal(
    (invalidPatch.structuredContent as { error?: { phase?: unknown } } | undefined)?.error?.phase,
    "not_started",
  );
  const invalidInstructionToken = await client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      instructionToken: "instructions_missing_context_budget",
      operationId: "invalid-instruction-token-recovery",
      cmd: "pwd",
      workingDirectory: "nested",
    },
  });
  assert.equal(invalidInstructionToken.isError, true);
  assert.match(toolText(invalidInstructionToken), /^instruction_token_invalid:/);
  assert.doesNotMatch(toolText(invalidInstructionToken), /instructions_missing_context_budget/);
  const recoveredInvalidInstructionToken = await client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      operationId: "invalid-instruction-token-recovery",
      cmd: "pwd",
      workingDirectory: "nested",
    },
  });
  assert.notEqual(
    recoveredInvalidInstructionToken.isError,
    true,
    "an invalid instruction token must release a not-started operationId",
  );

  const background = await client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: `${JSON.stringify(process.execPath)} -e "setTimeout(() => console.log('background-ok'), 50)"`,
      yieldTimeMs: 0,
    },
  });
  const backgroundSessionId = (background.structuredContent as { sessionId?: unknown } | undefined)
    ?.sessionId;
  assert.equal(typeof backgroundSessionId, "number");
  const backgroundResult = await client.callTool({
    name: "write_stdin",
    arguments: { workspaceId, sessionId: backgroundSessionId, yieldTimeMs: 1_000 },
  });
  assert.match(JSON.stringify(backgroundResult.content), /background-ok/);
  const dirtyWorkspace = await client.callTool({
    name: "open_workspace",
    arguments: { path: workspaceRoot, mode: "worktree", contextMode: "full" },
  });
  const dirtyWorkspaceId = String(
    (dirtyWorkspace.structuredContent as { workspace?: { ref?: unknown } } | undefined)?.workspace?.ref ?? "",
  );
  assert.ok(dirtyWorkspaceId);
  assert.equal(
    (dirtyWorkspace.structuredContent as {
      effects?: { workspace?: { result?: unknown; worktree?: unknown } };
    } | undefined)?.effects?.workspace?.worktree,
    "created",
  );
  const deduplicatedWorktree = await client.callTool({
    name: "open_workspace",
    arguments: { path: workspaceRoot, mode: "worktree", contextMode: "full" },
  });
  assert.equal(
    (deduplicatedWorktree.structuredContent as { workspace?: { ref?: unknown } } | undefined)?.workspace?.ref,
    dirtyWorkspaceId,
  );
  assert.deepEqual(
    (deduplicatedWorktree.structuredContent as {
      effects?: { workspace?: { result?: unknown; worktree?: unknown } };
    } | undefined)?.effects?.workspace,
    {
      confidence: "observed",
      action: "open",
      result: "reused",
      worktree: "reused",
      processesTerminated: 0,
    },
  );
  const forcedWorktreeQuota = await client.callTool({
    name: "open_workspace",
    arguments: { path: workspaceRoot, mode: "worktree", forceNew: true },
  });
  assert.equal(forcedWorktreeQuota.isError, true);
  assert.match(toolText(forcedWorktreeQuota), /^managed_worktree_quota:/);
  assert.equal(
    (forcedWorktreeQuota.structuredContent as { error?: { recovery?: unknown } } | undefined)?.error?.recovery,
    "close_workspace",
  );
  const invalidBaseRef = await client.callTool({
    name: "open_workspace",
    arguments: { path: workspaceRoot, mode: "worktree", baseRef: "missing-ref-for-context-budget" },
  });
  assert.equal(invalidBaseRef.isError, true);
  assert.match(toolText(invalidBaseRef), /^git_invalid_base_ref:/);
  assert.doesNotMatch(toolText(invalidBaseRef), new RegExp(workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const listedManagedWorkspace = ((await client.callTool({
    name: "list_workspaces",
    arguments: {},
  })).structuredContent as {
    workspaces?: Array<{ managed?: unknown; dirtySource?: unknown }>;
  } | undefined)?.workspaces?.find((candidate) => candidate.managed === true);
  assert.equal(typeof listedManagedWorkspace?.dirtySource, "boolean");
  assert.equal(
    "project" in ((dirtyWorkspace.structuredContent ?? {}) as Record<string, unknown>),
    false,
  );
  assert.equal(
    "root" in ((dirtyWorkspace.structuredContent ?? {}) as Record<string, unknown>),
    false,
    "workspace responses must not expose absolute host roots",
  );
  const dirtyInstructionLoad = await client.callTool({
    name: "load_workspace_instructions",
    arguments: { workspaceId: dirtyWorkspaceId, paths: ["."] },
  });
  assert.equal(
    (dirtyInstructionLoad.structuredContent as { instructionToken?: unknown } | undefined)
      ?.instructionToken,
    undefined,
  );
  const dirtyPwd = await client.callTool({
    name: "exec_command",
    arguments: { workspaceId: dirtyWorkspaceId, cmd: "pwd" },
  });
  const dirtyWorkspaceRoot = toolText(dirtyPwd).split("\n")[0]?.trim() ?? "";
  assert.ok(dirtyWorkspaceRoot);
  const siblingManagedRead = await client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: `cat ${JSON.stringify(join(dirtyWorkspaceRoot, "AGENTS.md"))}`,
    },
  });
  assert.equal(siblingManagedRead.isError, true);
  assert.match(toolText(siblingManagedRead), /protected DevSpace internal state/i);
  const managedRead = await client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId: dirtyWorkspaceId,
      cmd: `cat ${JSON.stringify(join(dirtyWorkspaceRoot, "AGENTS.md"))}`,
    },
  });
  assert.notEqual(managedRead.isError, true);
  const dirtyWrite = await client.callTool({
    name: "exec_command",
    arguments: { workspaceId: dirtyWorkspaceId, cmd: "printf dirty > dirty.txt" },
  });
  assert.notEqual(dirtyWrite.isError, true);
  const dirtyBackground = await client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId: dirtyWorkspaceId,
      cmd: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`,
      yieldTimeMs: 0,
    },
  });
  assert.equal(
    typeof (dirtyBackground.structuredContent as { sessionId?: unknown } | undefined)?.sessionId,
    "number",
  );
  const dirtyCloseArguments = {
    workspaceId: dirtyWorkspaceId,
    operationId: "dirty-worktree-close",
  };
  const dirtyClose = await client.callTool({
    name: "close_workspace",
    arguments: dirtyCloseArguments,
  });
  assert.equal(dirtyClose.isError, true);
  assert.equal(
    (dirtyClose.structuredContent as { ok?: unknown } | undefined)?.ok,
    false,
  );
  assert.equal(
    typeof (dirtyClose.structuredContent as { error?: { code?: unknown } } | undefined)?.error?.code,
    "string",
  );
  assert.deepEqual(
    (dirtyClose.structuredContent as { error?: unknown } | undefined)?.error,
    {
      code: "workspace_dirty",
      retryable: false,
      safeToRetry: false,
      recovery: "show_changes",
      phase: "committed",
      effectsKnown: true,
    },
  );
  assert.deepEqual((dirtyClose._meta as { card?: { summary?: unknown } } | undefined)?.card?.summary, {
    closed: false,
    processesTerminated: 1,
    worktreeRemoved: false,
    reason: "dirty",
  });
  assert.match(
    toolText(dirtyClose),
    /Workspace remains open: dirty worktree retained; 1 process\(es\) terminated\./,
  );
  const dirtyCloseReplay = await client.callTool({
    name: "close_workspace",
    arguments: dirtyCloseArguments,
  });
  assert.equal(dirtyCloseReplay.isError, true);
  assert.deepEqual(
    (dirtyCloseReplay.structuredContent as { operation?: unknown } | undefined)?.operation,
    {
      id: dirtyCloseArguments.operationId,
      phase: "committed",
      safeToRetry: false,
      effectsKnown: true,
    },
  );
  assert.equal(
    (dirtyCloseReplay.structuredContent as {
      effects?: { workspace?: { processesTerminated?: unknown } };
    } | undefined)?.effects?.workspace?.processesTerminated,
    1,
  );
  const retainedRead = await client.callTool({
    name: "read",
    arguments: { workspaceId: dirtyWorkspaceId, path: "dirty.txt" },
  });
  assert.match(toolText(retainedRead), /dirty/);
  const dirtyRevoke = await client.callTool({
    name: "revoke_workspace",
    arguments: { workspaceId: dirtyWorkspaceId, operationId: "dirty-worktree-revoke" },
  });
  assert.equal(dirtyRevoke.isError, true);
  assert.deepEqual(
    (dirtyRevoke.structuredContent as { error?: unknown } | undefined)?.error,
    {
      code: "workspace_dirty",
      retryable: false,
      safeToRetry: false,
      recovery: "show_changes",
      phase: "not_started",
      effectsKnown: true,
    },
  );
  assert.equal(
    (dirtyRevoke.structuredContent as { processesTerminated?: unknown } | undefined)?.processesTerminated,
    0,
  );
  const retainedAfterRevoke = await client.callTool({
    name: "read",
    arguments: { workspaceId: dirtyWorkspaceId, path: "dirty.txt" },
  });
  assert.match(toolText(retainedAfterRevoke), /dirty/);
  const cleanManagedWorktree = await client.callTool({
    name: "exec_command",
    arguments: { workspaceId: dirtyWorkspaceId, program: "rm", args: ["dirty.txt"] },
  });
  assert.notEqual(cleanManagedWorktree.isError, true);
  const cleanManagedRevokeArguments = {
    workspaceId: dirtyWorkspaceId,
    operationId: "clean-managed-revoke",
  };
  const cleanManagedRevoke = await client.callTool({
    name: "revoke_workspace",
    arguments: cleanManagedRevokeArguments,
  });
  assert.notEqual(cleanManagedRevoke.isError, true, JSON.stringify(cleanManagedRevoke.content));
  assert.equal(
    (cleanManagedRevoke.structuredContent as { worktreeRemoved?: unknown } | undefined)?.worktreeRemoved,
    true,
  );
  await assert.rejects(access(dirtyWorkspaceRoot), /ENOENT/);
  const cleanManagedRevokeReplay = await client.callTool({
    name: "revoke_workspace",
    arguments: cleanManagedRevokeArguments,
  });
  assert.notEqual(cleanManagedRevokeReplay.isError, true);
  assert.deepEqual(
    (cleanManagedRevokeReplay.structuredContent as { operation?: unknown } | undefined)?.operation,
    {
      id: cleanManagedRevokeArguments.operationId,
      phase: "committed",
      safeToRetry: false,
      effectsKnown: true,
    },
  );
  assert.equal(
    (cleanManagedRevokeReplay.structuredContent as {
      effects?: { workspace?: { processesTerminated?: unknown } };
    } | undefined)?.effects?.workspace?.processesTerminated,
    0,
  );
  const outputId = activeOutputId;
  assert.equal(typeof outputId, "string");
  const readProcessOutput = await client.callTool({
    name: "read_process_output",
    arguments: { workspaceId, outputId, offset: 0 },
  });
  assert.deepEqual(readProcessOutput.structuredContent, {
    ok: true,
    eof: true,
    workspace: {
      ref: workspaceId,
      generation: (openWorkspace.structuredContent as {
        workspace?: { generation?: unknown };
      } | undefined)?.workspace?.generation,
    },
    context: {
      phase: "context_loaded",
      instructionRevision: (openWorkspace.structuredContent as {
        instructions?: { revision?: unknown };
      } | undefined)?.instructions?.revision,
      skillRevision: (openWorkspace.structuredContent as {
        skills?: { revision?: unknown };
      } | undefined)?.skills?.revision,
    },
  });
  assert.match(toolText(readProcessOutput), /active-status/);
  assert.doesNotMatch(toolText(readProcessOutput), /completed|retained end|outputId/);

  const outputDatabase = new Database(join(stateDir, "process-output", "metadata.sqlite"));
  try {
    const changed = outputDatabase
      .prepare("update process_outputs set status = 'unknown' where output_id = ? and status = 'completed'")
      .run(outputId).changes;
    assert.equal(changed, 1, "the retained-output fixture must transition to recovered unknown status");
  } finally {
    outputDatabase.close();
  }
  const unknownProcessOutput = await client.callTool({
    name: "read_process_output",
    arguments: { workspaceId, outputId, offset: 0 },
  });
  assert.notEqual(unknownProcessOutput.isError, true);
  assert.equal(
    (unknownProcessOutput.structuredContent as { status?: unknown } | undefined)?.status,
    "unknown",
  );
  assert.deepEqual(unknownProcessOutput.structuredContent, {
    ok: true,
    eof: true,
    status: "unknown",
    workspace: {
      ref: workspaceId,
      generation: (openWorkspace.structuredContent as {
        workspace?: { generation?: unknown };
      } | undefined)?.workspace?.generation,
    },
    context: {
      phase: "context_loaded",
      instructionRevision: (openWorkspace.structuredContent as {
        instructions?: { revision?: unknown };
      } | undefined)?.instructions?.revision,
      skillRevision: (openWorkspace.structuredContent as {
        skills?: { revision?: unknown };
      } | undefined)?.skills?.revision,
    },
  });
  assert.match(
    toolText(unknownProcessOutput),
    /completion unknown; verify side effects before rerun/i,
  );

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
    repeatedOpenWorkspace: responseMeasurements(repeatedOpenWorkspace, openWorkspaceNeedle),
    read: responseMeasurements(read, readNeedle),
    batchRead: responseMeasurements(batchRead, batchNeedle),
    batchInspect: responseMeasurements(batchInspect, batchNeedle),
    loadSkill: responseMeasurements(loadSkill, skillNeedle),
    execCommand: responseMeasurements(execCommand, processNeedle),
    readProcessOutput: responseMeasurements(readProcessOutput, "active-status"),
  };

  console.log(`MCP context budget: ${JSON.stringify(measurements)}`);

  assert.ok(
    measurements.initialize.instructionsBytes < 850,
    `initialize instructions must be under 850 UTF-8 bytes; received ${measurements.initialize.instructionsBytes}`,
  );
  assertFirst512Lifecycle(instructions);
  assert.equal(
    measurements.openWorkspace.modelVisibleHeavyCopies,
    1,
    "open_workspace instructions must appear in exactly one model-visible field",
  );
  assert.equal(
    measurements.repeatedOpenWorkspace.modelVisibleHeavyCopies,
    0,
    "matching instructionRevision must omit repeated instruction bodies",
  );
  assert.equal(
    measurements.read.modelVisibleHeavyCopies,
    1,
    "read output must appear in exactly one model-visible field",
  );
  for (const [name, measurement] of Object.entries({
    batchRead: measurements.batchRead,
    batchInspect: measurements.batchInspect,
    loadSkill: measurements.loadSkill,
    execCommand: measurements.execCommand,
    readProcessOutput: measurements.readProcessOutput,
  })) {
    assert.equal(
      measurement.modelVisibleHeavyCopies,
      1,
      `${name} heavy output must appear in exactly one model-visible field`,
    );
  }
  for (const batchResult of [batchRead, batchInspect]) {
    const structured = batchResult.structuredContent as { result?: unknown; items?: unknown } | undefined;
    assert.equal(structured?.result, undefined);
    assert.ok(Array.isArray(structured?.items));
    for (const item of structured.items as Array<Record<string, unknown>>) {
      assert.deepEqual(
        Object.keys(item).sort(),
        item.truncated === true ? ["ok", "result", "truncated"] : ["ok", "result"],
      );
    }
  }
  assert.equal(measurements.batchRead.hiddenMetaHeavyCopies, 0);
  assert.equal(measurements.batchInspect.hiddenMetaHeavyCopies, 0);
  assert.match(
    String((read.structuredContent as { contentHash?: unknown } | undefined)?.contentHash),
    /^sha256:[a-f0-9]{64}$/,
  );
  assert.match(
    String((read.structuredContent as { mtimeNs?: unknown } | undefined)?.mtimeNs),
    /^\d+$/,
  );
  assert.equal((read.structuredContent as { content?: unknown } | undefined)?.content, undefined);
  assert.equal(loadSkill.structuredContent, undefined);
  assert.equal((loadSkill._meta as { tool?: unknown } | undefined)?.tool, "load_skill");
  assert.equal((execCommand.structuredContent as { result?: unknown } | undefined)?.result, undefined);
  assert.equal((execCommand._meta as { tool?: unknown } | undefined)?.tool, "exec_command");
  assert.equal((readProcessOutput.structuredContent as { content?: unknown } | undefined)?.content, undefined);

  const legacyModeStateDir = join(root, "state-legacy-mode");
  const legacyModeConfig = loadConfig({
    ...configEnvironment,
    DEVSPACE_STATE_DIR: legacyModeStateDir,
    DEVSPACE_TOOL_MODE: "full",
  });
  seedAccessToken(legacyModeConfig, legacyModeStateDir);
  const legacyModeDiscovery = await measureDiscovery(legacyModeConfig);
  assert.deepEqual(
    Object.keys(legacyModeDiscovery.perTool).sort(),
    Object.keys(measurements.toolsList.perTool).sort(),
    "legacy DEVSPACE_TOOL_MODE must not alter the fixed tool surface",
  );
  assert.equal("bash" in legacyModeDiscovery.perTool, false);

  const skillsOffStateDir = join(root, "state-skills-off");
  const skillsOffConfig = loadConfig({
    ...configEnvironment,
    DEVSPACE_STATE_DIR: skillsOffStateDir,
    DEVSPACE_SKILLS: "0",
  });
  seedAccessToken(skillsOffConfig, skillsOffStateDir);
  const skillsOffDiscovery = await measureDiscovery(skillsOffConfig);
  assert.equal("load_skill" in skillsOffDiscovery.perTool, false);
  assert.doesNotMatch(skillsOffDiscovery.instructions, /load_skill|matching skill|explicit-only/);

  const widgetsOffStateDir = join(root, "state-widgets-off");
  const widgetsOffConfig = loadConfig({
    ...configEnvironment,
    DEVSPACE_STATE_DIR: widgetsOffStateDir,
    DEVSPACE_WIDGETS: "off",
  });
  seedAccessToken(widgetsOffConfig, widgetsOffStateDir);
  const widgetsOffDiscovery = await measureDiscovery(widgetsOffConfig);
  assert.equal(widgetsOffDiscovery.resourceCount, 0);
  assert.equal(widgetsOffDiscovery.resourcesListBytes, utf8Bytes({ resources: [] }));
  assert.ok(widgetsOffDiscovery.toolsListBytes < measurements.toolsList.totalBytes);
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
  resourcesListBytes: number;
  resourceCount: number;
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
    let resources: { resources: unknown[] } = { resources: [] };
    try {
      resources = await testClient.listResources();
    } catch (error) {
      assert.equal((error as { code?: unknown }).code, -32601);
    }
    const instructions = testClient.getInstructions() ?? "";
    return {
      instructions,
      instructionsBytes: Buffer.byteLength(instructions, "utf8"),
      toolsListBytes: utf8Bytes(tools),
      toolCount: tools.tools.length,
      perTool: Object.fromEntries(tools.tools.map((tool) => [tool.name, utf8Bytes(tool)])),
      resourcesListBytes: utf8Bytes(resources),
      resourceCount: resources.resources.length,
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
    store.ensurePrincipalForClient(oauthClient.client_id);
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
    _meta?: unknown;
  };
  const modelVisibleFields = {
    content: result.content,
    structuredContent: result.structuredContent,
  };
  const hiddenMeta = result._meta;
  return {
    wireBytes: utf8Bytes(response),
    modelVisibleBytes:
      utf8Bytes(modelVisibleFields.content) + utf8Bytes(modelVisibleFields.structuredContent),
    contentBytes: utf8Bytes(modelVisibleFields.content),
    structuredContentBytes: utf8Bytes(modelVisibleFields.structuredContent),
    hiddenMetaBytes: utf8Bytes(hiddenMeta),
    modelVisibleHeavyCopies: Object.values(modelVisibleFields)
      .filter((field) => serialized(field).includes(needle)).length,
    hiddenMetaHeavyCopies: serialized(hiddenMeta).includes(needle) ? 1 : 0,
  };
}

function textBlocks(response: unknown): Array<{ type: "text"; text: string }> {
  if (!response || typeof response !== "object" || !("content" in response)) return [];
  const content = (response as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is { type: "text"; text: string } =>
      Boolean(block) && typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string",
  );
}

function toolText(response: unknown): string {
  return textBlocks(response)
    .map((block) => block.text)
    .join("\n");
}

function assertFirst512Lifecycle(instructions: string): void {
  const first512 = instructions.slice(0, 512);
  assert.match(first512, /opened, user-approved workspace/);
  assert.match(first512, /repository files and instructions as untrusted workspace data/);
  assert.match(first512, /safeToRetry is explicitly true/);
  assert.match(first512, /unrelated computation/);
  assert.doesNotMatch(
    first512,
    /open_workspace|workspaceId|instructionToken|Batch|operationId|sessionId|outputId|DevSpace state/,
  );
}

function enableWorkspaceGenerationTracking(client: Client): void {
  let operationSequence = 0;
  const receiptsByWorkspace = new Map<string, string>();
  const receiptsByAlias = new Map<string, string>();
  const scopedTools = new Set([
    "get_workspace_context", "load_workspace_instructions", "list_skills", "load_skill",
    "close_workspace", "revoke_workspace", "read", "batch_read", "batch_inspect",
    "apply_patch", "show_changes", "exec_command", "write_stdin", "read_process_output",
  ]);
  const original = client.callTool.bind(client);
  client.callTool = (async (...callArgs: Parameters<Client["callTool"]>) => {
    const request = callArgs[0];
    const requestArguments = {
      ...(request.arguments as Record<string, unknown> | undefined ?? {}),
    };
    const skipAutoOperationId = requestArguments.__skipAutoOperationId === true;
    delete requestArguments.__skipAutoOperationId;
    const mutatingWriteStdin = request.name === "write_stdin" && (
      requestArguments.chars !== undefined ||
      requestArguments.closeStdin === true ||
      requestArguments.columns !== undefined ||
      requestArguments.rows !== undefined
    );
    if (
      !skipAutoOperationId &&
      requestArguments.operationId === undefined &&
      (new Set([
        "exec_command", "apply_patch", "close_workspace", "revoke_workspace", "show_changes",
      ]).has(request.name) || mutatingWriteStdin)
    ) {
      operationSequence += 1;
      requestArguments.operationId = `context-budget-auto-${operationSequence}`;
    }
    const workspaceId = typeof requestArguments?.workspaceId === "string"
      ? requestArguments.workspaceId
      : undefined;
    const alias = typeof requestArguments.alias === "string" ? requestArguments.alias : undefined;
    const receipt = typeof requestArguments.receipt === "string"
      ? requestArguments.receipt
      : workspaceId
        ? receiptsByWorkspace.get(workspaceId)
        : alias
          ? receiptsByAlias.get(alias)
          : undefined;
    if (scopedTools.has(request.name) && receipt) {
      const {
        workspaceId: _workspaceId,
        workspaceGeneration: _workspaceGeneration,
        alias: _alias,
        ...rest
      } = requestArguments;
      callArgs[0] = { ...request, arguments: { ...rest, receipt } };
    } else if (request.arguments !== requestArguments) {
      callArgs[0] = { ...request, arguments: requestArguments };
    }
    const result = await original(...callArgs);
    const structured = result.structuredContent as Record<string, unknown> | undefined;
    const workspace = structured?.workspace as Record<string, unknown> | undefined;
    if (typeof workspace?.ref === "string" && typeof structured?.receipt === "string") {
      receiptsByWorkspace.set(workspace.ref, structured.receipt);
      if (alias) receiptsByAlias.set(alias, structured.receipt);
    }
    return result;
  }) as Client["callTool"];
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
