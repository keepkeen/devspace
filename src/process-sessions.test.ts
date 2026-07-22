import assert from "node:assert/strict";
import { HeadTailBuffer, ProcessSessionManager } from "./process-sessions.js";

const smallBuffer = new HeadTailBuffer(100);
smallBuffer.append("hello\n");
assert.deepEqual(smallBuffer.drain(100), { output: "hello\n", truncated: false, omittedCharacters: 0 });
assert.deepEqual(smallBuffer.drain(100), { output: "", truncated: false, omittedCharacters: 0 });

const headTail = new HeadTailBuffer(10);
headTail.append("start-middle-end");
const headTailResult = headTail.drain(1_000);
assert.equal(headTailResult.truncated, true);
assert.match(headTailResult.output, /^start/);
assert.match(headTailResult.output, /e-end$/);
assert.match(headTailResult.output, /characters omitted/);

const responseLimited = new HeadTailBuffer(100);
responseLimited.append("abcdef".repeat(20));
const responseLimitedResult = responseLimited.drain(40);
assert.equal(responseLimitedResult.truncated, true);
assert.match(responseLimitedResult.output, /^abc/);
assert.match(responseLimitedResult.output, /def$/);

const unicodeBuffer = new HeadTailBuffer(4);
unicodeBuffer.append("a🙂b🙂c");
const unicodeResult = unicodeBuffer.drain(1_000);
assert.equal(unicodeResult.truncated, true);
assert.match(unicodeResult.output, /^a🙂/);
assert.match(unicodeResult.output, /🙂c$/);

const manager = new ProcessSessionManager({
  maxBufferCharacters: 1_024,
  completedSessionTtlMs: 1_000,
});
const ownerClientId = "client-a";

const node = process.platform === "win32"
  ? `"${process.execPath}"`
  : JSON.stringify(process.execPath);

const foreground = await manager.start({
  ownerClientId,
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log('foreground')"`,
  yieldTimeMs: 2_000,
});
assert.equal(foreground.running, false);
assert.equal(foreground.exitCode, 0);
assert.match(foreground.output, /foreground/);
assert.equal(foreground.sessionId, undefined);

const previousCdPath = process.env.CDPATH;
process.env.CDPATH = "/tmp/should-not-leak";
const environment = await manager.start({
  ownerClientId,
  workspaceId: "workspace-a",
  workspaceRoot: "/tmp/devspace-workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log([process.env.NO_COLOR, process.env.TERM, process.env.PAGER, process.env.GIT_PAGER, process.env.GH_PAGER, process.env.CODEX_CI, process.env.DEVSPACE_WORKSPACE_ID, process.env.DEVSPACE_WORKSPACE_ROOT, process.env.CDPATH ?? 'unset'].join(','))"`,
  yieldTimeMs: 2_000,
});
if (previousCdPath === undefined) delete process.env.CDPATH;
else process.env.CDPATH = previousCdPath;
assert.equal(environment.running, false);
assert.match(environment.output, /1,dumb,cat,cat,cat,1,workspace-a,\/tmp\/devspace-workspace-a,unset/);

const background = await manager.start({
  ownerClientId,
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setTimeout(() => console.log('finished'), 100)"`,
  yieldTimeMs: 5,
});
assert.equal(background.running, true);
assert.ok(background.sessionId);
assert.equal(typeof background.sessionId, "number");

await assert.rejects(
  manager.write({
    ownerClientId,
    workspaceId: "workspace-b",
    sessionId: background.sessionId,
    yieldTimeMs: 1,
  }),
  /Unknown process session/,
);

const completed = await manager.write({
  ownerClientId,
  workspaceId: "workspace-a",
  sessionId: background.sessionId,
  yieldTimeMs: 2_000,
});
assert.equal(completed.running, false);
assert.equal(completed.exitCode, 0);
assert.match(completed.output, /finished/);

const interactive = await manager.start({
  ownerClientId,
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "process.stdin.once('data', data => { console.log('input:' + data.toString().trim()); process.exit(0); })"`,
  yieldTimeMs: 5,
});
assert.equal(interactive.running, true);
assert.ok(interactive.sessionId);
assert.equal(typeof interactive.sessionId, "number");

const inputResult = await manager.write({
  ownerClientId,
  workspaceId: "workspace-a",
  sessionId: interactive.sessionId,
  chars: "hello\n",
  yieldTimeMs: 2_000,
});
assert.equal(inputResult.running, false);
assert.match(inputResult.output, /input:hello/);

const defaultInteractive = await manager.start({
  ownerClientId,
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "process.stdin.once('data', data => setTimeout(() => { console.log('default-input:' + data.toString().trim()); process.exit(0); }, 100))"`,
  yieldTimeMs: 5,
});
assert.equal(defaultInteractive.running, true);
assert.ok(defaultInteractive.sessionId);

const defaultInputResult = await manager.write({
  ownerClientId,
  workspaceId: "workspace-a",
  sessionId: defaultInteractive.sessionId,
  chars: "hello\n",
});
assert.equal(defaultInputResult.running, false);
assert.match(defaultInputResult.output, /default-input:hello/);

const noisyInteractive = await manager.start({
  ownerClientId,
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setInterval(() => console.log('tick'), 10); process.stdin.once('data', data => { console.log('input:' + data.toString().trim()); process.exit(0); })"`,
  yieldTimeMs: 100,
});
assert.equal(noisyInteractive.running, true);
assert.ok(noisyInteractive.sessionId);

await new Promise((resolve) => setTimeout(resolve, 50));
const noisyInputResult = await manager.write({
  ownerClientId,
  workspaceId: "workspace-a",
  sessionId: noisyInteractive.sessionId,
  chars: "hello\n",
  yieldTimeMs: 2_000,
});
assert.equal(noisyInputResult.running, false);
assert.match(noisyInputResult.output, /input:hello/);

const interruptible = await manager.start({
  ownerClientId,
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setInterval(() => console.log('tick'), 10)"`,
  yieldTimeMs: 100,
});
assert.equal(interruptible.running, true);
assert.ok(interruptible.sessionId);

await new Promise((resolve) => setTimeout(resolve, 50));
const interrupted = await manager.write({
  ownerClientId,
  workspaceId: "workspace-a",
  sessionId: interruptible.sessionId,
  chars: "\u0003",
  yieldTimeMs: 2_000,
});
assert.equal(interrupted.running, false);
if (process.platform !== "win32") assert.equal(interrupted.signal, "SIGINT");

let buffered = await manager.start({
  ownerClientId,
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log('x'.repeat(5000)); setTimeout(() => {}, 100)"`,
  yieldTimeMs: 50,
  maxOutputTokens: 100,
});
if (!buffered.outputTruncated && buffered.sessionId) {
  buffered = await manager.write({
    ownerClientId,
    workspaceId: "workspace-a",
    sessionId: buffered.sessionId,
    yieldTimeMs: 2_000,
    maxOutputTokens: 100,
  });
}
assert.equal(buffered.outputTruncated, true);
assert.ok(buffered.originalTokenCount >= 1);
assert.ok(buffered.outputOmittedBytes >= 1);
if (buffered.sessionId) manager.terminate(ownerClientId, "workspace-a", buffered.sessionId);

try {
  if (process.platform === "win32") {
    const pty = await manager.start({
      ownerClientId,
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: "echo pty-ok",
      tty: true,
      yieldTimeMs: 10_000,
    });
    assert.equal(pty.running, false);
    assert.match(pty.output, /pty-ok/);
  } else {
    const pty = await manager.start({
      ownerClientId,
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
      ownerClientId,
      workspaceId: "workspace-a",
      sessionId: pty.sessionId,
      columns: 120,
      rows: 30,
      yieldTimeMs: 2_000,
    });
    assert.equal(resizedPty.running, false);
    assert.match(resizedPty.output, /columns:120/);
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
    ownerClientId,
    workspaceId: "quota-a",
    cwd: process.cwd(),
    command: `${node} -e "setInterval(() => {}, 1000)"`,
    yieldTimeMs: 5,
  });
  assert.ok(firstQuotaSession.sessionId);
  await assert.rejects(
    quotaManager.start({
      ownerClientId,
      workspaceId: "quota-a",
      cwd: process.cwd(),
      command: `${node} -e "setInterval(() => {}, 1000)"`,
      yieldTimeMs: 5,
    }),
    /limit reached for this workspace/,
  );
  await assert.rejects(
    quotaManager.write({
      ownerClientId: "client-b",
      workspaceId: "quota-a",
      sessionId: firstQuotaSession.sessionId,
      yieldTimeMs: 1,
    }),
    /Unknown process session/,
  );

  const secondQuotaSession = await quotaManager.start({
    ownerClientId,
    workspaceId: "quota-b",
    cwd: process.cwd(),
    command: `${node} -e "setInterval(() => {}, 1000)"`,
    yieldTimeMs: 5,
  });
  assert.ok(secondQuotaSession.sessionId);
  await assert.rejects(
    quotaManager.start({
      ownerClientId,
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
    ownerClientId: "client-a",
    workspaceId: "client-quota-a",
    cwd: process.cwd(),
    command: `${node} -e "setInterval(() => {}, 1000)"`,
    yieldTimeMs: 5,
  });
  assert.ok(clientASession.sessionId);
  await assert.rejects(
    clientQuotaManager.start({
      ownerClientId: "client-a",
      workspaceId: "client-quota-b",
      cwd: process.cwd(),
      command: `${node} -e "setInterval(() => {}, 1000)"`,
      yieldTimeMs: 5,
    }),
    /limit reached for this OAuth client/,
  );
  const clientBSession = await clientQuotaManager.start({
    ownerClientId: "client-b",
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
    owner: { sessions: 1, running: 1, limit: 1 },
  });
} finally {
  await clientQuotaManager.shutdown();
}

const timeoutManager = new ProcessSessionManager({
  maxRuntimeMs: 1_000,
  terminationGraceMs: 100,
});
try {
  const timedOut = await timeoutManager.start({
    ownerClientId,
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
    ownerClientId,
    workspaceId: "closing",
    cwd: process.cwd(),
    command: `${node} -e "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"`,
    yieldTimeMs: 20,
  });
  assert.ok(stubborn.sessionId);
  assert.equal(await closeManager.terminateWorkspace(ownerClientId, "closing"), 1);
  assert.equal(closeManager.hasActive(ownerClientId, "closing"), false);
  await assert.rejects(
    closeManager.start({
      ownerClientId,
      workspaceId: "closing",
      cwd: process.cwd(),
      command: "echo should-not-run",
    }),
    /Workspace is closing/,
  );
  closeManager.reopenWorkspace(ownerClientId, "closing");
  const reopened = await closeManager.start({
    ownerClientId,
    workspaceId: "closing",
    cwd: process.cwd(),
    command: "echo reopened",
    yieldTimeMs: 2_000,
  });
  assert.equal(reopened.exitCode, 0);
  assert.match(reopened.output, /reopened/);
} finally {
  await closeManager.shutdown();
}
