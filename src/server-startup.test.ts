import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import { MutationOperationStore } from "./mutation-operation-store.js";
import { createServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const root = await mkdtemp(join(tmpdir(), "devspace-server-startup-test-"));
const workspaceRoot = join(root, "workspace");
const stateDir = join(root, "state");
let active: ReturnType<typeof createServer> | undefined;
let mutationStore: MutationOperationStore | undefined;
let workspaceStore: SqliteWorkspaceStore | undefined;

try {
  await mkdir(workspaceRoot, { recursive: true });
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, "config"),
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
    DEVSPACE_ALLOWED_HOSTS: "*",
    DEVSPACE_PUBLIC_BASE_URL: "https://devspace.startup.test",
    DEVSPACE_OAUTH_OWNER_TOKEN: "server-startup-test-owner-password",
    DEVSPACE_SKILLS: "0",
    DEVSPACE_WIDGETS: "off",
    PORT: "1",
  });
  active = createServer(config);

  const identityDatabase = openDatabase(stateDir);
  try {
    const now = new Date(0).toISOString();
    identityDatabase.sqlite.prepare(`
      insert into connection_principals (principal_id, created_at, last_used_at, revoked_at)
      values (?, ?, ?, null)
    `).run("owner-a", now, now);
  } finally {
    identityDatabase.close();
  }
  workspaceStore = new SqliteWorkspaceStore(stateDir);
  workspaceStore.createSession({
    id: "workspace-a",
    connectionPrincipalId: "owner-a",
    root: workspaceRoot,
  });
  mutationStore = new MutationOperationStore(stateDir);
  const key = {
    connectionPrincipalId: "owner-a",
    workspaceId: "workspace-a",
    tool: "exec_command",
    operationId: "live-operation",
  };
  assert.deepEqual(mutationStore.reserve(key, "request-hash"), { status: "new" });

  assert.throws(
    () => createServer(config),
    /Another DevSpace process|writer lock/,
  );
  assert.deepEqual(
    mutationStore.settle(key, "request-hash", { ok: true }),
    { status: "settled" },
    "a rejected competing startup must not recover the live server's pending operation",
  );

  mutationStore.close();
  mutationStore = undefined;
  workspaceStore.close();
  workspaceStore = undefined;
  await active.close();
  active = undefined;

  const rotatedConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, "config"),
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
    DEVSPACE_ALLOWED_HOSTS: "*",
    DEVSPACE_PUBLIC_BASE_URL: "https://devspace.startup.test",
    DEVSPACE_OAUTH_OWNER_TOKEN: "server-startup-rotated-owner-password",
    DEVSPACE_SKILLS: "0",
    DEVSPACE_WIDGETS: "off",
    PORT: "1",
  });
  active = createServer(rotatedConfig);
  workspaceStore = new SqliteWorkspaceStore(stateDir);
  assert.equal(
    workspaceStore.getSession("workspace-a", "owner-a")?.stateGeneration,
    2,
    "Owner credential epoch changes must stale active Workspace handles",
  );
} finally {
  mutationStore?.close();
  workspaceStore?.close();
  await active?.close();
  await rm(root, { recursive: true, force: true });
}
