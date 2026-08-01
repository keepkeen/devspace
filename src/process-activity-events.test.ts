import assert from "node:assert/strict";
import {
  ProcessSessionManager,
  type ProcessActivityEvent,
} from "./process-sessions.js";

const events: ProcessActivityEvent[] = [];
const manager = new ProcessSessionManager({
  terminationGraceMs: 100,
  maxRuntimeMs: 10_000,
  onActivity: (event) => events.push(event),
});

try {
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
      operationId: "command-a",
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
} finally {
  await manager.shutdown();
}

console.log("process activity event tests passed");
