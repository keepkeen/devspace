import assert from "node:assert/strict";
import {
  ProcessSessionManager,
  type ProcessActivityEvent,
  type ProcessSnapshot,
  type ProcessTerminalEvent,
} from "./process-sessions.js";
import { processToolResponse } from "./server.js";
import type { WorkspaceRootLease } from "./workspace-root-locks.js";

const events: ProcessActivityEvent[] = [];
const terminalEvents: ProcessTerminalEvent[] = [];
const manager = new ProcessSessionManager({
  terminationGraceMs: 100,
  maxRuntimeMs: 10_000,
  onActivity: (event) => events.push(event),
  onTerminal: (event) => terminalEvents.push(event),
});

try {
  const failed = await manager.start({
    connectionPrincipalId: "principal-a",
    workspaceId: "workspace-exit-7",
    cwd: process.cwd(),
    command: {
      program: process.execPath,
      args: ["-e", "process.exit(7)"],
    },
    yieldTimeMs: 2_000,
  });
  assert.equal(failed.exitCode, 7);
  const exitEvent = terminalEvents.find((event) => event.workspaceId === "workspace-exit-7");
  assert.deepEqual(
    exitEvent && { ...exitEvent, durationMs: 0 },
    {
      connectionPrincipalId: "principal-a",
      workspaceId: "workspace-exit-7",
      commandMode: "program",
      outcome: "exited",
      exitCode: 7,
      timedOut: false,
      durationMs: 0,
      outputRetained: false,
      outputPartiallyLost: false,
      outputUnavailable: false,
    },
  );
  assert.ok((exitEvent?.durationMs ?? -1) >= 0);

  const timedOut = await manager.start({
    connectionPrincipalId: "principal-a",
    workspaceId: "workspace-timeout",
    cwd: process.cwd(),
    command: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`,
    runtimeLimitMs: 25,
    yieldTimeMs: 2_000,
  });
  assert.equal(timedOut.timedOut, true);
  const timeoutEvent = terminalEvents.find((event) => event.workspaceId === "workspace-timeout");
  assert.equal(timeoutEvent?.commandMode, "shell");
  assert.equal(timeoutEvent?.outcome, "timed_out");
  assert.equal(timeoutEvent?.timedOut, true);
  assert.ok((timeoutEvent?.durationMs ?? -1) >= 0);

  const spawnCanary = "devspace-spawn-canary-9d7a4f";
  const directSpawnFailure = await manager.start({
    connectionPrincipalId: "principal-a",
    workspaceId: "workspace-spawn-failure",
    cwd: process.cwd(),
    command: { program: spawnCanary, args: ["--secret-argument"] },
    yieldTimeMs: 2_000,
  });
  assert.deepEqual(directSpawnFailure.startFailure, {
    phase: "spawn",
    errorCode: "ENOENT",
    errorCategory: "process_spawn",
  });
  assertSpawnFailureToolResponse(directSpawnFailure);
  assert.doesNotMatch(directSpawnFailure.output, /9d7a4f|secret-argument/u);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const directSpawnTerminals = terminalEvents.filter(
    (event) => event.workspaceId === "workspace-spawn-failure",
  );
  assert.equal(directSpawnTerminals.length, 1);
  assert.equal(directSpawnTerminals[0]?.outcome, "spawn_failed");
  assert.equal(directSpawnTerminals[0]?.errorCode, "ENOENT");

  const gatedLeaseRelease = (() => undefined) as WorkspaceRootLease;
  gatedLeaseRelease.release = gatedLeaseRelease;
  gatedLeaseRelease.heartbeat = async () => undefined;
  gatedLeaseRelease.attachProcess = async () => undefined;
  const gatedSpawnFailure = await manager.start({
    connectionPrincipalId: "principal-a",
    workspaceId: "workspace-gated-spawn-failure",
    cwd: process.cwd(),
    command: { program: spawnCanary, args: ["--secret-argument"] },
    yieldTimeMs: 2_000,
    retainWorkspaceRootLease: () => gatedLeaseRelease,
  });
  assert.equal(gatedSpawnFailure.exitCode, 127);
  assert.deepEqual(gatedSpawnFailure.startFailure, {
    phase: "spawn",
    errorCode: "ENOENT",
    errorCategory: "process_spawn",
  });
  assertSpawnFailureToolResponse(gatedSpawnFailure);
  assert.doesNotMatch(gatedSpawnFailure.output, /9d7a4f|secret-argument/u);
  const gatedSpawnTerminal = terminalEvents.find(
    (event) => event.workspaceId === "workspace-gated-spawn-failure",
  );
  assert.equal(gatedSpawnTerminal?.errorCode, "ENOENT");
  assert.equal(gatedSpawnTerminal?.errorCategory, "process_spawn");
  assert.equal(gatedSpawnTerminal?.phase, "spawn");
  assert.equal(gatedSpawnTerminal?.outcome, "spawn_failed");

  if (process.platform !== "win32") {
    const ptyLeaseRelease = (() => undefined) as WorkspaceRootLease;
    ptyLeaseRelease.release = ptyLeaseRelease;
    ptyLeaseRelease.heartbeat = async () => undefined;
    ptyLeaseRelease.attachProcess = async () => undefined;
    const ptySpawnFailure = await manager.start({
      connectionPrincipalId: "principal-a",
      workspaceId: "workspace-pty-spawn-failure",
      cwd: process.cwd(),
      command: { program: spawnCanary, args: ["--secret-argument"] },
      tty: true,
      closeStdin: false,
      yieldTimeMs: 2_000,
      retainWorkspaceRootLease: () => ptyLeaseRelease,
    });
    assert.deepEqual(ptySpawnFailure.startFailure, {
      phase: "spawn",
      errorCode: "ENOENT",
      errorCategory: "process_spawn",
    });
    assertSpawnFailureToolResponse(ptySpawnFailure);
    assert.doesNotMatch(ptySpawnFailure.output, /9d7a4f|secret-argument|devspace-spawn-failed/u);
    const ptySpawnTerminals = terminalEvents.filter(
      (event) => event.workspaceId === "workspace-pty-spawn-failure",
    );
    assert.equal(ptySpawnTerminals.length, 1);
    assert.equal(ptySpawnTerminals[0]?.outcome, "spawn_failed");
    assert.equal(ptySpawnTerminals[0]?.errorCode, "ENOENT");
  }

  const started = await manager.start({
    connectionPrincipalId: "principal-a",
    workspaceId: "workspace-a",
    cwd: process.cwd(),
    command: {
      program: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    },
    yieldTimeMs: 0,
    activity: {
      threadId: "thread-a",
      profileId: "profile-a",
      executionId: "execution-a",
      operationId: "command-a",
      workingDirectory: ".",
      summary: "Running activity test command.",
    },
  });
  assert.equal(started.running, true);
  assert.equal(typeof started.sessionId, "number");
  assert.equal(events.some((event) => event.type === "command.started"), true);

  assert.deepEqual(
    manager.interruptWorkspace("principal-b", "workspace-a"),
    [],
    "a different principal must not interrupt the process",
  );
  assert.deepEqual(
    manager.interruptWorkspace("principal-a", "workspace-b"),
    [],
    "a different workspace must not interrupt the process",
  );
  assert.deepEqual(
    manager.interruptWorkspace("principal-a", "workspace-a"),
    [started.sessionId],
  );

  let snapshot = started;
  for (let attempt = 0; attempt < 100 && snapshot.running; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    snapshot = await manager.write({
      connectionPrincipalId: "principal-a",
      workspaceId: "workspace-a",
      sessionId: started.sessionId!,
      chars: "",
      yieldTimeMs: 10,
    });
  }
  assert.equal(snapshot.running, false);
  assert.equal(
    events.some((event) =>
      event.type === "command.interrupted" &&
      event.threadId === "thread-a" &&
      event.operationId === "command-a"
    ),
    true,
  );
  const interruptTerminals = terminalEvents.filter(
    (event) => event.workspaceId === "workspace-a",
  );
  assert.equal(interruptTerminals.length, 1, "async completion emits one terminal event");
  assert.equal(interruptTerminals[0]?.outcome, "interrupted");
  assert.equal(interruptTerminals[0]?.timedOut, false);
  assert.deepEqual(interruptTerminals[0]?.activity, {
    threadId: "thread-a",
    profileId: "profile-a",
    executionId: "execution-a",
    operationId: "command-a",
    workingDirectory: ".",
    summary: "Running activity test command.",
  });
  assert.equal(interruptTerminals[0]?.outputRetained, false);
  assert.equal(interruptTerminals[0]?.outputPartiallyLost, false);
  assert.equal(interruptTerminals[0]?.outputUnavailable, false);
  if (process.platform !== "win32") assert.equal(interruptTerminals[0]?.signal, "SIGINT");
} finally {
  await manager.shutdown();
}

function assertSpawnFailureToolResponse(snapshot: ProcessSnapshot): void {
  const response = processToolResponse("exec_command", snapshot, { inputRevision: 0 });
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.commandExecuted, false);
  assert.equal(response.structuredContent.error?.phase, "not_started");
  assert.equal(response.structuredContent.error?.effectsKnown, true);
}

const shutdownTerminals: ProcessTerminalEvent[] = [];
const shutdownManager = new ProcessSessionManager({
  terminationGraceMs: 100,
  maxRuntimeMs: 10_000,
  onTerminal: (event) => shutdownTerminals.push(event),
});
const shutdownProcess = await shutdownManager.start({
  connectionPrincipalId: "principal-shutdown",
  workspaceId: "workspace-shutdown",
  cwd: process.cwd(),
  command: {
    program: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
  },
  yieldTimeMs: 0,
});
assert.equal(shutdownProcess.running, true);
await shutdownManager.shutdown();
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(shutdownTerminals.length, 1, "shutdown emits exactly one terminal event");

console.log("process activity event tests passed");
