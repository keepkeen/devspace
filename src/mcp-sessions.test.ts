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
const connectionPrincipalId = "client-a";
const registry = new McpSessionRegistry<FakeTransport>({ now: () => now });
const staleTransport = createTransport();
const activeTransport = createTransport();

registry.register("stale", connectionPrincipalId, staleTransport);
now = 1_000;
registry.register("active", connectionPrincipalId, activeTransport);
now = 1_500;
assert.equal(registry.get("active", connectionPrincipalId), activeTransport);
assert.equal(registry.get("active", "client-b"), undefined);
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
registry.remove("first");

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
  transportCloseRegistry.removeOnTransportClose("unexpected-close"),
  "unexpected",
);
assert.equal(transportCloseRegistry.removeOnTransportClose("unexpected-close"), undefined);

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
  transportCloseRegistry.removeOnTransportClose("intentional-close"),
  "intentional",
);
finishIntentionalClose?.();
assert.deepEqual(await intentionalClose, [{ sessionId: "intentional-close" }]);
assert.equal(intentionalCloseTransport.closeCalls, 1);

const limited = new McpSessionRegistry<FakeTransport>({ maxSessions: 1 });
const limitedReservation = limited.tryReserve();
assert(limitedReservation);
assert.equal(limited.tryReserve(), undefined);
const limitedTransport = createTransport();
limited.register("limited", connectionPrincipalId, limitedTransport, limitedReservation);
assert.equal(limited.get("limited", connectionPrincipalId), limitedTransport);
assert.equal(limited.get("limited", "client-b"), undefined);
assert.equal(limited.tryReserve(), undefined);
assert.equal(limited.remove("limited"), true);
const releasedSlotReservation = limited.tryReserve();
assert(releasedSlotReservation);
limited.releaseReservation(releasedSlotReservation);

let reclaimNow = 0;
const reclaiming = new McpSessionRegistry<FakeTransport>({
  maxSessions: 3,
  now: () => reclaimNow,
});
const otherOldest = createTransport();
const ownerOlder = createTransport();
const ownerNewest = createTransport();
reclaiming.register("other-oldest", "client-b", otherOldest);
reclaimNow = 10;
reclaiming.register("owner-older", connectionPrincipalId, ownerOlder);
reclaimNow = 20;
reclaiming.register("owner-newest", connectionPrincipalId, ownerNewest);
const reclaimedReservation = await reclaiming.reserveWithIdleReclaim(connectionPrincipalId);
assert.deepEqual(reclaimedReservation, {
  reservation: reclaimedReservation.reservation,
  reclaimed: { sessionId: "owner-older" },
});
assert(reclaimedReservation.reservation);
assert.equal(ownerOlder.closeCalls, 1);
assert.equal(otherOldest.closeCalls, 0);
assert.equal(ownerNewest.closeCalls, 0);
assert.equal(reclaiming.size, 2);
reclaiming.releaseReservation(reclaimedReservation.reservation);

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
assert.equal(failedReclaim.tryReserve(), undefined);
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

let finishConcurrentClose: (() => void) | undefined;
const closeRaceRegistry = new McpSessionRegistry<FakeTransport>({ now: () => 1_000 });
let closeRaceDisposition: "intentional" | "unexpected" | undefined;
const closeRaceTransport: FakeTransport = {
  closeCalls: 0,
  close() {
    this.closeCalls += 1;
    closeRaceDisposition = closeRaceRegistry.removeOnTransportClose("close-race");
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
assert.deepEqual(await shutdownClose, []);
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
assert.equal(hungIdleRegistry.tryReserve(), undefined);
finishHungIdle?.();
await Promise.resolve();
await Promise.resolve();
assert.equal(hungIdleRegistry.size, 0);
const afterHungIdle = hungIdleRegistry.tryReserve();
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
    detachedHungDisposition = detachedHungRegistry.removeOnTransportClose("detached-hung");
    return new Promise<void>(() => undefined);
  },
});
const detachedHungResults = await detachedHungRegistry.closeIdle(0);
assert.equal(detachedHungDisposition, "intentional");
assert.match(String(detachedHungResults[0]?.error), /Timed out closing MCP session/);
assert.equal(detachedHungRegistry.size, 0);
const afterDetachedHung = detachedHungRegistry.tryReserve();
assert(afterDetachedHung);
detachedHungRegistry.releaseReservation(afterDetachedHung);

const perClient = new McpSessionRegistry<FakeTransport>({
  maxSessions: 3,
  maxSessionsPerClient: 1,
});
const clientAReservation = perClient.tryReserve("client-a");
assert(clientAReservation);
assert.equal(perClient.tryReserve("client-a"), undefined);
const clientBReservation = perClient.tryReserve("client-b");
assert(clientBReservation);
assert.throws(
  () => perClient.register("wrong-owner", "client-b", createTransport(), clientAReservation),
  /different OAuth client/,
);
perClient.register("client-a-session", "client-a", createTransport(), clientAReservation);
perClient.register("client-b-session", "client-b", createTransport(), clientBReservation);
assert.deepEqual(perClient.usageSnapshot("client-a"), {
  sessions: 2,
  reservations: 0,
  statelessRequests: 0,
  limit: 3,
  owner: { sessions: 1, reservations: 0, statelessRequests: 0, limit: 1 },
});
const clientAReplacement = await perClient.reserveWithIdleReclaim("client-a");
assert.equal(clientAReplacement.reclaimed?.sessionId, "client-a-session");
assert(clientAReplacement.reservation);
perClient.register(
  "client-a-replacement",
  "client-a",
  createTransport(),
  clientAReplacement.reservation,
);
assert.equal(perClient.get("client-b-session", "client-b") !== undefined, true);
assert.equal(perClient.usageSnapshot("client-a").owner?.sessions, 1);
await perClient.closeAll();

const perClientActive = new McpSessionRegistry<FakeTransport>({
  maxSessions: 3,
  maxSessionsPerClient: 1,
});
perClientActive.register("active-client-a", "client-a", createTransport());
assert(perClientActive.acquire("active-client-a", "client-a"));
assert.deepEqual(await perClientActive.reserveWithIdleReclaim("client-a"), {});
await perClientActive.closeAll();

const statelessLimited = new McpSessionRegistry<FakeTransport>({
  maxSessions: 2,
  maxSessionsPerClient: 1,
});
const clientARequest = statelessLimited.tryAcquireStatelessRequest("client-a");
assert(clientARequest);
assert.equal(statelessLimited.tryAcquireStatelessRequest("client-a"), undefined);
const clientBRequest = statelessLimited.tryAcquireStatelessRequest("client-b");
assert(clientBRequest);
assert.equal(statelessLimited.tryReserve("client-c"), undefined);
assert.deepEqual(statelessLimited.usageSnapshot("client-a"), {
  sessions: 0,
  reservations: 0,
  statelessRequests: 2,
  limit: 2,
  owner: { sessions: 0, reservations: 0, statelessRequests: 1, limit: 1 },
});
statelessLimited.releaseStatelessRequest(clientARequest);
const clientAReservationAfterRelease = statelessLimited.tryReserve("client-a");
assert(clientAReservationAfterRelease);
statelessLimited.releaseReservation(clientAReservationAfterRelease);
statelessLimited.releaseStatelessRequest(clientBRequest);
assert.equal(statelessLimited.usageSnapshot().statelessRequests, 0);
assert.deepEqual(await detachedHungRegistry.closeAll(), []);
assert.equal(detachedHungRegistry.size, 0);
