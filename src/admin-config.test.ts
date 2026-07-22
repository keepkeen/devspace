import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdminConfigValidationError,
  adminConfigOverridePaths,
  adminConfigWarnings,
  loadAdminConfig,
  saveAdminConfig,
  validateAdminConfig,
} from "./admin-config.js";

const testDir = mkdtempSync(join(tmpdir(), "devspace-admin-config-test-"));
const configDir = join(testDir, "config");
const rootA = join(testDir, "root-a");
const rootB = join(testDir, "root-b");
mkdirSync(configDir);
mkdirSync(rootA);
mkdirSync(rootB);
symlinkSync(rootA, join(testDir, "root-a-link"));
writeFileSync(join(configDir, "auth.json"), JSON.stringify({
  ownerToken: "test-owner-token-that-is-long-enough",
}));
writeFileSync(join(configDir, "config.json"), JSON.stringify({
  allowedRoots: [rootA],
  toolMode: "minimal",
  widgets: "changes",
  publicBaseUrl: "https://example.test",
  futureSetting: { preserve: true },
  resources: { maxMcpSessions: 12, cleanupIntervalMs: 1234 },
}));
chmodSync(join(configDir, "config.json"), 0o644);

const env = { DEVSPACE_CONFIG_DIR: configDir };
const initial = loadAdminConfig(env);
assert.equal(initial.toolMode, "minimal");
assert.equal(initial.widgets, "changes");
assert.equal(initial.resources.maxMcpSessions, 12);

const next = validateAdminConfig({
  ...initial,
  allowedRoots: [rootB, join(testDir, "root-a-link"), rootA],
  toolMode: "codex",
  widgets: "full",
  resources: {
    ...initial.resources,
    maxMcpSessions: 20,
    maxProcessSessions: 10,
    maxProcessSessionsPerWorkspace: 5,
  },
});
assert.deepEqual(next.allowedRoots, [realpathSync(rootB), realpathSync(rootA)]);

const saved = saveAdminConfig(next, env);
assert.equal(saved.restartRequired, true);
assert.deepEqual(saved.config.allowedRoots, [realpathSync(rootB), realpathSync(rootA)]);
assert.equal(lstatSync(join(configDir, "config.json")).mode & 0o777, 0o600);
const persisted = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
assert.deepEqual(persisted.futureSetting, { preserve: true });
assert.equal(persisted.publicBaseUrl, "https://example.test");
assert.equal(persisted.resources.cleanupIntervalMs, 1234);
assert.equal(persisted.resources.maxMcpSessions, 20);
assert.equal(saveAdminConfig(next, env).restartRequired, false);

assert.equal(
  loadAdminConfig({ ...env, DEVSPACE_TOOL_MODE: "full", DEVSPACE_WIDGETS: "off" }).toolMode,
  "full",
);
assert.equal(
  loadAdminConfig({ ...env, DEVSPACE_TOOL_MODE: "full", DEVSPACE_WIDGETS: "off" }).widgets,
  "off",
);
assert.equal(
  loadAdminConfig({ ...env, DEVSPACE_MAX_MCP_SESSIONS: "7" }).resources.maxMcpSessions,
  7,
);
assert.deepEqual(
  adminConfigOverridePaths({
    ...env,
    DEVSPACE_TOOL_MODE: "full",
    DEVSPACE_WIDGETS: "off",
    DEVSPACE_MAX_MCP_SESSIONS: "7",
  }),
  ["toolMode", "widgets", "resources.maxMcpSessions"],
);

const overriddenEnv = { ...env, DEVSPACE_TOOL_MODE: "full" };
const overridden = loadAdminConfig(overriddenEnv);
assert.throws(
  () => saveAdminConfig({ ...overridden, toolMode: "minimal" }, overriddenEnv),
  (error) => error instanceof AdminConfigValidationError && "toolMode" in error.fields,
);
const savedWithOverride = saveAdminConfig({
  ...overridden,
  widgets: "off",
}, overriddenEnv);
assert.equal(savedWithOverride.config.toolMode, "full");
assert.equal(JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")).toolMode, "codex");

const conflictConfigDir = join(testDir, "conflict-config");
mkdirSync(conflictConfigDir);
writeFileSync(join(conflictConfigDir, "auth.json"), JSON.stringify({
  ownerToken: "test-owner-token-that-is-long-enough",
}));
writeFileSync(join(conflictConfigDir, "config.json"), JSON.stringify({
  allowedRoots: [rootA],
  resources: { maxProcessSessions: 4, maxProcessSessionsPerWorkspace: 4 },
}));
const conflictEnv = {
  DEVSPACE_CONFIG_DIR: conflictConfigDir,
  DEVSPACE_MAX_PROCESS_SESSIONS: "32",
};
const effectiveConflictConfig = loadAdminConfig(conflictEnv);
assert.equal(effectiveConflictConfig.resources.maxProcessSessions, 32);
assert.throws(
  () => saveAdminConfig({
    ...effectiveConflictConfig,
    resources: {
      ...effectiveConflictConfig.resources,
      maxProcessSessionsPerWorkspace: 8,
    },
  }, conflictEnv),
  (error) => error instanceof AdminConfigValidationError &&
    "resources.maxProcessSessionsPerWorkspace" in error.fields,
);

writeFileSync(join(conflictConfigDir, "config.json"), JSON.stringify({
  allowedRoots: [rootA],
  resources: { maxProcessSessions: 4, maxProcessSessionsPerWorkspace: 8 },
}));
const repairableConfig = loadAdminConfig({ DEVSPACE_CONFIG_DIR: conflictConfigDir });
assert.equal(repairableConfig.resources.maxProcessSessions, 4);
assert.equal(repairableConfig.resources.maxProcessSessionsPerWorkspace, 8);
assert.match(
  adminConfigWarnings(repairableConfig)["resources.maxProcessSessionsPerWorkspace"],
  /exceed/,
);

renameSync(rootB, `${rootB}-removed`);
const configWithMissingRoot = loadAdminConfig(env);
assert.equal(configWithMissingRoot.allowedRoots[0], next.allowedRoots[0]);
assert.match(adminConfigWarnings(configWithMissingRoot)["allowedRoots.0"], /no longer/);

assertValidationError({ ...next, allowedRoots: [] }, "allowedRoots");
assertValidationError({ ...next, allowedRoots: [join(testDir, "missing")] }, "allowedRoots.0");
assertValidationError({ ...next, allowedRoots: ["/"] }, "allowedRoots.0");
assertValidationError({
  ...next,
  resources: { ...next.resources, maxProcessSessions: 2, maxProcessSessionsPerWorkspace: 3 },
}, "resources.maxProcessSessionsPerWorkspace");
assertValidationError({
  ...next,
  resources: { ...next.resources, maxMcpSessions: 1_025 },
}, "resources.maxMcpSessions");

function assertValidationError(input: unknown, field: string): void {
  assert.throws(
    () => validateAdminConfig(input),
    (error) => error instanceof AdminConfigValidationError && field in error.fields,
  );
}
