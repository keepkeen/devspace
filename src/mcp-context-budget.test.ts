import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { authorizationRootId } from "./authorization-roots.js";
import { loadConfig } from "./config.js";
import { DEVSPACE_CAPABILITY_SCOPES } from "./oauth-scopes.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";
import {
  ProjectExecutionStore,
  type ProjectExecutionAuthorization,
} from "./project-execution-store.js";
import { encodeProjectThreadRef } from "./project-thread-ref.js";
import { ProjectThreadStore } from "./project-thread-store.js";
import { createServer, modelProjectListingPage } from "./server.js";

const root = await mkdtemp(join(tmpdir(), "devspace-context-budget-"));
const projectRoot = join(root, "project");
const trustedSkillRoot = join(root, "trusted-skills");
const adminSkillRoot = join(root, "admin-skills");
const devspaceSkillRoot = join(root, "config", "skills");
const stateDir = join(root, "state");
const publicBaseUrl = "http://127.0.0.1:7676";
const accessToken = "context-budget-access-token";
const rootInstruction = "CONTEXT_BUDGET_ROOT_INSTRUCTION";
const nestedInstruction = "CONTEXT_BUDGET_NESTED_INSTRUCTION";
const skillBody = "CONTEXT_BUDGET_SKILL_BODY";
const CONTRACT_V9_TOOLS_LIST_BASELINE_BYTES = 15_118;
// Leave room for staged Batch C-D schema edits; those batches are expected to
// reduce the surface further before the final contract ceiling is selected.
const STAGED_TOOLS_LIST_CEILING_BYTES = 15_500;
const execFileAsync = promisify(execFile);

const projectPage = modelProjectListingPage(
  Array.from({ length: 101 }, (_, index) => `project-${index}`),
);
assert.equal(projectPage.projects.length, 100);
assert.equal(projectPage.truncated, true);
assert.deepEqual(projectPage.projects, Array.from({ length: 100 }, (_, index) => `project-${index}`));

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
  mkdir(join(trustedSkillRoot, "trusted-provenance-skill", "references"), {
    recursive: true,
  }),
  mkdir(join(adminSkillRoot, "admin-provenance-skill", "references"), { recursive: true }),
  mkdir(join(devspaceSkillRoot, "devspace-provenance-skill", "references"), { recursive: true }),
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
  writeFile(
    join(trustedSkillRoot, "trusted-provenance-skill", "SKILL.md"),
    "---\nname: trusted-provenance-skill\ndescription: Trusted provenance fixture.\n---\n\nTRUSTED_SKILL_BODY\n",
  ),
  writeFile(
    join(trustedSkillRoot, "trusted-provenance-skill", "references", "trusted.md"),
    "trusted skill reference\n",
  ),
  writeFile(
    join(adminSkillRoot, "admin-provenance-skill", "SKILL.md"),
    "---\nname: admin-provenance-skill\ndescription: Admin provenance fixture.\n---\n\nADMIN_SKILL_BODY\n",
  ),
  writeFile(
    join(adminSkillRoot, "admin-provenance-skill", "references", "admin.md"),
    "admin skill reference\n",
  ),
  writeFile(
    join(devspaceSkillRoot, "devspace-provenance-skill", "SKILL.md"),
    "---\nname: devspace-provenance-skill\ndescription: DevSpace provenance fixture.\n---\n\nDEVSPACE_SKILL_BODY\n",
  ),
  writeFile(
    join(devspaceSkillRoot, "devspace-provenance-skill", "references", "devspace.md"),
    "devspace skill reference\n",
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
await utimes(join(projectRoot, "payload.txt"), new Date(-1_000), new Date(-1_000));

const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_ALLOWED_ROOTS: projectRoot,
  DEVSPACE_ALLOWED_HOSTS: "*",
  DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
  DEVSPACE_SKILL_PATHS: trustedSkillRoot,
  DEVSPACE_ADMIN_SKILLS_DIR: adminSkillRoot,
  DEVSPACE_OAUTH_OWNER_TOKEN: "context-budget-owner-token-long-enough",
  DEVSPACE_WIDGETS: "changes",
  DEVSPACE_LOG_LEVEL: "silent",
  PORT: "1",
});

const seededAuthorization = seedAccessToken();
const legacyUnknownOwner = seedLegacyUnknownOwner(seededAuthorization);
const running = createServer(config);
const httpServer = createHttpServer(running.app);
const clients: Client[] = [];

try {
  const origin = await listen(httpServer);
  const first = await connect(origin, "context-budget-first");
  const firstMeta = {
    "openai/subject": "context-budget-subject",
    "openai/session": "context-budget-session-first",
  };
  const toolsList = await first.listTools();
  const toolNames = toolsList.tools.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, [
    "apply_patch",
    "exec_command",
    "inspect",
    "list_projects",
    "project_control",
    "project_thread_control",
    "read_files",
    "read_process_output",
    "save_progress",
    "show_changes",
    "skills",
    "write_stdin",
  ].sort());
  const toolsListBytes = utf8Bytes(toolsList);
  assert.ok(
    toolsListBytes < STAGED_TOOLS_LIST_CEILING_BYTES,
    `ChatGPT Project tools/list must remain under the staged ${STAGED_TOOLS_LIST_CEILING_BYTES}-byte ceiling; got ${toolsListBytes}`,
  );
  assert.ok(
    toolsListBytes < CONTRACT_V9_TOOLS_LIST_BASELINE_BYTES,
    `The v9 contract must improve on the ${CONTRACT_V9_TOOLS_LIST_BASELINE_BYTES}-byte baseline; got ${toolsListBytes}`,
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
    "action", "projectRef", "operationId", "taskRef",
    "cursor", "checkoutKind",
  ]) assert.match(projectControlSchema, new RegExp(field, "u"));
  assert.doesNotMatch(
    projectControlSchema,
    /executionRef|threadRef|fresh|handoffRef|resolve|list|status|activity|pause|archive|complete|close|waitMs|limit|ifMatch/u,
  );
  const projectThreadControl = toolsList.tools.find((tool) => tool.name === "project_thread_control");
  const projectThreadControlSchema = JSON.stringify(projectThreadControl?.inputSchema);
  for (const action of [
    "resolve", "list", "status", "activity", "pause", "archive", "complete", "close",
  ]) assert.match(projectThreadControlSchema, new RegExp(action, "u"));
  assert.deepEqual(
    (projectThreadControl?._meta as { ui?: { visibility?: unknown } } | undefined)?.ui?.visibility,
    ["app"],
  );
  assert.equal(
    (projectThreadControl?._meta as { ui?: { resourceUri?: unknown } } | undefined)?.ui?.resourceUri,
    "ui://devspace/project-app.html",
  );
  assert.equal(projectThreadControl?.annotations?.idempotentHint, false);
  const modelVisibleTools = toolsList.tools.filter((tool) =>
    !((tool._meta as { ui?: { visibility?: unknown } } | undefined)?.ui?.visibility as unknown[] | undefined)
      ?.includes("app")
  );
  assert.equal(modelVisibleTools.length, 11);
  assert.doesNotMatch(
    JSON.stringify(modelVisibleTools),
    /executionRef/u,
    "the model-facing Project surface must not expose execution capabilities",
  );
  for (const toolName of [
    "apply_patch",
    "exec_command",
    "inspect",
    "read_files",
    "read_process_output",
    "save_progress",
    "show_changes",
    "skills",
    "write_stdin",
  ]) {
    assert.doesNotMatch(
      JSON.stringify(toolsList.tools.find((tool) => tool.name === toolName)?.inputSchema),
      /executionRef/u,
      `${toolName} must resolve its Project from trusted session state`,
    );
  }
  const skillsInput = toolsList.tools.find((tool) => tool.name === "skills")?.inputSchema as {
    properties?: Record<string, unknown>;
  } | undefined;
  assert.deepEqual(
    Object.keys(skillsInput?.properties ?? {}).sort(),
    ["cursor", "limit", "query", "skillId"],
  );
  const readFilesSchema = JSON.stringify(
    toolsList.tools.find((tool) => tool.name === "read_files")?.inputSchema,
  );
  const inspectSchema = JSON.stringify(
    toolsList.tools.find((tool) => tool.name === "inspect")?.inputSchema,
  );
  assert.doesNotMatch(readFilesSchema, /"ref"/u);
  assert.doesNotMatch(inspectSchema, /"ref"/u);
  const malformedProjectControl = await first.callTool({
    name: "project_control",
    arguments: { action: "open" },
    _meta: firstMeta,
  });
  assertErrorCode(malformedProjectControl, "invalid_tool_input");
  for (const argumentsValue of [
    { action: "resume", operationId: "missing-task" },
    { action: "resume", taskRef: "phf1_missing-operation.signature" },
    {
      action: "resume",
      taskRef: "phf1_task.signature",
      threadRef: "pth1_thread.signature",
      operationId: "resume-xor",
    },
    {
      action: "interrupt",
      operationId: "untrusted-thread",
      threadRef: "pth1_thread.signature",
    },
  ]) {
    assertErrorCode(await first.callTool({
      name: "project_control",
      arguments: argumentsValue,
      _meta: firstMeta,
    }), "invalid_tool_input");
  }
  const maximumOpenOperationId = "o".repeat(128);
  assertMutationError(await first.callTool({
    name: "project_control",
    arguments: {
      action: "open",
      projectRef: "not-authorized",
      operationId: maximumOpenOperationId,
    },
    _meta: firstMeta,
  }), {
    code: "project_not_authorized",
    operationId: maximumOpenOperationId,
    phase: "not_started",
    effectsKnown: true,
    safeToRetry: true,
    recovery: "list_projects",
  });
  assertErrorCode(await first.callTool({
    name: "project_control",
    arguments: {
      action: "open",
      projectRef: "not-authorized",
      operationId: "o".repeat(129),
    },
    _meta: firstMeta,
  }), "invalid_tool_input");
  const maximumMultibyteOperationId = `${"界".repeat(42)}ab`;
  assert.equal(Buffer.byteLength(maximumMultibyteOperationId, "utf8"), 128);
  assertMutationError(await first.callTool({
    name: "project_control",
    arguments: {
      action: "open",
      projectRef: "not-authorized",
      operationId: maximumMultibyteOperationId,
    },
    _meta: firstMeta,
  }), {
    code: "project_not_authorized",
    operationId: maximumMultibyteOperationId,
    phase: "not_started",
    effectsKnown: true,
    safeToRetry: true,
    recovery: "list_projects",
  });
  const maximumProjectOperationId = "i".repeat(128);
  const unboundInterrupt = await first.callTool({
    name: "project_control",
    arguments: { action: "interrupt", operationId: maximumProjectOperationId },
    _meta: firstMeta,
  });
  assertErrorCode(unboundInterrupt, "project_execution_required");
  assert.deepEqual(unboundInterrupt.structuredContent, {
    error: {
      code: "project_execution_required",
      safeToRetry: true,
      recovery: "project_control_open_or_resume",
      operationId: maximumProjectOperationId,
      phase: "not_started",
      effectsKnown: true,
    },
  });
  assertErrorCode(await first.callTool({
    name: "project_control",
    arguments: { action: "interrupt", operationId: "i".repeat(129) },
    _meta: firstMeta,
  }), "invalid_tool_input");
  const saveProgressSchema = JSON.stringify(
    toolsList.tools.find((tool) => tool.name === "save_progress")?.inputSchema,
  );
  assert.match(saveProgressSchema, /operationId/u);
  assert.match(saveProgressSchema, /progress/u);
  assert.match(saveProgressSchema, /ifMatch/u);
  const execCommandInput = toolsList.tools.find((tool) => tool.name === "exec_command")
    ?.inputSchema as { properties?: Record<string, unknown> } | undefined;
  assert.deepEqual(Object.keys(execCommandInput?.properties ?? {}).sort(), [
    "args", "closeStdin", "command", "environment", "operationId", "program", "shell",
    "stdin", "timeoutMs", "tty", "workingDirectory",
  ]);
  const writeStdinInput = toolsList.tools.find((tool) => tool.name === "write_stdin")
    ?.inputSchema as { properties?: Record<string, unknown> } | undefined;
  assert.deepEqual(Object.keys(writeStdinInput?.properties ?? {}).sort(), [
    "chars", "closeStdin", "expectedRevision", "interrupt", "operationId", "sessionId",
  ]);
  const readProcessInput = toolsList.tools.find((tool) => tool.name === "read_process_output")
    ?.inputSchema as { properties?: Record<string, unknown> } | undefined;
  assert.deepEqual(Object.keys(readProcessInput?.properties ?? {}).sort(), [
    "cursor", "ignoreCase", "mode", "offset", "outputId", "query", "sessionId",
  ]);
  const listProjectsTool = toolsList.tools.find((tool) => tool.name === "list_projects");
  assert.match(
    JSON.stringify(listProjectsTool?.inputSchema),
    /projectRef/u,
    "list_projects must support a Project-scoped recovery listing",
  );
  const showChangesTool = toolsList.tools.find((tool) => tool.name === "show_changes");
  assert.deepEqual(
    Object.keys((showChangesTool?.inputSchema as {
      properties?: Record<string, unknown>;
    } | undefined)?.properties ?? {}).sort(),
    ["cursor", "source"],
  );
  assert.equal(
    (showChangesTool?.inputSchema as { required?: string[] } | undefined)?.required
      ?.includes("source") ?? false,
    false,
    "show_changes continuation must not repeat the source",
  );
  assert.match(JSON.stringify(showChangesTool?.inputSchema), /apply_patch_history/u);
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
    _meta: firstMeta,
  });
  assertErrorCode(beforeSelection, "project_execution_required");

  const listed = await first.callTool({
    name: "list_projects",
    arguments: {},
    _meta: firstMeta,
  });
  assertSucceeded(listed);
  assert.equal((listed._meta as { tool?: unknown } | undefined)?.tool, "list_projects");
  const listedSerialized = JSON.stringify(listed.structuredContent);
  assert.doesNotMatch(listedSerialized, new RegExp(escapeRegExp(projectRoot), "u"));
  assert.doesNotMatch(
    listedSerialized,
    /tasks|title|updatedAt|createdAt|defaultProjectRef|taskLimits|schemaVersion|"ok"\s*:/u,
  );
  const projects = (listed.structuredContent as {
    projects?: Array<{
      projectRef?: unknown;
      label?: unknown;
      resumableTaskCount?: unknown;
    }>;
  } | undefined)?.projects ?? [];
  assert.equal(projects.length, 1);
  assert.equal(typeof projects[0]?.projectRef, "string");
  assert.equal(projects[0]?.resumableTaskCount, 0);

  const selected = await first.callTool({
    name: "project_control",
    arguments: { action: "open", operationId: "context-budget-execution" },
    _meta: firstMeta,
  });
  assertSucceeded(selected);
  const selectedThreadRef = String(
    (selected._meta as { thread?: { threadRef?: unknown } } | undefined)
      ?.thread?.threadRef ?? "",
  );
  assert.match(selectedThreadRef, /^pth1_/u);
  const invalidOperationIds = [
    "x".repeat(129),
    `${maximumMultibyteOperationId}c`,
    "nul\0operation",
    "\uD800",
    "\uDC00",
  ];
  const invalidEffectMarker = join(projectRoot, "invalid-operation-effect.txt");
  const mutationDatabase = new Database(join(stateDir, "devspace.sqlite"));
  const beforeInvalidMutationCount = Number(
    mutationDatabase.prepare("select count(*) from mutation_operations").pluck().get(),
  );
  const beforeInvalidExecutionCount = Number(
    mutationDatabase.prepare("select count(*) from project_executions").pluck().get(),
  );
  mutationDatabase.close();
  for (const invalidOperationId of invalidOperationIds) {
    const invalidMutationCalls = [
      {
        name: "project_control",
        arguments: { action: "open", operationId: invalidOperationId },
      },
      {
        name: "project_control",
        arguments: {
          action: "resume",
          operationId: invalidOperationId,
          taskRef: "phf1_task.signature",
        },
      },
      {
        name: "project_control",
        arguments: { action: "interrupt", operationId: invalidOperationId },
      },
      {
        name: "apply_patch",
        arguments: {
          operationId: invalidOperationId,
          ifMatch: `sha256:${"0".repeat(64)}`,
          patch: "*** Begin Patch\n*** Add File: invalid-operation-effect.txt\n+invalid\n*** End Patch",
        },
      },
      {
        name: "exec_command",
        arguments: {
          operationId: invalidOperationId,
          program: process.execPath,
          args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(invalidEffectMarker)}, 'invalid')`],
        },
      },
      {
        name: "write_stdin",
        arguments: { operationId: invalidOperationId, sessionId: 999_999, chars: "invalid" },
      },
      {
        name: "save_progress",
        arguments: {
          operationId: invalidOperationId,
          title: "Invalid operation fixture",
          progress: "This must not be persisted.",
        },
      },
      ...(["pause", "archive", "complete", "close"] as const).map((action) => ({
        name: "project_thread_control",
        arguments: { action, threadRef: selectedThreadRef, operationId: invalidOperationId },
      })),
    ];
    for (const call of invalidMutationCalls) {
      const result = await first.callTool({ ...call, _meta: firstMeta });
      assertErrorCode(result, "invalid_tool_input");
      assert.doesNotMatch(JSON.stringify(result.structuredContent), /outcome_unknown/u);
    }
  }
  const afterInvalidDatabase = new Database(join(stateDir, "devspace.sqlite"), {
    readonly: true,
  });
  try {
    assert.equal(
      Number(afterInvalidDatabase.prepare("select count(*) from mutation_operations").pluck().get()),
      beforeInvalidMutationCount,
      "invalid operation IDs must fail before mutation reservation",
    );
    assert.equal(
      Number(afterInvalidDatabase.prepare("select count(*) from project_executions").pluck().get()),
      beforeInvalidExecutionCount,
      "invalid operation IDs must fail before Project execution reservation",
    );
  } finally {
    afterInvalidDatabase.close();
  }
  await assert.rejects(access(invalidEffectMarker));
  const selectedReplay = await first.callTool({
    name: "project_control",
    arguments: { action: "open", operationId: "context-budget-execution" },
    _meta: firstMeta,
  });
  assertSucceeded(selectedReplay);
  assert.equal(
    (selectedReplay._meta as { thread?: { threadRef?: unknown } } | undefined)?.thread?.threadRef,
    (selected._meta as { thread?: { threadRef?: unknown } } | undefined)?.thread?.threadRef,
  );
  assertProjectContext(selected);
  const selectedContent = selected.structuredContent as {
    project?: { ref?: unknown; writeAccess?: unknown; checkoutKind?: unknown };
    instructions?: Array<{ path?: unknown; content?: unknown }>;
    thread?: unknown;
  };
  assert.equal(selectedContent.project?.ref, projects[0]?.projectRef);
  assert.equal(selectedContent.project?.writeAccess, "read_write");
  assert.equal(selectedContent.project?.checkoutKind, "checkout");
  assert.equal(selectedContent.thread, undefined);
  assert.equal(Object.hasOwn(selectedContent.project ?? {}, "executionRef"), false);
  const rootInstructionItem = selectedContent.instructions?.find(
    (item) => item.path === "AGENTS.md",
  ) as Record<string, unknown> | undefined;
  assert.equal(rootInstructionItem?.trustClass, "repository_untrusted");
  assert.equal(Object.hasOwn(rootInstructionItem ?? {}, "scope"), false);
  assert.equal(Object.hasOwn(rootInstructionItem ?? {}, "source"), false);
  assert.equal(Object.hasOwn(rootInstructionItem ?? {}, "trust"), false);
  assert.match(
    String(selectedContent.instructions?.find(
      (item) => item.path === "AGENTS.md",
    )?.content),
    new RegExp(rootInstruction, "u"),
  );
  assert.doesNotMatch(
    JSON.stringify(selectedContent),
    /instructionManifest|projectInstructions|skills|contextDelta|rootInstructionsComplete|schemaVersion|"ok"\s*:/u,
  );
  const interrupted = await first.callTool({
    name: "project_control",
    arguments: { action: "interrupt", operationId: "interrupt-current-execution" },
    _meta: firstMeta,
  });
  assertSucceeded(interrupted);
  const interruptedContent = interrupted.structuredContent as Record<string, unknown>;
  assert.equal(interruptedContent.interrupted, 0);
  assert.equal(Object.hasOwn(interruptedContent, "sessionIds"), false);
  assert.equal(
    (interruptedContent.operation as { id?: unknown } | undefined)?.id,
    "interrupt-current-execution",
  );

  const read = await first.callTool({
    name: "read_files",
    arguments: { files: [{ path: "payload.txt" }] },
    _meta: firstMeta,
  });
  assertSucceeded(read);
  assert.match(JSON.stringify(read.structuredContent), /root payload/u);
  assert.equal(toolText(read), "Files read.");
  const readContent = read.structuredContent as Record<string, unknown> & {
    items?: Array<Record<string, unknown>>;
  };
  assert.deepEqual(Object.keys(readContent).sort(), ["items", "provenance"]);
  assert.deepEqual(readContent.provenance, {
    source: "repository",
    trust: "untrusted",
    authority: "none",
  });
  assert.deepEqual(Object.keys(readContent.items?.[0] ?? {}).sort(), [
    "content", "path", "version",
  ]);
  assert.deepEqual(Object.keys(
    (readContent.items?.[0]?.version as Record<string, unknown> | undefined) ?? {},
  ).sort(), ["contentHash", "mtimeNs"]);
  const preEpochVersion = readContent.items?.[0]?.version as {
    contentHash?: unknown;
    mtimeNs?: unknown;
  } | undefined;
  assert.match(String(preEpochVersion?.mtimeNs), /^-/u);
  assertSucceeded(await first.callTool({
    name: "apply_patch",
    arguments: {
      operationId: "context-budget-pre-epoch-patch",
      ifMatch: { "payload.txt": preEpochVersion },
      patch: "*** Begin Patch\n*** Update File: payload.txt\n@@\n-root payload\n+root payload updated\n*** End Patch",
    },
    _meta: firstMeta,
  }));
  assertErrorCode(await first.callTool({
    name: "apply_patch",
    arguments: {
      operationId: "context-budget-invalid-mtime-patch",
      ifMatch: {
        "payload.txt": {
          contentHash: preEpochVersion?.contentHash,
          mtimeNs: "--1",
        },
      },
      patch: "*** Begin Patch\n*** Update File: payload.txt\n@@\n-root payload updated\n+must not apply\n*** End Patch",
    },
    _meta: firstMeta,
  }), "invalid_tool_input");

  const partialRead = await first.callTool({
    name: "read_files",
    arguments: { files: [{ path: "payload.txt" }, { path: "missing.txt" }] },
    _meta: firstMeta,
  });
  assertSucceeded(partialRead);
  assert.equal(toolText(partialRead), "Some files failed.");
  const partialReadItems = (partialRead.structuredContent as {
    items?: Array<Record<string, unknown>>;
  }).items ?? [];
  assert.deepEqual(partialReadItems.map((item) => item.path), ["payload.txt", "missing.txt"]);
  assert.equal(Object.hasOwn(partialReadItems[0] ?? {}, "content"), true);
  assert.equal(Object.hasOwn(partialReadItems[1] ?? {}, "error"), true);
  assert.doesNotMatch(
    JSON.stringify(partialRead.structuredContent),
    /"ok"|"status"|"succeeded"|"failed"|"truncated"|"offset"|"omittedReason"/u,
  );
  const failedRead = await first.callTool({
    name: "read_files",
    arguments: { files: [{ path: "missing-one.txt" }, { path: "missing-two.txt" }] },
    _meta: firstMeta,
  });
  assertReadOnlyBatchFailure(failedRead, "read_files_failed", "correct_paths_and_retry", 2);

  const inspected = await first.callTool({
    name: "inspect",
    arguments: { operations: [{ operation: "ls" }] },
    _meta: firstMeta,
  });
  assertSucceeded(inspected);
  assert.equal(toolText(inspected), "Inspection complete.");
  const inspectContent = inspected.structuredContent as Record<string, unknown> & {
    items?: Array<Record<string, unknown>>;
  };
  assert.deepEqual(Object.keys(inspectContent).sort(), ["items", "provenance"]);
  assert.deepEqual(Object.keys(inspectContent.items?.[0] ?? {}).sort(), [
    "operation", "path", "result",
  ]);
  assert.equal(inspectContent.items?.[0]?.path, ".");
  assert.equal(typeof inspectContent.items?.[0]?.result, "string");

  const partialInspect = await first.callTool({
    name: "inspect",
    arguments: {
      operations: [
        { operation: "ls" },
        { operation: "grep", pattern: "payload", path: "missing-dir" },
      ],
    },
    _meta: firstMeta,
  });
  assertSucceeded(partialInspect);
  assert.equal(toolText(partialInspect), "Some inspections failed.");
  const partialInspectItems = (partialInspect.structuredContent as {
    items?: Array<Record<string, unknown>>;
  }).items ?? [];
  assert.deepEqual(partialInspectItems.map((item) => item.path), [".", "missing-dir"]);
  assert.equal(Object.hasOwn(partialInspectItems[0] ?? {}, "result"), true);
  assert.equal(Object.hasOwn(partialInspectItems[1] ?? {}, "error"), true);
  assert.equal(Object.hasOwn(partialInspectItems[1] ?? {}, "result"), false);
  assert.doesNotMatch(
    JSON.stringify(partialInspect.structuredContent),
    /"ok"|"status"|"succeeded"|"failed"|"omittedReason"/u,
  );
  const failedInspect = await first.callTool({
    name: "inspect",
    arguments: {
      operations: [
        { operation: "grep", pattern: "payload", path: "missing-one" },
        { operation: "ls", path: "missing-two" },
      ],
    },
    _meta: firstMeta,
  });
  assertReadOnlyBatchFailure(
    failedInspect,
    "inspect_failed",
    "correct_operations_and_retry",
    2,
  );

  const nestedRead = await first.callTool({
    name: "read_files",
    arguments: { files: [{ path: "nested/payload.txt" }] },
    _meta: firstMeta,
  });
  assertSucceeded(nestedRead);
  assert.match(JSON.stringify(nestedRead.structuredContent), new RegExp(nestedInstruction, "u"));
  const nestedDelta = (nestedRead.structuredContent as {
    instructionsDelta?: Array<Record<string, unknown>>;
  }).instructionsDelta?.[0];
  assert.equal(nestedDelta?.trustClass, "repository_untrusted");
  assert.equal(nestedDelta?.scope, "nested");
  assert.equal(Object.hasOwn(nestedDelta ?? {}, "source"), false);
  assert.equal(Object.hasOwn(nestedDelta ?? {}, "trust"), false);
  assert.doesNotMatch(
    JSON.stringify(nestedRead.structuredContent),
    /instructionToken|instructionManifest|fragment|receipt|contextChanged|phase/iu,
  );
  const ambiguityVersions = await first.callTool({
    name: "read_files",
    arguments: { files: [{ path: "payload.txt" }, { path: "nested/payload.txt" }] },
    _meta: firstMeta,
  });
  assertSucceeded(ambiguityVersions);
  const ambiguityItems = (ambiguityVersions.structuredContent as {
    items?: Array<{ path?: unknown; version?: unknown }>;
  }).items ?? [];
  const ambiguityVersionMap = Object.fromEntries(
    ambiguityItems.map((item) => [String(item.path), item.version]),
  );
  const ambiguityPatch = "*** Begin Patch\n" +
    "*** Update File: payload.txt\n@@\n-root payload updated\n+root payload ambiguity fixed\n" +
    "*** Update File: nested/payload.txt\n@@\n-nested payload\n+nested payload ambiguity fixed\n" +
    "*** End Patch";
  const ambiguousIfMatch = await first.callTool({
    name: "apply_patch",
    arguments: {
      operationId: "context-budget-ambiguous-if-match",
      ifMatch: (ambiguityVersionMap["payload.txt"] as { contentHash?: unknown }).contentHash,
      patch: ambiguityPatch,
    },
    _meta: firstMeta,
  });
  assertMutationError(ambiguousIfMatch, {
    code: "if_match_ambiguous",
    operationId: "context-budget-ambiguous-if-match",
    phase: "not_started",
    effectsKnown: true,
    safeToRetry: true,
    recovery: "provide_path_version_map_retry_same_operation_id",
  });
  assertSucceeded(await first.callTool({
    name: "apply_patch",
    arguments: {
      operationId: "context-budget-ambiguous-if-match",
      ifMatch: ambiguityVersionMap,
      patch: ambiguityPatch,
    },
    _meta: firstMeta,
  }));

  const apply = await first.callTool({
    name: "apply_patch",
    arguments: {
      operationId: "context-budget-patch",
      ifMatch: { "nested/created.txt": null },
      patch: "*** Begin Patch\n*** Add File: nested/created.txt\n+created\n*** End Patch",
    },
    _meta: firstMeta,
  });
  assertSucceeded(apply);
  const applyStructured = (apply.structuredContent ?? {}) as Record<string, unknown>;
  assert.deepEqual(Object.keys(applyStructured).sort(), ["effects", "operation"]);
  const applyEffect = (applyStructured.effects as {
    files?: Array<Record<string, unknown>>;
  } | undefined)?.files?.[0] ?? {};
  assert.deepEqual(Object.keys(applyEffect).sort(), ["operation", "path", "version"]);
  assert.equal(applyEffect.operation, "add");
  assert.equal(applyEffect.path, "nested/created.txt");

  const persistedMutationCases = [
    {
      operationId: "persisted-outcome-unknown",
      path: "persisted-outcome-unknown.txt",
      state: "outcome_unknown",
      expected: {
        code: "operation_outcome_unknown",
        operationId: "persisted-outcome-unknown",
        phase: "outcome_unknown",
        effectsKnown: false,
        safeToRetry: false,
        recovery: "verify_effects_or_admin",
      },
    },
    {
      operationId: "persisted-verified-not-started",
      path: "persisted-verified-not-started.txt",
      state: "verified_not_started",
      expected: {
        code: "operation_verified_not_started",
        operationId: "persisted-verified-not-started",
        phase: "not_started",
        effectsKnown: true,
        safeToRetry: true,
        recovery: "new_operation_id",
      },
    },
    {
      operationId: "persisted-result-unavailable",
      path: "persisted-result-unavailable.txt",
      state: "settled",
      expected: {
        code: "operation_result_unavailable",
        operationId: "persisted-result-unavailable",
        phase: "committed",
        effectsKnown: false,
        safeToRetry: false,
        recovery: "verify_effects",
      },
    },
  ] as const;
  for (const mutationCase of persistedMutationCases) {
    const argumentsValue = addFilePatchArguments(
      mutationCase.operationId,
      mutationCase.path,
      "persisted state fixture",
    );
    assertSucceeded(await first.callTool({
      name: "apply_patch",
      arguments: argumentsValue,
      _meta: firstMeta,
    }));
    fixtureMutationOperationState(mutationCase.operationId, mutationCase.state);
    assertMutationError(await first.callTool({
      name: "apply_patch",
      arguments: argumentsValue,
      _meta: firstMeta,
    }), mutationCase.expected);
    assertMutationError(await first.callTool({
      name: "apply_patch",
      arguments: addFilePatchArguments(
        mutationCase.operationId,
        mutationCase.path,
        "conflicting request",
      ),
      _meta: firstMeta,
    }), {
      code: "operation_id_conflict",
      operationId: mutationCase.operationId,
      phase: "not_started",
      effectsKnown: true,
      safeToRetry: false,
      recovery: "new_operation_id",
    });
  }
  const replayArguments = addFilePatchArguments(
    "persisted-settled-replay",
    "persisted-settled-replay.txt",
    "replay fixture",
  );
  const replaySeed = await first.callTool({
    name: "apply_patch",
    arguments: replayArguments,
    _meta: firstMeta,
  });
  assertSucceeded(replaySeed);
  const replayed = await first.callTool({
    name: "apply_patch",
    arguments: replayArguments,
    _meta: firstMeta,
  });
  assertSucceeded(replayed);
  assert.deepEqual(replayed.structuredContent, replaySeed.structuredContent);
  assertMutationError(await first.callTool({
    name: "apply_patch",
    arguments: addFilePatchArguments(
      "persisted-settled-replay",
      "persisted-settled-replay.txt",
      "conflicting replay",
    ),
    _meta: firstMeta,
  }), {
    code: "operation_id_conflict",
    operationId: "persisted-settled-replay",
    phase: "not_started",
    effectsKnown: true,
    safeToRetry: false,
    recovery: "new_operation_id",
  });

  const changes = await first.callTool({
    name: "show_changes",
    arguments: { source: "repository" },
    _meta: firstMeta,
  });
  assertSucceeded(changes);
  assert.deepEqual(
    Object.keys((changes.structuredContent ?? {}) as Record<string, unknown>).sort(),
    ["diff", "summary"],
  );
  assert.doesNotMatch(
    JSON.stringify(changes.structuredContent),
    /changeSource|revision|offsetBytes|lengthBytes|totalBytes|eof/u,
  );
  assert.match(
    String((changes.structuredContent as {
      diff?: { patch?: unknown };
    } | undefined)?.diff?.patch),
    /nested\/created\.txt/u,
  );

  const listedSkills = await first.callTool({
    name: "skills",
    arguments: { query: "context-budget", limit: 1 },
    _meta: firstMeta,
  });
  assertSucceeded(listedSkills);
  assert.equal(toolText(listedSkills), "Skills found.");
  assert.deepEqual(
    Object.keys((listedSkills.structuredContent ?? {}) as Record<string, unknown>).sort(),
    ["nextCursor", "skills", "total"],
  );
  const listedSkillRecord = (listedSkills.structuredContent as {
    skills?: Array<Record<string, unknown>>;
  }).skills?.[0] ?? {};
  assert.deepEqual(Object.keys(listedSkillRecord).sort(), [
    "description", "explicitOnly", "name", "skillId", "trust",
  ]);
  const skillCursor = (listedSkills.structuredContent as {
    nextCursor?: unknown;
  } | undefined)?.nextCursor;
  assert.equal(typeof skillCursor, "string");
  const continuedSkills = await first.callTool({
    name: "skills",
    arguments: { cursor: skillCursor },
    _meta: firstMeta,
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
    arguments: { cursor: skillCursor, query: "context-budget" },
    _meta: firstMeta,
  });
  assertReadCursorRestart(repeatedSkillFields, "skill_cursor_fields_invalid");
  const invalidSkillCursor = await first.callTool({
    name: "skills",
    arguments: { cursor: "not-a-signed-cursor" },
    _meta: firstMeta,
  });
  assertReadCursorRestart(invalidSkillCursor, "invalid_skill_cursor");
  const skillId = (listedSkills.structuredContent as {
    skills?: Array<{ skillId?: unknown }>;
  } | undefined)?.skills?.[0]?.skillId;
  assert.equal(typeof skillId, "string");
  assertErrorCode(await first.callTool({
    name: "skills",
    arguments: { query: "context-budget", skillId },
    _meta: firstMeta,
  }), "skill_fields_invalid");
  assertErrorCode(await first.callTool({
    name: "skills",
    arguments: { query: "   " },
    _meta: firstMeta,
  }), "skill_query_required");
  const loadedSkill = await first.callTool({
    name: "skills",
    arguments: { skillId },
    _meta: firstMeta,
  });
  assertSucceeded(loadedSkill);
  assert.match(JSON.stringify(loadedSkill.structuredContent), new RegExp(skillBody, "u"));
  assert.equal(toolText(loadedSkill), "Skill loaded.");
  const loadedSkillRecord = (loadedSkill.structuredContent as {
    skill?: Record<string, unknown>;
  }).skill ?? {};
  assert.deepEqual(Object.keys(loadedSkillRecord).sort(), [
    "content", "resourceRoot", "skillId", "trust",
  ]);
  assert.equal(loadedSkillRecord.trust, "repository_untrusted");
  const reference = await first.callTool({
    name: "read_files",
    arguments: {
      files: [{ path: `skill://${skillId}/references/example.md` }],
    },
    _meta: firstMeta,
  });
  assertSucceeded(reference);
  assert.match(JSON.stringify(reference.structuredContent), /skill reference/u);
  assert.deepEqual(
    (reference.structuredContent as { provenance?: unknown }).provenance,
    { source: "repository", trust: "untrusted", authority: "none" },
  );

  const trustedSkills = await first.callTool({
    name: "skills",
    arguments: { query: "trusted-provenance-skill" },
    _meta: firstMeta,
  });
  assertSucceeded(trustedSkills);
  const trustedSkillId = (trustedSkills.structuredContent as {
    skills?: Array<{ skillId?: unknown }>;
  }).skills?.[0]?.skillId;
  assert.equal(typeof trustedSkillId, "string");
  assertSucceeded(await first.callTool({
    name: "skills",
    arguments: { skillId: trustedSkillId },
    _meta: firstMeta,
  }));
  const sourceSkillIds = new Map<string, string>();
  for (const source of ["admin", "devspace"] as const) {
    const result = await first.callTool({
      name: "skills",
      arguments: { query: `${source}-provenance-skill` },
      _meta: firstMeta,
    });
    assertSucceeded(result);
    const sourceSkillId = (result.structuredContent as {
      skills?: Array<{ skillId?: unknown }>;
    }).skills?.[0]?.skillId;
    assert.equal(typeof sourceSkillId, "string");
    sourceSkillIds.set(source, sourceSkillId as string);
    assertSucceeded(await first.callTool({
      name: "skills",
      arguments: { skillId: sourceSkillId },
      _meta: firstMeta,
    }));
  }
  const mixedRead = await first.callTool({
    name: "read_files",
    arguments: {
      files: [
        { path: "payload.txt" },
        { path: `skill://${skillId}/references/example.md` },
        { path: `skill://${trustedSkillId}/references/trusted.md` },
        { path: `skill://${sourceSkillIds.get("admin")}/references/admin.md` },
        { path: `skill://${sourceSkillIds.get("devspace")}/references/devspace.md` },
      ],
    },
    _meta: firstMeta,
  });
  assertSucceeded(mixedRead);
  const mixedReadContent = mixedRead.structuredContent as {
    provenance?: unknown;
    items?: Array<{ provenance?: unknown }>;
  };
  assert.equal(mixedReadContent.provenance, undefined);
  assert.deepEqual(mixedReadContent.items?.map((item) => item.provenance), [
    { source: "repository", trust: "untrusted", authority: "none" },
    { source: "repository", trust: "untrusted", authority: "none" },
    { source: "explicit", trust: "trusted", authority: "none" },
    { source: "admin", trust: "trusted", authority: "none" },
    { source: "devspace", trust: "trusted", authority: "none" },
  ]);

  const command = await first.callTool({
    name: "exec_command",
    arguments: {
      operationId: "context-budget-command",
      program: process.execPath,
      args: ["-e", "console.log('command-ok')"],
    },
    _meta: firstMeta,
  });
  assertSucceeded(command);
  assert.match(processOutputText(command), /command-ok/u);

  const second = await connect(origin, "context-budget-second");
  const secondMeta = {
    "openai/subject": "context-budget-subject",
    "openai/session": "context-budget-session-second",
  };
  const unboundSecond = await second.callTool({
    name: "read_files",
    arguments: {},
    _meta: secondMeta,
  });
  assertErrorCode(unboundSecond, "project_execution_required");
  const secondExecution = await second.callTool({
    name: "project_control",
    arguments: { action: "open", operationId: "context-budget-second-execution" },
    _meta: secondMeta,
  });
  assertSucceeded(secondExecution);
  const staleSkillCursor = await second.callTool({
    name: "skills",
    arguments: { cursor: skillCursor },
    _meta: secondMeta,
  });
  assertReadCursorRestart(staleSkillCursor, "skill_cursor_stale");
  assertSucceeded(await second.callTool({
    name: "read_files",
    arguments: { files: [{ path: "payload.txt" }] },
    _meta: secondMeta,
  }));
  assertErrorCode(await first.callTool({
    name: "read_files",
    arguments: {
      executionRef: "pex1_legacy-explicit-ref-that-must-not-select-an-execution",
      files: [{ path: "payload.txt" }],
    },
    _meta: firstMeta,
  }), "invalid_tool_input");
  assertSucceeded(await first.callTool({
    name: "project_control",
    arguments: { action: "hydrate" },
    _meta: firstMeta,
  }));
  const missingSession = await first.callTool({
    name: "read_files",
    arguments: { files: [{ path: "payload.txt" }] },
  });
  assertErrorCode(missingSession, "project_execution_required");
  const differentActor = await first.callTool({
    name: "read_files",
    arguments: { files: [{ path: "payload.txt" }] },
    _meta: {
      "openai/subject": "context-budget-other-subject",
      "openai/session": "context-budget-session-first",
    },
  });
  assertErrorCode(differentActor, "project_execution_required");
  const otherActorMeta = {
    "openai/subject": "context-budget-other-subject",
    "openai/session": "context-budget-session-first",
  };
  const crossActorReplay = await first.callTool({
    name: "project_control",
    arguments: { action: "open", operationId: "context-budget-execution" },
    _meta: otherActorMeta,
  });
  assertMutationError(crossActorReplay, {
    code: "operation_id_conflict",
    operationId: "context-budget-execution",
    phase: "not_started",
    effectsKnown: true,
    safeToRetry: false,
    recovery: "new_operation_id",
  });
  assertMutationError(await first.callTool({
    name: "project_control",
    arguments: { action: "interrupt", operationId: "cross-actor-interrupt" },
    _meta: otherActorMeta,
  }), {
    code: "project_execution_required",
    operationId: "cross-actor-interrupt",
    phase: "not_started",
    effectsKnown: true,
    safeToRetry: true,
    recovery: "project_control_open_or_resume",
  });

  const legacyActorMetas = [
    {
      "openai/subject": "legacy-unknown-owner-actor-a",
      "openai/session": "legacy-unknown-owner-session-a",
    },
    {
      "openai/subject": "legacy-unknown-owner-actor-b",
      "openai/session": "legacy-unknown-owner-session-b",
    },
  ];
  for (const actorMeta of legacyActorMetas) {
    const legacyList = await first.callTool({
      name: "project_thread_control",
      arguments: { action: "list" },
      _meta: actorMeta,
    });
    assertSucceeded(legacyList);
    assert.doesNotMatch(
      JSON.stringify(legacyList.structuredContent),
      new RegExp(legacyUnknownOwner.threadRef, "u"),
    );
    for (const action of ["status", "activity"] as const) {
      assertErrorCode(await first.callTool({
        name: "project_thread_control",
        arguments: { action, threadRef: legacyUnknownOwner.threadRef },
        _meta: actorMeta,
      }), "project_thread_not_found");
    }
    assertMutationError(await first.callTool({
      name: "project_control",
      arguments: {
        action: "open",
        projectRef: legacyUnknownOwner.projectRef,
        operationId: legacyUnknownOwner.operationId,
      },
      _meta: actorMeta,
    }), {
      code: "operation_id_conflict",
      operationId: legacyUnknownOwner.operationId,
      phase: "not_started",
      effectsKnown: true,
      safeToRetry: false,
      recovery: "new_operation_id",
    });
  }
  const legacyDatabase = new Database(join(stateDir, "project-threads.sqlite"), {
    readonly: true,
  });
  try {
    assert.equal(
      legacyDatabase.prepare(
        "select profile_id from project_threads where thread_id = ?",
      ).pluck().get(legacyUnknownOwner.threadId),
      legacyUnknownOwner.profileId,
      "current Actors must not claim a legacy thread while reading or replaying it",
    );
  } finally {
    legacyDatabase.close();
  }

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

function seedAccessToken(): ProjectExecutionAuthorization {
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
    return {
      principalId: grant.principalId,
      clientId: client.client_id,
      grantId: grant.grantId,
      authorizationEpoch: grant.authorizationEpoch,
    };
  } finally {
    store.close();
  }
}

function seedLegacyUnknownOwner(authorization: ProjectExecutionAuthorization): {
  threadId: string;
  threadRef: string;
  profileId: string;
  projectRef: string;
  operationId: string;
} {
  const projectRef = authorizationRootId(projectRoot, config.oauth.keys.authorizationRoot);
  const projectFingerprint = `proj_${createHmac(
    "sha256",
    config.oauth.keys.projectFingerprint,
  )
    .update("devspace:project-fingerprint:v1\0", "utf8")
    .update(projectRoot, "utf8")
    .digest("base64url")
    .slice(0, 22)}`;
  const profileId = createHash("sha256")
    .update("devspace:project-thread-profile:v1\0", "utf8")
    .update(authorization.principalId, "utf8")
    .update("\0", "utf8")
    .update(authorization.clientId, "utf8")
    .update("\0", "utf8")
    .update(authorization.grantId, "utf8")
    .digest("hex");
  const operationId = "legacy-unknown-owner-operation";
  const executions = new ProjectExecutionStore(stateDir);
  const threads = new ProjectThreadStore(stateDir);
  try {
    const reservation = executions.reserve({
      ...authorization,
      projectRef,
      projectFingerprint,
      sourceRoot: projectRoot,
      canonicalSourceRoot: projectRoot,
      createOperationId: operationId,
      requestHash: createHash("sha256").update(JSON.stringify({
        action: "open",
        projectRef,
        checkoutKind: "checkout",
      })).digest("hex"),
    });
    assert.equal(reservation.status, "new");
    if (reservation.status !== "new") throw new Error("legacy execution fixture conflict");
    const thread = threads.create({
      profileId,
      projectRef,
      projectFingerprint,
      title: "Legacy unknown owner",
      checkoutKind: "checkout",
      checkoutRoot: projectRoot,
    });
    threads.bindExecution(
      thread.threadId,
      profileId,
      reservation.execution.executionId,
      authorization.grantId,
    );
    return {
      threadId: thread.threadId,
      threadRef: encodeProjectThreadRef(thread.threadId, config.oauth.keys.projectFingerprint),
      profileId,
      projectRef,
      operationId,
    };
  } finally {
    threads.close();
    executions.close();
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
      safeToRetry?: unknown;
      recovery?: unknown;
    };
  } | undefined)?.error;
  assert.equal(error?.safeToRetry, true);
  assert.notEqual(error?.recovery, "user_action_required");
}

function assertReadOnlyBatchFailure(
  result: Awaited<ReturnType<Client["callTool"]>>,
  expectedCode: string,
  expectedRecovery: string,
  expectedItems: number,
): void {
  assertErrorCode(result, expectedCode);
  const structured = result.structuredContent as {
    error?: Record<string, unknown>;
    items?: Array<Record<string, unknown>>;
  } | undefined;
  assert.deepEqual(structured?.error, {
    code: expectedCode,
    safeToRetry: true,
    recovery: expectedRecovery,
  });
  assert.equal(structured?.items?.length, expectedItems);
  assert.ok(structured?.items?.every((item) => Object.hasOwn(item, "error")));
}

function assertMutationError(
  result: Awaited<ReturnType<Client["callTool"]>>,
  expected: {
    code: string;
    operationId: string;
    phase: "not_started" | "committed" | "outcome_unknown";
    effectsKnown: boolean;
    safeToRetry: boolean;
    recovery: string;
  },
): void {
  assert.equal(result.isError, true, JSON.stringify(result.content));
  const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
  assert.deepEqual(structured.error, expected);
  assert.equal(Object.hasOwn(structured, "operation"), false);
  assert.equal(Object.hasOwn(structured, "ok"), false);
  assert.equal(
    Object.hasOwn((structured.error ?? {}) as Record<string, unknown>, "retryable"),
    false,
  );
}

function addFilePatchArguments(operationId: string, path: string, content: string) {
  return {
    operationId,
    ifMatch: { [path]: null },
    patch: `*** Begin Patch\n*** Add File: ${path}\n+${content}\n*** End Patch`,
  };
}

function fixtureMutationOperationState(
  operationId: string,
  state: "outcome_unknown" | "verified_not_started" | "settled",
): void {
  const database = new Database(join(stateDir, "devspace.sqlite"));
  try {
    const updated = database.prepare(`
      update mutation_operations
      set state = ?, result_json = null,
        resolution_method = null, evidence_type = null, evidence_json = null,
        resolved_at = null, operator_ref = null
      where operation_id = ?
    `).run(state, operationId);
    assert.equal(updated.changes, 1);
  } finally {
    database.close();
  }
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
