import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import {
  CrossProcessWorkspaceRootLock,
  WorkspaceRootLockTimeoutError,
} from "./cross-process-root-lock.js";
import { WorkspaceRootLockManager } from "./workspace-root-locks.js";
import { WorkspaceRegistry } from "./workspaces.js";

const locks = new WorkspaceRootLockManager();
const events: string[] = [];
let releaseReadA!: () => void;
let releaseReadB!: () => void;
let releaseWrite!: () => void;

const readA = locks.acquire("root-a", "read").then((release) => {
  events.push("read-a");
  releaseReadA = release;
});
const readB = locks.acquire("root-a", "read").then((release) => {
  events.push("read-b");
  releaseReadB = release;
});
const write = locks.acquire("root-a", "write").then((release) => {
  events.push("write");
  releaseWrite = release;
});
const lateRead = locks.acquire("root-a", "read").then((release) => {
  events.push("late-read");
  release();
});

await Promise.all([readA, readB]);
assert.deepEqual(events, ["read-a", "read-b"]);
releaseReadA();
await Promise.resolve();
assert.deepEqual(events, ["read-a", "read-b"]);
releaseReadB();
await write;
assert.deepEqual(events, ["read-a", "read-b", "write"]);
releaseWrite();
await lateRead;
assert.deepEqual(events, ["read-a", "read-b", "write", "late-read"]);

const independent: string[] = [];
await Promise.all([
  locks.withLock("root-a", "write", async () => { independent.push("a"); }),
  locks.withLock("root-b", "write", async () => { independent.push("b"); }),
]);
assert.deepEqual(new Set(independent), new Set(["a", "b"]));

const crossProcessRoot = await mkdtemp(join(tmpdir(), "devspace-cross-process-root-lock-"));
try {
  const processA = new WorkspaceRootLockManager({
    crossProcessLockRoot: crossProcessRoot,
    acquireTimeoutMs: 2_000,
    pollIntervalMs: 10,
  });
  const processB = new WorkspaceRootLockManager({
    crossProcessLockRoot: crossProcessRoot,
    acquireTimeoutMs: 2_000,
    pollIntervalMs: 10,
  });

  const releaseWriterA = await processA.acquire("canonical-root", "write");
  let writerBAcquired = false;
  const writerB = processB.acquire("canonical-root", "write").then((release) => {
    writerBAcquired = true;
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(writerBAcquired, false, "different lock managers must serialize the same root");
  releaseWriterA();
  const releaseWriterB = await writerB;
  assert.equal(writerBAcquired, true);
  releaseWriterB();

  const releaseReaderA = await processA.acquire("canonical-root", "read");
  const releaseReaderB = await processB.acquire("canonical-root", "read");
  // The second reader proves cross-manager read sharing; release it before the
  // same manager queues a writer so its process-local fairness queue can
  // publish writer intent to the filesystem layer.
  releaseReaderB();
  let waitingWriterAcquired = false;
  const waitingWriter = processB.acquire("canonical-root", "write").then((release) => {
    waitingWriterAcquired = true;
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  let lateReaderAcquired = false;
  const lateCrossReader = processA.acquire("canonical-root", "read").then((release) => {
    lateReaderAcquired = true;
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(waitingWriterAcquired, false);
  assert.equal(lateReaderAcquired, false, "writer intent must block later cross-process readers");
  releaseReaderA();
  const releaseWaitingWriter = await waitingWriter;
  assert.equal(waitingWriterAcquired, true);
  assert.equal(lateReaderAcquired, false);
  releaseWaitingWriter();
  const releaseLateReader = await lateCrossReader;
  assert.equal(lateReaderAcquired, true);
  releaseLateReader();

  let clockOffsetMs = 0;
  const clock = () => Date.now() + clockOffsetMs;
  const longLivedA = new CrossProcessWorkspaceRootLock({
    root: crossProcessRoot,
    acquireTimeoutMs: 100,
    pollIntervalMs: 10,
    now: clock,
  });
  const longLivedB = new CrossProcessWorkspaceRootLock({
    root: crossProcessRoot,
    acquireTimeoutMs: 100,
    pollIntervalMs: 10,
    now: clock,
  });
  const releaseLongLived = await longLivedA.acquire("long-lived-process-root", "write");
  try {
    clockOffsetMs += 48 * 60 * 60_000;
    await assert.rejects(
      longLivedB.acquire("long-lived-process-root", "write"),
      WorkspaceRootLockTimeoutError,
      "a live process must retain its lock regardless of marker age",
    );
  } finally {
    releaseLongLived();
  }

  const temporaryCleanupKey = "temporary-cleanup-root";
  const temporaryCleanupDigest = createHash("sha256")
    .update("devspace-cross-process-root-lock-v1\0", "utf8")
    .update(temporaryCleanupKey, "utf8")
    .digest("hex");
  const temporaryCleanupDirectory = join(crossProcessRoot, temporaryCleanupDigest);
  const temporaryReaderDirectory = join(temporaryCleanupDirectory, "readers");
  await mkdir(temporaryReaderDirectory, { recursive: true });
  const deadTemporaryMarker = join(
    temporaryCleanupDirectory,
    "writer.json.2147483647-dead.tmp",
  );
  const livePartialMarker = join(
    temporaryReaderDirectory,
    `reader.json.${process.pid}-live.tmp`,
  );
  await writeFile(deadTemporaryMarker, JSON.stringify({
    pid: 2_147_483_647,
    token: "dead",
    createdAt: Date.now(),
  }));
  await writeFile(livePartialMarker, "{");
  const cleanupLock = new CrossProcessWorkspaceRootLock({
    root: crossProcessRoot,
    acquireTimeoutMs: 500,
    pollIntervalMs: 10,
  });
  const releaseCleanupRead = await cleanupLock.acquire(temporaryCleanupKey, "read");
  releaseCleanupRead();
  await assert.rejects(access(deadTemporaryMarker), { code: "ENOENT" });
  await access(livePartialMarker);
  await rm(livePartialMarker, { force: true });

  const lockModuleUrl = new URL("./cross-process-root-lock.ts", import.meta.url).href;
  const childSource = `
    import { CrossProcessWorkspaceRootLock } from ${JSON.stringify(lockModuleUrl)};
    const lock = new CrossProcessWorkspaceRootLock({
      root: process.argv[1],
      acquireTimeoutMs: 2_000,
      pollIntervalMs: 10,
    });
    const release = await lock.acquire("actual-process-root", "write");
    process.stdout.write("LOCKED\\n");
    process.stdin.once("data", () => {
      release();
      process.stdout.write("RELEASED\\n");
      process.exit(0);
    });
    process.stdin.resume();
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", childSource, crossProcessRoot],
    { stdio: "pipe" },
  );
  let childStderr = "";
  child.stderr.on("data", (chunk) => { childStderr += String(chunk); });
  try {
    await waitForChildOutput(child, "LOCKED");
    const independentProcess = new CrossProcessWorkspaceRootLock({
      root: crossProcessRoot,
      acquireTimeoutMs: 100,
      pollIntervalMs: 10,
    });
    await assert.rejects(
      independentProcess.acquire("actual-process-root", "write"),
      WorkspaceRootLockTimeoutError,
      "an independent OS process must hold the same physical-root lease",
    );
    const releasedOutput = waitForChildOutput(child, "RELEASED");
    child.stdin.write("release\n");
    await releasedOutput;
    const exit = await waitForChildExit(child);
    assert.deepEqual(exit, { code: 0, signal: null }, childStderr);
    const releaseAfterExit = await independentProcess.acquire("actual-process-root", "write");
    releaseAfterExit();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForChildExit(child).catch(() => undefined);
    }
  }

  if (process.platform !== "win32") {
    const crashSource = `
      import { spawn } from "node:child_process";
      import { CrossProcessWorkspaceRootLock } from ${JSON.stringify(lockModuleUrl)};
      const lock = new CrossProcessWorkspaceRootLock({
        root: process.argv[1],
        acquireTimeoutMs: 2_000,
        pollIntervalMs: 10,
        heartbeatIntervalMs: 50,
      });
      const lease = await lock.acquire("orphan-process-root", "write", {
        workspaceGeneration: 17,
      });
      const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
      });
      if (!sleeper.pid) throw new Error("orphan sleeper PID missing");
      sleeper.unref();
      await lease.attachProcess({ pid: sleeper.pid, processGroupId: sleeper.pid });
      process.stdout.write("ORPHAN " + sleeper.pid + "\\n");
      setInterval(() => {}, 1000);
    `;
    const crashedServer = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", crashSource, crossProcessRoot],
      { stdio: "pipe" },
    );
    let crashedStderr = "";
    crashedServer.stderr.on("data", (chunk) => { crashedStderr += String(chunk); });
    let orphanPid: number | undefined;
    try {
      const line = await waitForChildLine(crashedServer, /^ORPHAN (\d+)$/u);
      orphanPid = Number(/^ORPHAN (\d+)$/u.exec(line)?.[1]);
      assert.ok(Number.isSafeInteger(orphanPid) && orphanPid > 0, crashedStderr);
      crashedServer.kill("SIGKILL");
      const crashedExit = await waitForChildExit(crashedServer);
      assert.equal(crashedExit.signal, "SIGKILL", crashedStderr);

      const contender = new CrossProcessWorkspaceRootLock({
        root: crossProcessRoot,
        acquireTimeoutMs: 150,
        pollIntervalMs: 10,
      });
      await assert.rejects(
        contender.acquire("orphan-process-root", "write"),
        WorkspaceRootLockTimeoutError,
        "a child process must retain the root lease after its DevSpace server crashes",
      );

      process.kill(-orphanPid, "SIGTERM");
      await waitForProcessExit(orphanPid);
      const releaseAfterOrphanExit = await new CrossProcessWorkspaceRootLock({
        root: crossProcessRoot,
        acquireTimeoutMs: 2_000,
        pollIntervalMs: 10,
      }).acquire("orphan-process-root", "write");
      releaseAfterOrphanExit();
    } finally {
      if (crashedServer.exitCode === null && crashedServer.signalCode === null) {
        crashedServer.kill("SIGKILL");
        await waitForChildExit(crashedServer).catch(() => undefined);
      }
      if (orphanPid) {
        try {
          process.kill(-orphanPid, "SIGKILL");
        } catch {
          // The detached process group already exited.
        }
      }
    }
  }
} finally {
  await rm(crossProcessRoot, { recursive: true, force: true });
}

function waitForChildOutput(
  child: ChildProcessWithoutNullStreams,
  expected: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const cleanup = () => {
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onData = (chunk: Buffer | string) => {
      output += String(chunk);
      if (!output.includes(expected)) return;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Child exited before ${expected}: code=${code}, signal=${signal}, output=${output}`));
    };
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function waitForChildLine(
  child: ChildProcessWithoutNullStreams,
  pattern: RegExp,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const cleanup = () => {
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onData = (chunk: Buffer | string) => {
      output += String(chunk);
      for (const line of output.split(/\r?\n/u)) {
        if (!pattern.test(line)) continue;
        cleanup();
        resolve(line);
        return;
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Child exited before matching line: code=${code}, signal=${signal}, output=${output}`));
    };
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Process ${pid} did not exit.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const root = await mkdtemp(join(tmpdir(), "devspace-root-lock-integration-"));
try {
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, "config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: join(root, "state"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "root-lock-test-owner-token-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: "https://devspace.example.com",
    PORT: "1",
  });
  const registry = new WorkspaceRegistry(config);
  const workspaceA = (await registry.openWorkspace("principal-a", root)).workspace;
  const workspaceB = (await registry.openWorkspace("principal-b", root)).workspace;
  assert.notEqual(workspaceA.id, workspaceB.id);

  let releaseFirstWrite!: () => void;
  let firstWriteStarted!: () => void;
  const firstWriteBarrier = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
  const firstWriteStart = new Promise<void>((resolve) => { firstWriteStarted = resolve; });
  let secondWriteStarted = false;
  const firstWrite = registry.withWorkspaceOperation(
    "principal-a",
    workspaceA.id,
    workspaceA.stateGeneration,
    async () => {
      firstWriteStarted();
      await firstWriteBarrier;
    },
    "write",
  );
  await firstWriteStart;
  const secondWrite = registry.withWorkspaceOperation(
    "principal-b",
    workspaceB.id,
    workspaceB.stateGeneration,
    () => { secondWriteStarted = true; },
    "write",
  );
  await Promise.resolve();
  assert.equal(secondWriteStarted, false, "same physical root must serialize writes across principals");
  releaseFirstWrite();
  await Promise.all([firstWrite, secondWrite]);
  assert.equal(secondWriteStarted, true);

  let releaseRead!: () => void;
  let readAStarted!: () => void;
  let readBStarted!: () => void;
  const readBarrier = new Promise<void>((resolve) => { releaseRead = resolve; });
  const readAStart = new Promise<void>((resolve) => { readAStarted = resolve; });
  const readBStart = new Promise<void>((resolve) => { readBStarted = resolve; });
  const sharedReadA = registry.withWorkspaceOperation(
    "principal-a",
    workspaceA.id,
    workspaceA.stateGeneration,
    async () => { readAStarted(); await readBarrier; },
    "read",
  );
  const sharedReadB = registry.withWorkspaceOperation(
    "principal-b",
    workspaceB.id,
    workspaceB.stateGeneration,
    async () => { readBStarted(); await readBarrier; },
    "read",
  );
  await Promise.all([readAStart, readBStart]);
  releaseRead();
  await Promise.all([sharedReadA, sharedReadB]);
} finally {
  await rm(root, { recursive: true, force: true });
}
