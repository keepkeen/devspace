import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";

const LAUNCHCTL_PATH = "/bin/launchctl";
const PLUTIL_PATH = "/usr/bin/plutil";
const COMMAND_TIMEOUT_MS = 15_000;
const VERIFY_TIMEOUT_MS = 30_000;
const PROCESS_QUIESCE_TIMEOUT_MS = 30_000;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

export class DeploymentFailure extends Error {
  constructor(stage, cause, recoveryErrors = []) {
    super(`macOS deployment failed during ${stage}: ${safeErrorMessage(cause)}`);
    this.name = "DeploymentFailure";
    this.stage = stage;
    this.cause = cause;
    this.recoveryErrors = recoveryErrors;
  }
}

export class DeploymentBusyError extends Error {
  constructor(message = "Another macOS deployment is already in progress.") {
    super(message);
    this.name = "DeploymentBusyError";
  }
}

/**
 * Runs the one-shot deployment state machine. Actions are injected so every
 * transition and failure boundary can be tested without touching launchd.
 */
export async function runOneShotDeployment({ operationId, actions, log = () => undefined }) {
  assertOperationId(operationId);
  let currentStage = "acquire-lock";
  let lockAcquired = false;
  let mainServiceStopped = false;
  let swapAttempted = false;
  let deploymentVerified = false;
  let primaryFailure;
  const recoveryErrors = [];

  const runStage = async (stage, action) => {
    currentStage = stage;
    await logStage(log, operationId, stage, "started");
    try {
      const result = await action();
      await logStage(log, operationId, stage, "completed");
      return result;
    } catch (error) {
      await logStage(log, operationId, stage, "failed", error);
      throw error;
    }
  };

  try {
    await runStage("acquire-lock", actions.acquireLock);
    lockAcquired = true;
    await runStage("preflight", actions.preflight);
    await runStage("stop-main-service", actions.stopMainService);
    mainServiceStopped = true;
    swapAttempted = true;
    await runStage("swap-dist", actions.swapDist);
    await runStage("start-main-service", actions.startMainService);
    await runStage("verify-main-service", actions.verifyMainService);
    deploymentVerified = true;
  } catch (error) {
    primaryFailure = new DeploymentFailure(currentStage, error);
    let distReadyForRestore = !swapAttempted;

    if (swapAttempted && !deploymentVerified) {
      try {
        await runStage("stop-main-service-for-rollback", actions.ensureMainServiceStopped);
      } catch (recoveryError) {
        recoveryErrors.push({ stage: currentStage, error: recoveryError });
      }
      try {
        await runStage("rollback-dist", actions.rollbackDist);
        distReadyForRestore = true;
      } catch (recoveryError) {
        recoveryErrors.push({ stage: currentStage, error: recoveryError });
      }
    }

    // This flag is set only after this operation's stop command succeeded.
    // A preflight or stop failure must never start an otherwise untouched job.
    if (mainServiceStopped && !deploymentVerified && distReadyForRestore) {
      try {
        await runStage("restore-main-service", actions.restoreMainService);
      } catch (recoveryError) {
        recoveryErrors.push({ stage: currentStage, error: recoveryError });
      }
    }
  }

  const intendedResult = primaryFailure
    ? {
        status: "failed",
        failedStage: primaryFailure.stage,
        recoveryErrors: recoveryErrors.map(({ stage, error }) => ({
          stage,
          message: safeErrorMessage(error),
        })),
      }
    : { status: "succeeded" };

  let terminalRecorded = false;
  if (lockAcquired && recoveryErrors.length === 0) {
    try {
      await runStage("record-terminal", () => actions.recordTerminal(intendedResult));
      terminalRecorded = true;
    } catch (error) {
      recoveryErrors.push({ stage: currentStage, error });
    }
  }

  // Keep the old dist until the success receipt is durable. If the helper is
  // killed before that point, the same plan can always reconcile back to it.
  if (!primaryFailure && terminalRecorded) {
    try {
      await runStage("cleanup-backup", actions.cleanupBackup);
    } catch (error) {
      recoveryErrors.push({ stage: currentStage, error });
    }
  }

  if (lockAcquired) {
    try {
      await runStage("release-lock", actions.releaseLock);
    } catch (error) {
      recoveryErrors.push({ stage: currentStage, error });
    }
  }

  // Preserve the plan/plist whenever recovery or finalization is incomplete;
  // a later install or login can resume this exact operation.
  if (terminalRecorded && recoveryErrors.length === 0) {
    try {
      await runStage("unload-helper", actions.unloadHelper);
    } catch (error) {
      recoveryErrors.push({ stage: currentStage, error });
    }
  }

  if (primaryFailure) {
    primaryFailure.recoveryErrors = recoveryErrors;
    throw primaryFailure;
  }
  if (recoveryErrors.length > 0) {
    const [{ stage, error }] = recoveryErrors;
    throw new DeploymentFailure(stage, error, recoveryErrors.slice(1));
  }
  return intendedResult;
}

export function renderLaunchAgentPlist({ label, nodePath, scriptPath, planPath, logPath }) {
  assertLabel(label, "helper label");
  for (const [name, value] of Object.entries({ nodePath, scriptPath, planPath, logPath })) {
    assertAbsolutePath(value, name);
  }
  const argument = (value) => `      <string>${escapeXml(value)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "  <dict>",
    "    <key>Label</key>",
    `    <string>${escapeXml(label)}</string>`,
    "    <key>ProgramArguments</key>",
    "    <array>",
    argument(nodePath),
    argument(scriptPath),
    argument("run"),
    argument("--plan"),
    argument(planPath),
    "    </array>",
    "    <key>RunAtLoad</key>",
    "    <true/>",
    "    <key>KeepAlive</key>",
    "    <false/>",
    "    <key>ProcessType</key>",
    "    <string>Background</string>",
    "    <key>StandardOutPath</key>",
    `    <string>${escapeXml(logPath)}</string>`,
    "    <key>StandardErrorPath</key>",
    `    <string>${escapeXml(logPath)}</string>`,
    "  </dict>",
    "</plist>",
    "",
  ].join("\n");
}

export async function installOneShotLaunchAgent({
  projectRoot,
  stagedDistPath,
  serviceLabel,
  servicePlistPath,
  controlReadinessUrl = "http://127.0.0.1:7677/internal/readiness",
  diagnosticsToken,
  scriptPath,
  nodePath = process.execPath,
  platform = process.platform,
  uid = process.getuid?.(),
  home = homedir(),
  runCommand = defaultRunCommand,
}) {
  if (platform !== "darwin" || uid === undefined) {
    throw new Error("One-shot LaunchAgent deployment is supported only for a macOS user session.");
  }
  const root = resolve(projectRoot);
  const staged = resolve(stagedDistPath);
  const servicePlist = resolve(servicePlistPath);
  assertPathInside(root, staged, "staged dist");
  assertLabel(serviceLabel, "service label");
  assertControlReadinessUrl(controlReadinessUrl);
  assertDiagnosticsToken(diagnosticsToken);
  assertAbsolutePath(scriptPath, "script path");
  assertAbsolutePath(nodePath, "Node path");

  const operationId = randomUUID();
  const compactId = operationId.replaceAll("-", "");
  const helperLabel = `com.waishnav.devspace.deploy.${compactId}`;
  const stateDirectory = join(root, ".build-stage", "deployments");
  const launchAgentsDirectory = join(resolve(home), "Library", "LaunchAgents");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await mkdir(launchAgentsDirectory, { recursive: true, mode: 0o700 });
  const lockPath = join(stateDirectory, "deployment-lock.sqlite");
  const installLease = acquireDeploymentLock(lockPath, COMMAND_TIMEOUT_MS);
  try {
    const resumable = await findResumablePlan(stateDirectory, root, serviceLabel);
    if (resumable) {
      const helperTarget = `gui/${uid}/${resumable.helperLabel}`;
      try {
        await runCommand(LAUNCHCTL_PATH, ["kickstart", helperTarget], COMMAND_TIMEOUT_MS);
      } catch {
        await runCommand(
          LAUNCHCTL_PATH,
          ["bootstrap", `gui/${uid}`, resumable.helperPlistPath],
          COMMAND_TIMEOUT_MS,
        );
      }
      return {
        operationId: resumable.operationId,
        helperLabel: resumable.helperLabel,
        planPath: resumable.planPath,
        logPath: resumable.logPath,
        receiptPath: resumable.receiptPath,
        resumed: true,
      };
    }
    const planPath = join(stateDirectory, `${operationId}.json`);
    const logPath = join(stateDirectory, `${operationId}.jsonl`);
    const receiptPath = join(stateDirectory, `${operationId}.result.json`);
    const helperPlistPath = join(launchAgentsDirectory, `${helperLabel}.plist`);
    const plan = {
      schemaVersion: 1,
      operationId,
      uid,
      projectRoot: root,
      stagedDistPath: staged,
      serviceLabel,
      servicePlistPath: servicePlist,
      controlReadinessUrl,
      diagnosticsToken,
      helperLabel,
      helperPlistPath,
      planPath,
      logPath,
      receiptPath,
      lockPath,
      nodePath,
      scriptPath,
    };
    validatePlan(plan);

    await writeDurableFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "wx");
    try {
      await writeDurableFile(helperPlistPath, renderLaunchAgentPlist({
        label: helperLabel,
        nodePath,
        scriptPath,
        planPath,
        logPath,
      }), "wx");
      await runCommand(LAUNCHCTL_PATH, ["bootstrap", `gui/${uid}`, helperPlistPath], COMMAND_TIMEOUT_MS);
    } catch (error) {
      await unlinkIfExists(helperPlistPath);
      await unlinkIfExists(planPath);
      throw error;
    }
    return { operationId, helperLabel, planPath, logPath, receiptPath };
  } finally {
    installLease.release();
  }
}

export async function runDeploymentPlan(planPath, options = {}) {
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  validatePlan(plan);
  if (resolve(planPath) !== plan.planPath) throw new Error("The plan path does not match its bound path.");
  const recorded = await readJsonIfExists(plan.receiptPath);
  if (recorded) return finalizeRecordedDeployment(plan, recorded, options);
  const actions = createLaunchdDeploymentActions(plan, options);
  return runOneShotDeployment({
    operationId: plan.operationId,
    actions,
    log: actions.log,
  });
}

export function createLaunchdDeploymentActions(plan, {
  runCommand = defaultRunCommand,
  fetchReady = fetchAuthenticatedReadiness,
  fetchPreflight,
  wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
  now = () => new Date().toISOString(),
  lockTimeoutMs = COMMAND_TIMEOUT_MS,
  quiesceTimeoutMs = PROCESS_QUIESCE_TIMEOUT_MS,
  platform = process.platform,
  uid = process.getuid?.(),
} = {}) {
  validatePlan(plan);
  if (platform !== "darwin" || uid !== plan.uid) {
    throw new Error("Deployment plan user or platform does not match this process.");
  }
  const serviceTarget = `gui/${plan.uid}/${plan.serviceLabel}`;
  const helperTarget = `gui/${plan.uid}/${plan.helperLabel}`;
  const distPath = join(plan.projectRoot, "dist");
  const backupPath = join(plan.projectRoot, ".build-stage", `dist-backup-${plan.operationId}`);
  let deploymentLock;
  let previousPid;
  let previousGeneration;
  let resumeRequired = false;
  const fetchRestartPreflight = fetchPreflight ?? (
    fetchReady === fetchAuthenticatedReadiness
      ? fetchAuthenticatedRestartPreflight
      : fetchReady
  );

  return {
    log: async (event) => {
      await appendDurableLine(plan.logPath, `${JSON.stringify(event)}\n`);
    },
    acquireLock: async () => {
      resumeRequired = await journalNeedsRecovery(plan.logPath);
      deploymentLock = acquireDeploymentLock(plan.lockPath, lockTimeoutMs);
      try {
        await stat(plan.receiptPath);
        deploymentLock.release();
        deploymentLock = undefined;
        throw new DeploymentBusyError("This deployment operation already has a terminal receipt.");
      } catch (error) {
        if (error instanceof DeploymentBusyError) throw error;
        if (!isMissingFile(error)) {
          deploymentLock.release();
          deploymentLock = undefined;
          throw error;
        }
      }
    },
    preflight: async () => {
      if (resumeRequired) {
        await reconcileInterruptedDeployment(plan, {
          runCommand,
          fetchReady,
          fetchPreflight: fetchRestartPreflight,
          wait,
        });
        resumeRequired = false;
      }
      await assertPlainDirectory(distPath, "current dist");
      await assertPlainDirectory(plan.stagedDistPath, "staged dist");
      if (await pathExists(backupPath)) throw new Error("The operation-specific dist backup already exists.");
      for (const entrypoint of ["cli.js", "server.js"]) {
        await stat(join(plan.stagedDistPath, entrypoint));
        await runCommand(plan.nodePath, ["--check", join(plan.stagedDistPath, entrypoint)], COMMAND_TIMEOUT_MS);
      }
      await runCommand(PLUTIL_PATH, ["-lint", plan.servicePlistPath], COMMAND_TIMEOUT_MS);
      const labelResult = await runCommand(
        PLUTIL_PATH,
        ["-extract", "Label", "raw", "-o", "-", plan.servicePlistPath],
        COMMAND_TIMEOUT_MS,
      );
      if (labelResult.stdout.trim() !== plan.serviceLabel) {
        throw new Error("The main service plist Label does not match the deployment plan.");
      }
      const launchd = await runCommand(LAUNCHCTL_PATH, ["print", serviceTarget], COMMAND_TIMEOUT_MS);
      previousPid = launchdPid(launchd.stdout);
      if (!previousPid) throw new Error("The enrolled main service PID is unavailable.");
      const quiesceDeadline = Date.now() + quiesceTimeoutMs;
      do {
        const readiness = await fetchRestartPreflight(
          plan.controlReadinessUrl,
          plan.diagnosticsToken,
        );
        const observedGeneration = readiness.generation;
        const identityMatches = readiness.pid === previousPid || (
          readiness.identity === "legacy_authenticated" && readiness.pid === undefined
        );
        if (!readiness.ready || !identityMatches || !observedGeneration) {
          throw new Error("The enrolled main service did not pass PID-correlated readiness preflight.");
        }
        if (previousGeneration === undefined) previousGeneration = observedGeneration;
        if (observedGeneration !== previousGeneration) {
          throw new Error("The backend generation changed during deployment preflight.");
        }
        if ((readiness.runningProcesses ?? 0) === 0) break;
        if (Date.now() >= quiesceDeadline) {
          throw new Error(
            `Deployment was refused because ${readiness.runningProcesses} managed process session(s) are still running.`,
          );
        }
        await wait(250);
      } while (true);
    },
    stopMainService: async () => {
      await runCommand(LAUNCHCTL_PATH, ["bootout", serviceTarget], COMMAND_TIMEOUT_MS);
    },
    swapDist: async () => {
      await rename(distPath, backupPath);
      await rename(plan.stagedDistPath, distPath);
    },
    startMainService: async () => {
      await runCommand(LAUNCHCTL_PATH, ["bootstrap", `gui/${plan.uid}`, plan.servicePlistPath], COMMAND_TIMEOUT_MS);
    },
    verifyMainService: async () => {
      const deadline = Date.now() + VERIFY_TIMEOUT_MS;
      do {
        try {
          const launchd = await runCommand(LAUNCHCTL_PATH, ["print", serviceTarget], COMMAND_TIMEOUT_MS);
          const currentPid = launchdPid(launchd.stdout);
          const readiness = await fetchReady(plan.controlReadinessUrl, plan.diagnosticsToken);
          if (
            currentPid &&
            currentPid !== previousPid &&
            readiness.ready &&
            readiness.pid === currentPid &&
            readiness.generation &&
            readiness.generation !== previousGeneration
          ) return;
        } catch {
          // launchd and HTTP readiness can be transient while the job starts.
        }
        await wait(250);
      } while (Date.now() < deadline);
      throw new Error("The deployed service did not prove a new PID and readiness generation.");
    },
    ensureMainServiceStopped: async () => {
      try {
        await runCommand(LAUNCHCTL_PATH, ["bootout", serviceTarget], COMMAND_TIMEOUT_MS);
      } catch {
        try {
          await runCommand(LAUNCHCTL_PATH, ["print", serviceTarget], COMMAND_TIMEOUT_MS);
        } catch {
          return;
        }
        throw new Error("The main service could not be stopped before dist rollback.");
      }
    },
    rollbackDist: async () => {
      await rollbackDistPaths({ distPath, stagedDistPath: plan.stagedDistPath, backupPath });
    },
    restoreMainService: async () => {
      await startAndVerifyService(
        plan,
        serviceTarget,
        runCommand,
        fetchRestartPreflight,
        wait,
      );
    },
    cleanupBackup: async () => {
      await cleanupBackupPath(backupPath);
    },
    recordTerminal: async (result) => {
      await writeDurableFile(plan.receiptPath, `${JSON.stringify({
        operationId: plan.operationId,
        completedAt: now(),
        ...result,
      }, null, 2)}\n`, "wx");
    },
    releaseLock: async () => {
      deploymentLock?.release();
      deploymentLock = undefined;
    },
    unloadHelper: async () => {
      await unlinkIfExists(plan.planPath);
      await unlinkIfExists(plan.helperPlistPath);
      await runCommand(LAUNCHCTL_PATH, ["bootout", helperTarget], COMMAND_TIMEOUT_MS);
    },
  };
}

function validatePlan(plan) {
  if (!plan || plan.schemaVersion !== 1) throw new Error("Unsupported macOS deployment plan.");
  assertOperationId(plan.operationId);
  if (!Number.isSafeInteger(plan.uid) || plan.uid < 0) throw new Error("Invalid deployment uid.");
  assertLabel(plan.serviceLabel, "service label");
  assertLabel(plan.helperLabel, "helper label");
  assertControlReadinessUrl(plan.controlReadinessUrl);
  assertDiagnosticsToken(plan.diagnosticsToken);
  const pathFields = [
    "projectRoot",
    "stagedDistPath",
    "servicePlistPath",
    "helperPlistPath",
    "planPath",
    "logPath",
    "receiptPath",
    "lockPath",
    "nodePath",
    "scriptPath",
  ];
  for (const field of pathFields) assertAbsolutePath(plan[field], field);
  assertPathInside(plan.projectRoot, plan.stagedDistPath, "staged dist");
  for (const field of ["planPath", "logPath", "receiptPath", "lockPath"]) {
    assertPathInside(plan.projectRoot, plan[field], field);
  }
  if (basename(plan.helperPlistPath) !== `${plan.helperLabel}.plist`) {
    throw new Error("Helper plist path is not bound to the helper label.");
  }
}

async function logStage(log, operationId, stage, outcome, error) {
  await log({
    timestamp: new Date().toISOString(),
    operationId,
    stage,
    outcome,
    ...(error ? { error: safeErrorMessage(error) } : {}),
  });
}

async function defaultRunCommand(executable, args, timeoutMs) {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(executable, [...args], { timeout: timeoutMs, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        rejectCommand(error);
        return;
      }
      resolveCommand({ stdout, stderr });
    });
  });
}

export async function fetchAuthenticatedReadiness(url, diagnosticsToken) {
  const response = await fetchJsonEndpoint(url, diagnosticsToken);
  if (response.statusCode !== 200) return { ready: false };
  return strictReadinessFromBody(response.body);
}

/**
 * Upgrade-only preflight for backends that predate authenticated
 * `/internal/readiness`. A 404 may fall back to authenticated diagnostics, but
 * only when diagnostics and `/readyz` on the same control listener report the
 * exact same generation. Replacement verification never uses this fallback.
 */
export async function fetchAuthenticatedRestartPreflight(url, diagnosticsToken) {
  const diagnosticsUrl = siblingControlUrl(url, "/internal/diagnostics");
  const diagnosticsRequest = fetchJsonEndpoint(diagnosticsUrl, diagnosticsToken);
  const strictResponse = await fetchJsonEndpoint(url, diagnosticsToken);
  const diagnosticsResponse = await diagnosticsRequest;
  if (diagnosticsResponse.statusCode !== 200 || !validDiagnosticsShape(diagnosticsResponse.body)) {
    return { ready: false };
  }
  const diagnosticsGeneration = generationFromBody(diagnosticsResponse.body);
  const runningProcesses = runningProcessesFromDiagnostics(diagnosticsResponse.body);
  if (!diagnosticsGeneration || runningProcesses === undefined) return { ready: false };

  if (strictResponse.statusCode === 200) {
    const strict = strictReadinessFromBody(strictResponse.body);
    return strict.ready && strict.pid && strict.generation === diagnosticsGeneration
      ? { ...strict, identity: "pid_correlated", runningProcesses }
      : { ready: false };
  }
  if (strictResponse.statusCode !== 404) return { ready: false };

  const readinessUrl = siblingControlUrl(url, "/readyz");
  const readinessResponse = await fetchJsonEndpoint(readinessUrl);
  if (readinessResponse.statusCode !== 200) return { ready: false };
  const readinessGeneration = generationFromBody(readinessResponse.body);
  const readinessOk = readinessResponse.body?.ok === true &&
    readinessResponse.body?.status === "ready";
  if (
    diagnosticsGeneration !== readinessGeneration ||
    !readinessOk
  ) return { ready: false };
  return {
    ready: true,
    generation: diagnosticsGeneration,
    identity: "legacy_authenticated",
    runningProcesses,
  };
}

async function fetchJsonEndpoint(url, diagnosticsToken) {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(1_500),
    ...(diagnosticsToken
      ? { headers: { "x-devspace-internal-token": diagnosticsToken } }
      : {}),
  });
  let body;
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed;
  } catch {
    // Invalid JSON cannot establish restart identity.
  }
  return { statusCode: response.status, body };
}

function strictReadinessFromBody(body) {
  return {
    ready: body?.ok === true,
    pid: Number.isSafeInteger(body?.pid) ? body.pid : undefined,
    generation: generationFromBody(body),
  };
}

function generationFromBody(body) {
  if (typeof body?.generation !== "string" && typeof body?.generation !== "number") {
    return undefined;
  }
  const generation = String(body.generation);
  return generation || undefined;
}

function validDiagnosticsShape(body) {
  return typeof body?.version === "string" && Boolean(body.version) &&
    body.runtimeConfig !== null && typeof body.runtimeConfig === "object";
}

function runningProcessesFromDiagnostics(body) {
  const running = body?.usage?.processSessions?.running;
  return Number.isSafeInteger(running) && running >= 0 ? running : undefined;
}

function siblingControlUrl(url, pathname) {
  const sibling = new URL(url);
  sibling.pathname = pathname;
  sibling.search = "";
  sibling.hash = "";
  return sibling.href;
}

function launchdPid(stdout) {
  const match = stdout.match(/(?:^|\n)\s*pid\s*=\s*(\d+)\s*(?:\n|$)/);
  const pid = match ? Number(match[1]) : undefined;
  return pid && Number.isSafeInteger(pid) ? pid : undefined;
}

async function assertPlainDirectory(path, description) {
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${description} is not a plain directory.`);
  }
}

export async function rollbackDistPaths({ distPath, stagedDistPath, backupPath }) {
  const [distExists, stagedExists, backupExists] = await Promise.all([
    pathExists(distPath),
    pathExists(stagedDistPath),
    pathExists(backupPath),
  ]);

  // No rename occurred, or a previous rollback already completed.
  if (distExists && stagedExists && !backupExists) return;

  // The old dist moved but the staged dist did not: restore the old dist in place.
  if (!distExists && stagedExists && backupExists) {
    await rename(backupPath, distPath);
    return;
  }

  // The full swap completed: put the staged build back and restore the old dist.
  if (distExists && !stagedExists && backupExists) {
    await rename(distPath, stagedDistPath);
    try {
      await rename(backupPath, distPath);
    } catch (error) {
      try {
        await rename(stagedDistPath, distPath);
      } catch (undoError) {
        throw new AggregateError([error, undoError], "Dist rollback and its undo both failed.");
      }
      throw error;
    }
    return;
  }

  throw new Error("Dist paths are in an ambiguous state; refusing an unsafe rollback.");
}

export async function reconcileInterruptedDeployment(plan, {
  runCommand = defaultRunCommand,
  fetchReady = fetchAuthenticatedReadiness,
  fetchPreflight,
  wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
} = {}) {
  validatePlan(plan);
  const serviceTarget = `gui/${plan.uid}/${plan.serviceLabel}`;
  const distPath = join(plan.projectRoot, "dist");
  const backupPath = join(plan.projectRoot, ".build-stage", `dist-backup-${plan.operationId}`);
  const fetchRecoveryIdentity = fetchPreflight ?? (
    fetchReady === fetchAuthenticatedReadiness
      ? fetchAuthenticatedRestartPreflight
      : fetchReady
  );
  const [distExists, stagedExists, backupExists] = await Promise.all([
    pathExists(distPath),
    pathExists(plan.stagedDistPath),
    pathExists(backupPath),
  ]);

  for (const [path, exists, description] of [
    [distPath, distExists, "current dist"],
    [plan.stagedDistPath, stagedExists, "staged dist"],
    [backupPath, backupExists, "dist backup"],
  ]) {
    if (exists) await assertPlainDirectory(path, description);
  }

  if (backupExists) {
    await stopServiceIfLoaded(serviceTarget, runCommand);
    await rollbackDistPaths({ distPath, stagedDistPath: plan.stagedDistPath, backupPath });
    await startAndVerifyService(plan, serviceTarget, runCommand, fetchRecoveryIdentity, wait);
    return { recovered: true, layout: "rolled_back" };
  }

  if (distExists && stagedExists) {
    if (!await serviceMatchesReadiness(plan, serviceTarget, runCommand, fetchRecoveryIdentity)) {
      await stopServiceIfLoaded(serviceTarget, runCommand);
      await startAndVerifyService(plan, serviceTarget, runCommand, fetchRecoveryIdentity, wait);
    }
    return { recovered: true, layout: "unchanged" };
  }

  throw new Error("Interrupted deployment paths are ambiguous; refusing automatic recovery.");
}

async function startAndVerifyService(plan, serviceTarget, runCommand, fetchReady, wait) {
  await runCommand(
    LAUNCHCTL_PATH,
    ["bootstrap", `gui/${plan.uid}`, plan.servicePlistPath],
    COMMAND_TIMEOUT_MS,
  );
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  do {
    if (await serviceMatchesReadiness(plan, serviceTarget, runCommand, fetchReady)) return;
    if (Date.now() < deadline) await wait(250);
  } while (Date.now() < deadline);
  throw new Error("The recovered main service did not pass PID-correlated readiness.");
}

async function serviceMatchesReadiness(plan, serviceTarget, runCommand, fetchReady) {
  try {
    const launchd = await runCommand(LAUNCHCTL_PATH, ["print", serviceTarget], COMMAND_TIMEOUT_MS);
    const pid = launchdPid(launchd.stdout);
    const readiness = await fetchReady(plan.controlReadinessUrl, plan.diagnosticsToken);
    const identityMatches = readiness.pid === pid || (
      readiness.identity === "legacy_authenticated" && readiness.pid === undefined
    );
    return Boolean(pid && readiness.ready && identityMatches && readiness.generation);
  } catch {
    return false;
  }
}

async function stopServiceIfLoaded(serviceTarget, runCommand) {
  try {
    await runCommand(LAUNCHCTL_PATH, ["bootout", serviceTarget], COMMAND_TIMEOUT_MS);
  } catch (error) {
    try {
      await runCommand(LAUNCHCTL_PATH, ["print", serviceTarget], COMMAND_TIMEOUT_MS);
    } catch {
      return;
    }
    throw error;
  }
}

async function finalizeRecordedDeployment(plan, recorded, options) {
  if (recorded?.operationId !== plan.operationId || !["succeeded", "failed"].includes(recorded?.status)) {
    throw new Error("Deployment terminal receipt does not match its plan.");
  }
  const runCommand = options.runCommand ?? defaultRunCommand;
  const backupPath = join(plan.projectRoot, ".build-stage", `dist-backup-${plan.operationId}`);
  const lease = acquireDeploymentLock(plan.lockPath, 0);
  try {
    if (recorded.status === "succeeded" && await pathExists(backupPath)) {
      await cleanupBackupPath(backupPath);
    }
    if (recorded.status === "failed" && await pathExists(backupPath)) {
      throw new Error("A failed deployment still has rollback state; refusing terminal cleanup.");
    }
    await unlinkIfExists(plan.planPath);
    await unlinkIfExists(plan.helperPlistPath);
  } finally {
    lease.release();
  }
  const helperTarget = `gui/${plan.uid}/${plan.helperLabel}`;
  try {
    await runCommand(LAUNCHCTL_PATH, ["bootout", helperTarget], COMMAND_TIMEOUT_MS);
  } catch (error) {
    try {
      await runCommand(LAUNCHCTL_PATH, ["print", helperTarget], COMMAND_TIMEOUT_MS);
    } catch {
      return recorded;
    }
    throw error;
  }
  return recorded;
}

async function findResumablePlan(stateDirectory, projectRoot, serviceLabel) {
  const entries = await readdir(stateDirectory, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[0-9a-f-]{36}\.json$/iu.test(entry.name)) continue;
    const plan = JSON.parse(await readFile(join(stateDirectory, entry.name), "utf8"));
    validatePlan(plan);
    if (plan.projectRoot === projectRoot && plan.serviceLabel === serviceLabel) candidates.push(plan);
  }
  if (candidates.length > 1) {
    throw new Error("Multiple unfinished deployment plans require operator review.");
  }
  return candidates[0];
}

async function journalNeedsRecovery(path) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
  const destructiveStages = new Set([
    "stop-main-service",
    "swap-dist",
    "start-main-service",
    "verify-main-service",
    "stop-main-service-for-rollback",
    "rollback-dist",
    "restore-main-service",
  ]);
  let destructiveTransition = false;
  let terminal = false;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (destructiveStages.has(event.stage)) destructiveTransition = true;
      if (event.stage === "record-terminal" && event.outcome === "completed") terminal = true;
    } catch {
      // launchd may append a non-JSON diagnostic to the shared log file.
    }
  }
  return destructiveTransition && !terminal;
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function appendDurableLine(path, text) {
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

async function writeDurableFile(path, text, flag) {
  const handle = await open(path, flag, 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function cleanupBackupPath(path) {
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error("Refusing to clean a dist backup that is not a plain directory.");
  }
  await rm(path, { recursive: true });
  await syncDirectory(dirname(path));
}

function acquireDeploymentLock(path, timeoutMs) {
  const sqlite = new Database(path, { timeout: timeoutMs });
  try {
    chmodSync(path, 0o600);
    sqlite.pragma(`busy_timeout = ${timeoutMs}`);
    sqlite.pragma("journal_mode = DELETE");
    sqlite.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    sqlite.close();
    if (error?.code === "SQLITE_BUSY" || error?.code === "SQLITE_LOCKED") {
      throw new DeploymentBusyError();
    }
    throw error;
  }
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      try {
        if (sqlite.inTransaction) sqlite.exec("ROLLBACK");
      } finally {
        sqlite.close();
      }
    },
  };
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function unlinkIfExists(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

function isMissingFile(error) {
  return error?.code === "ENOENT";
}

function assertOperationId(value) {
  if (typeof value !== "string" || !OPERATION_ID_PATTERN.test(value)) {
    throw new Error("Invalid deployment operation id.");
  }
}

function assertLabel(value, description) {
  if (typeof value !== "string" || !LABEL_PATTERN.test(value)) {
    throw new Error(`Invalid ${description}.`);
  }
}

function assertAbsolutePath(value, description) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) {
    throw new Error(`${description} must be an absolute normalized path.`);
  }
}

function assertPathInside(root, candidate, description) {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const pathFromRoot = relative(normalizedRoot, normalizedCandidate);
  if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error(`${description} must be a distinct path inside the project root.`);
  }
}

function assertControlReadinessUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Readiness URL is invalid.");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/internal/readiness" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Control readiness URL must be a loopback /internal/readiness URL.");
  }
}

function assertDiagnosticsToken(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 4_096 || /[\r\n]/.test(value)) {
    throw new Error("A valid internal diagnostics token is required.");
  }
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : "Unknown deployment error.";
}
