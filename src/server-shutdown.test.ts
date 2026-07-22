import assert from "node:assert/strict";
import { shutdownHttpServer } from "./server-shutdown.js";

let finishHttpClose: (() => void) | undefined;
let applicationCloseStarted = false;

const drainingHttpServer = {
  close(callback: (error?: Error) => void) {
    finishHttpClose = () => callback();
  },
};

const drainingShutdown = shutdownHttpServer(drainingHttpServer, async () => {
  applicationCloseStarted = true;
});

await Promise.resolve();
assert.equal(
  applicationCloseStarted,
  false,
  "application cleanup must wait until in-flight HTTP requests drain",
);
finishHttpClose?.();
await drainingShutdown;
assert.equal(applicationCloseStarted, true);

let finishApplicationClose: (() => void) | undefined;
let shutdownResolved = false;

const immediatelyClosedHttpServer = {
  close(callback: (error?: Error) => void) {
    callback();
  },
};

const delayedApplicationClose = () =>
  new Promise<void>((resolve) => {
    finishApplicationClose = resolve;
  });

const delayedShutdown = shutdownHttpServer(
  immediatelyClosedHttpServer,
  delayedApplicationClose,
);
void delayedShutdown.then(() => {
  shutdownResolved = true;
});

await Promise.resolve();
for (let attempt = 0; attempt < 5 && !finishApplicationClose; attempt += 1) {
  await Promise.resolve();
}
assert.equal(
  shutdownResolved,
  false,
  "shutdown must wait for asynchronous application cleanup",
);
assert.ok(finishApplicationClose);
finishApplicationClose?.();
await delayedShutdown;
assert.equal(shutdownResolved, true);

let finishDelayedHttpClose: (() => void) | undefined;
let httpDrainResolved = false;
const delayedHttpDrain = shutdownHttpServer(
  {
    close(callback: (error?: Error) => void) {
      finishDelayedHttpClose = () => callback();
    },
  },
  async () => {},
);
void delayedHttpDrain.then(() => {
  httpDrainResolved = true;
});

await Promise.resolve();
assert.equal(
  httpDrainResolved,
  false,
  "shutdown must wait for active HTTP responses to drain",
);
finishDelayedHttpClose?.();
await delayedHttpDrain;
assert.equal(httpDrainResolved, true);

const httpCloseError = new Error("http close failed");
let applicationClosedAfterHttpError = false;
await assert.rejects(
  shutdownHttpServer(
    {
      close(callback: (error?: Error) => void) {
        callback(httpCloseError);
      },
    },
    async () => {
      applicationClosedAfterHttpError = true;
    },
  ),
  httpCloseError,
);
assert.equal(applicationClosedAfterHttpError, true);

const applicationCloseError = new Error("application close failed");
await assert.rejects(
  shutdownHttpServer(
    {
      close(callback: (error?: Error) => void) {
        callback(httpCloseError);
      },
    },
    async () => {
      throw applicationCloseError;
    },
  ),
  (error: unknown) =>
    error instanceof AggregateError &&
    error.errors.includes(httpCloseError) &&
    error.errors.includes(applicationCloseError),
);

let forcedCloseCalls = 0;
let pendingCloseCallback: ((error?: Error) => void) | undefined;
await shutdownHttpServer(
  {
    close(callback: (error?: Error) => void) {
      pendingCloseCallback = callback;
    },
    closeAllConnections() {
      forcedCloseCalls += 1;
      pendingCloseCallback?.();
    },
  },
  async () => {},
  10,
);
assert.equal(forcedCloseCalls, 1);
