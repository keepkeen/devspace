import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
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
