import assert from "node:assert/strict";
import {
  localAgentWorkerSpawnOptions,
  shouldUnrefLocalAgentWorker,
} from "./local-agent-worker.js";

const options = localAgentWorkerSpawnOptions({ PATH: "/usr/bin" });
assert.equal(options.detached, false);
assert.equal(options.stdio, "ignore");
assert.equal(options.windowsHide, true);
assert.deepEqual(options.env, { PATH: "/usr/bin" });
assert.equal(shouldUnrefLocalAgentWorker("darwin"), true);
assert.equal(shouldUnrefLocalAgentWorker("linux"), true);
assert.equal(shouldUnrefLocalAgentWorker("win32"), false);
