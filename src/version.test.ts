import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import {
  DEVSPACE_SERVER_INFO,
  DEVSPACE_VERSION,
  SUPPORTED_NODE_RANGE,
} from "./version.js";

const require = createRequire(import.meta.url);

test("DEVSPACE_VERSION matches the package version", () => {
  const packageJson = require("../package.json") as {
    version: string;
    engines: { node: string };
  };
  assert.equal(DEVSPACE_VERSION, packageJson.version);
  assert.equal(DEVSPACE_SERVER_INFO.version, packageJson.version);
  assert.equal(SUPPORTED_NODE_RANGE, packageJson.engines.node);
});
