import assert from "node:assert/strict";
import { McpSessionRegistry } from "./mcp-sessions.js";

interface FakeTransport {
  closeCalls: number;
  close(): Promise<void>;
}

function createTransport(closeError?: Error): FakeTransport {
  return {
    closeCalls: 0,
    async close() {
      this.closeCalls += 1;
      if (closeError) throw closeError;
    },
  };
}

let now = 0;
const connectionPrincipalId = {
  principalId: "principal-a",
  grantId: "grant-a",
  authorizationEpoch: 1,
} as const;
const otherPrincipalOwner = {
  principalId: "principal-b",
  grantId: "grant-b",
  authorizationEpoch: 1,
} as const;
const otherGrantOwner = {
  ...connectionPrincipalId,
  grantId: "grant-a-2",
} as const;
const nextEpochOwner = {
  ...connectionPrincipalId,
  authorizationEpoch: 2,
} as const;
const registry = new McpSessionRegistry<FakeTransport>({ now: () => now });
const staleTransport = createTransport();
const activeTransport = createTransport();

registry.register("stale", connectionPrincipalId, staleTransport);
now = 1_000;
registry.register("active", connectionPrincipalId, activeTransport);
now = 1_500;
assert.equal(registry.get("active", connectionPrincipalId), activeTransport);
assert.equal(registry.get("active", otherPrincipalOwner), undefined);
now = 2_000;

const idleResults = await registry.closeIdle(1_500);
assert.deepEqual(idleResults, [{ sessionId: "stale" }]);
assert.equal(staleTransport.closeCalls, 1);
assert.equal(activeTransport.closeCalls, 0);
assert.equal(registry.size, 1);
assert.equal(registry.get("stale", connectionPrincipalId), undefined);
assert.equal(registry.get("active", connectionPrincipalId), activeTransport);

const closeError = new Error("close failed");
const failingTransport: FakeTransport = {
  closeCalls: 0,
  async close() {
    this.closeCalls += 1;
    if (this.closeCalls === 1) throw closeError;
  },
};
registry.register("failing", connectionPrincipalId, failingTransport);
now = 10_000;

const failingResults = await registry.closeIdle(1);
assert.equal(failingResults.length, 2);
assert.deepEqual(failingResults.map((result) => result.sessionId).sort(), ["active", "failing"]);
assert.equal(failingResults.find((result) => result.sessionId === "failing")?.error, closeError);
assert.equal(failingTransport.closeCalls, 1);
assert.equal(registry.size, 1);
assert.equal(registry.get("failing", connectionPrincipalId), undefined);
assert.deepEqual(await registry.closeIdle(1), [{ sessionId: "failing" }]);
assert.equal(failingTransport.closeCalls, 2);
assert.equal(registry.size, 0);

const first = createTransport();
const second = createTransport();
registry.register("first", connectionPrincipalId, first);
registry.register("second", connectionPrincipalId, second);
registry.remove("first", connectionPrincipalId);

const shutdownResults = await registry.closeAll();
assert.deepEqual(shutdownResults, [{ sessionId: "second" }]);
assert.equal(first.closeCalls, 0);
assert.equal(second.closeCalls, 1);
assert.equal(registry.size, 0);

let finishDelayedClose: (() => void) | undefined;
let delayedCloseResolved = false;
const delayedTransport: FakeTransport = {
  closeCalls: 0,
  close() {
    this.closeCalls += 1;
    return new Promise<void>((resolve) => {
      finishDelayedClose = resolve;
    });
  },
};
const delayedRegistry = new McpSessionRegistry<FakeTransport>();
delayedRegistry.register("delayed", connectionPrincipalId, delayedTransport);
const delayedClose = delayedRegistry.closeAll();
void delayedClose.then(() => {
  delayedCloseResolved = true;
});

await Promise.resolve();
assert.equal(delayedCloseResolved, false);
assert.equal(delayedTransport.closeCalls, 1);
finishDelayedClose?.();
await delayedClose;
assert.equal(delayedCloseResolved, true);
assert.equal(delayedRegistry.size, 0);

const activeCloseRegistry = new McpSessionRegistry<FakeTransport>({ maxSessions: 2 });
const activeCloseTransport = createTransport();
activeCloseRegistry.register("active-close", connectionPrincipalId, activeCloseTransport);
const preActiveCloseReservation = activeCloseRegistry.tryReserve(connectionPrincipalId);
assert(preActiveCloseReservation);
assert.deepEqual(await activeCloseRegistry.closeActive(), [{ sessionId: "active-close" }]);
assert.equal(activeCloseTransport.closeCalls, 1);
assert.throws(
  () => activeCloseRegistry.register(
    "reserved-before-active-close",
    connectionPrincipalId,
    createTransport(),
    preActiveCloseReservation,
  ),
  /reservation is no longer valid/,
);
const postActiveCloseReservation = activeCloseRegistry.tryReserve(connectionPrincipalId);
assert(postActiveCloseReservation);
activeCloseRegistry.register(
  "after-active-close",
  connectionPrincipalId,
  createTransport(),
  postActiveCloseReservation,
);
assert.equal(activeCloseRegistry.get("after-active-close", connectionPrincipalId) !== undefined, true);
await activeCloseRegistry.closeAll();

const transportCloseRegistry = new McpSessionRegistry<FakeTransport>();
transportCloseRegistry.register("unexpected-close", connectionPrincipalId, createTransport());
assert.equal(
  transportCloseRegistry.removeOnTransportClose("unexpected-close", connectionPrincipalId),
  "unexpected",
);
assert.equal(
  transportCloseRegistry.removeOnTransportClose("unexpected-close", connectionPrincipalId),
  undefined,
);

let finishIntentionalClose: (() => void) | undefined;
const intentionalCloseTransport: FakeTransport = {
  closeCalls: 0,
  close() {
    this.closeCalls += 1;
    return new Promise<void>((resolve) => {
      finishIntentionalClose = resolve;
    });
  },
};
transportCloseRegistry.register("intentional-close", connectionPrincipalId, intentionalCloseTransport);
const intentionalClose = transportCloseRegistry.closeIdle(0);
await Promise.resolve();
assert.equal(
  transportCloseRegistry.removeOnTransportClose("intentional-close", connectionPrincipalId),
  "intentional",
);
finishIntentionalClose?.();
assert.deepEqual(await intentionalClose, [{ sessionId: "intentional-close" }]);
assert.equal(intentionalCloseTransport.closeCalls, 1);

const limited = new McpSessionRegistry<FakeTransport>({ maxSessions: 1 });
const limitedReservation = limited.tryReserve(connectionPrincipalId);
assert(limitedReservation);
assert.equal(limited.tryReserve(connectionPrincipalId), undefined);
const limitedTransport = createTransport();
limited.register("limited", connectionPrincipalId, limitedTransport, limitedReservation);
assert.equal(limited.get("limited", connectionPrincipalId), limitedTransport);
assert.equal(limited.get("limited", otherPrincipalOwner), undefined);
assert.equal(limited.tryReserve(connectionPrincipalId), undefined);
assert.equal(limited.remove("limited", otherGrantOwner), false);
assert.equal(limited.remove("limited", connectionPrincipalId), true);
const releasedSlotReservation = limited.tryReserve(connectionPrincipalId);
assert(releasedSlotReservation);
limited.releaseReservation(releasedSlotReservation);

const reconnectCapacity = new McpSessionRegistry<FakeTransport>({
  maxSessions: 1,
});
const replacedGrantTransport = createTransport();
reconnectCapacity.register(
  "replaced-grant-session",
  connectionPrincipalId,
  replacedGrantTransport,
);
assert.deepEqual(
  await reconnectCapacity.closeAuthorizationSessions(connectionPrincipalId),
  [{ sessionId: "replaced-grant-session" }],
);
assert.equal(replacedGrantTransport.closeCalls, 1);
const reconnectReservation = reconnectCapacity.tryReserve(nextEpochOwner);
assert(
  reconnectReservation,
  "revoked authorization sessions must release maxSessions=1 capacity for reconnect",
);
reconnectCapacity.register(
  "replacement-grant-session",
  nextEpochOwner,
  createTransport(),
  reconnectReservation,
);
await reconnectCapacity.closeAll();

const sharedGrantIsolation = new McpSessionRegistry<FakeTransport>({ maxSessions: 2 });
const revokedSharedTransport = createTransport();
const retainedSharedTransport = createTransport();
sharedGrantIsolation.register("revoked-shared-grant", connectionPrincipalId, revokedSharedTransport);
sharedGrantIsolation.register("retained-shared-grant", otherGrantOwner, retainedSharedTransport);
assert.deepEqual(
  await sharedGrantIsolation.closeAuthorizationSessions(connectionPrincipalId),
  [{ sessionId: "revoked-shared-grant" }],
);
assert.equal(revokedSharedTransport.closeCalls, 1);
assert.equal(retainedSharedTransport.closeCalls, 0);
assert.equal(
  sharedGrantIsolation.get("retained-shared-grant", otherGrantOwner),
  retainedSharedTransport,
  "revoking one grant must not close another active share grant on the same principal",
);
await sharedGrantIsolation.closeAll();

let finishBoundaryClose: (() => void) | undefined;
const boundaryCloseRace = new McpSessionRegistry<FakeTransport>({ maxSessions: 1 });
const boundaryRaceTransport: FakeTransport = {
  closeCalls: 0,
  close() {
    this.closeCalls += 1;
    return new Promise<void>((resolve) => {
      finishBoundaryClose = resolve;
    });
  },
};
boundaryCloseRace.register("boundary-close-race", connectionPrincipalId, boundaryRaceTransport);
const idleBoundaryClose = boundaryCloseRace.closeIdle(0);
await Promise.resolve();
const authorizationBoundaryClose =
  boundaryCloseRace.closeAuthorizationSessions(connectionPrincipalId);
assert.equal(boundaryRaceTransport.closeCalls, 1, "authorization cleanup must reuse an in-flight close");
assert.equal(
  boundaryCloseRace.tryReserve(nextEpochOwner),
  undefined,
  "authorization cleanup must quarantine capacity until transport close succeeds",
);
finishBoundaryClose?.();
assert.deepEqual(await idleBoundaryClose, [{ sessionId: "boundary-close-race" }]);
assert.deepEqual(await authorizationBoundaryClose, [{ sessionId: "boundary-close-race" }]);
const boundaryReplacement = boundaryCloseRace.tryReserve(nextEpochOwner);
assert(boundaryReplacement, "successful authorization cleanup must release capacity");
boundaryCloseRace.releaseReservation(boundaryReplacement);

let reclaimNow = 0;
const reclaiming = new McpSessionRegistry<FakeTransport>({
  maxSessions: 3,
  now: () => reclaimNow,
});
const otherOldest = createTransport();
const ownerOlder = createTransport();
const ownerNewest = createTransport();
reclaiming.register("other-oldest", otherPrincipalOwner, otherOldest);
reclaimNow = 10;
reclaiming.register("owner-older", connectionPrincipalId, ownerOlder);
reclaimNow = 20;
reclaiming.register("owner-newest", connectionPrincipalId, ownerNewest);
const reclaimedReservation = await reclaiming.reserveWithIdleReclaim(connectionPrincipalId);
assert.deepEqual(reclaimedReservation, {
  reservation: reclaimedReservation.reservation,
  reclaimed: { sessionId: "other-oldest" },
});
assert(reclaimedReservation.reservation);
assert.equal(ownerOlder.closeCalls, 0);
assert.equal(otherOldest.closeCalls, 1);
assert.equal(ownerNewest.closeCalls, 0);
assert.equal(reclaiming.size, 2);
reclaiming.releaseReservation(reclaimedReservation.reservation);

const crossEpochReclaim = new McpSessionRegistry<FakeTransport>({ maxSessions: 1 });
const epochScopedTransport = createTransport();
crossEpochReclaim.register("epoch-scoped", connectionPrincipalId, epochScopedTransport);
const epochReplacement = await crossEpochReclaim.reserveWithIdleReclaim(nextEpochOwner);
assert.equal(epochReplacement.reclaimed?.sessionId, "epoch-scoped");
assert(epochReplacement.reservation);
assert.equal(
  epochScopedTransport.closeCalls,
  1,
  "same-principal reclaim must cross authorization epochs",
);
crossEpochReclaim.releaseReservation(epochReplacement.reservation);

const globalActive = new McpSessionRegistry<FakeTransport>({
  maxSessions: 1,
});
const globalActiveTransport = createTransport();
globalActive.register("global-active", otherPrincipalOwner, globalActiveTransport);
assert.equal(globalActive.acquire("global-active", otherPrincipalOwner), globalActiveTransport);
assert.deepEqual(await globalActive.reserveWithIdleReclaim(connectionPrincipalId), {});
assert.equal(globalActiveTransport.closeCalls, 0);
globalActive.release("global-active", otherPrincipalOwner);
await globalActive.closeAll();

const allActive = new McpSessionRegistry<FakeTransport>({ maxSessions: 1 });
const allActiveTransport = createTransport();
allActive.register("active-at-capacity", connectionPrincipalId, allActiveTransport);
assert.equal(allActive.acquire("active-at-capacity", connectionPrincipalId), allActiveTransport);
assert.deepEqual(await allActive.reserveWithIdleReclaim(connectionPrincipalId), {});
assert.equal(allActiveTransport.closeCalls, 0);

const failedReclaim = new McpSessionRegistry<FakeTransport>({ maxSessions: 1 });
const failedReclaimError = new Error("cannot close for reclaim");
const failedReclaimTransport: FakeTransport = {
  closeCalls: 0,
  async close() {
    this.closeCalls += 1;
    if (this.closeCalls === 1) throw failedReclaimError;
  },
};
failedReclaim.register("failed-reclaim", connectionPrincipalId, failedReclaimTransport);
const failedReservation = await failedReclaim.reserveWithIdleReclaim(connectionPrincipalId);
assert.equal(failedReservation.reservation, undefined);
assert.equal(failedReservation.reclaimed?.sessionId, "failed-reclaim");
assert.equal(failedReservation.reclaimed?.error, failedReclaimError);
assert.equal(failedReclaim.size, 1);
assert.equal(failedReclaim.get("failed-reclaim", connectionPrincipalId), undefined);
assert.equal(failedReclaim.tryReserve(connectionPrincipalId), undefined);
const retriedReclaim = await failedReclaim.reserveWithIdleReclaim(connectionPrincipalId);
assert(retriedReclaim.reservation);
assert.equal(retriedReclaim.reclaimed?.error, undefined);
assert.equal(failedReclaimTransport.closeCalls, 2);
failedReclaim.releaseReservation(retriedReclaim.reservation);

let finishFirstReclaim: (() => void) | undefined;
let finishSecondReclaim: (() => void) | undefined;
const concurrentReclaim = new McpSessionRegistry<FakeTransport>({ maxSessions: 2 });
concurrentReclaim.register("concurrent-first", connectionPrincipalId, {
  closeCalls: 0,
  close() {
    this.closeCalls += 1;
    return new Promise<void>((resolve) => {
      finishFirstReclaim = resolve;
    });
  },
});
concurrentReclaim.register("concurrent-second", connectionPrincipalId, {
  closeCalls: 0,
  close() {
    this.closeCalls += 1;
    return new Promise<void>((resolve) => {
      finishSecondReclaim = resolve;
    });
  },
});
const firstReclaimPromise = concurrentReclaim.reserveWithIdleReclaim(connectionPrincipalId);
const secondReclaimPromise = concurrentReclaim.reserveWithIdleReclaim(connectionPrincipalId);
await Promise.resolve();
finishFirstReclaim?.();
const firstConcurrentReservation = await firstReclaimPromise;
assert(firstConcurrentReservation.reservation);
concurrentReclaim.register(
  "replacement-first",
  connectionPrincipalId,
  createTransport(),
  firstConcurrentReservation.reservation,
);
assert.equal(concurrentReclaim.size, 2);
finishSecondReclaim?.();
const secondConcurrentReservation = await secondReclaimPromise;
assert(secondConcurrentReservation.reservation);
concurrentReclaim.register(
  "replacement-second",
  connectionPrincipalId,
  createTransport(),
  secondConcurrentReservation.reservation,
);
assert.equal(concurrentReclaim.size, 2);

let activeNow = 100;
const activeRegistry = new McpSessionRegistry<FakeTransport>({ now: () => activeNow });
const inFlightTransport = createTransport();
activeRegistry.register("in-flight", connectionPrincipalId, inFlightTransport);
assert.equal(activeRegistry.acquire("in-flight", connectionPrincipalId), inFlightTransport);
activeNow = 1_000;
assert.deepEqual(await activeRegistry.closeIdle(1), []);
assert.equal(inFlightTransport.closeCalls, 0);
activeRegistry.release("in-flight", connectionPrincipalId);
activeNow = 2_000;
assert.deepEqual(await activeRegistry.closeIdle(1), [{ sessionId: "in-flight" }]);

let finishAuthorizationDrainClose: (() => void) | undefined;
const authorizationDrain = new McpSessionRegistry<FakeTransport>({
  maxSessions: 1,
});
const authorizationDrainTransport: FakeTransport = {
  closeCalls: 0,
  close() {
    this.closeCalls += 1;
    return new Promise<void>((resolve) => {
      finishAuthorizationDrainClose = resolve;
    });
  },
};
authorizationDrain.register(
  "authorization-drain",
  connectionPrincipalId,
  authorizationDrainTransport,
);
assert.equal(
  authorizationDrain.acquire("authorization-drain", connectionPrincipalId),
  authorizationDrainTransport,
);
const authorizationDrainClose =
  authorizationDrain.closeAuthorizationSessions(connectionPrincipalId);
await Promise.resolve();
assert.equal(
  authorizationDrainTransport.closeCalls,
  0,
  "exact revocation must not close a transport while an admitted request is active",
);
assert.equal(authorizationDrain.get("authorization-drain", connectionPrincipalId), undefined);
assert.equal(authorizationDrain.tryReserve(nextEpochOwner), undefined);
assert.equal(authorizationDrain.usageSnapshot().sessions, 1);
authorizationDrain.release("authorization-drain", connectionPrincipalId);
await Promise.resolve();
await Promise.resolve();
assert.equal(authorizationDrainTransport.closeCalls, 1);
finishAuthorizationDrainClose?.();
assert.deepEqual(
  await authorizationDrainClose,
  [{ sessionId: "authorization-drain" }],
);
const afterAuthorizationDrain = authorizationDrain.tryReserve(nextEpochOwner);
assert(afterAuthorizationDrain);
authorizationDrain.releaseReservation(afterAuthorizationDrain);

let finishTimedOutDrainClose: (() => void) | undefined;
const timedOutAuthorizationDrain = new McpSessionRegistry<FakeTransport>({
  closeTimeoutMs: 10,
  maxSessions: 1,
});
const timedOutDrainTransport: FakeTransport = {
  closeCalls: 0,
  close() {
    this.closeCalls += 1;
    return new Promise<void>((resolve) => {
      finishTimedOutDrainClose = resolve;
    });
  },
};
timedOutAuthorizationDrain.register(
  "timed-out-authorization-drain",
  connectionPrincipalId,
  timedOutDrainTransport,
);
assert(timedOutAuthorizationDrain.acquire(
  "timed-out-authorization-drain",
  connectionPrincipalId,
));
const timedOutDrainResults =
  await timedOutAuthorizationDrain.closeAuthorizationSessions(connectionPrincipalId);
assert.match(String(timedOutDrainResults[0]?.error), /Timed out closing MCP session/);
assert.equal(timedOutDrainTransport.closeCalls, 0);
assert.equal(timedOutAuthorizationDrain.size, 1);
assert.equal(timedOutAuthorizationDrain.tryReserve(connectionPrincipalId), undefined);
timedOutAuthorizationDrain.release(
  "timed-out-authorization-drain",
  connectionPrincipalId,
);
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(timedOutDrainTransport.closeCalls, 1);
finishTimedOutDrainClose?.();
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(timedOutAuthorizationDrain.size, 0);

let finishConcurrentClose: (() => void) | undefined;
const closeRaceRegistry = new McpSessionRegistry<FakeTransport>({ now: () => 1_000 });
let closeRaceDisposition: "intentional" | "unexpected" | undefined;
const closeRaceTransport: FakeTransport = {
  closeCalls: 0,
  close() {
    this.closeCalls += 1;
    closeRaceDisposition = closeRaceRegistry.removeOnTransportClose(
      "close-race",
      connectionPrincipalId,
    );
    return new Promise<void>((resolve) => {
      finishConcurrentClose = resolve;
    });
  },
};
closeRaceRegistry.register("close-race", connectionPrincipalId, closeRaceTransport);
const idleClose = closeRaceRegistry.closeIdle(0);
await Promise.resolve();
assert.equal(closeRaceDisposition, "intentional");
const shutdownClose = closeRaceRegistry.closeAll();
let shutdownCloseResolved = false;
void shutdownClose.then(() => {
  shutdownCloseResolved = true;
});
await Promise.resolve();
assert.equal(closeRaceTransport.closeCalls, 1);
assert.equal(shutdownCloseResolved, false);
finishConcurrentClose?.();
assert.deepEqual(await idleClose, [{ sessionId: "close-race" }]);
assert.deepEqual(
  await shutdownClose,
  [{ sessionId: "close-race" }],
  "shutdown must retain an intentional close attempt until its promise settles",
);
assert.equal(closeRaceRegistry.size, 0);

const hungRegistry = new McpSessionRegistry<FakeTransport>({ closeTimeoutMs: 10 });
hungRegistry.register("hung", connectionPrincipalId, {
  closeCalls: 0,
  async close() {
    this.closeCalls += 1;
    await new Promise<void>(() => undefined);
  },
});
const hungResults = await hungRegistry.closeAll();
assert.equal(hungResults.length, 1);
assert.match(String(hungResults[0]?.error), /Timed out closing MCP session/);
assert.equal(hungRegistry.size, 1);
assert.equal(hungRegistry.get("hung", connectionPrincipalId), undefined);

const authorizationRejectError = new Error("authorization close rejected");
const authorizationRejectTransport: FakeTransport = {
  closeCalls: 0,
  async close() {
    this.closeCalls += 1;
    if (this.closeCalls === 1) throw authorizationRejectError;
  },
};
const authorizationRejectRegistry = new McpSessionRegistry<FakeTransport>({
  maxSessions: 1,
});
authorizationRejectRegistry.register(
  "authorization-reject",
  connectionPrincipalId,
  authorizationRejectTransport,
);
const authorizationRejectResults =
  await authorizationRejectRegistry.closeAuthorizationSessions(connectionPrincipalId);
assert.equal(authorizationRejectResults[0]?.error, authorizationRejectError);
assert.equal(authorizationRejectRegistry.size, 1);
assert.equal(authorizationRejectRegistry.usageSnapshot().sessions, 1);
assert.equal(authorizationRejectRegistry.tryReserve(nextEpochOwner), undefined);
assert.deepEqual(
  await authorizationRejectRegistry.closeAll(),
  [{ sessionId: "authorization-reject" }],
  "shutdown must retry a rejected exact-authorization close",
);
assert.equal(authorizationRejectTransport.closeCalls, 2);
assert.equal(authorizationRejectRegistry.size, 0);

const authorizationHungTransport: FakeTransport = {
  closeCalls: 0,
  async close() {
    this.closeCalls += 1;
    await new Promise<void>(() => undefined);
  },
};
const authorizationHungRegistry = new McpSessionRegistry<FakeTransport>({
  closeTimeoutMs: 10,
  maxSessions: 1,
});
authorizationHungRegistry.register(
  "authorization-hung",
  connectionPrincipalId,
  authorizationHungTransport,
);
const authorizationHungResults =
  await authorizationHungRegistry.closeAuthorizationSessions(connectionPrincipalId);
assert.match(String(authorizationHungResults[0]?.error), /Timed out closing MCP session/);
assert.equal(authorizationHungRegistry.size, 1);
assert.equal(authorizationHungRegistry.usageSnapshot().sessions, 1);
const authorizationHungShutdownResults = await authorizationHungRegistry.closeAll();
assert.equal(authorizationHungShutdownResults.length, 1);
assert.equal(authorizationHungShutdownResults[0]?.sessionId, "authorization-hung");
assert.match(
  String(authorizationHungShutdownResults[0]?.error),
  /Timed out closing MCP session/,
);
assert.equal(
  authorizationHungTransport.closeCalls,
  1,
  "shutdown must reuse the observable pending close instead of double-closing",
);

let finishHungIdle: (() => void) | undefined;
const hungIdleRegistry = new McpSessionRegistry<FakeTransport>({
  closeTimeoutMs: 10,
  maxSessions: 1,
});
hungIdleRegistry.register("hung-idle", connectionPrincipalId, {
  closeCalls: 0,
  close() {
    this.closeCalls += 1;
    return new Promise<void>((resolve) => {
      finishHungIdle = resolve;
    });
  },
});
const hungIdleResults = await hungIdleRegistry.closeIdle(0);
assert.match(String(hungIdleResults[0]?.error), /Timed out closing MCP session/);
assert.equal(hungIdleRegistry.size, 1);
assert.equal(hungIdleRegistry.tryReserve(connectionPrincipalId), undefined);
finishHungIdle?.();
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(hungIdleRegistry.size, 0);
const afterHungIdle = hungIdleRegistry.tryReserve(connectionPrincipalId);
assert(afterHungIdle);
hungIdleRegistry.releaseReservation(afterHungIdle);

const detachedHungRegistry = new McpSessionRegistry<FakeTransport>({
  closeTimeoutMs: 10,
  maxSessions: 1,
});
let detachedHungDisposition: "intentional" | "unexpected" | undefined;
detachedHungRegistry.register("detached-hung", connectionPrincipalId, {
  closeCalls: 0,
  close() {
    this.closeCalls += 1;
    detachedHungDisposition = detachedHungRegistry.removeOnTransportClose(
      "detached-hung",
      connectionPrincipalId,
    );
    return new Promise<void>(() => undefined);
  },
});
const detachedHungResults = await detachedHungRegistry.closeIdle(0);
assert.equal(detachedHungDisposition, "intentional");
assert.match(String(detachedHungResults[0]?.error), /Timed out closing MCP session/);
assert.equal(
  detachedHungRegistry.size,
  1,
  "a close event must not hide a close promise that never settles",
);
assert.equal(detachedHungRegistry.tryReserve(connectionPrincipalId), undefined);

const reservationOwnership = new McpSessionRegistry<FakeTransport>({ maxSessions: 2 });
const firstAuthorizationReservation = reservationOwnership.tryReserve(connectionPrincipalId);
assert(firstAuthorizationReservation);
assert.throws(
  () => reservationOwnership.register(
    "wrong-owner",
    otherGrantOwner,
    createTransport(),
    firstAuthorizationReservation,
  ),
  /different authorization/,
);
reservationOwnership.register(
  "owner-session",
  connectionPrincipalId,
  createTransport(),
  firstAuthorizationReservation,
);
assert.deepEqual(reservationOwnership.usageSnapshot(), {
  sessions: 1,
  reservations: 0,
  statelessRequests: 0,
  statelessLeases: { agesMs: [] },
  limit: 2,
});
assert.equal(reservationOwnership.get("owner-session", otherGrantOwner), undefined);
await reservationOwnership.closeAll();

let statelessNow = 1_000;
const statelessLimited = new McpSessionRegistry<FakeTransport>({
  now: () => statelessNow,
  maxSessions: 2,
});
const firstStatelessRequest =
  statelessLimited.tryAcquireStatelessRequest(connectionPrincipalId);
assert(firstStatelessRequest);
const globalReservation = statelessLimited.tryReserve(connectionPrincipalId);
assert(globalReservation);
const temporaryReservation = statelessLimited.tryReserve(connectionPrincipalId);
assert.equal(
  temporaryReservation,
  undefined,
  "stateless requests and reservations share the single global capacity",
);
statelessNow = 1_250;
const secondStatelessRequest =
  statelessLimited.tryAcquireStatelessRequest(otherGrantOwner);
assert.equal(
  secondStatelessRequest,
  undefined,
  "the outstanding reservation consumes the remaining global slot",
);
statelessLimited.releaseReservation(globalReservation);
const clientBRequest = statelessLimited.tryAcquireStatelessRequest(otherGrantOwner);
assert(clientBRequest);
assert.equal(statelessLimited.tryReserve(otherGrantOwner), undefined);
statelessNow = 2_000;
assert.deepEqual(statelessLimited.usageSnapshot(), {
  sessions: 0,
  reservations: 0,
  statelessRequests: 2,
  statelessLeases: { agesMs: [1_000, 750] },
  limit: 2,
});
assert.equal(statelessLimited.releaseStatelessRequest(firstStatelessRequest), true);
assert.equal(statelessLimited.releaseStatelessRequest(firstStatelessRequest), false);
const clientAReservationAfterRelease = statelessLimited.tryReserve(connectionPrincipalId);
assert(clientAReservationAfterRelease);
statelessLimited.releaseReservation(clientAReservationAfterRelease);
assert.equal(statelessLimited.releaseStatelessRequest(clientBRequest), true);
assert.deepEqual(statelessLimited.usageSnapshot().statelessLeases, { agesMs: [] });

const exactStatelessDrain = new McpSessionRegistry<FakeTransport>({
  maxSessions: 2,
});
const revokedStatelessLease = exactStatelessDrain.tryAcquireStatelessRequest(
  connectionPrincipalId,
);
const retainedStatelessLease = exactStatelessDrain.tryAcquireStatelessRequest(
  otherGrantOwner,
);
assert(revokedStatelessLease);
assert(retainedStatelessLease);
let exactStatelessCloseSettled = false;
const exactStatelessClose =
  exactStatelessDrain.closeAuthorizationSessions(connectionPrincipalId).then((results) => {
    exactStatelessCloseSettled = true;
    return results;
  });
await Promise.resolve();
assert.equal(exactStatelessCloseSettled, false);
assert.equal(
  exactStatelessDrain.tryAcquireStatelessRequest(
    connectionPrincipalId,
  ),
  undefined,
  "exact revocation must quarantine new stateless leases for the revoked tuple",
);
assert.equal(exactStatelessDrain.tryReserve(connectionPrincipalId), undefined);
assert.equal(exactStatelessDrain.usageSnapshot().statelessRequests, 2);
assert.equal(exactStatelessDrain.releaseStatelessRequest(revokedStatelessLease), true);
assert.deepEqual(await exactStatelessClose, []);
assert.equal(
  exactStatelessDrain.usageSnapshot().statelessRequests,
  1,
  "another grant on the same principal must remain independently tracked",
);
assert.equal(exactStatelessDrain.releaseStatelessRequest(retainedStatelessLease), true);
const nextEpochAfterStatelessDrain = exactStatelessDrain.tryReserve(nextEpochOwner);
assert(nextEpochAfterStatelessDrain);
exactStatelessDrain.releaseReservation(nextEpochAfterStatelessDrain);

const detachedHungShutdown = await detachedHungRegistry.closeAll();
assert.equal(detachedHungShutdown.length, 1);
assert.match(String(detachedHungShutdown[0]?.error), /Timed out closing MCP session/);
assert.equal(detachedHungRegistry.size, 1);
