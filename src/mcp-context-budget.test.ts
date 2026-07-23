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
  mkdir(join(workspaceRoot, ".agents", "skills", "context-budget", "references"), { recursive: true }),
]);
await writeFile(join(workspaceRoot, "AGENTS.md"), `# Test instructions\n\n${openWorkspaceNeedle}\n`);
await writeFile(join(workspaceRoot, "nested", "AGENTS.md"), "# Nested instructions\n\nKeep nested commands scoped.\n");
await writeFile(join(workspaceRoot, "read-scope", "AGENTS.md"), `${scopedInstructionNeedle}\n`);
await writeFile(join(workspaceRoot, "read-scope", "payload.txt"), `${scopedPayloadNeedle}\n`);
await writeFile(join(workspaceRoot, "payload.txt"), `${readNeedle}\n`);
await writeFile(join(workspaceRoot, "batch.txt"), `${batchNeedle}\n`);
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
      "load_skill",
      "open_workspace",
      "read",
      "read_process_output",
      "show_changes",
      "write_stdin",
    ],
    "tools/list must expose only the fixed DevSpace surface",
  );
  const toolsByName = new Map(toolsList.tools.map((tool) => [tool.name, tool]));
  assert.doesNotMatch(toolsByName.get("write_stdin")?.description ?? "", /rerun/i);
  assert.match(
    toolsByName.get("read_process_output")?.description ?? "",
    /retained across process-session loss\/backend restart until TTL\/quota eviction/i,
  );
  assert.ok((toolsByName.get("open_workspace")?.description?.length ?? Infinity) < 140);
  assert.match(toolsByName.get("load_skill")?.description ?? "", /exact unique name.*catalog-omitted.*recovery/i);
  assert.ok((toolsByName.get("load_skill")?.description?.length ?? Infinity) < 150);
  const readProcessOutputSchema = JSON.stringify(toolsByName.get("read_process_output")?.outputSchema);
  assert.match(readProcessOutputSchema, /unknown/);
  assert.match(readProcessOutputSchema, /active/);
  assert.doesNotMatch(readProcessOutputSchema, /completed|storedBytes|totalBytes|outputId/);
  for (const name of ["read", "load_skill", "close_workspace", "apply_patch", "show_changes"]) {
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
    utf8Bytes(toolsList) < 11_500,
    `tools/list must be under 11500 UTF-8 bytes; received ${utf8Bytes(toolsList)} (${toolsList.tools.map((tool) => `${tool.name}=${utf8Bytes(tool)}/${utf8Bytes(tool.inputSchema)}/${utf8Bytes(tool.outputSchema)}`).join(", ")})`,
  );
  const resourcesList = await client.listResources();
  const openWorkspace = await client.callTool({
    name: "open_workspace",
    arguments: { path: workspaceRoot },
  });
  const workspaceId = String(
    (openWorkspace.structuredContent as { workspaceId?: unknown } | undefined)?.workspaceId ?? "",
  );
  assert.ok(workspaceId, "open_workspace must return a structured workspaceId");
  const advertisedSkill = (openWorkspace.structuredContent as {
    skills?: Array<Record<string, unknown> & { skillId?: unknown; name?: unknown }>;
  } | undefined)?.skills?.find((skill) => skill.name === "context-budget");
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
    (openWorkspace.structuredContent as { instructionRevision?: unknown } | undefined)
      ?.instructionRevision ?? "",
  );
  assert.ok(instructionRevision, "open_workspace must return an instructionRevision");
  const skillRevision = String(
    (openWorkspace.structuredContent as { skillRevision?: unknown } | undefined)?.skillRevision ?? "",
  );
  assert.ok(skillRevision, "open_workspace must return a skillRevision");
  const repeatedOpenWorkspace = await client.callTool({
    name: "open_workspace",
    arguments: {
      path: workspaceRoot,
      knownInstructionRevision: instructionRevision,
      knownSkillRevision: skillRevision,
    },
  });
  assert.equal(
    (repeatedOpenWorkspace.structuredContent as { workspaceId?: unknown } | undefined)?.workspaceId,
    workspaceId,
    "reopening the same path must reuse its workspace",
  );
  assert.equal(
    (repeatedOpenWorkspace.structuredContent as { instructionsIncluded?: unknown } | undefined)
      ?.instructionsIncluded,
    false,
  );
  assert.deepEqual(
    (repeatedOpenWorkspace.structuredContent as { agentsFiles?: unknown } | undefined)?.agentsFiles,
    [],
  );
  assert.equal(
    (repeatedOpenWorkspace.structuredContent as { skillsIncluded?: unknown } | undefined)?.skillsIncluded,
    false,
  );
  assert.deepEqual(
    (repeatedOpenWorkspace.structuredContent as { skills?: unknown } | undefined)?.skills,
    [],
  );
  const instructionsOnlySuppressed = await client.callTool({
    name: "open_workspace",
    arguments: { path: workspaceRoot, knownInstructionRevision: instructionRevision },
  });
  assert.equal(
    (instructionsOnlySuppressed.structuredContent as { instructionsIncluded?: unknown } | undefined)
      ?.instructionsIncluded,
    false,
  );
  assert.equal(
    (instructionsOnlySuppressed.structuredContent as { skillsIncluded?: unknown } | undefined)?.skillsIncluded,
    true,
  );
  const skillsOnlySuppressed = await client.callTool({
    name: "open_workspace",
    arguments: { path: workspaceRoot, knownSkillRevision: skillRevision },
  });
  assert.equal(
    (skillsOnlySuppressed.structuredContent as { instructionsIncluded?: unknown } | undefined)
      ?.instructionsIncluded,
    true,
  );
  assert.equal(
    (skillsOnlySuppressed.structuredContent as { skillsIncluded?: unknown } | undefined)?.skillsIncluded,
    false,
  );
  const firstOpenText = toolText(openWorkspace);
  assert.equal(firstOpenText.match(/nested instructions load/gi)?.length, 1);
  assert.equal(firstOpenText.match(/Load an applicable returned Skill before work/gi)?.length, 1);
  assert.doesNotMatch(firstOpenText, new RegExp(workspaceId));
  assert.doesNotMatch(firstOpenText, new RegExp(workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const repeatedOpenText = toolText(repeatedOpenWorkspace);
  assert.equal(repeatedOpenText, "Workspace context unchanged.");
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
  assert.match(scopedReadBlocks[0]?.text ?? "", new RegExp(scopedInstructionNeedle));
  assert.match(scopedReadBlocks.at(-1)?.text ?? "", new RegExp(scopedPayloadNeedle));
  assert.ok(toolText(scopedRead).indexOf(scopedInstructionNeedle) < toolText(scopedRead).indexOf(scopedPayloadNeedle));
  assert.doesNotMatch(toolText(scopedRead), /instructionToken=/);
  const repeatedScopedRead = await client.callTool({
    name: "read",
    arguments: { workspaceId, path: "read-scope/payload.txt" },
  });
  assert.doesNotMatch(toolText(repeatedScopedRead), new RegExp(scopedInstructionNeedle));
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
    /^unknown_workspace: Call open_workspace.*replace workspaceId.*retry once/i,
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
    arguments: { workspaceId, files: [{ path: "batch.txt" }, { path: "missing-partial.txt" }] },
  });
  assert.notEqual(partialBatchRead.isError, true);
  assert.match(toolText(partialBatchRead), /partial: 1 failed/i);
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
        { operation: "grep", pattern: batchNeedle, path: "batch.txt" },
        { operation: "ls", path: "missing-partial-dir" },
      ],
    },
  });
  assert.notEqual(partialBatchInspect.isError, true);
  assert.match(toolText(partialBatchInspect), /partial: 1 failed/i);
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
  const execCommand = await client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: `${JSON.stringify(process.execPath)} -e "process.stdin.pipe(process.stdout)"`,
      stdin: `${processNeedle}\n`,
    },
  });
  assert.deepEqual(execCommand.structuredContent, {});
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
  const activeOutputId = (activeCommand.structuredContent as { outputId?: unknown } | undefined)
    ?.outputId;
  const activeSessionId = (activeCommand.structuredContent as { sessionId?: unknown } | undefined)
    ?.sessionId;
  assert.equal(typeof activeOutputId, "string");
  assert.equal(typeof activeSessionId, "number");
  assert.deepEqual(
    Object.keys((activeCommand.structuredContent ?? {}) as Record<string, unknown>).sort(),
    ["outputId", "sessionId"],
  );
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
    ["nextOffset", "status"],
  );
  assert.match(toolText(activeProcessOutput), /active-status.*current end; poll offset=/s);
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
    arguments: { workspaceId, cmd: "pwd", workingDirectory: "nested" },
  });
  assert.equal(nestedGate.isError, true);
  const nestedGateText = JSON.stringify(nestedGate.content);
  assert.match(
    nestedGateText,
    /No mutation or command was executed because new scoped instructions must be reviewed first/,
  );
  const instructionToken = nestedGateText.match(/instructionToken=([A-Za-z0-9_-]+)/)?.[1];
  assert.ok(instructionToken, "nested instruction gate must return an acknowledgement token");
  const nestedRetry = await client.callTool({
    name: "exec_command",
    arguments: { workspaceId, instructionToken, cmd: "pwd", workingDirectory: "nested" },
  });
  assert.notEqual(nestedRetry.isError, true);
  assert.match(JSON.stringify(nestedRetry.content), /nested/);
  const invalidInstructionToken = await client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      instructionToken: "instructions_missing_context_budget",
      cmd: "pwd",
      workingDirectory: "nested",
    },
  });
  assert.equal(invalidInstructionToken.isError, true);
  assert.match(toolText(invalidInstructionToken), /^instruction_token_invalid:/);
  assert.doesNotMatch(toolText(invalidInstructionToken), /instructions_missing_context_budget/);

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
    arguments: { path: workspaceRoot, mode: "worktree" },
  });
  const dirtyWorkspaceId = String(
    (dirtyWorkspace.structuredContent as { workspaceId?: unknown } | undefined)?.workspaceId ?? "",
  );
  const dirtyWorkspaceRoot = String(
    (dirtyWorkspace.structuredContent as { root?: unknown } | undefined)?.root ?? "",
  );
  assert.ok(dirtyWorkspaceId);
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
  const dirtyClose = await client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: dirtyWorkspaceId },
  });
  assert.equal(dirtyClose.isError, true);
  assert.equal(dirtyClose.structuredContent, undefined);
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
  const retainedRead = await client.callTool({
    name: "read",
    arguments: { workspaceId: dirtyWorkspaceId, path: "dirty.txt" },
  });
  assert.match(toolText(retainedRead), /dirty/);
  const outputId = activeOutputId;
  assert.equal(typeof outputId, "string");
  const readProcessOutput = await client.callTool({
    name: "read_process_output",
    arguments: { workspaceId, outputId, offset: 0 },
  });
  assert.deepEqual(readProcessOutput.structuredContent, { eof: true });
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
  assert.deepEqual(unknownProcessOutput.structuredContent, { eof: true, status: "unknown" });
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
  assert.equal(read.structuredContent, undefined);
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
  assert.match(first512, /open_workspace once for the exact path/);
  assert.match(first512, /reuse workspaceId across turns\/transports/);
  assert.match(first512, /unknown_workspace.*reopen the path.*replace ID/s);
  assert.match(first512, /close_workspace only when asked/);
  assert.match(first512, /Follow returned instructions/);
  assert.match(first512, /Read\/open needs no retry/);
  assert.match(first512, /blocked mutation\/command.*instructionToken/);
  assert.match(first512, /Batch 2–8 independent known targets/);
  assert.doesNotMatch(first512, /reconnect|MCP session is rejected/);
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
