import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: unknown };

if (typeof packageJson.version !== "string" || packageJson.version.trim().length === 0) {
  throw new Error("Unable to read DevSpace package version.");
}

export const DEVSPACE_VERSION = packageJson.version;

export const DEVSPACE_SERVER_INFO = {
  name: "devspace",
  title: "DevSpace",
  version: DEVSPACE_VERSION,
  description:
    "Secure local coding workspace for MCP clients. Provides workspace-scoped file, search, edit, write, and shell tools.",
} as const;
