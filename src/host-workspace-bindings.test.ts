import assert from "node:assert/strict";
import test from "node:test";
import { HostWorkspaceBindingStore } from "./host-workspace-bindings.js";
import type { WorkspaceContextReceiptBinding } from "./workspace-context-protocol.js";

const binding: WorkspaceContextReceiptBinding = {
  connectionPrincipalId: "principal-a",
  workspaceId: "workspace-a",
  alias: "alpha",
  projectFingerprint: "proj-alpha",
  contextSessionId: "context-a",
  generation: 3,
  instructionRevision: "instructions-a",
  skillRevision: "skills-a",
  phase: "context_loaded",
};

test("host Workspace bindings isolate grants and require matching epoch, principal, and session", () => {
  const store = new HostWorkspaceBindingStore();
  const authorization = {
    principalId: "principal-a",
    grantId: "grant-a",
    authorizationEpoch: 2,
    sessionHash: "session-a",
  };
  store.bind(authorization, binding);
  assert.equal(store.resolve(authorization)?.binding.workspaceId, "workspace-a");
  const otherGrant = { ...authorization, grantId: "grant-b" };
  assert.equal(store.resolve(otherGrant), undefined);
  assert.equal(
    store.resolve(authorization)?.binding.workspaceId,
    "workspace-a",
    "looking up another grant must not evict the original binding",
  );
  store.bind(otherGrant, {
    ...binding,
    workspaceId: "workspace-b",
    contextSessionId: "context-b",
  });
  assert.equal(store.resolve(authorization)?.binding.workspaceId, "workspace-a");
  assert.equal(store.resolve(otherGrant)?.binding.workspaceId, "workspace-b");
  assert.equal(store.resolve({ ...authorization, authorizationEpoch: 3 }), undefined);
  assert.equal(store.resolve(authorization), undefined, "epoch mismatch invalidates its grant binding");
  assert.equal(store.resolve(otherGrant)?.binding.workspaceId, "workspace-b");
});

test("host Workspace bindings do not expire and enforce per-principal limits", () => {
  let now = 100;
  const store = new HostWorkspaceBindingStore({
    now: () => now,
    maxBindings: 3,
    maxBindingsPerPrincipal: 2,
  });
  const authorization = {
    principalId: "principal-a",
    grantId: "grant-a",
    authorizationEpoch: 1,
  };
  store.bind({ ...authorization, sessionHash: "one" }, binding);
  store.bind({ ...authorization, sessionHash: "two" }, { ...binding, workspaceId: "workspace-b" });
  store.bind({ ...authorization, sessionHash: "three" }, { ...binding, workspaceId: "workspace-c" });
  assert.equal(store.resolve({ ...authorization, sessionHash: "one" }), undefined);
  assert.equal(store.size, 2);
  now = Number.MAX_SAFE_INTEGER - 1;
  assert.equal(
    store.resolve({ ...authorization, sessionHash: "two" })?.binding.workspaceId,
    "workspace-b",
  );
});

test("hosts without session metadata cannot create an implicit binding", () => {
  const store = new HostWorkspaceBindingStore();
  assert.equal(store.bind({
    principalId: "principal-a",
    grantId: "grant-a",
    authorizationEpoch: 1,
  }, binding), undefined);
  assert.equal(store.size, 0);
});
