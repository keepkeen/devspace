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
const ownerClientId = "client-a";
const registry = new McpSessionRegistry<FakeTransport>({ now: () => now });
const staleTransport = createTransport();
const activeTransport = createTransport();

registry.register("stale", ownerClientId, staleTransport);
now = 1_000;
registry.register("active", ownerClientId, activeTransport);
now = 1_500;
assert.equal(registry.get("active", ownerClientId), activeTransport);
assert.equal(registry.get("active", "client-b"), undefined);
now = 2_000;

const idleResults = await registry.closeIdle(1_500);
assert.deepEqual(idleResults, [{ sessionId: "stale" }]);
assert.equal(staleTransport.closeCalls, 1);
assert.equal(activeTransport.closeCalls, 0);
assert.equal(registry.size, 1);
assert.equal(registry.get("stale", ownerClientId), undefined);
assert.equal(registry.get("active", ownerClientId), activeTransport);

const closeError = new Error("close failed");
const failingTransport: FakeTransport = {
  closeCalls: 0,
  async close() {
    this.closeCalls += 1;
    if (this.closeCalls === 1) throw closeError;
  },
};
registry.register("failing", ownerClientId, failingTransport);
now = 10_000;

const failingResults = await registry.closeIdle(1);
assert.equal(failingResults.length, 2);
assert.deepEqual(failingResults.map((result) => result.sessionId).sort(), ["active", "failing"]);
assert.equal(failingResults.find((result) => result.sessionId === "failing")?.error, closeError);
assert.equal(failingTransport.closeCalls, 1);
assert.equal(registry.size, 1);
assert.equal(registry.get("failing", ownerClientId), undefined);
assert.deepEqual(await registry.closeIdle(1), [{ sessionId: "failing" }]);
assert.equal(failingTransport.closeCalls, 2);
assert.equal(registry.size, 0);

const first = createTransport();
const second = createTransport();
registry.register("first", ownerClientId, first);
registry.register("second", ownerClientId, second);
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
delayedRegistry.register("delayed", ownerClientId, delayedTransport);
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

const transportCloseRegistry = new McpSessionRegistry<FakeTransport>();
transportCloseRegistry.register("unexpected-close", ownerClientId, createTransport());
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
transportCloseRegistry.register("intentional-close", ownerClientId, intentionalCloseTransport);
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
limited.register("limited", ownerClientId, limitedTransport, limitedReservation);
assert.equal(limited.get("limited", ownerClientId), limitedTransport);
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
reclaiming.register("owner-older", ownerClientId, ownerOlder);
reclaimNow = 20;
reclaiming.register("owner-newest", ownerClientId, ownerNewest);
const reclaimedReservation = await reclaiming.reserveWithIdleReclaim(ownerClientId);
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
allActive.register("active-at-capacity", ownerClientId, allActiveTransport);
assert.equal(allActive.acquire("active-at-capacity", ownerClientId), allActiveTransport);
assert.deepEqual(await allActive.reserveWithIdleReclaim(ownerClientId), {});
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
failedReclaim.register("failed-reclaim", ownerClientId, failedReclaimTransport);
const failedReservation = await failedReclaim.reserveWithIdleReclaim(ownerClientId);
assert.equal(failedReservation.reservation, undefined);
assert.equal(failedReservation.reclaimed?.sessionId, "failed-reclaim");
assert.equal(failedReservation.reclaimed?.error, failedReclaimError);
assert.equal(failedReclaim.size, 1);
assert.equal(failedReclaim.get("failed-reclaim", ownerClientId), undefined);
assert.equal(failedReclaim.tryReserve(), undefined);
const retriedReclaim = await failedReclaim.reserveWithIdleReclaim(ownerClientId);
assert(retriedReclaim.reservation);
assert.equal(retriedReclaim.reclaimed?.error, undefined);
assert.equal(failedReclaimTransport.closeCalls, 2);
failedReclaim.releaseReservation(retriedReclaim.reservation);

let finishFirstReclaim: (() => void) | undefined;
let finishSecondReclaim: (() => void) | undefined;
const concurrentReclaim = new McpSessionRegistry<FakeTransport>({ maxSessions: 2 });
concurrentReclaim.register("concurrent-first", ownerClientId, {
  closeCalls: 0,
  close() {
    this.closeCalls += 1;
    return new Promise<void>((resolve) => {
      finishFirstReclaim = resolve;
    });
  },
});
concurrentReclaim.register("concurrent-second", ownerClientId, {
  closeCalls: 0,
  close() {
    this.closeCalls += 1;
    return new Promise<void>((resolve) => {
      finishSecondReclaim = resolve;
    });
  },
});
const firstReclaimPromise = concurrentReclaim.reserveWithIdleReclaim(ownerClientId);
const secondReclaimPromise = concurrentReclaim.reserveWithIdleReclaim(ownerClientId);
await Promise.resolve();
finishFirstReclaim?.();
const firstConcurrentReservation = await firstReclaimPromise;
assert(firstConcurrentReservation.reservation);
concurrentReclaim.register(
  "replacement-first",
  ownerClientId,
  createTransport(),
  firstConcurrentReservation.reservation,
);
assert.equal(concurrentReclaim.size, 2);
finishSecondReclaim?.();
const secondConcurrentReservation = await secondReclaimPromise;
assert(secondConcurrentReservation.reservation);
concurrentReclaim.register(
  "replacement-second",
  ownerClientId,
  createTransport(),
  secondConcurrentReservation.reservation,
);
assert.equal(concurrentReclaim.size, 2);

let activeNow = 100;
const activeRegistry = new McpSessionRegistry<FakeTransport>({ now: () => activeNow });
const inFlightTransport = createTransport();
activeRegistry.register("in-flight", ownerClientId, inFlightTransport);
assert.equal(activeRegistry.acquire("in-flight", ownerClientId), inFlightTransport);
activeNow = 1_000;
assert.deepEqual(await activeRegistry.closeIdle(1), []);
assert.equal(inFlightTransport.closeCalls, 0);
activeRegistry.release("in-flight", ownerClientId);
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
closeRaceRegistry.register("close-race", ownerClientId, closeRaceTransport);
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
hungRegistry.register("hung", ownerClientId, {
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
assert.equal(hungRegistry.get("hung", ownerClientId), undefined);

let finishHungIdle: (() => void) | undefined;
const hungIdleRegistry = new McpSessionRegistry<FakeTransport>({
  closeTimeoutMs: 10,
  maxSessions: 1,
});
hungIdleRegistry.register("hung-idle", ownerClientId, {
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
detachedHungRegistry.register("detached-hung", ownerClientId, {
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
assert.equal(detachedHungRegistry.size, 1);
assert.equal(detachedHungRegistry.tryReserve(), undefined);
assert.deepEqual(await detachedHungRegistry.closeAll(), []);
assert.equal(detachedHungRegistry.size, 1);
