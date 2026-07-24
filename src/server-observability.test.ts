import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  OPEN_WORKSPACE_ANNOTATIONS,
  SHOW_CHANGES_ANNOTATIONS,
  MAX_SKILL_CATALOG_BYTES,
  buildWorkspaceSkillCatalog,
  containsBatchedToolCall,
  commandInstructionScopePaths,
  jsonRpcRequestId,
  isExpectedPiToolError,
  processInputInstructionScopePaths,
  processInputPolicyViolation,
  processEnvironmentViolation,
  processCallSucceeded,
  processModelState,
  processResult,
  requiredOAuthScopesForToolCall,
  requiredOAuthScopesForTool,
  recoverableWorkspaceError,
  toolSurface,
  toolCallOperationId,
  toolCallWorkspaceId,
  readinessSnapshot,
  workspaceOperationId,
  workspaceToolRootLockMode,
  toolCallWorkspaceReceipt,
  workspaceAppAssetPaths,
} from "./server.js";
import type { Skill } from "./skills.js";
import { UnknownWorkspaceError } from "./workspaces.js";
import {
  connectionRef,
  isLoopbackProxyPeer,
  oauthClientRef,
  workspaceActivityRef,
} from "./logger.js";

assert.equal(isLoopbackProxyPeer("127.0.0.1"), true);
assert.equal(isLoopbackProxyPeer("127.12.34.56"), true);
assert.equal(isLoopbackProxyPeer("::1"), true);
assert.equal(isLoopbackProxyPeer("::ffff:127.0.0.1"), true);
assert.equal(isLoopbackProxyPeer("10.0.0.1"), false);
assert.equal(isLoopbackProxyPeer("::ffff:10.0.0.1"), false);
assert.equal(connectionRef("principal-a"), connectionRef("principal-a"));
assert.notEqual(connectionRef("principal-a"), connectionRef("principal-b"));
assert.match(connectionRef("principal-a") ?? "", /^conn_[a-f0-9]{12}$/u);
assert.equal(oauthClientRef("oauth-client-a"), oauthClientRef("oauth-client-a"));
assert.notEqual(oauthClientRef("oauth-client-a"), oauthClientRef("oauth-client-b"));
assert.match(oauthClientRef("oauth-client-a") ?? "", /^oauth_[a-f0-9]{12}$/u);
assert.equal(
  workspaceActivityRef("principal-a", "ws_project_a"),
  workspaceActivityRef("principal-a", "ws_project_a"),
);
assert.notEqual(
  workspaceActivityRef("principal-a", "ws_project_a"),
  workspaceActivityRef("principal-a", "ws_project_b"),
);
assert.notEqual(
  workspaceActivityRef("principal-a", "ws_project_a"),
  workspaceActivityRef("principal-b", "ws_project_a"),
);
assert.match(workspaceActivityRef("principal-a", "ws_project_a") ?? "", /^act_[a-f0-9]{12}$/u);
assert.equal(workspaceActivityRef(undefined, "ws_project_a"), undefined);
assert.equal(workspaceActivityRef("principal-a", undefined), undefined);
assert.equal(isExpectedPiToolError(Object.assign(new Error("missing"), { code: "ENOENT" })), true);
assert.equal(isExpectedPiToolError(Object.assign(new Error("not a directory"), { code: "ENOTDIR" })), true);
assert.equal(isExpectedPiToolError(Object.assign(new Error("storage failure"), { code: "EIO" })), false);
assert.equal(isExpectedPiToolError(new Error("unknown adapter failure")), false);

const catalogSkills: Skill[] = Array.from({ length: 80 }, (_, index) => ({
  skillId: `skill_${String(index).padStart(64, "0")}`,
  manifestHash: String(index).padStart(64, "0"),
  name: index < 2 ? "duplicate" : `skill-${index}`,
  description: `Skill ${index} ${"description ".repeat(80)}`,
  filePath: `/tmp/catalog/scope-${index}/SKILL.md`,
  baseDir: `/tmp/catalog/scope-${index}`,
  source: index % 2 === 0 ? "repo" : "user",
  scope: index % 2 === 0 ? "repo" : "user",
  sourceRoot: "/tmp/catalog",
  allowImplicitInvocation: index !== 1,
  disableModelInvocation: index === 1,
  sourceInfo: {
    path: `/tmp/catalog/scope-${index}/SKILL.md`,
    source: index % 2 === 0 ? "repo" : "user",
    scope: index % 2 === 0 ? "project" : "user",
    origin: "top-level",
    baseDir: "/tmp/catalog",
  },
}));
const boundedCatalog = buildWorkspaceSkillCatalog(catalogSkills);
assert.ok(boundedCatalog.bytes <= MAX_SKILL_CATALOG_BYTES);
assert.equal(Buffer.byteLength(JSON.stringify(boundedCatalog.skills), "utf8"), boundedCatalog.bytes);
assert.equal(boundedCatalog.totalSkills, catalogSkills.length);
assert.ok(boundedCatalog.omittedSkills > 0);
assert.equal(boundedCatalog.truncated, true);
assert.equal(boundedCatalog.skills[0]?.name, "duplicate");
assert.equal(boundedCatalog.skills[1]?.name, "duplicate");
assert.equal(boundedCatalog.skills[1]?.explicitOnly, true);
assert.equal(boundedCatalog.skills[1]?.scope, "user");
assert.doesNotMatch(JSON.stringify(boundedCatalog.skills), /\/tmp\/catalog/);

const multibyteCatalog = buildWorkspaceSkillCatalog(
  catalogSkills.map((skill) => ({ ...skill, description: `中文😀${skill.description}` })),
  1_024,
);
assert.ok(multibyteCatalog.bytes <= 1_024);
assert.equal(
  Buffer.byteLength(JSON.stringify(multibyteCatalog.skills), "utf8"),
  multibyteCatalog.bytes,
);

const recoverableProcessResult = processResult({
  output: "head\ntail\n",
  outputTruncated: true,
  running: false,
  exitCode: 0,
  wallTimeMs: 100,
  originalTokenCount: 50_000,
  outputOmittedBytes: 100_000,
  outputId: "output-test-id",
  totalOutputBytes: 200_000,
  storedOutputBytes: 200_000,
  droppedBytes: 0,
  timedOut: false,
  stdinClosed: true,
});
assert.match(recoverableProcessResult, /read_process_output/);
assert.doesNotMatch(recoverableProcessResult, /outputId=output-test-id/);
assert.equal(recoverableProcessResult.match(/truncated/g)?.length, 1);
assert.equal(recoverableProcessResult.match(/^\[/gm)?.length, 1);
const failedProcessSnapshot = {
  output: "ModuleNotFoundError: No module named 'numpy'",
  outputTruncated: false,
  running: false,
  exitCode: 1,
  wallTimeMs: 100,
  originalTokenCount: 8,
  outputOmittedBytes: 0,
  totalOutputBytes: 44,
  storedOutputBytes: 44,
  droppedBytes: 0,
  timedOut: false,
  stdinClosed: true,
};
assert.match(processResult(failedProcessSnapshot), /Process exited \(code 1\)/);
assert.doesNotMatch(processResult(failedProcessSnapshot), /partial effects|side effects/i);
assert.equal(processCallSucceeded(failedProcessSnapshot), false);
assert.equal(processCallSucceeded({ ...failedProcessSnapshot, running: true, exitCode: undefined }), true);
assert.equal(processCallSucceeded({ ...failedProcessSnapshot, exitCode: 0 }), true);
assert.match(processResult({
  output: "tail",
  outputTruncated: false,
  running: false,
  exitCode: 0,
  wallTimeMs: 100,
  originalTokenCount: 1,
  outputOmittedBytes: 0,
  outputId: "quota-output",
  totalOutputBytes: 20,
  storedOutputBytes: 10,
  droppedBytes: 10,
  timedOut: false,
  stdinClosed: true,
}), /10 bytes were irrecoverably dropped/);
assert.match(processResult({
  output: "",
  outputTruncated: false,
  running: true,
  sessionId: 42,
  wallTimeMs: 100,
  originalTokenCount: 0,
  outputOmittedBytes: 0,
  totalOutputBytes: 0,
  storedOutputBytes: 0,
  droppedBytes: 0,
  timedOut: false,
  stdinClosed: true,
}), /Stdin is closed/);
const sanitizedStorageFailure = processResult({
  output: "command stdout",
  outputTruncated: false,
  running: false,
  exitCode: 0,
  wallTimeMs: 100,
  originalTokenCount: 2,
  outputOmittedBytes: 0,
  totalOutputBytes: 14,
  storedOutputBytes: 0,
  droppedBytes: 0,
  outputStorageError: "SQLITE_CANTOPEN /Users/example/.devspace/private.sqlite",
  timedOut: false,
  stdinClosed: true,
});
assert.equal(sanitizedStorageFailure.match(/command stdout/g)?.length, 1);
assert.equal(sanitizedStorageFailure.match(/durable output unavailable/g)?.length, 1);
assert.doesNotMatch(sanitizedStorageFailure, /SQLITE|\/Users\/example|private\.sqlite/);

const failedStorageState = processModelState({
  output: "head\ntail",
  outputTruncated: true,
  running: false,
  exitCode: 0,
  wallTimeMs: 100,
  originalTokenCount: 50_000,
  outputOmittedBytes: 100_000,
  outputId: "unrecoverable-output",
  totalOutputBytes: 200_000,
  storedOutputBytes: 0,
  droppedBytes: 0,
  outputStorageError: "unavailable",
  timedOut: false,
  stdinClosed: true,
});
assert.equal("outputId" in failedStorageState, false);
assert.doesNotMatch(processResult({
  output: "head\ntail",
  outputTruncated: true,
  running: false,
  exitCode: 0,
  wallTimeMs: 100,
  originalTokenCount: 50_000,
  outputOmittedBytes: 100_000,
  outputId: "unrecoverable-output",
  totalOutputBytes: 200_000,
  storedOutputBytes: 0,
  droppedBytes: 0,
  outputStorageError: "unavailable",
  timedOut: false,
  stdinClosed: true,
}), /read_process_output|unrecoverable-output/);

const shellWorkspaceRoot = mkdtempSync(resolve(tmpdir(), "devspace-shell-scopes-"));
mkdirSync(resolve(shellWorkspaceRoot, "nested"));
mkdirSync(resolve(shellWorkspaceRoot, "foo", "bar"), { recursive: true });
mkdirSync(resolve(shellWorkspaceRoot, "bar"), { recursive: true });
const staticShellScopes = commandInstructionScopePaths(
  shellWorkspaceRoot,
  "cd nested && pwd",
  shellWorkspaceRoot,
  undefined,
);
assert.ok("paths" in staticShellScopes);
assert.deepEqual(staticShellScopes.paths, [".", resolve(shellWorkspaceRoot, "nested")]);
const dynamicShellScopes = commandInstructionScopePaths(
  shellWorkspaceRoot,
  'cd "$TARGET" && pwd',
  shellWorkspaceRoot,
  undefined,
);
assert.ok("error" in dynamicShellScopes);
assert.match(dynamicShellScopes.error.content[0]?.type === "text" ? dynamicShellScopes.error.content[0].text : "", /No command was executed/);
const missingShellScopes = commandInstructionScopePaths(
  shellWorkspaceRoot,
  "mkdir future && cd future && pwd",
  shellWorkspaceRoot,
  undefined,
);
assert.ok("paths" in missingShellScopes);
assert.ok(missingShellScopes.paths.includes(resolve(shellWorkspaceRoot, "future")));
const ambiguousChainedShellScopes = commandInstructionScopePaths(
  shellWorkspaceRoot,
  "cd foo && cd missing && pwd",
  shellWorkspaceRoot,
  undefined,
);
assert.ok("paths" in ambiguousChainedShellScopes);
assert.ok(ambiguousChainedShellScopes.paths.includes(resolve(shellWorkspaceRoot, "foo", "missing")));
assert.deepEqual(
  commandInstructionScopePaths(
    shellWorkspaceRoot,
    "/bin/bash -i",
    shellWorkspaceRoot,
    undefined,
  ),
  { paths: ["."] },
);

assert.equal(
  processInputInstructionScopePaths(shellWorkspaceRoot, undefined, {
    cwd: shellWorkspaceRoot,
    scopePaths: [shellWorkspaceRoot],
  }),
  undefined,
);
const interruptInput = processInputInstructionScopePaths(shellWorkspaceRoot, "\u0003", {
    cwd: shellWorkspaceRoot,
    scopePaths: [shellWorkspaceRoot],
  });
assert.ok(interruptInput && "paths" in interruptInput);
assert.equal(interruptInput.preparedInput.charsToWrite, "\u0003");
const interactiveInputScopes = processInputInstructionScopePaths(
  shellWorkspaceRoot,
  "cd nested\npwd\n",
  {
    cwd: shellWorkspaceRoot,
    scopePaths: [shellWorkspaceRoot],
  },
);
assert.ok(interactiveInputScopes && "paths" in interactiveInputScopes);
assert.deepEqual(interactiveInputScopes.paths, [
  shellWorkspaceRoot,
  resolve(shellWorkspaceRoot, "nested"),
]);
const retainedInteractiveScopes = processInputInstructionScopePaths(
  shellWorkspaceRoot,
  "cd bar\n",
  {
    cwd: shellWorkspaceRoot,
    scopePaths: [shellWorkspaceRoot, resolve(shellWorkspaceRoot, "foo")],
  },
);
assert.ok(retainedInteractiveScopes && "paths" in retainedInteractiveScopes);
assert.deepEqual(retainedInteractiveScopes.paths, [
  shellWorkspaceRoot,
  resolve(shellWorkspaceRoot, "foo"),
  resolve(shellWorkspaceRoot, "bar"),
]);
assert.equal(retainedInteractiveScopes.preparedInput.nextCwd, resolve(shellWorkspaceRoot, "bar"));

const firstInputFragment = processInputInstructionScopePaths(
  shellWorkspaceRoot,
  "c",
  {
    cwd: shellWorkspaceRoot,
    scopePaths: [shellWorkspaceRoot],
    inputMode: "shell",
    pendingInput: "",
    inputRevision: 0,
  },
);
assert.ok(firstInputFragment && "paths" in firstInputFragment);
assert.equal(firstInputFragment.preparedInput.charsToWrite, "");
assert.equal(firstInputFragment.preparedInput.pendingInput, "c");
const completedInputFragment = processInputInstructionScopePaths(
  shellWorkspaceRoot,
  "d nested\n",
  {
    cwd: shellWorkspaceRoot,
    scopePaths: [shellWorkspaceRoot],
    inputMode: "shell",
    pendingInput: "c",
    inputRevision: 1,
  },
);
assert.ok(completedInputFragment && "paths" in completedInputFragment);
assert.equal(completedInputFragment.preparedInput.charsToWrite, "cd nested\n");
assert.equal(completedInputFragment.preparedInput.nextCwd, resolve(shellWorkspaceRoot, "nested"));
assert.ok(completedInputFragment.paths.includes(resolve(shellWorkspaceRoot, "nested")));
assert.equal(processInputPolicyViolation(completedInputFragment.preparedInput), undefined);

const flushedInputFragment = processInputInstructionScopePaths(
  shellWorkspaceRoot,
  undefined,
  {
    cwd: shellWorkspaceRoot,
    scopePaths: [shellWorkspaceRoot],
    inputMode: "shell",
    pendingInput: "cd nested",
    inputRevision: 1,
  },
  { flushPending: true },
);
assert.ok(flushedInputFragment && "paths" in flushedInputFragment);
assert.equal(flushedInputFragment.preparedInput.charsToWrite, "cd nested");
assert.equal(flushedInputFragment.preparedInput.pendingInput, "");
assert.equal(flushedInputFragment.preparedInput.nextCwd, resolve(shellWorkspaceRoot, "nested"));

const dangerousInputFragment = processInputInstructionScopePaths(
  shellWorkspaceRoot,
  " -rf nested/file\n",
  {
    cwd: shellWorkspaceRoot,
    scopePaths: [shellWorkspaceRoot],
    inputMode: "shell",
    pendingInput: "rm",
    inputRevision: 1,
  },
);
assert.ok(dangerousInputFragment && "paths" in dangerousInputFragment);
assert.equal(processInputPolicyViolation(dangerousInputFragment.preparedInput), undefined);
const multilineDangerousInput = processInputInstructionScopePaths(
  shellWorkspaceRoot,
  "echo ok\nrm -rf nested/file\n",
  {
    cwd: shellWorkspaceRoot,
    scopePaths: [shellWorkspaceRoot],
    inputMode: "shell",
    pendingInput: "",
    inputRevision: 0,
  },
);
assert.ok(multilineDangerousInput && "paths" in multilineDangerousInput);
assert.equal(processInputPolicyViolation(multilineDangerousInput.preparedInput), undefined);
const privilegedInput = processInputInstructionScopePaths(
  shellWorkspaceRoot,
  "sudo id\n",
  {
    cwd: shellWorkspaceRoot,
    scopePaths: [shellWorkspaceRoot],
    inputMode: "shell",
    pendingInput: "",
    inputRevision: 0,
  },
);
assert.ok(privilegedInput && "paths" in privilegedInput);
assert.match(
  processInputPolicyViolation(privilegedInput.preparedInput) ?? "",
  /blocked by command policy/i,
);
const outsideWriteInput = processInputInstructionScopePaths(
  shellWorkspaceRoot,
  `touch ${resolve(shellWorkspaceRoot, "..", "outside-write.txt")}\n`,
  {
    cwd: shellWorkspaceRoot,
    scopePaths: [shellWorkspaceRoot],
    inputMode: "shell",
    pendingInput: "",
    inputRevision: 0,
  },
);
assert.ok(outsideWriteInput && "paths" in outsideWriteInput);
assert.match(
  processInputPolicyViolation(outsideWriteInput.preparedInput, {
    cwd: shellWorkspaceRoot,
    workspaceRoot: shellWorkspaceRoot,
  }) ?? "",
  /outside the workspace/i,
);
const opaqueInteractiveCwd = processInputInstructionScopePaths(
  shellWorkspaceRoot,
  "eval cd ..\ntouch escaped\n",
  {
    cwd: shellWorkspaceRoot,
    scopePaths: [shellWorkspaceRoot],
    inputMode: "shell",
    pendingInput: "",
    inputRevision: 0,
  },
);
assert.ok(opaqueInteractiveCwd && "error" in opaqueInteractiveCwd);
assert.match(
  opaqueInteractiveCwd.error.content[0]?.type === "text"
    ? opaqueInteractiveCwd.error.content[0].text
    : "",
  /can change an interactive cwd without a verifiable path/i,
);
const chainedOpaqueInteractiveCwd = processInputInstructionScopePaths(
  shellWorkspaceRoot,
  "true && eval cd ..\ntouch escaped\n",
  {
    cwd: shellWorkspaceRoot,
    scopePaths: [shellWorkspaceRoot],
    inputMode: "shell",
    pendingInput: "",
    inputRevision: 0,
  },
);
assert.ok(chainedOpaqueInteractiveCwd && "error" in chainedOpaqueInteractiveCwd);

assert.equal(
  processInputInstructionScopePaths(shellWorkspaceRoot, 'print("$TARGET")\n', {
    cwd: shellWorkspaceRoot,
    scopePaths: [shellWorkspaceRoot],
    inputMode: "opaque",
    pendingInput: "",
    inputRevision: 0,
  }),
  undefined,
);
const dynamicInteractiveInputScopes = processInputInstructionScopePaths(
  shellWorkspaceRoot,
  'cd "$TARGET"\n',
  {
    cwd: shellWorkspaceRoot,
    scopePaths: [shellWorkspaceRoot],
  },
);
assert.ok(dynamicInteractiveInputScopes && "error" in dynamicInteractiveInputScopes);

assert.deepEqual(OPEN_WORKSPACE_ANNOTATIONS, {
  destructiveHint: false,
  openWorldHint: false,
});

assert.deepEqual(SHOW_CHANGES_ANNOTATIONS, {
  destructiveHint: false,
  openWorldHint: false,
});

assert.deepEqual(
  readinessSnapshot({
    closing: false,
    workspaceDatabaseReady: true,
    oauthDatabaseReady: true,
  }),
  {
    statusCode: 200,
    body: {
      ok: true,
      name: "devspace",
      status: "ready",
      checks: {
        lifecycle: true,
        workspaceDatabase: true,
        oauthDatabase: true,
      },
    },
  },
);

const notReady = readinessSnapshot({
  closing: true,
  workspaceDatabaseReady: false,
  oauthDatabaseReady: true,
});
assert.equal(notReady.statusCode, 503);
assert.equal(notReady.body.ok, false);
assert.equal(notReady.body.status, "not_ready");
assert.deepEqual(notReady.body.checks, {
  lifecycle: false,
  workspaceDatabase: false,
  oauthDatabase: true,
});

const generated = readinessSnapshot({
  closing: false,
  workspaceDatabaseReady: true,
  oauthDatabaseReady: true,
  generation: "generation-test",
});
assert.equal(generated.body.generation, "generation-test");

assert.equal(workspaceOperationId({
  method: "tools/call",
  params: { name: "read", arguments: { workspaceId: "ws_test" } },
}), undefined);
assert.equal(toolCallWorkspaceReceipt({
  method: "tools/call",
  params: { name: "read", arguments: { receipt: `wctx3.${"A".repeat(43)}` } },
}), `wctx3.${"A".repeat(43)}`);
assert.equal(toolCallOperationId({
  method: "tools/call",
  params: { name: "exec_command", arguments: { operationId: "operation-17" } },
}), "operation-17");
assert.equal(toolCallOperationId({
  method: "tools/call",
  params: { name: "exec_command", arguments: { operationId: "x".repeat(129) } },
}), undefined);
assert.equal(workspaceToolRootLockMode({
  method: "tools/call",
  params: { name: "read", arguments: { receipt: `wctx3.${"A".repeat(43)}` } },
}), "read");
assert.equal(workspaceToolRootLockMode({
  method: "tools/call",
  params: { name: "apply_patch", arguments: { receipt: `wctx3.${"A".repeat(43)}` } },
}), "write");
assert.equal(workspaceToolRootLockMode({
  method: "tools/call",
  params: { name: "write_stdin", arguments: { receipt: `wctx3.${"A".repeat(43)}`, sessionId: 1 } },
}), "read");
assert.equal(workspaceToolRootLockMode({
  method: "tools/call",
  params: {
    name: "write_stdin",
    arguments: { receipt: `wctx3.${"A".repeat(43)}`, sessionId: 1, chars: "input" },
  },
}), "write");
assert.deepEqual(requiredOAuthScopesForTool("read"), ["workspace:read"]);
assert.deepEqual(requiredOAuthScopesForTool("get_operation_status"), ["workspace:read"]);
assert.deepEqual(requiredOAuthScopesForTool("exec_command"), [
  "workspace:read",
  "workspace:write",
  "process:execute",
  "network:access",
]);
assert.deepEqual(requiredOAuthScopesForTool("read_process_output"), [
  "workspace:read",
  "process:execute",
]);
assert.deepEqual(requiredOAuthScopesForTool("show_changes"), [
  "workspace:read",
  "workspace:write",
]);
assert.deepEqual(requiredOAuthScopesForToolCall({
  method: "tools/call",
  params: { name: "write_stdin", arguments: { sessionId: 1 } },
}), ["workspace:read", "process:execute"]);
assert.deepEqual(requiredOAuthScopesForToolCall({
  method: "tools/call",
  params: { name: "write_stdin", arguments: { sessionId: 1, chars: "input" } },
}), ["workspace:read", "process:execute", "workspace:write", "network:access"]);
assert.deepEqual(requiredOAuthScopesForToolCall({
  method: "tools/call",
  params: {
    name: "open_workspace",
    arguments: { path: "/tmp/project", mode: "worktree" },
  },
}), ["workspace:read", "workspace:write", "worktree:create"]);
assert.deepEqual(requiredOAuthScopesForTool("revoke_workspace"), ["workspace:revoke"]);
assert.equal(processEnvironmentViolation({ VALID_NAME: "value" }), undefined);
assert.match(
  processEnvironmentViolation(Object.fromEntries(
    Array.from({ length: 129 }, (_, index) => [`ENV_${index}`, "value"]),
  )) ?? "",
  /limited to 128 entries/,
);
assert.match(
  processEnvironmentViolation({ TOO_LARGE: "x".repeat(128 * 1_024) }) ?? "",
  /byte limit/,
);
assert.match(processEnvironmentViolation({ CDPATH: "/tmp" }) ?? "", /managed by DevSpace/);
assert.equal(workspaceOperationId({
  method: "tools/call",
  params: { name: "close_workspace", arguments: { workspaceId: "ws_test" } },
}), undefined);
for (const name of ["list_workspaces", "resume_workspace", "get_workspace_context"]) {
  assert.equal(workspaceOperationId({
    method: "tools/call",
    params: { name, arguments: { alias: "project" } },
  }), undefined);
}
assert.equal(toolCallWorkspaceId({
  method: "tools/call",
  params: { name: "close_workspace", arguments: { workspaceId: "ws_test" } },
}), "ws_test");
assert.equal(toolCallWorkspaceId({
  method: "tools/call",
  params: { name: "open_workspace", arguments: { path: "/tmp/project" } },
}), undefined);
assert.equal(toolCallWorkspaceId([{ method: "tools/call" }]), undefined);
assert.equal(workspaceOperationId([{ method: "tools/call" }]), undefined);
assert.equal(jsonRpcRequestId({ jsonrpc: "2.0", id: 42 }), 42);
assert.equal(jsonRpcRequestId({ jsonrpc: "2.0", id: "call-1" }), "call-1");
assert.equal(jsonRpcRequestId([{ jsonrpc: "2.0", id: 42 }]), null);
assert.match(
  recoverableWorkspaceError(new UnknownWorkspaceError("ws_stale")) ?? "",
  /^unknown_workspace: Call list_workspaces/,
);
assert.doesNotMatch(
  recoverableWorkspaceError(new UnknownWorkspaceError("ws_stale")) ?? "",
  /ws_stale/,
);
assert.equal(recoverableWorkspaceError(new Error("database failure")), undefined);

const commonTools = [
  "apply_patch", "batch_inspect", "batch_read", "close_workspace", "exec_command",
  "get_operation_status", "get_workspace_context", "list_workspaces", "load_workspace_instructions",
  "open_workspace", "read", "read_process_output", "resume_workspace", "revoke_workspace", "write_stdin",
];
assert.deepEqual(toolSurface({ widgets: "off", skillsEnabled: true }), [
  ...commonTools, "list_skills", "load_skill",
].sort());
const changesSurface = toolSurface({ widgets: "changes", skillsEnabled: false });
assert.ok(changesSurface.includes("show_changes"));
assert.equal(changesSurface.includes("load_skill"), false);
assert.equal(changesSurface.includes("bash"), false);
assert.equal(changesSurface.some((name) => ["write", "edit", "grep", "glob", "ls"].includes(name)), false);
assert.equal(changesSurface.some((name) => name.startsWith("ui://")), false);
assert.equal(containsBatchedToolCall([
  { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "close_workspace", arguments: { workspaceId: "ws_test" } } },
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "exec_command", arguments: { workspaceId: "ws_test", command: "pwd" } } },
]), true);
assert.equal(containsBatchedToolCall([
  { jsonrpc: "2.0", id: 1, method: "ping" },
  { jsonrpc: "2.0", method: "notifications/initialized" },
]), false);

const publicAssets = workspaceAppAssetPaths();
assert.equal(publicAssets.has("admin.html"), false);
assert.equal([...publicAssets].some((path) => /(^|\/)admin-[^/]+\.(?:js|css)$/.test(path)), false);
assert.equal([...publicAssets].every((path) => path.startsWith("assets/")), true);
