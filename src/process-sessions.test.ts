import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HeadTailBuffer,
  isInteractiveShellCommand,
  MAX_PROCESS_INPUT_BYTES,
  ProcessSessionManager,
} from "./process-sessions.js";
import { ProcessOutputStore } from "./process-output-store.js";

for (const command of [
  "bash",
  "/bin/zsh -i",
  "env bash",
  "/usr/bin/env TEST=1 /bin/sh -s",
  "command zsh",
  "nohup nice -n 5 bash",
  "bash -s -- name",
  "bash --rcfile /dev/null",
  "bash -O extglob",
  "sh -eu",
  "zsh --no-rcs",
  "dash -e",
  "ksh -o vi",
  "fish -C 'set greeting hello'",
  "fish --no-config",
  "env -S 'bash -s'",
  "find . -exec bash -s {} \\;",
  "printf x | xargs bash -s",
  // Malformed or unknown options are conservatively treated as shell mode.
  "bash -c",
  "bash --future-option value",
]) {
  assert.equal(isInteractiveShellCommand(command), true, command);
}

for (const command of [
  "python",
  "bash -lc 'echo unsafe'",
  "bash ./script.sh",
  "bash --rcfile /dev/null ./script.sh",
  "sh -eu ./script.sh",
  "zsh -f ./script.zsh",
  "dash -- ./script.sh",
  "ksh -R xref ./script.ksh",
  "fish -C 'set greeting hello' ./script.fish",
  "fish --command 'echo unsafe'",
  "fish --command='echo unsafe'",
  "env -S \"bash -c 'echo delegated'\"",
]) {
  assert.equal(isInteractiveShellCommand(command), false, command);
}

const smallBuffer = new HeadTailBuffer(100);
smallBuffer.append("hello\n");
assert.deepEqual(smallBuffer.drain(100), { output: "hello\n", truncated: false, omittedBytes: 0 });
assert.deepEqual(smallBuffer.drain(100), { output: "", truncated: false, omittedBytes: 0 });

const headTail = new HeadTailBuffer(10);
headTail.append("start-middle-end");
const headTailResult = headTail.drain(1_000);
assert.equal(headTailResult.truncated, true);
assert.match(headTailResult.output, /^start/);
assert.match(headTailResult.output, /e-end$/);
assert.match(headTailResult.output, /bytes omitted/);

const responseLimited = new HeadTailBuffer(100);
responseLimited.append("abcdef".repeat(20));
const responseLimitedResult = responseLimited.drain(40);
assert.equal(responseLimitedResult.truncated, true);
assert.match(responseLimitedResult.output, /^abc/);
assert.match(responseLimitedResult.output, /def$/);

const unicodeBuffer = new HeadTailBuffer(10);
unicodeBuffer.append("a🙂b🙂c");
const unicodeResult = unicodeBuffer.drain(1_000);
assert.equal(unicodeResult.truncated, true);
assert.match(unicodeResult.output, /^a🙂/);
assert.match(unicodeResult.output, /🙂c$/);

const byteBoundedBuffer = new HeadTailBuffer(8);
byteBoundedBuffer.append("中".repeat(10));
const byteBoundedResult = byteBoundedBuffer.drain(1_000);
assert.equal(byteBoundedResult.truncated, true);
assert.ok(Buffer.byteLength(byteBoundedResult.output.replace(/\n\.\.\. output truncated \(\d+ bytes omitted\) \.\.\.\n/u, ""), "utf8") <= 8);

for (const multibyteOutput of ["🙂".repeat(200), "中文".repeat(200)]) {
  const responseByteBounded = new HeadTailBuffer(10_000);
  responseByteBounded.append(multibyteOutput);
  const responseByteBoundedResult = responseByteBounded.drain(400);
  assert.equal(responseByteBoundedResult.truncated, true);
  assert.ok(Buffer.byteLength(responseByteBoundedResult.output, "utf8") <= 400);
  assert.equal(responseByteBoundedResult.output.includes("�"), false);
}

const manager = new ProcessSessionManager({
  maxBufferBytes: 1_024,
  completedSessionTtlMs: 1_000,
});
const connectionPrincipalId = "client-a";

const node = process.platform === "win32"
  ? `"${process.execPath}"`
  : JSON.stringify(process.execPath);

interface ProcessTreePids {
  child: number;
  grandchild: number;
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail("Timed out waiting for process state");
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function assertProcessTreeExited(pids: ProcessTreePids, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pids.child) && !processExists(pids.grandchild)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail(`PTY descendants survived termination: ${JSON.stringify(pids)}`);
}

async function startStubbornPtyTree(
  treeManager: ProcessSessionManager,
  workspaceId: string,
  markerPath: string,
  readyPath: string,
  runtimeLimitMs?: number,
): Promise<{ sessionId: number; pids: ProcessTreePids }> {
  const grandchildScript = [
    "const fs = require('node:fs');",
    "process.on('SIGTERM', () => {});",
    "process.on('SIGHUP', () => {});",
    "fs.writeFileSync(process.argv[1], 'ready');",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const childScript = [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}, process.argv[2]], { stdio: 'ignore' });`,
    "process.on('SIGTERM', () => {});",
    "process.on('SIGHUP', () => {});",
    "fs.writeFileSync(process.argv[1], JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const rootScript = [
    "const { spawn } = require('node:child_process');",
    `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}, process.argv[1], process.argv[2]], { stdio: 'ignore' });`,
    "process.on('SIGTERM', () => {});",
    "process.on('SIGHUP', () => {});",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const started = await treeManager.start({
    connectionPrincipalId,
    workspaceId,
    cwd: process.cwd(),
    command: { program: process.execPath, args: ["-e", rootScript, markerPath, readyPath] },
    tty: true,
    runtimeLimitMs,
    yieldTimeMs: 5,
  });
  assert.ok(started.sessionId);
  const pids = JSON.parse(await waitForFile(markerPath)) as ProcessTreePids;
  await waitForFile(readyPath);
  return { sessionId: started.sessionId, pids };
}

function forceKillLeftovers(pids: ProcessTreePids | undefined): void {
  if (!pids) return;
  for (const pid of [pids.child, pids.grandchild]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

const foreground = await manager.start({
  connectionPrincipalId,
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log('foreground')"`,
  yieldTimeMs: 2_000,
});
assert.equal(foreground.running, false);
assert.equal(foreground.exitCode, 0);
assert.match(foreground.output, /foreground/);
assert.equal(foreground.sessionId, undefined);
assert.equal(foreground.stdinClosed, true);

const literalArgs = ["two words", "$(echo not-executed)", "semi;colon", "*.ts", "'quoted'", ""];
const directForeground = await manager.start({
  connectionPrincipalId,
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: {
    program: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...literalArgs],
  },
  yieldTimeMs: 2_000,
});
assert.equal(directForeground.running, false);
assert.equal(directForeground.exitCode, 0);
assert.deepEqual(JSON.parse(directForeground.output), literalArgs);

const initialStdin = await manager.start({
  connectionPrincipalId,
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "let data=''; process.stdin.on('data', chunk => data += chunk); process.stdin.on('end', () => console.log(JSON.stringify(data)))"`,
  stdin: "first line\n第二行\n",
  yieldTimeMs: 2_000,
});
assert.equal(initialStdin.running, false);
assert.equal(initialStdin.exitCode, 0);
assert.equal(initialStdin.stdinClosed, true);
assert.match(initialStdin.output, /first line\\n第二行\\n/);

const earlyExitWithStdin = await manager.start({
  connectionPrincipalId,
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: "true",
  stdin: "x".repeat(MAX_PROCESS_INPUT_BYTES),
  yieldTimeMs: 2_000,
});
assert.equal(earlyExitWithStdin.running, false);
assert.equal(earlyExitWithStdin.exitCode, 0);

const emptyInitialStdin = await manager.start({
  connectionPrincipalId,
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "process.stdin.on('end', () => console.log('empty-eof')); process.stdin.resume()"`,
  stdin: "",
  yieldTimeMs: 2_000,
});
assert.equal(emptyInitialStdin.running, false);
assert.match(emptyInitialStdin.output, /empty-eof/);

const streamedStdin = await manager.start({
  connectionPrincipalId,
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "let data=''; process.stdin.on('data', chunk => data += chunk); process.stdin.on('end', () => console.log(data))"`,
  stdin: "first-",
  closeStdin: false,
  yieldTimeMs: 5,
});
assert.equal(streamedStdin.running, true);
assert.equal(streamedStdin.stdinClosed, false);
const streamedResult = await manager.write({
  connectionPrincipalId,
  workspaceId: "workspace-a",
  sessionId: streamedStdin.sessionId!,
  chars: "second",
  closeStdin: true,
  yieldTimeMs: 2_000,
});
assert.equal(streamedResult.running, false);
assert.equal(streamedResult.stdinClosed, true);
assert.match(streamedResult.output, /first-second/);

const closedButRunning = await manager.start({
  connectionPrincipalId,
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "process.stdin.on('end', () => setTimeout(() => process.exit(0), 500)); process.stdin.resume()"`,
  stdin: "done",
  yieldTimeMs: 5,
});
assert.equal(closedButRunning.running, true);
assert.equal(closedButRunning.stdinClosed, true);
await assert.rejects(
  manager.write({
    connectionPrincipalId,
    workspaceId: "workspace-a",
    sessionId: closedButRunning.sessionId!,
    chars: "too-late",
  }),
  /stdin is already closed/,
);
const repeatedClose = await manager.write({
  connectionPrincipalId,
  workspaceId: "workspace-a",
  sessionId: closedButRunning.sessionId!,
  closeStdin: true,
  yieldTimeMs: 1,
});
assert.equal(repeatedClose.stdinClosed, true);

await assert.rejects(
  manager.start({
    connectionPrincipalId,
    workspaceId: "workspace-a",
    cwd: process.cwd(),
    command: "sh",
    tty: true,
    stdin: "echo no\n",
  }),
  /PTY stdin cannot be closed reliably/,
);
await assert.rejects(
  manager.start({
    connectionPrincipalId,
    workspaceId: "workspace-a",
    cwd: process.cwd(),
    command: "printf unreachable",
    stdin: "a".repeat(MAX_PROCESS_INPUT_BYTES + 1),
  }),
  /exceeds the .*byte limit/,
);

const previousCdPath = process.env.CDPATH;
const previousSecret = process.env.DEVSPACE_TEST_SECRET;
const previousJavaHome = process.env.JAVA_HOME;
process.env.CDPATH = "/tmp/should-not-leak";
process.env.DEVSPACE_TEST_SECRET = "must-not-leak";
process.env.JAVA_HOME = "/tmp/devspace-java-home";
const environment = await manager.start({
  connectionPrincipalId,
  workspaceId: "workspace-a",
  workspaceRoot: "/tmp/devspace-workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log([process.env.NO_COLOR, process.env.TERM, process.env.PAGER, process.env.GIT_PAGER, process.env.GH_PAGER, process.env.CODEX_CI, process.env.DEVSPACE_WORKSPACE_ID, process.env.DEVSPACE_WORKSPACE_ROOT, process.env.CDPATH ?? 'unset', process.env.DEVSPACE_TEST_SECRET ?? 'unset', process.env.DEVSPACE_EXPLICIT_ENV, process.env.PATH ? 'path' : 'no-path', process.env.JAVA_HOME].join(','))"`,
  environment: { DEVSPACE_EXPLICIT_ENV: "explicit" },
  yieldTimeMs: 2_000,
});
if (previousCdPath === undefined) delete process.env.CDPATH;
else process.env.CDPATH = previousCdPath;
if (previousSecret === undefined) delete process.env.DEVSPACE_TEST_SECRET;
else process.env.DEVSPACE_TEST_SECRET = previousSecret;
if (previousJavaHome === undefined) delete process.env.JAVA_HOME;
else process.env.JAVA_HOME = previousJavaHome;
assert.equal(environment.running, false);
assert.match(
  environment.output,
  /1,dumb,cat,cat,cat,1,workspace-a,\/tmp\/devspace-workspace-a,unset,unset,explicit,path,\/tmp\/devspace-java-home/,
);

const background = await manager.start({
  connectionPrincipalId,
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setTimeout(() => console.log('finished'), 100)"`,
  instructionScopePaths: [process.cwd(), `${process.cwd()}/nested`],
  yieldTimeMs: 5,
});
assert.equal(background.running, true);
assert.ok(background.sessionId);
assert.equal(typeof background.sessionId, "number");
const backgroundSessionId = background.sessionId;
assert.ok(backgroundSessionId);
assert.deepEqual(
  manager.instructionContext(connectionPrincipalId, "workspace-a", backgroundSessionId),
  {
    cwd: process.cwd(),
    scopePaths: [process.cwd(), `${process.cwd()}/nested`],
    inputMode: "opaque",
    pendingInput: "",
    inputRevision: 0,
    stdinClosed: false,
  },
);
await assert.rejects(
  async () => manager.instructionContext("client-b", "workspace-a", backgroundSessionId),
  (error: unknown) =>
    error instanceof Error &&
    error.message === "The process session is no longer available." &&
    "code" in error && error.code === "unknown_process_session",
);

await assert.rejects(
  manager.write({
    connectionPrincipalId,
    workspaceId: "workspace-b",
    sessionId: background.sessionId,
    yieldTimeMs: 1,
  }),
  /no longer available/,
);

await manager.write({
  connectionPrincipalId,
  workspaceId: "workspace-a",
  sessionId: backgroundSessionId,
  chars: "x",
  instructionScopePaths: ["./deeper"],
  yieldTimeMs: 1,
});
assert.deepEqual(
  manager.instructionContext(connectionPrincipalId, "workspace-a", backgroundSessionId).scopePaths,
  [process.cwd(), `${process.cwd()}/nested`, `${process.cwd()}/deeper`],
);

const completed = await manager.write({
  connectionPrincipalId,
  workspaceId: "workspace-a",
  sessionId: background.sessionId,
  yieldTimeMs: 2_000,
});
assert.equal(completed.running, false);
assert.equal(completed.exitCode, 0);
assert.match(completed.output, /finished/);

const interactive = await manager.start({
  connectionPrincipalId,
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "process.stdin.once('data', data => { console.log('input:' + data.toString().trim()); process.exit(0); })"`,
  yieldTimeMs: 5,
});
assert.equal(interactive.running, true);
assert.ok(interactive.sessionId);
assert.equal(typeof interactive.sessionId, "number");

const inputResult = await manager.write({
  connectionPrincipalId,
  workspaceId: "workspace-a",
  sessionId: interactive.sessionId,
  chars: "hello\n",
  yieldTimeMs: 2_000,
});
assert.equal(inputResult.running, false);
assert.match(inputResult.output, /input:hello/);

const fragmentedShellInput = await manager.start({
  connectionPrincipalId,
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "process.stdin.once('data', data => { console.log('fragment:' + JSON.stringify(data.toString())); process.exit(0); })"`,
  instructionInputMode: "shell",
  yieldTimeMs: 5,
});
assert.ok(fragmentedShellInput.sessionId);
const bufferedFragment = await manager.write({
  connectionPrincipalId,
  workspaceId: "workspace-a",
  sessionId: fragmentedShellInput.sessionId,
  chars: "c",
  preparedInput: {
    expectedRevision: 0,
    pendingInput: "c",
    charsToWrite: "",
    nextCwd: process.cwd(),
    instructionScopePaths: [],
  },
  yieldTimeMs: 1,
});
assert.equal(bufferedFragment.running, true);
assert.doesNotMatch(bufferedFragment.output, /fragment:/);
assert.equal(
  manager.instructionContext(connectionPrincipalId, "workspace-a", fragmentedShellInput.sessionId).pendingInput,
  "c",
);
const completedFragment = await manager.write({
  connectionPrincipalId,
  workspaceId: "workspace-a",
  sessionId: fragmentedShellInput.sessionId,
  chars: "d nested\n",
  preparedInput: {
    expectedRevision: 1,
    pendingInput: "",
    charsToWrite: "cd nested\n",
    nextCwd: `${process.cwd()}/nested`,
    instructionScopePaths: [`${process.cwd()}/nested`],
  },
  yieldTimeMs: 2_000,
});
assert.equal(completedFragment.running, false);
assert.match(completedFragment.output, /fragment:"cd nested\\n"/);

const defaultInteractive = await manager.start({
  connectionPrincipalId,
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "process.stdin.once('data', data => setTimeout(() => { console.log('default-input:' + data.toString().trim()); process.exit(0); }, 100))"`,
  yieldTimeMs: 5,
});
assert.equal(defaultInteractive.running, true);
assert.ok(defaultInteractive.sessionId);

const defaultInputResult = await manager.write({
  connectionPrincipalId,
  workspaceId: "workspace-a",
  sessionId: defaultInteractive.sessionId,
  chars: "hello\n",
  yieldTimeMs: 2_000,
});
assert.equal(defaultInputResult.running, false);
assert.match(defaultInputResult.output, /default-input:hello/);

const noisyInteractive = await manager.start({
  connectionPrincipalId,
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setInterval(() => console.log('tick'), 10); process.stdin.once('data', data => { console.log('input:' + data.toString().trim()); process.exit(0); })"`,
  yieldTimeMs: 100,
});
assert.equal(noisyInteractive.running, true);
assert.ok(noisyInteractive.sessionId);

await new Promise((resolve) => setTimeout(resolve, 50));
const noisyInputResult = await manager.write({
  connectionPrincipalId,
  workspaceId: "workspace-a",
  sessionId: noisyInteractive.sessionId,
  chars: "hello\n",
  yieldTimeMs: 2_000,
});
assert.equal(noisyInputResult.running, false);
assert.match(noisyInputResult.output, /input:hello/);

const interruptible = await manager.start({
  connectionPrincipalId,
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setInterval(() => console.log('tick'), 10)"`,
  yieldTimeMs: 100,
});
assert.equal(interruptible.running, true);
assert.ok(interruptible.sessionId);

await new Promise((resolve) => setTimeout(resolve, 50));
const interrupted = await manager.write({
  connectionPrincipalId,
  workspaceId: "workspace-a",
  sessionId: interruptible.sessionId,
  chars: "\u0003",
  yieldTimeMs: 2_000,
});
assert.equal(interrupted.running, false);
if (process.platform !== "win32") assert.equal(interrupted.signal, "SIGINT");

let buffered = await manager.start({
  connectionPrincipalId,
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log('x'.repeat(5000)); setTimeout(() => {}, 100)"`,
  yieldTimeMs: 50,
  maxOutputTokens: 100,
});
if (!buffered.outputTruncated && buffered.sessionId) {
  buffered = await manager.write({
    connectionPrincipalId,
    workspaceId: "workspace-a",
    sessionId: buffered.sessionId,
    yieldTimeMs: 2_000,
    maxOutputTokens: 100,
  });
}
assert.equal(buffered.outputTruncated, true);
assert.ok(buffered.originalTokenCount >= 1);
assert.ok(buffered.outputOmittedBytes >= 1);
if (buffered.sessionId) manager.terminate(connectionPrincipalId, "workspace-a", buffered.sessionId);

for (const expression of ["'🙂'.repeat(200)", "'中文'.repeat(200)"]) {
  const multibyteLimited = await manager.start({
    connectionPrincipalId,
    workspaceId: "workspace-a",
    cwd: process.cwd(),
    command: `${node} -e "process.stdout.write(${expression})"`,
    yieldTimeMs: 2_000,
    maxOutputTokens: 100,
  });
  assert.equal(multibyteLimited.outputTruncated, true);
  assert.ok(Buffer.byteLength(multibyteLimited.output, "utf8") <= 400);
  assert.equal(multibyteLimited.output.includes("�"), false);
}

try {
  if (process.platform === "win32") {
    const pty = await manager.start({
      connectionPrincipalId,
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: "echo pty-ok",
      tty: true,
      yieldTimeMs: 10_000,
    });
    assert.equal(pty.running, false);
    assert.match(pty.output, /pty-ok/);
  } else {
    const directPty = await manager.start({
      connectionPrincipalId,
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: {
        program: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...literalArgs],
      },
      tty: true,
      yieldTimeMs: 2_000,
    });
    assert.equal(directPty.running, false);
    assert.equal(directPty.exitCode, 0);
    assert.deepEqual(JSON.parse(directPty.output), literalArgs);

    const pty = await manager.start({
      connectionPrincipalId,
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: `${node} -e "setTimeout(() => console.log('columns:' + process.stdout.columns), 250)"`,
      tty: true,
      columns: 80,
      rows: 24,
      yieldTimeMs: 10,
    });
    assert.equal(pty.running, true);
    assert.ok(pty.sessionId);

    const resizedPty = await manager.write({
      connectionPrincipalId,
      workspaceId: "workspace-a",
      sessionId: pty.sessionId,
      columns: 120,
      rows: 30,
      yieldTimeMs: 2_000,
    });
    assert.equal(resizedPty.running, false);
    assert.match(resizedPty.output, /columns:120/);

    const interruptiblePty = await manager.start({
      connectionPrincipalId,
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: { program: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] },
      tty: true,
      yieldTimeMs: 10,
    });
    assert.ok(interruptiblePty.sessionId);
    const interruptedPty = await manager.write({
      connectionPrincipalId,
      workspaceId: "workspace-a",
      sessionId: interruptiblePty.sessionId,
      chars: "\u0003",
      yieldTimeMs: 2_000,
    });
    assert.equal(interruptedPty.running, false);
  }
} finally {
  await manager.shutdown();
}

const quotaManager = new ProcessSessionManager({
  maxSessions: 2,
  maxSessionsPerWorkspace: 1,
  maxRuntimeMs: 10_000,
});
try {
  const firstQuotaSession = await quotaManager.start({
    connectionPrincipalId,
    workspaceId: "quota-a",
    cwd: process.cwd(),
    command: `${node} -e "setInterval(() => {}, 1000)"`,
    yieldTimeMs: 5,
  });
  assert.ok(firstQuotaSession.sessionId);
  await assert.rejects(
    quotaManager.start({
      connectionPrincipalId,
      workspaceId: "quota-a",
      cwd: process.cwd(),
      command: `${node} -e "setInterval(() => {}, 1000)"`,
      yieldTimeMs: 5,
    }),
    /limit reached for this workspace/,
  );
  await assert.rejects(
    quotaManager.write({
      connectionPrincipalId: "client-b",
      workspaceId: "quota-a",
      sessionId: firstQuotaSession.sessionId,
      yieldTimeMs: 1,
    }),
    /no longer available/,
  );

  const secondQuotaSession = await quotaManager.start({
    connectionPrincipalId,
    workspaceId: "quota-b",
    cwd: process.cwd(),
    command: `${node} -e "setInterval(() => {}, 1000)"`,
    yieldTimeMs: 5,
  });
  assert.ok(secondQuotaSession.sessionId);
  await assert.rejects(
    quotaManager.start({
      connectionPrincipalId,
      workspaceId: "quota-c",
      cwd: process.cwd(),
      command: `${node} -e "setInterval(() => {}, 1000)"`,
      yieldTimeMs: 5,
    }),
    /Process session limit reached/,
  );
} finally {
  await quotaManager.shutdown();
}

const clientQuotaManager = new ProcessSessionManager({
  maxSessions: 3,
  maxSessionsPerClient: 1,
  maxSessionsPerWorkspace: 2,
  maxRuntimeMs: 10_000,
});
try {
  const clientASession = await clientQuotaManager.start({
    connectionPrincipalId: "client-a",
    workspaceId: "client-quota-a",
    cwd: process.cwd(),
    command: `${node} -e "setInterval(() => {}, 1000)"`,
    yieldTimeMs: 5,
  });
  assert.ok(clientASession.sessionId);
  await assert.rejects(
    clientQuotaManager.start({
      connectionPrincipalId: "client-a",
      workspaceId: "client-quota-b",
      cwd: process.cwd(),
      command: `${node} -e "setInterval(() => {}, 1000)"`,
      yieldTimeMs: 5,
    }),
    /limit reached for this OAuth client/,
  );
  const clientBSession = await clientQuotaManager.start({
    connectionPrincipalId: "client-b",
    workspaceId: "client-quota-a",
    cwd: process.cwd(),
    command: `${node} -e "setInterval(() => {}, 1000)"`,
    yieldTimeMs: 5,
  });
  assert.ok(clientBSession.sessionId);
  assert.deepEqual(clientQuotaManager.usageSnapshot("client-a"), {
    sessions: 2,
    running: 2,
    limit: 3,
    principal: { sessions: 1, running: 1, limit: 1 },
  });
} finally {
  await clientQuotaManager.shutdown();
}

const completedQuotaManager = new ProcessSessionManager({
  maxSessions: 1,
  completedSessionTtlMs: 5_000,
});
try {
  const awaitingPoll = await completedQuotaManager.start({
    connectionPrincipalId,
    workspaceId: "completed-quota",
    cwd: process.cwd(),
    command: `${node} -e "setTimeout(() => console.log('retained-result'), 50)"`,
    yieldTimeMs: 1,
  });
  assert.ok(awaitingPoll.sessionId);
  await waitForCondition(
    () => completedQuotaManager.usageSnapshot(connectionPrincipalId).running === 0,
  );
  await assert.rejects(
    completedQuotaManager.start({
      connectionPrincipalId,
      workspaceId: "completed-quota",
      cwd: process.cwd(),
      command: `${node} -e "console.log('must-not-start')"`,
      yieldTimeMs: 1_000,
    }),
    /Process session limit reached/,
  );
  const retainedResult = await completedQuotaManager.write({
    connectionPrincipalId,
    workspaceId: "completed-quota",
    sessionId: awaitingPoll.sessionId,
    yieldTimeMs: 1,
  });
  assert.equal(retainedResult.running, false);
  assert.match(retainedResult.output, /retained-result/);
  const afterConsumption = await completedQuotaManager.start({
    connectionPrincipalId,
    workspaceId: "completed-quota",
    cwd: process.cwd(),
    command: `${node} -e "console.log('after-consumption')"`,
    yieldTimeMs: 1_000,
  });
  assert.match(afterConsumption.output, /after-consumption/);
} finally {
  await completedQuotaManager.shutdown();
}

const timeoutManager = new ProcessSessionManager({
  maxRuntimeMs: 1_000,
  terminationGraceMs: 100,
});
try {
  await assert.rejects(
    timeoutManager.start({
      connectionPrincipalId,
      workspaceId: "timeout-over-global-limit",
      cwd: process.cwd(),
      command: "echo should-not-run",
      runtimeLimitMs: 1_001,
    }),
    /timeoutMs 1001 exceeds the global maximum 1000ms/,
  );
  const timedOut = await timeoutManager.start({
    connectionPrincipalId,
    workspaceId: "timeout",
    cwd: process.cwd(),
    command: `${node} -e "setInterval(() => {}, 1000)"`,
    runtimeLimitMs: 50,
    yieldTimeMs: 2_000,
  });
  assert.equal(timedOut.running, false);
  assert.equal(timedOut.timedOut, true);
  assert.match(timedOut.output, /runtime limit/);
} finally {
  await timeoutManager.shutdown();
}

const closeManager = new ProcessSessionManager({
  terminationGraceMs: 50,
  maxRuntimeMs: 10_000,
});
try {
  const stubborn = await closeManager.start({
    connectionPrincipalId,
    workspaceId: "closing",
    cwd: process.cwd(),
    command: `${node} -e "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"`,
    yieldTimeMs: 20,
  });
  assert.ok(stubborn.sessionId);
  assert.equal(await closeManager.terminateWorkspace(connectionPrincipalId, "closing"), 1);
  assert.equal(closeManager.hasActive(connectionPrincipalId, "closing"), false);
  await assert.rejects(
    closeManager.start({
      connectionPrincipalId,
      workspaceId: "closing",
      cwd: process.cwd(),
      command: "echo should-not-run",
    }),
    /Workspace is closing/,
  );
  closeManager.reopenWorkspace(connectionPrincipalId, "closing");
  const reopened = await closeManager.start({
    connectionPrincipalId,
    workspaceId: "closing",
    cwd: process.cwd(),
    command: "echo reopened",
    yieldTimeMs: 2_000,
  });
  assert.equal(reopened.exitCode, 0);
  assert.match(reopened.output, /reopened/);
  closeManager.blockWorkspace(connectionPrincipalId, "revoked-root");
  await assert.rejects(
    closeManager.start({
      connectionPrincipalId,
      workspaceId: "revoked-root",
      cwd: process.cwd(),
      command: "echo should-not-run",
    }),
    /Workspace is closing/,
  );
} finally {
  await closeManager.shutdown();
}

if (process.platform !== "win32") {
  const ptyTreeRoot = await mkdtemp(join(tmpdir(), "devspace-pty-tree-"));
  let timeoutPids: ProcessTreePids | undefined;
  let workspacePids: ProcessTreePids | undefined;
  let shutdownPids: ProcessTreePids | undefined;
  try {
    const ptyTimeoutManager = new ProcessSessionManager({
      maxRuntimeMs: 2_000,
      terminationGraceMs: 50,
    });
    try {
      const started = await startStubbornPtyTree(
        ptyTimeoutManager,
        "pty-timeout",
        join(ptyTreeRoot, "timeout-pids.json"),
        join(ptyTreeRoot, "timeout-ready"),
        1_000,
      );
      timeoutPids = started.pids;
      const timedOutTree = await ptyTimeoutManager.write({
        connectionPrincipalId,
        workspaceId: "pty-timeout",
        sessionId: started.sessionId,
        yieldTimeMs: 2_000,
      });
      assert.equal(timedOutTree.running, false);
      assert.equal(timedOutTree.timedOut, true);
      await assertProcessTreeExited(started.pids);
      timeoutPids = undefined;
    } finally {
      await ptyTimeoutManager.shutdown();
      forceKillLeftovers(timeoutPids);
    }

    const ptyWorkspaceManager = new ProcessSessionManager({
      maxRuntimeMs: 10_000,
      terminationGraceMs: 50,
    });
    try {
      const started = await startStubbornPtyTree(
        ptyWorkspaceManager,
        "pty-workspace",
        join(ptyTreeRoot, "workspace-pids.json"),
        join(ptyTreeRoot, "workspace-ready"),
      );
      workspacePids = started.pids;
      assert.equal(await ptyWorkspaceManager.terminateWorkspace(connectionPrincipalId, "pty-workspace"), 1);
      await assertProcessTreeExited(started.pids);
      workspacePids = undefined;
    } finally {
      await ptyWorkspaceManager.shutdown();
      forceKillLeftovers(workspacePids);
    }

    const ptyShutdownManager = new ProcessSessionManager({
      maxRuntimeMs: 10_000,
      terminationGraceMs: 50,
    });
    const started = await startStubbornPtyTree(
      ptyShutdownManager,
      "pty-shutdown",
      join(ptyTreeRoot, "shutdown-pids.json"),
      join(ptyTreeRoot, "shutdown-ready"),
    );
    shutdownPids = started.pids;
    await ptyShutdownManager.shutdown();
    await assertProcessTreeExited(started.pids);
    shutdownPids = undefined;
  } finally {
    forceKillLeftovers(timeoutPids);
    forceKillLeftovers(workspacePids);
    forceKillLeftovers(shutdownPids);
    await rm(ptyTreeRoot, { recursive: true, force: true });
  }
}

const durableRoot = await mkdtemp(join(tmpdir(), "devspace-process-session-output-"));
const durableStore = new ProcessOutputStore({
  stateDir: durableRoot,
  maxFileBytes: 120_000,
  maxStorageBytes: 500_000,
  completedTtlMs: 60_000,
});
const durableManager = new ProcessSessionManager({
  maxBufferBytes: 1_000,
  outputStore: durableStore,
});
let durableOutputId = "";
try {
  const empty = await durableManager.start({
    connectionPrincipalId,
    workspaceId: "durable",
    cwd: process.cwd(),
    command: `${node} -e "process.exit(0)"`,
    yieldTimeMs: 2_000,
  });
  assert.equal(empty.outputId, undefined);
  assert.equal(durableStore.usageSnapshot().outputs, 0);

  let active = await durableManager.start({
    connectionPrincipalId,
    workspaceId: "durable",
    cwd: process.cwd(),
    command: `${node} -e "process.stdout.write('seed'); setTimeout(() => process.stdout.write('late'), 250); setTimeout(() => process.exit(0), 1000)"`,
    yieldTimeMs: 100,
  });
  const outputIdDeadline = Date.now() + 2_000;
  while (active.running && !active.outputId && Date.now() < outputIdDeadline) {
    active = await durableManager.write({
      connectionPrincipalId,
      workspaceId: "durable",
      sessionId: active.sessionId!,
      yieldTimeMs: 50,
    });
  }
  assert.equal(active.running, true);
  assert.ok(active.outputId);
  await new Promise((resolveWait) => setTimeout(resolveWait, 350));
  durableManager.flushOutput(connectionPrincipalId, "durable", active.outputId);
  assert.equal(
    durableStore.read(connectionPrincipalId, "durable", active.outputId, { offset: 0, limit: 100 }).content,
    "seedlate",
  );
  durableManager.terminate(connectionPrincipalId, "durable", active.sessionId!);
  await durableManager.write({
    connectionPrincipalId,
    workspaceId: "durable",
    sessionId: active.sessionId!,
    yieldTimeMs: 2_000,
  });

  const durable = await durableManager.start({
    connectionPrincipalId,
    workspaceId: "durable",
    cwd: process.cwd(),
    command: `${node} -e "process.stdout.write('x'.repeat(100000))"`,
    maxOutputTokens: 100,
    yieldTimeMs: 2_000,
  });
  assert.equal(durable.outputTruncated, true);
  assert.equal(durable.totalOutputBytes, 100_000);
  assert.equal(durable.storedOutputBytes, 100_000);
  assert.equal(durable.droppedBytes, 0);
  assert.ok(durable.outputId);
  durableOutputId = durable.outputId;

  let offset = 0;
  let recovered = "";
  while (offset < durable.storedOutputBytes) {
    const page = durableStore.read(connectionPrincipalId, "durable", durable.outputId, {
      offset,
      limit: 7_777,
    });
    recovered += page.content;
    offset = page.nextOffset;
  }
  assert.equal(recovered, "x".repeat(100_000));
  assert.equal(durableStore.metadata(connectionPrincipalId, "durable", durable.outputId).status, "completed");

  const quotaLimited = await durableManager.start({
    connectionPrincipalId,
    workspaceId: "durable",
    cwd: process.cwd(),
    command: `${node} -e "process.stdout.write('y'.repeat(150000))"`,
    maxOutputTokens: 100,
    yieldTimeMs: 2_000,
  });
  assert.equal(quotaLimited.totalOutputBytes, 150_000);
  assert.equal(quotaLimited.storedOutputBytes, 120_000);
  assert.equal(quotaLimited.droppedBytes, 30_000);
} finally {
  await durableManager.shutdown();
  durableStore.close();
}

const reopenedDurableStore = new ProcessOutputStore({
  stateDir: durableRoot,
  maxFileBytes: 120_000,
  maxStorageBytes: 500_000,
  completedTtlMs: 60_000,
});
try {
  assert.equal(
    reopenedDurableStore.read(connectionPrincipalId, "durable", durableOutputId, { offset: 0, limit: 10 }).content,
    "xxxxxxxxxx",
  );
} finally {
  reopenedDurableStore.close();
  await rm(durableRoot, { recursive: true, force: true });
}

const storageFailureRoot = await mkdtemp(join(tmpdir(), "devspace-process-session-storage-failure-"));
const storageFailureStore = new ProcessOutputStore({
  stateDir: storageFailureRoot,
  maxFileBytes: 120_000,
  maxStorageBytes: 500_000,
  completedTtlMs: 60_000,
});
const rawStorageError = `SQLITE_CANTOPEN: cannot open ${join(storageFailureRoot, "process-output.sqlite")}`;
let reportedStorageError: unknown;
storageFailureStore.append = () => {
  throw new Error(rawStorageError);
};
const storageFailureManager = new ProcessSessionManager({
  outputStore: storageFailureStore,
  onOutputStorageError: (error) => {
    reportedStorageError = error;
  },
});
try {
  const snapshot = await storageFailureManager.start({
    connectionPrincipalId,
    workspaceId: "storage-failure",
    cwd: process.cwd(),
    command: `${node} -e "process.stdout.write('model-visible-stdout')"`,
    yieldTimeMs: 2_000,
  });
  assert.equal(snapshot.output.match(/model-visible-stdout/gu)?.length, 1);
  assert.equal(snapshot.outputStorageError, "unavailable");
  assert.equal(reportedStorageError instanceof Error ? reportedStorageError.message : "", rawStorageError);
  assert.equal(snapshot.output.includes(rawStorageError), false);
  assert.equal(snapshot.output.includes(storageFailureRoot), false);
  assert.doesNotMatch(snapshot.output, /Durable process output failed/u);
} finally {
  await storageFailureManager.shutdown();
  storageFailureStore.close();
  await rm(storageFailureRoot, { recursive: true, force: true });
}
