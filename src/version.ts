import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as {
  version?: unknown;
  engines?: { node?: unknown };
};

if (typeof packageJson.version !== "string" || packageJson.version.trim().length === 0) {
  throw new Error("Unable to read DevSpace package version.");
}

export const DEVSPACE_VERSION = packageJson.version;

if (typeof packageJson.engines?.node !== "string" || packageJson.engines.node.trim().length === 0) {
  throw new Error("Unable to read the supported Node range from package.json.");
}

/** One source of truth for installation metadata and runtime validation. */
export const SUPPORTED_NODE_RANGE = packageJson.engines.node;

export const DEVSPACE_SERVER_INFO = {
  name: "devspace",
  title: "DevSpace",
  version: DEVSPACE_VERSION,
  description:
    "Local Project coding tools, AGENTS.md instructions, and Skills for ChatGPT.",
} as const;
