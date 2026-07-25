import assert from "node:assert/strict";
import test from "node:test";
import {
  processIdentityAlive,
  readProcessIdentity,
  type ProcessIdentityRuntime,
} from "./process-identity.js";

function runtime(start = "start-a", boot = "boot-a"): ProcessIdentityRuntime {
  return {
    platform: "linux",
    currentPid: 10,
    processAlive: (pid) => pid === 10,
    processGroupAlive: (group) => group === 10,
    processStartIdentity: (pid) => pid === 10 ? start : undefined,
    processGroupId: (pid) => pid === 10 ? 10 : undefined,
    bootIdentity: () => boot,
  };
}

test("process identity detects PID reuse and reboot", () => {
  const identity = readProcessIdentity(10, runtime());
  assert.equal(processIdentityAlive(identity, runtime()), true);
  assert.equal(processIdentityAlive(identity, runtime("start-b")), false);
  assert.equal(processIdentityAlive(identity, runtime("start-a", "boot-b")), false);
});

test("process identity falls back conservatively when start metadata is unavailable", () => {
  const identity = { pid: 10, startIdentity: "known", bootIdentity: "boot-a" };
  const unavailable = runtime();
  unavailable.processStartIdentity = () => undefined;
  assert.equal(processIdentityAlive(identity, unavailable), true);
  unavailable.processAlive = () => false;
  assert.equal(processIdentityAlive(identity, unavailable), false);
});
