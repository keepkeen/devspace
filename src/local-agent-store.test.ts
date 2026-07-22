import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAgentStore } from "./local-agent-store.js";

const root = mkdtempSync(join(tmpdir(), "devspace-local-agent-store-test-"));
const stores: LocalAgentStore[] = [];

try {
  const store = new LocalAgentStore(root);
  stores.push(store);
  const created = store.create({
    workspaceId: "ws_1",
    workspaceRoot: join(root, "project"),
    profileName: "reviewer",
    provider: "codex",
    model: "gpt-5.4",
    thinking: "high",
  });

  assert.match(created.id, /^agt_[a-f0-9]{8}$/);
  assert.equal(created.status, "starting");
  assert.equal(store.get(created.id)?.thinking, "high");
  assert.equal(store.get(created.id)?.profileName, "reviewer");
  assert.equal(store.get(created.id.slice(0, 7))?.id, created.id);

  const updated = store.update(created.id, {
    status: "idle",
    latestResponse: "done",
    providerSessionId: "thread_123",
    thinking: "medium",
  });

  assert.equal(updated.status, "idle");
  assert.equal(updated.thinking, "medium");
  assert.equal(store.get("thread_123")?.id, created.id);
  assert.equal(store.get(created.id)?.thinking, "medium");
  assert.equal(store.update(created.id, { latestResponse: undefined }).latestResponse, undefined);
  assert.deepEqual(
    store.list({ workspaceRoot: join(root, "project") }).map((agent) => agent.latestResponse),
    [undefined],
  );
  assert.deepEqual(store.list({ workspaceId: "ws_1" }).map((agent) => agent.id), [created.id]);
  assert.deepEqual(store.list({ workspaceId: "ws_other" }), []);
  assert.deepEqual(store.list({ workspaceRoot: join(root, "other") }), []);

  const otherStore = new LocalAgentStore(root);
  stores.push(otherStore);
  const createdFromOtherStore = otherStore.create({
    workspaceId: "ws_1",
    workspaceRoot: join(root, "project"),
    profileName: "explorer",
    provider: "claude",
  });

  assert.deepEqual(
    store.list({ workspaceId: "ws_1" }).map((agent) => agent.id).sort(),
    [created.id, createdFromOtherStore.id].sort(),
  );

  otherStore.update(createdFromOtherStore.id, { status: "running" });
  const completed = store.update(store.create({
    workspaceId: "ws_1",
    workspaceRoot: join(root, "project"),
    profileName: "reviewer",
    provider: "codex",
  }).id, { status: "idle" });
  const pruned = store.cleanup({
    retentionMs: 365 * 24 * 60 * 60_000,
    maxCompletedRecords: 1,
  });
  assert.equal(pruned.pruned, 1);
  assert.equal(store.get(createdFromOtherStore.id)?.status, "running");
  assert.equal([store.get(created.id), store.get(completed.id)].filter(Boolean).length, 1);

  const staleStarting = store.create({
    workspaceId: "ws_1",
    workspaceRoot: join(root, "project"),
    profileName: "reviewer",
    provider: "codex",
  });
  const cleanupNow = Date.now() + 11 * 60_000;
  const reconciled = store.cleanup({
    now: cleanupNow,
    staleStartingMs: 10 * 60_000,
    staleRunningMs: 48 * 60 * 60_000,
    retentionMs: 365 * 24 * 60 * 60_000,
    maxCompletedRecords: 10,
  });
  assert.equal(reconciled.reconciledStarting, 1);
  assert.equal(reconciled.reconciledRunning, 0);
  assert.equal(store.get(staleStarting.id)?.status, "error");
  assert.match(store.get(staleStarting.id)?.error ?? "", /did not start/);
  assert.equal(store.get(createdFromOtherStore.id)?.status, "running");
} finally {
  for (const store of stores) {
    store.close();
  }
  rmSync(root, { recursive: true, force: true });
}
