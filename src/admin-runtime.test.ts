import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  AdminRuntimeError,
  AdminRuntimeManager,
  probeBackendRestartPreflight,
} from "./admin-runtime.js";
import { internalDiagnosticsToken } from "./internal-auth.js";

const calls: Array<{ executable: string; args: readonly string[]; timeoutMs: number }> = [];
let finishSignal: (() => void) | undefined;
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
    if (args[0] === "kill") {
      await new Promise<void>((resolve) => {
        finishSignal = resolve;
      });
      currentPid = 43;
      currentGeneration = "generation-2";
    }
    return { stdout: "", stderr: "" };
  },
  probeReady: async () => ({ ready: true, generation: currentGeneration, pid: currentPid }),
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
assert.deepEqual(calls.at(-1)?.args, ["kill", "SIGTERM", "gui/501/com.keepkeen.devspace"]);
finishSignal?.();
await new Promise((resolve) => setImmediate(resolve));
assert.ok(events.includes("admin_runtime_operation_completed"));
const completedStatus = await manager.backendStatus();
assert.equal(completedStatus.operation?.state, "completed");
assert.deepEqual(completedStatus.operation?.verification, {
  previousPid: 42,
  currentPid: 43,
  previousGeneration: "generation-1",
  currentGeneration: "generation-2",
  preflightIdentity: "pid_correlated",
  restartSignal: "SIGTERM",
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
  probeReady: async () => ({ ready: true, generation: "concurrent-1", pid: 50 }),
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
  probeReady: async () => ({ ready: true, generation: "failed-1", pid: 60 }),
});
await failedRestart.restartBackend();
await new Promise((resolve) => setImmediate(resolve));
const failedStatus = await failedRestart.backendStatus();
assert.equal(failedStatus.label, "com.waishnav.devspace");
assert.equal(failedStatus.state, "running");
assert.equal(
  failedStatus.lastError,
  "launchd could not send SIGTERM to the enrolled backend service.",
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
  probeReady: async () => ({ ready: true, pid: 70 }),
});
await assert.rejects(
  missingGeneration.restartBackend(),
  (error) => error instanceof AdminRuntimeError && error.code === "runtime_generation_unavailable",
);

let mismatchedPidSignals = 0;
const mismatchedPid = new AdminRuntimeManager({
  env: { DEVSPACE_LAUNCHD_SERVICE_LABEL: "com.keepkeen.pid-mismatch" },
  platform: "darwin",
  uid: 501,
  runCommand: async (_executable, args) => {
    if (args[0] === "kill") mismatchedPidSignals += 1;
    return { stdout: "state = running\npid = 80\n", stderr: "" };
  },
  probeReady: async () => ({ ready: true, generation: "mismatch-1", pid: 81 }),
});
await assert.rejects(
  mismatchedPid.restartBackend(),
  (error) => error instanceof AdminRuntimeError && error.code === "runtime_pid_mismatch",
);
assert.equal(mismatchedPidSignals, 0, "PID correlation must fail before launchctl sends SIGTERM");

let activeProcessSignals = 0;
const activeProcesses = new AdminRuntimeManager({
  env: { DEVSPACE_LAUNCHD_SERVICE_LABEL: "com.keepkeen.active-process" },
  platform: "darwin",
  uid: 501,
  runCommand: async (_executable, args) => {
    if (args[0] === "kill") activeProcessSignals += 1;
    return { stdout: "state = running\npid = 85\n", stderr: "" };
  },
  probeReady: async () => ({
    ready: true,
    generation: "active-process-generation",
    pid: 85,
    identity: "pid_correlated",
    runningProcesses: 2,
  }),
});
await assert.rejects(
  activeProcesses.restartBackend(),
  (error) => error instanceof AdminRuntimeError && error.code === "runtime_active_processes",
);
assert.equal(activeProcessSignals, 0, "active processes must block restart before SIGTERM");

let legacyPid = 90;
let legacyGeneration = "legacy-generation-1";
let legacyRestarted = false;
const legacyEvents: string[] = [];
const legacyManager = new AdminRuntimeManager({
  env: { DEVSPACE_LAUNCHD_SERVICE_LABEL: "com.keepkeen.legacy-upgrade" },
  platform: "darwin",
  uid: 501,
  runCommand: async (_executable, args) => {
    if (args[0] === "print") {
      return { stdout: `state = running\npid = ${legacyPid}\n`, stderr: "" };
    }
    legacyPid = 91;
    legacyGeneration = "strict-generation-2";
    legacyRestarted = true;
    return { stdout: "", stderr: "" };
  },
  probeReady: async () => legacyRestarted
    ? {
        ready: true,
        generation: legacyGeneration,
        pid: legacyPid,
        identity: "pid_correlated",
      }
    : {
        ready: true,
        generation: legacyGeneration,
        identity: "legacy_authenticated",
      },
  wait: async () => undefined,
  onEvent: (event) => legacyEvents.push(event),
});
await legacyManager.restartBackend();
await new Promise((resolve) => setImmediate(resolve));
assert.ok(legacyEvents.includes("admin_runtime_operation_completed"));
assert.deepEqual((await legacyManager.backendStatus()).operation?.verification, {
  previousPid: 90,
  currentPid: 91,
  previousGeneration: "legacy-generation-1",
  currentGeneration: "strict-generation-2",
  preflightIdentity: "legacy_authenticated",
  restartSignal: "SIGTERM",
});

let unmarkedLegacySignals = 0;
const unmarkedLegacy = new AdminRuntimeManager({
  env: { DEVSPACE_LAUNCHD_SERVICE_LABEL: "com.keepkeen.unmarked-legacy" },
  platform: "darwin",
  uid: 501,
  runCommand: async (_executable, args) => {
    if (args[0] === "kill") unmarkedLegacySignals += 1;
    return { stdout: "state = running\npid = 92\n", stderr: "" };
  },
  probeReady: async () => ({ ready: true, generation: "legacy-unmarked" }),
});
await assert.rejects(
  unmarkedLegacy.restartBackend(),
  (error) => error instanceof AdminRuntimeError && error.code === "runtime_pid_mismatch",
);
assert.equal(unmarkedLegacySignals, 0);

const diagnosticsKey = "legacy-probe-owner-key";
let legacyReadyGeneration = "legacy-http-generation";
let diagnosticsGeneration = legacyReadyGeneration;
let strictEndpoint = false;
const probeServer = createServer((request, response) => {
  if (request.url === "/internal/readiness") {
    if (!strictEndpoint) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      ok: true,
      pid: 101,
      generation: "strict-http-generation",
    }));
    return;
  }
  if (request.url === "/internal/diagnostics") {
    if (request.headers["x-devspace-internal-token"] !== internalDiagnosticsToken(diagnosticsKey)) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      version: "2.0.1",
      generation: diagnosticsGeneration,
      runtimeConfig: { widgets: "full" },
      usage: { processSessions: { running: 0 } },
    }));
    return;
  }
  if (request.url === "/readyz") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      ok: true,
      status: "ready",
      generation: legacyReadyGeneration,
    }));
    return;
  }
  response.statusCode = 404;
  response.end();
});
await new Promise<void>((resolveListen, rejectListen) => {
  probeServer.once("error", rejectListen);
  probeServer.listen(0, "127.0.0.1", () => {
    probeServer.off("error", rejectListen);
    resolveListen();
  });
});
try {
  const address = probeServer.address();
  assert.ok(address && typeof address !== "string");
  assert.deepEqual(
    await probeBackendRestartPreflight("127.0.0.1", address.port, diagnosticsKey),
    {
      ready: true,
      generation: "legacy-http-generation",
      identity: "legacy_authenticated",
      runningProcesses: 0,
    },
  );
  diagnosticsGeneration = "different-generation";
  assert.deepEqual(
    await probeBackendRestartPreflight("127.0.0.1", address.port, diagnosticsKey),
    { ready: false },
  );
  diagnosticsGeneration = legacyReadyGeneration;
  strictEndpoint = true;
  diagnosticsGeneration = "strict-http-generation";
  assert.deepEqual(
    await probeBackendRestartPreflight("127.0.0.1", address.port, diagnosticsKey),
    {
      ready: true,
      generation: "strict-http-generation",
      pid: 101,
      identity: "pid_correlated",
      runningProcesses: 0,
    },
  );
} finally {
  await new Promise<void>((resolveClose, rejectClose) => {
    probeServer.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

console.log("admin-runtime tests passed");
