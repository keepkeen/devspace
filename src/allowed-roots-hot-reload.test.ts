import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.js";
import { writeDevspaceConfig } from "./user-config.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const testRoot = await mkdtemp(join(tmpdir(), "devspace-roots-hot-reload-"));
const configDir = join(testRoot, "config");
const rootA = join(testRoot, "root-a");
const rootB = join(testRoot, "root-b");
const stateDir = join(testRoot, "state");
const previousConfigDir = process.env.DEVSPACE_CONFIG_DIR;
const previousAllowedRoots = process.env.DEVSPACE_ALLOWED_ROOTS;
const previousLogLevel = process.env.DEVSPACE_LOG_LEVEL;

await Promise.all([
  mkdir(configDir, { recursive: true }),
  mkdir(rootA, { recursive: true }),
  mkdir(rootB, { recursive: true }),
]);
await writeFile(join(configDir, "auth.json"), JSON.stringify({
  ownerToken: "allowed-roots-hot-reload-owner-token",
}));
process.env.DEVSPACE_CONFIG_DIR = configDir;
delete process.env.DEVSPACE_ALLOWED_ROOTS;
process.env.DEVSPACE_LOG_LEVEL = "silent";
writeDevspaceConfig({
  allowedRoots: [rootA],
  stateDir,
  publicBaseUrl: "http://127.0.0.1:7676",
}, process.env);
const staleStore = new SqliteWorkspaceStore(stateDir);
staleStore.createSession({
  id: "ws_stale_startup_root",
  connectionPrincipalId: "owner",
  root: rootB,
});
staleStore.close();

const running = createServer();
try {
  const canonicalRootA = await realpath(rootA);
  const canonicalRootB = await realpath(rootB);
  assert.deepEqual(
    await Promise.all(running.config.allowedRoots.map((root) => realpath(root))),
    [canonicalRootA],
  );
  await waitFor(() => {
    const store = new SqliteWorkspaceStore(stateDir);
    try {
      return store.getSession("ws_stale_startup_root", "owner") === undefined;
    } finally {
      store.close();
    }
  });

  writeDevspaceConfig({
    allowedRoots: [rootB],
    stateDir,
    publicBaseUrl: "http://127.0.0.1:7676",
  }, process.env);
  await waitFor(() => running.config.allowedRoots[0] === canonicalRootB);
  assert.deepEqual(running.config.allowedRoots, [canonicalRootB]);

  await writeFile(join(configDir, "config.json"), "{ invalid json");
  await new Promise((resolveWait) => setTimeout(resolveWait, 700));
  assert.deepEqual(running.config.allowedRoots, [canonicalRootB]);

  writeDevspaceConfig({
    allowedRoots: [rootA, rootB],
    stateDir,
    publicBaseUrl: "http://127.0.0.1:7676",
  }, process.env);
  await waitFor(() => running.config.allowedRoots.length === 2);
  assert.deepEqual(running.config.allowedRoots, [canonicalRootA, canonicalRootB]);
} finally {
  await running.close();
  restoreEnvironment("DEVSPACE_CONFIG_DIR", previousConfigDir);
  restoreEnvironment("DEVSPACE_ALLOWED_ROOTS", previousAllowedRoots);
  restoreEnvironment("DEVSPACE_LOG_LEVEL", previousLogLevel);
  await rm(testRoot, { recursive: true, force: true });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for allowed roots hot reload.");
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
