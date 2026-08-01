import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keeping the deploy worker in scripts/ lets a currently running checkout load
// it without depending on whichever dist tree is about to be replaced.
const modulePath = "../scripts/lib/macos-launchd-deployment.mjs";
const {
  DeploymentBusyError,
  DeploymentFailure,
  createLaunchdDeploymentActions,
  fetchAuthenticatedReadiness,
  fetchAuthenticatedRestartPreflight,
  renderLaunchAgentPlist,
  rollbackDistPaths,
  runDeploymentPlan,
  runOneShotDeployment,
} = await import(modulePath);

const operationId = "12345678-1234-1234-1234-123456789abc";

function harness(failingStage?: string) {
  const calls: string[] = [];
  const logs: Array<{ stage: string; outcome: string }> = [];
  const action = (name: string) => async () => {
    calls.push(name);
    if (name === failingStage) throw new Error(`${name} failed`);
  };
  return {
    calls,
    logs,
    actions: {
      acquireLock: action("acquireLock"),
      preflight: action("preflight"),
      stopMainService: action("stopMainService"),
      swapDist: action("swapDist"),
      startMainService: action("startMainService"),
      verifyMainService: action("verifyMainService"),
      ensureMainServiceStopped: action("ensureMainServiceStopped"),
      rollbackDist: action("rollbackDist"),
      restoreMainService: action("restoreMainService"),
      cleanupBackup: action("cleanupBackup"),
      recordTerminal: async (result: { status: string }) => {
        calls.push(`recordTerminal:${result.status}`);
        if (failingStage === "recordTerminal") throw new Error("recordTerminal failed");
      },
      releaseLock: action("releaseLock"),
      unloadHelper: action("unloadHelper"),
    },
    log: async (event: { stage: string; outcome: string }) => {
      logs.push(event);
    },
  };
}

{
  const test = harness();
  assert.deepEqual(await runOneShotDeployment({ operationId, actions: test.actions, log: test.log }), {
    status: "succeeded",
  });
  assert.deepEqual(test.calls, [
    "acquireLock",
    "preflight",
    "stopMainService",
    "swapDist",
    "startMainService",
    "verifyMainService",
    "recordTerminal:succeeded",
    "cleanupBackup",
    "releaseLock",
    "unloadHelper",
  ]);
  assert.ok(test.logs.some((event) => event.stage === "verify-main-service" && event.outcome === "completed"));
}

{
  const test = harness("preflight");
  await assert.rejects(
    runOneShotDeployment({ operationId, actions: test.actions, log: test.log }),
    (error: unknown) => error instanceof DeploymentFailure &&
      (error as { stage?: string }).stage === "preflight",
  );
  assert.deepEqual(test.calls, [
    "acquireLock",
    "preflight",
    "recordTerminal:failed",
    "releaseLock",
    "unloadHelper",
  ], "preflight failure must not stop or start the main service");
}

{
  const test = harness("stopMainService");
  await assert.rejects(runOneShotDeployment({ operationId, actions: test.actions, log: test.log }));
  assert.equal(test.calls.includes("restoreMainService"), false, "an unconfirmed stop must not trigger restore");
  assert.equal(test.calls.at(-1), "unloadHelper");
}

{
  const test = harness("swapDist");
  await assert.rejects(runOneShotDeployment({ operationId, actions: test.actions, log: test.log }));
  assert.ok(test.calls.includes("rollbackDist"), "every attempted swap must trigger idempotent rollback");
  assert.ok(test.calls.includes("restoreMainService"), "a service stopped by this run must be restored");
  assert.equal(test.calls.at(-1), "unloadHelper");
}

{
  const test = harness("cleanupBackup");
  await assert.rejects(runOneShotDeployment({ operationId, actions: test.actions, log: test.log }));
  assert.equal(test.calls.includes("rollbackDist"), false, "verified deployment cleanup must not roll back live code");
  assert.equal(test.calls.includes("restoreMainService"), false, "verified service must remain running");
  assert.equal(test.calls.includes("unloadHelper"), false, "an incomplete cleanup must preserve the resumable helper");
}

for (const failingStage of ["startMainService", "verifyMainService"]) {
  const test = harness(failingStage);
  await assert.rejects(runOneShotDeployment({ operationId, actions: test.actions, log: test.log }));
  assert.deepEqual(
    test.calls.slice(test.calls.indexOf(failingStage) + 1, -3),
    ["ensureMainServiceStopped", "rollbackDist", "restoreMainService"],
    `${failingStage} must stop the replacement, roll back the swapped dist, and restore the original job`,
  );
  assert.equal(test.calls.at(-1), "unloadHelper");
}

{
  const test = harness("rollbackDist");
  test.actions.verifyMainService = async () => {
    test.calls.push("verifyMainService");
    throw new Error("verification failed");
  };
  await assert.rejects(
    runOneShotDeployment({ operationId, actions: test.actions, log: test.log }),
    (error: unknown) => error instanceof DeploymentFailure &&
      (error as { recoveryErrors?: unknown[] }).recoveryErrors?.length === 1,
  );
  assert.equal(
    test.calls.includes("restoreMainService"),
    false,
    "a failed rollback must not bootstrap a service against an unproven dist layout",
  );
  assert.equal(test.calls.includes("recordTerminal:failed"), false);
  assert.equal(test.calls.includes("unloadHelper"), false, "failed recovery must preserve the plan for resume");
}

{
  const test = harness();
  test.actions.acquireLock = async () => {
    test.calls.push("acquireLock");
    throw new DeploymentBusyError();
  };
  await assert.rejects(runOneShotDeployment({ operationId, actions: test.actions, log: test.log }));
  assert.deepEqual(test.calls, ["acquireLock"], "a competing runner must not finalize or unload the active helper");
}

{
  const originalFetch = globalThis.fetch;
  let suppliedToken: string | null = null;
  globalThis.fetch = async (_input, init) => {
    suppliedToken = new Headers(init?.headers).get("x-devspace-internal-token");
    return new Response(JSON.stringify({ ok: true, pid: 42, generation: "generation-2" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    assert.deepEqual(
      await fetchAuthenticatedReadiness("http://127.0.0.1:7677/internal/readiness", "secret-token"),
      { ready: true, pid: 42, generation: "generation-2" },
    );
    assert.equal(suppliedToken, "secret-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/internal/readiness") return new Response("", { status: 404 });
    if (url.pathname === "/internal/diagnostics") {
      return new Response(JSON.stringify({
        version: "2.0.1",
        generation: "legacy-generation",
        runtimeConfig: { widgets: "full" },
        usage: { processSessions: { running: 3 } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/readyz") {
      return new Response(JSON.stringify({
        ok: true,
        status: "ready",
        generation: "legacy-generation",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("", { status: 404 });
  };
  try {
    assert.deepEqual(
      await fetchAuthenticatedRestartPreflight(
        "http://127.0.0.1:7677/internal/readiness",
        "secret-token",
      ),
      {
        ready: true,
        generation: "legacy-generation",
        identity: "legacy_authenticated",
        runningProcesses: 3,
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const root = await mkdtemp(join(tmpdir(), "devspace-deployment-active-process-test-"));
  const stagedDistPath = join(root, "staged");
  const stateDirectory = join(root, ".build-stage", "deployments");
  const serviceLabel = "com.example.devspace.active";
  const helperLabel = "com.waishnav.devspace.deploy.12345678123412341234123456789abc";
  const plan = {
    schemaVersion: 1,
    operationId,
    uid: 501,
    projectRoot: root,
    stagedDistPath,
    serviceLabel,
    servicePlistPath: join(root, "service.plist"),
    controlReadinessUrl: "http://127.0.0.1:7677/internal/readiness",
    diagnosticsToken: "active-process-token",
    helperLabel,
    helperPlistPath: join(root, `${helperLabel}.plist`),
    planPath: join(stateDirectory, `${operationId}.json`),
    logPath: join(stateDirectory, `${operationId}.jsonl`),
    receiptPath: join(stateDirectory, `${operationId}.result.json`),
    lockPath: join(stateDirectory, "deployment.lock"),
    nodePath: process.execPath,
    scriptPath: join(root, "deploy.mjs"),
  };
  let stopCalls = 0;
  const runCommand = async (executable: string, args: string[]) => {
    if (executable === "/usr/bin/plutil" && args[0] === "-extract") {
      return { stdout: `${serviceLabel}\n`, stderr: "" };
    }
    if (executable === "/bin/launchctl" && args[0] === "print") {
      return { stdout: "state = running\npid = 42\n", stderr: "" };
    }
    if (executable === "/bin/launchctl" && args[0] === "bootout") stopCalls += 1;
    return { stdout: "", stderr: "" };
  };
  try {
    await mkdir(join(root, "dist"), { recursive: true });
    await mkdir(stagedDistPath, { recursive: true });
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(join(stagedDistPath, "cli.js"), "export {};\n");
    await writeFile(join(stagedDistPath, "server.js"), "export {};\n");
    await writeFile(plan.servicePlistPath, "service");
    const actions = createLaunchdDeploymentActions(plan, {
      runCommand,
      fetchReady: async () => ({
        ready: true,
        pid: 42,
        generation: "active-generation",
        runningProcesses: 1,
      }),
      wait: async () => undefined,
      quiesceTimeoutMs: 0,
      platform: "darwin",
      uid: 501,
    });
    await assert.rejects(
      actions.preflight(),
      /managed process session\(s\) are still running/u,
    );
    assert.equal(stopCalls, 0, "active processes must block deployment before service stop");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

{
  const root = await mkdtemp(join(tmpdir(), "devspace-deployment-test-"));
  const distPath = join(root, "dist");
  const stagedDistPath = join(root, "staged");
  const backupPath = join(root, "backup");
  try {
    await mkdir(distPath);
    await mkdir(stagedDistPath);
    await writeFile(join(distPath, "marker"), "old");
    await writeFile(join(stagedDistPath, "marker"), "new");
    await rollbackDistPaths({ distPath, stagedDistPath, backupPath });
    assert.equal(await readFile(join(distPath, "marker"), "utf8"), "old");

    await rm(distPath, { recursive: true });
    await mkdir(backupPath);
    await writeFile(join(backupPath, "marker"), "old-partial");
    await rollbackDistPaths({ distPath, stagedDistPath, backupPath });
    assert.equal(await readFile(join(distPath, "marker"), "utf8"), "old-partial");
    await rollbackDistPaths({ distPath, stagedDistPath, backupPath });

    await rm(distPath, { recursive: true });
    await rm(stagedDistPath, { recursive: true });
    await mkdir(distPath);
    await mkdir(backupPath);
    await writeFile(join(distPath, "marker"), "new-swapped");
    await writeFile(join(backupPath, "marker"), "old-swapped");
    await rollbackDistPaths({ distPath, stagedDistPath, backupPath });
    assert.equal(await readFile(join(distPath, "marker"), "utf8"), "old-swapped");
    assert.equal(await readFile(join(stagedDistPath, "marker"), "utf8"), "new-swapped");
    await rollbackDistPaths({ distPath, stagedDistPath, backupPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

{
  const root = await mkdtemp(join(tmpdir(), "devspace-deployment-resume-test-"));
  const operationId = "87654321-4321-4321-4321-cba987654321";
  const stateDirectory = join(root, ".build-stage", "deployments");
  const distPath = join(root, "dist");
  const stagedDistPath = join(root, "staged");
  const backupPath = join(root, ".build-stage", `dist-backup-${operationId}`);
  const planPath = join(stateDirectory, `${operationId}.json`);
  const logPath = join(stateDirectory, `${operationId}.jsonl`);
  const receiptPath = join(stateDirectory, `${operationId}.result.json`);
  const servicePlistPath = join(root, "service.plist");
  const serviceLabel = "com.example.devspace";
  const helperLabel = `com.waishnav.devspace.deploy.${operationId.replaceAll("-", "")}`;
  const helperPlistPath = join(root, `${helperLabel}.plist`);
  const plan = {
    schemaVersion: 1,
    operationId,
    uid: 501,
    projectRoot: root,
    stagedDistPath,
    serviceLabel,
    servicePlistPath,
    controlReadinessUrl: "http://127.0.0.1:7677/internal/readiness",
    diagnosticsToken: "resume-test-token",
    helperLabel,
    helperPlistPath,
    planPath,
    logPath,
    receiptPath,
    lockPath: join(stateDirectory, "deployment.lock"),
    nodePath: process.execPath,
    scriptPath: join(root, "deploy.mjs"),
  };
  let currentPid: number | undefined;
  let generation: string | undefined;
  let bootstrapCount = 0;
  const runCommand = async (executable: string, args: string[]) => {
    if (executable === "/usr/bin/plutil" && args[0] === "-extract") {
      return { stdout: `${serviceLabel}\n`, stderr: "" };
    }
    if (executable === "/bin/launchctl" && args[0] === "print") {
      if (!currentPid) throw new Error("not loaded");
      return { stdout: `state = running\npid = ${currentPid}\n`, stderr: "" };
    }
    if (executable === "/bin/launchctl" && args[0] === "bootout") {
      currentPid = undefined;
      generation = undefined;
      return { stdout: "", stderr: "" };
    }
    if (executable === "/bin/launchctl" && args[0] === "bootstrap") {
      bootstrapCount += 1;
      currentPid = bootstrapCount === 1 ? 42 : 43;
      generation = bootstrapCount === 1 ? "generation-old" : "generation-new";
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  const fetchReady = async () => ({
    ready: currentPid !== undefined,
    pid: currentPid,
    generation,
  });
  try {
    await mkdir(stateDirectory, { recursive: true });
    await mkdir(stagedDistPath);
    await mkdir(backupPath);
    await writeFile(join(stagedDistPath, "cli.js"), "export {};\n");
    await writeFile(join(stagedDistPath, "server.js"), "export {};\n");
    await writeFile(join(stagedDistPath, "marker"), "new");
    await writeFile(join(backupPath, "marker"), "old");
    await writeFile(planPath, `${JSON.stringify(plan)}\n`);
    await writeFile(helperPlistPath, "helper");
    await writeFile(servicePlistPath, "service");
    await writeFile(logPath, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      operationId,
      stage: "swap-dist",
      outcome: "started",
    })}\n`);

    const firstLockActions = createLaunchdDeploymentActions(plan, {
      runCommand,
      fetchReady,
      lockTimeoutMs: 0,
      platform: "darwin",
      uid: 501,
    });
    const competingLockActions = createLaunchdDeploymentActions(plan, {
      runCommand,
      fetchReady,
      lockTimeoutMs: 0,
      platform: "darwin",
      uid: 501,
    });
    await firstLockActions.acquireLock();
    await assert.rejects(
      competingLockActions.acquireLock(),
      DeploymentBusyError,
      "the OS-backed deployment lock must reject a competing runner",
    );
    await firstLockActions.releaseLock();
    await competingLockActions.acquireLock();
    await competingLockActions.releaseLock();

    assert.deepEqual(await runDeploymentPlan(planPath, {
      runCommand,
      fetchReady,
      wait: async () => undefined,
      platform: "darwin",
      uid: 501,
    }), { status: "succeeded" });
    assert.equal(bootstrapCount, 2, "resume must restore old service before attempting the deployment again");
    assert.equal(await readFile(join(distPath, "marker"), "utf8"), "new");
    assert.equal(JSON.parse(await readFile(receiptPath, "utf8")).status, "succeeded");
    await assert.rejects(access(planPath));
    await assert.rejects(access(backupPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

{
  const plist = renderLaunchAgentPlist({
    label: "com.waishnav.devspace.deploy.test",
    nodePath: "/usr/local/bin/node",
    scriptPath: "/tmp/a&b/deploy.mjs",
    planPath: "/tmp/deployment.json",
    logPath: "/tmp/deployment.log",
  });
  assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<string>\/tmp\/a&amp;b\/deploy\.mjs<\/string>/);
  assert.doesNotMatch(plist, /\/bin\/(?:ba|z)?sh/);
}

console.log("macOS launchd deployment tests passed");
