import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkspaceBash } from "./bash-tool.js";
import { loadConfig } from "./config.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { WorkspaceRegistry } from "./workspaces.js";

const root = await mkdtemp(join(tmpdir(), "devspace-bash-tool-"));
const outsideRoot = await mkdtemp(join(tmpdir(), "devspace-bash-tool-outside-"));
const canonicalRoot = await realpath(root);
const nested = join(root, "src");
await mkdir(nested);
await writeFile(join(nested, "hello.txt"), "hi\n");

const config = loadConfig({
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-123456",
  DEVSPACE_ALLOWED_ROOTS: root,
  DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:7676",
  DEVSPACE_TOOL_MODE: "full",
  DEVSPACE_SKILLS: "0",
  DEVSPACE_LOG_LEVEL: "silent",
});

const workspaces = new WorkspaceRegistry(config);
const processSessions = new ProcessSessionManager();
const ownerClientId = "client-a";
const { workspace } = await workspaces.openWorkspace(ownerClientId, root);

try {
  const first = await runWorkspaceBash({
    workspaces,
    processSessions,
    workspace,
    input: { command: "pwd" },
  });
  assert.equal(first.isError, undefined);
  assert.equal(first.snapshot.exitCode, 0);
  assert.match(first.content[0]?.text ?? "", new RegExp(root.replaceAll("\\", "\\\\")));
  assert.equal(first.cwd, canonicalRoot);

  const structuredStdin = await runWorkspaceBash({
    workspaces,
    processSessions,
    workspace,
    input: {
      command: `${JSON.stringify(process.execPath)} -e "let data=''; process.stdin.on('data', chunk => data += chunk); process.stdin.on('end', () => console.log(JSON.stringify(data)))"`,
      stdin: "line one\n第二行\n",
    },
  });
  assert.equal(structuredStdin.isError, undefined);
  assert.equal(structuredStdin.snapshot.exitCode, 0);
  assert.equal(structuredStdin.snapshot.stdinClosed, true);
  assert.match(structuredStdin.content[0]?.text ?? "", /line one\\n第二行\\n/);

  // Per-turn cwd: cd inside one call does not change later calls.
  const cd = await runWorkspaceBash({
    workspaces,
    processSessions,
    workspace,
    input: { command: "cd src && pwd" },
  });
  assert.equal(cd.snapshot.exitCode, 0);
  assert.match(cd.content[0]?.text ?? "", /src/);
  assert.equal(workspaces.getShellCwd(workspace), canonicalRoot);

  const afterCd = await runWorkspaceBash({
    workspaces,
    processSessions,
    workspace,
    input: { command: "pwd" },
  });
  assert.equal(afterCd.snapshot.exitCode, 0);
  assert.match(afterCd.content[0]?.text ?? "", new RegExp(root.replaceAll("\\", "\\\\")));
  assert.doesNotMatch(afterCd.content[0]?.text ?? "", /\/src$/);

  // Explicit workingDirectory selects a subdir for that call only.
  const nestedPwd = await runWorkspaceBash({
    workspaces,
    processSessions,
    workspace,
    input: {
      command: "pwd",
      workingDirectory: "src",
    },
  });
  assert.equal(nestedPwd.snapshot.exitCode, 0);
  assert.match(nestedPwd.content[0]?.text ?? "", /src/);
  assert.equal(nestedPwd.cwd, join(canonicalRoot, "src"));
  assert.equal(workspaces.getShellCwd(workspace), canonicalRoot);

  const failed = await runWorkspaceBash({
    workspaces,
    processSessions,
    workspace,
    input: {
      command: "exit 7",
      description: "Exit with failure",
    },
  });
  assert.equal(failed.isError, true);
  assert.equal(failed.snapshot.exitCode, 7);
  assert.match(failed.content[0]?.text ?? "", /exited with code 7/);

  const blocked = await runWorkspaceBash({
    workspaces,
    processSessions,
    workspace,
    input: { command: "rm -f hello.txt" },
  });
  assert.equal(blocked.isError, true);
  assert.equal(blocked.policy?.decision, "deny");
  assert.match(blocked.content[0]?.text ?? "", /Command blocked by command policy/);

  const wrappedShellStdin = await runWorkspaceBash({
    workspaces,
    processSessions,
    workspace,
    input: {
      command: "env bash",
      stdin: "rm -rf generated\n",
    },
  });
  assert.equal(wrappedShellStdin.isError, true);
  assert.match(wrappedShellStdin.content[0]?.text ?? "", /command policy/i);

  const shellWrite = await runWorkspaceBash({
    workspaces,
    processSessions,
    workspace,
    input: {
      command: "bash -lc 'mkdir -p generated && printf ok > generated/result.txt && cp generated/result.txt generated/copy.txt'",
    },
  });
  assert.equal(shellWrite.snapshot.exitCode, 0);
  assert.equal(await readFile(join(root, "generated", "copy.txt"), "utf8"), "ok");

  const outsideWrite = await runWorkspaceBash({
    workspaces,
    processSessions,
    workspace,
    input: { command: `touch ${JSON.stringify(join(outsideRoot, "blocked.txt"))}` },
  });
  assert.equal(outsideWrite.isError, true);
  assert.match(outsideWrite.content[0]?.text ?? "", /outside the workspace/);

  const background = await runWorkspaceBash({
    workspaces,
    processSessions,
    workspace,
    input: {
      command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => console.log('bg-done'), 150)"`,
      runInBackground: true,
    },
  });
  assert.equal(background.snapshot.running, true);
  assert.ok(background.snapshot.sessionId);
  assert.match(background.content[0]?.text ?? "", /session ID/);

  const polled = await processSessions.write({
    ownerClientId,
    workspaceId: workspace.id,
    sessionId: background.snapshot.sessionId!,
    yieldTimeMs: 2_000,
  });
  assert.equal(polled.running, false);
  assert.match(polled.output, /bg-done/);
  assert.equal(typeof polled.originalTokenCount, "number");
  assert.equal(typeof polled.outputOmittedBytes, "number");
} finally {
  await processSessions.shutdown();
  await rm(root, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
}

console.log("bash-tool integration tests passed");
