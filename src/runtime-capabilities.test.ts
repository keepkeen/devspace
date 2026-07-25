import assert from "node:assert/strict";
import test from "node:test";
import { runtimeCapabilities, supportedNetworkModes } from "./runtime-capabilities.js";

test("runtime capabilities fail closed for isolation claims", () => {
  const capabilities = runtimeCapabilities();
  assert.deepEqual(capabilities, {
    networkIsolation: false,
    filesystemIsolation: "guardrail_only",
    processSandbox: false,
    mcpHttpTransport: "stateless",
  });
  assert.deepEqual(supportedNetworkModes(capabilities), ["inherit"]);
  assert.deepEqual(supportedNetworkModes({ networkIsolation: true }), ["inherit", "deny"]);
});
