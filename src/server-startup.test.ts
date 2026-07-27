import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import { MutationOperationStore } from "./mutation-operation-store.js";
import {
  createServer,
  listenerErrorKind,
  oauthDiscoveryCompatibilityPath,
  patchFitsUtf8ByteLimit,
} from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const root = await mkdtemp(join(tmpdir(), "devspace-server-startup-test-"));
const workspaceRoot = join(root, "workspace");
const stateDir = join(root, "state");
let active: ReturnType<typeof createServer> | undefined;
let mutationStore: MutationOperationStore | undefined;
let workspaceStore: SqliteWorkspaceStore | undefined;

assert.equal(listenerErrorKind(Object.assign(new Error("busy"), { code: "EADDRINUSE" })), "bind");
assert.equal(listenerErrorKind(Object.assign(new Error("files"), { code: "EMFILE" })), "runtime");
assert.equal(
  oauthDiscoveryCompatibilityPath("/.well-known/oauth-protected-resource"),
  "/.well-known/oauth-protected-resource/mcp",
);
assert.equal(
  oauthDiscoveryCompatibilityPath("/.well-known/oauth-authorization-server/mcp"),
  "/.well-known/oauth-authorization-server",
);
assert.equal(oauthDiscoveryCompatibilityPath("/.well-known/oauth-authorization-server"), undefined);
assert.equal(patchFitsUtf8ByteLimit("a".repeat(4 * 1024 * 1024)), true);
assert.equal(patchFitsUtf8ByteLimit("中".repeat(2 * 1024 * 1024)), false);

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

  // An oversized body must come back as a JSON-RPC error the caller can act on.
  // The body-parser default used to surface as an HTML error page plus an
  // unhandled PayloadTooLargeError, which no MCP client can interpret.
  {
    const bodyLimitConfig = loadConfig({
      DEVSPACE_CONFIG_DIR: join(root, "config-body-limit"),
      DEVSPACE_STATE_DIR: join(root, "state-body-limit"),
      DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
      DEVSPACE_ALLOWED_HOSTS: "*",
      DEVSPACE_PUBLIC_BASE_URL: "https://devspace.body-limit.test",
      DEVSPACE_OAUTH_OWNER_TOKEN: "server-startup-test-owner-password",
      DEVSPACE_MAX_REQUEST_BODY_BYTES: "65536",
      DEVSPACE_SKILLS: "0",
      DEVSPACE_WIDGETS: "off",
      PORT: "1",
    });
    assert.equal(bodyLimitConfig.resources.maxRequestBodyBytes, 65_536);
    const bodyLimitServer = createServer(bodyLimitConfig);
    const httpServer = createHttpServer(bodyLimitServer.app);
    try {
      const origin = await new Promise<string>((resolveOrigin) => {
        httpServer.listen(0, "127.0.0.1", () => {
          const address = httpServer.address();
          resolveOrigin(
            `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`,
          );
        });
      });
      const response = await fetch(new URL("/mcp", origin), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "x", version: "1", padding: "y".repeat(200_000) } },
        }),
      });
      assert.equal(response.status, 413);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/u);
      const payload = await response.json() as { jsonrpc?: string; error?: { message?: string } };
      assert.equal(payload.jsonrpc, "2.0");
      assert.match(payload.error?.message ?? "", /exceeds the 65536-byte limit/u);
      assert.match(payload.error?.message ?? "", /nothing was executed/u);

      const malformed = await fetch(new URL("/mcp", origin), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: '{"jsonrpc":"2.0", bad',
      });
      assert.equal(malformed.status, 400);
      assert.match(malformed.headers.get("content-type") ?? "", /application\/json/u);
      assert.equal(malformed.headers.get("x-powered-by"), null);
      const malformedText = await malformed.text();
      assert.match(malformedText, /"code":-32700/u);
      assert.match(malformedText, /nothing was executed/u);
      assert.doesNotMatch(malformedText, /SyntaxError|node_modules|\/Users\//u);
    } finally {
      await bodyLimitServer.beginClose();
      await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
      await bodyLimitServer.close();
    }
  }

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
