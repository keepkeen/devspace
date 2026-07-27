import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAgentStore } from "./local-agent-store.js";
import { MAX_LOCAL_AGENT_RESPONSE_BYTES } from "./local-agent-limits.js";
import {
  readLocalAgentOutput,
  writeLocalAgentOutput,
} from "./local-agent-output.js";

const root = mkdtempSync(join(tmpdir(), "devspace-local-agent-store-test-"));
const stores: LocalAgentStore[] = [];

try {
  const projectRoot = join(root, "project");
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
  const projectScope = { workspaceId: "ws_1", workspaceRoot: projectRoot };
  assert.equal(store.get(created.id, projectScope)?.thinking, "high");
  assert.equal(store.get(created.id, projectScope)?.profileName, "reviewer");
  assert.equal(store.get(created.id.slice(0, 7), projectScope)?.id, created.id);

  const updated = store.update(created.id, {
    status: "idle",
    latestResponse: "done",
    providerSessionId: "thread_123",
    thinking: "medium",
  });

  assert.equal(updated.status, "idle");
  assert.equal(updated.thinking, "medium");
  assert.equal(store.get("thread_123", projectScope)?.id, created.id);
  assert.equal(store.get(created.id, projectScope)?.thinking, "medium");
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
  assert.equal(store.get(createdFromOtherStore.id, projectScope)?.status, "running");
  assert.equal([store.get(created.id, projectScope), store.get(completed.id, projectScope)].filter(Boolean).length, 1);

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
  assert.equal(store.get(staleStarting.id, projectScope)?.status, "error");
  assert.match(store.get(staleStarting.id, projectScope)?.error ?? "", /did not start/);
  assert.equal(store.get(createdFromOtherStore.id, projectScope)?.status, "running");

  // A session belongs to the workspace that created it. Without the workspace
  // predicate an id — or a short prefix, which resolves whenever one row
  // matches — read another workspace's transcript, and `agents run` on that id
  // resumed the agent with the *other* workspace as its cwd.
  const otherRoot = join(root, "other-project");
  const otherAgent = store.create({
    workspaceId: "ws_other",
    workspaceRoot: otherRoot,
    profileName: "reviewer",
    provider: "codex",
  });
  store.update(otherAgent.id, { latestResponse: "secrets from the other workspace" });

  assert.equal(store.get(otherAgent.id, projectScope), undefined, "exact id must not cross workspaces");
  assert.equal(
    store.get(otherAgent.id.slice(0, 7), projectScope),
    undefined,
    "an id prefix must not cross workspaces either",
  );
  assert.equal(
    store.get(otherAgent.id, { workspaceId: "ws_other", workspaceRoot: otherRoot })?.latestResponse,
    "secrets from the other workspace",
  );

  const sameRootOtherWorkspace = store.create({
    workspaceId: "ws_same_root_other",
    workspaceRoot: projectRoot,
    profileName: "reviewer",
    provider: "codex",
  });
  store.update(sameRootOtherWorkspace.id, { latestResponse: "same root, different Workspace" });
  assert.equal(
    store.get(sameRootOtherWorkspace.id, projectScope),
    undefined,
    "Workspace id remains the application tenancy key even when the checkout root is shared",
  );
  assert.equal(
    store.get(sameRootOtherWorkspace.id, { workspaceRoot: projectRoot })?.latestResponse,
    "same root, different Workspace",
    "an explicit local root-only lookup remains available outside MCP",
  );

  const oversized = store.update(sameRootOtherWorkspace.id, {
    latestResponse: "x".repeat(MAX_LOCAL_AGENT_RESPONSE_BYTES + 10_000),
  }).latestResponse ?? "";
  assert.equal(Buffer.byteLength(oversized, "utf8") <= MAX_LOCAL_AGENT_RESPONSE_BYTES, true);
  assert.match(oversized, /sha256=[a-f0-9]{64}/u);
  // The detached worker learns its workspace from the record, so its lookup is
  // deliberately unscoped; callers confine the recorded root themselves.
  assert.equal(store.getForWorker(otherAgent.id)?.workspaceRoot, otherRoot);

  const artifactRecord = store.update(store.create({
    workspaceId: "ws_artifact",
    workspaceRoot: projectRoot,
    profileName: "reviewer",
    provider: "codex",
  }).id, { status: "idle" });
  assert.equal(writeLocalAgentOutput(
    root,
    artifactRecord.id,
    "z".repeat(MAX_LOCAL_AGENT_RESPONSE_BYTES + 1),
  ), true);
  assert.ok(readLocalAgentOutput(root, artifactRecord.id));
  store.cleanup({
    now: Date.now() + 1_000,
    retentionMs: 0,
    maxCompletedRecords: 1_000,
    batchSize: 1_000,
  });
  assert.equal(readLocalAgentOutput(root, artifactRecord.id), undefined);
} finally {
  for (const store of stores) {
    store.close();
  }
  rmSync(root, { recursive: true, force: true });
}
