import assert from "node:assert/strict";
import {
  AdminRuntimeError,
  AdminRuntimeManager,
} from "./admin-runtime.js";

const calls: Array<{ executable: string; args: readonly string[]; timeoutMs: number }> = [];
let finishKickstart: (() => void) | undefined;
let currentPid = 42;
let currentGeneration = "generation-1";
const events: string[] = [];
const manager = new AdminRuntimeManager({
  env: { DEVSPACE_LAUNCHD_SERVICE_LABEL: "com.keepkeen.devspace" },
  platform: "darwin",
  uid: 501,
  runCommand: async (executable, args, timeoutMs) => {
    calls.push({ executable, args, timeoutMs });
    if (args[0] === "print") {
      return { stdout: `state = running\npid = ${currentPid}\n`, stderr: "" };
    }
    await new Promise<void>((resolve) => {
      finishKickstart = resolve;
    });
    currentPid = 43;
    currentGeneration = "generation-2";
    return { stdout: "", stderr: "" };
  },
  probeReady: async () => ({ ready: true, generation: currentGeneration }),
  wait: async () => undefined,
  onEvent: (event) => events.push(event),
});

assert.deepEqual(await manager.backendStatus(), {
  managed: true,
  state: "running",
  supervisor: "launchd",
  label: "com.keepkeen.devspace",
  actions: ["restart"],
});
assert.deepEqual(calls[0], {
  executable: "/bin/launchctl",
  args: ["print", "gui/501/com.keepkeen.devspace"],
  timeoutMs: 10_000,
});

const operation = await manager.restartBackend();
assert.equal(operation.target, "backend");
assert.equal(operation.action, "restart");
assert.equal(operation.state, "accepted");
assert.equal(events[0], "admin_runtime_operation_requested");
await assert.rejects(
  manager.restartBackend(),
  (error) => error instanceof AdminRuntimeError && error.code === "runtime_busy",
);
assert.deepEqual(calls.at(-1)?.args, ["kickstart", "-k", "gui/501/com.keepkeen.devspace"]);
finishKickstart?.();
await new Promise((resolve) => setImmediate(resolve));
assert.ok(events.includes("admin_runtime_operation_completed"));
const completedStatus = await manager.backendStatus();
assert.equal(completedStatus.operation?.state, "completed");
assert.deepEqual(completedStatus.operation?.verification, {
  previousPid: 42,
  currentPid: 43,
  previousGeneration: "generation-1",
  currentGeneration: "generation-2",
});

let releaseConcurrentPrint: (() => void) | undefined;
const concurrentManager = new AdminRuntimeManager({
  env: { DEVSPACE_LAUNCHD_SERVICE_LABEL: "com.keepkeen.concurrent" },
  platform: "darwin",
  uid: 501,
  runCommand: async (_executable, args) => {
    if (args[0] === "print") {
      await new Promise<void>((resolve) => {
        releaseConcurrentPrint = resolve;
      });
      return { stdout: "state = running\npid = 50\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  },
  probeReady: async () => ({ ready: true, generation: "concurrent-1" }),
  recoveryTimeoutMs: 1,
  wait: async () => undefined,
});
const firstConcurrentRestart = concurrentManager.restartBackend();
await Promise.resolve();
await assert.rejects(
  concurrentManager.restartBackend(),
  (error) => error instanceof AdminRuntimeError && error.code === "runtime_busy",
);
releaseConcurrentPrint?.();
await firstConcurrentRestart;
await new Promise((resolve) => setImmediate(resolve));

let invalidCalls = 0;
const invalid = new AdminRuntimeManager({
  env: { DEVSPACE_LAUNCHD_SERVICE_LABEL: "../../unsafe" },
  platform: "darwin",
  uid: 501,
  runCommand: async () => {
    invalidCalls += 1;
    return { stdout: "", stderr: "" };
  },
});
assert.deepEqual(await invalid.backendStatus(), {
  managed: false,
  state: "failed",
  actions: [],
  label: "../../unsafe",
  lastError: "DEVSPACE_LAUNCHD_SERVICE_LABEL is invalid.",
});
assert.equal(invalidCalls, 0);

const failedRestart = new AdminRuntimeManager({
  env: { DEVSPACE_LAUNCHD_SERVICE_LABEL: "com.waishnav.devspace" },
  platform: "darwin",
  uid: 501,
  runCommand: async (_executable, args) => {
    if (args[0] === "print") return { stdout: "state = running\npid = 60\n", stderr: "" };
    throw new Error("sensitive launchctl failure");
  },
  probeReady: async () => ({ ready: true, generation: "failed-1" }),
});
await failedRestart.restartBackend();
await new Promise((resolve) => setImmediate(resolve));
const failedStatus = await failedRestart.backendStatus();
assert.equal(failedStatus.label, "com.waishnav.devspace");
assert.equal(failedStatus.state, "running");
assert.equal(
  failedStatus.lastError,
  "launchd could not restart the enrolled backend service.",
);
assert.doesNotMatch(JSON.stringify(failedStatus), /sensitive/);

const unmanaged = new AdminRuntimeManager({
  env: {},
  platform: "darwin",
  uid: 501,
});
assert.deepEqual(await unmanaged.backendStatus(), {
  managed: false,
  state: "unmanaged",
  actions: [],
});
await assert.rejects(
  unmanaged.restartBackend(),
  (error) => error instanceof AdminRuntimeError && error.code === "runtime_unmanaged",
);

const missingGeneration = new AdminRuntimeManager({
  env: { DEVSPACE_LAUNCHD_SERVICE_LABEL: "com.keepkeen.no-generation" },
  platform: "darwin",
  uid: 501,
  runCommand: async () => ({ stdout: "state = running\npid = 70\n", stderr: "" }),
  probeReady: async () => ({ ready: true }),
});
await assert.rejects(
  missingGeneration.restartBackend(),
  (error) => error instanceof AdminRuntimeError && error.code === "runtime_generation_unavailable",
);

console.log("admin-runtime tests passed");
