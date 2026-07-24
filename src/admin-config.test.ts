import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdminConfigValidationError,
  AdminConfigConflictError,
  adminConfigOverridePaths,
  adminConfigWarnings,
  loadAdminConfig,
  loadAdminConfigSnapshot,
  saveAdminConfig,
  saveAdminConfigIfMatch,
  validateAdminConfig,
} from "./admin-config.js";

const testDir = mkdtempSync(join(tmpdir(), "devspace-admin-config-test-"));
const configDir = join(testDir, "config");
const rootA = join(testDir, "root-a");
const rootB = join(testDir, "root-b");
const userInstructionsPath = join(testDir, "USER_INSTRUCTIONS.md");
mkdirSync(configDir);
mkdirSync(rootA);
mkdirSync(rootB);
writeFileSync(userInstructionsPath, "Use concise project edits.\n");
symlinkSync(rootA, join(testDir, "root-a-link"));
writeFileSync(join(configDir, "auth.json"), JSON.stringify({
  ownerToken: "test-owner-token-that-is-long-enough",
}));
writeFileSync(join(configDir, "config.json"), JSON.stringify({
  allowedRoots: [rootA],
  widgets: "changes",
  publicBaseUrl: "https://example.test",
  futureSetting: { preserve: true },
  resources: { maxMcpSessions: 12, cleanupIntervalMs: 1234 },
}));
chmodSync(join(configDir, "config.json"), 0o644);

const env = { DEVSPACE_CONFIG_DIR: configDir };
const initial = loadAdminConfig(env);
assert.equal(JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")).schemaVersion, 2);
assert.equal(existsSync(join(configDir, "config.json.backup-v0")), true);
assert.equal(JSON.parse(readFileSync(join(configDir, "config.json.backup-v0"), "utf8")).schemaVersion, undefined);
assert.equal(initial.widgets, "changes");
assert.deepEqual(initial.projectDocFallbackFilenames, []);
assert.equal(initial.userInstructionsPath, null);
assert.equal(initial.resources.maxMcpSessions, 12);
assert.equal(initial.resources.maxProcessOutputFileBytes, 64 * 1024 * 1024);
assert.equal(initial.resources.maxProcessOutputStorageBytes, 1024 * 1024 * 1024);
assert.equal(initial.resources.completedProcessOutputTtlMs, 24 * 60 * 60 * 1_000);

const next = validateAdminConfig({
  ...initial,
  allowedRoots: [rootB, join(testDir, "root-a-link"), rootA],
  userInstructionsPath,
  projectDocFallbackFilenames: ["TEAM_GUIDE.md", "TEAM_GUIDE.md"],
  widgets: "full",
  resources: {
    ...initial.resources,
    maxMcpSessions: 20,
    maxProcessSessions: 10,
    maxProcessSessionsPerClient: 10,
    maxProcessSessionsPerWorkspace: 5,
    maxProcessOutputFileBytes: 2_097_152,
    maxProcessOutputStorageBytes: 4_194_304,
    completedProcessOutputTtlMs: 120_000,
  },
});
assert.deepEqual(next.allowedRoots, [realpathSync(rootB), realpathSync(rootA)]);

const saved = saveAdminConfig(next, env);
assert.equal(saved.restartRequired, true);
assert.equal(saved.rootsChanged, true);
assert.deepEqual(saved.config.allowedRoots, [realpathSync(rootB), realpathSync(rootA)]);
assert.deepEqual(saved.config.projectDocFallbackFilenames, ["TEAM_GUIDE.md"]);
assert.equal(saved.config.userInstructionsPath, realpathSync(userInstructionsPath));
assert.equal(lstatSync(join(configDir, "config.json")).mode & 0o777, 0o600);
const persisted = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
assert.deepEqual(persisted.futureSetting, { preserve: true });
assert.equal(persisted.publicBaseUrl, "https://example.test");
assert.equal(persisted.resources.cleanupIntervalMs, 1234);
assert.equal(persisted.resources.maxMcpSessions, 20);
assert.equal(persisted.resources.maxProcessOutputFileBytes, 2_097_152);
assert.equal(persisted.resources.maxProcessOutputStorageBytes, 4_194_304);
assert.equal(persisted.resources.completedProcessOutputTtlMs, 120_000);
assert.deepEqual(persisted.projectDocFallbackFilenames, ["TEAM_GUIDE.md"]);
assert.equal(persisted.userInstructionsPath, realpathSync(userInstructionsPath));
const unchangedSave = saveAdminConfig(next, env);
assert.equal(unchangedSave.restartRequired, false);
assert.equal(unchangedSave.rootsChanged, false);

assert.equal(loadAdminConfig({ ...env, DEVSPACE_WIDGETS: "off" }).widgets, "off");
assert.equal(
  loadAdminConfig({ ...env, DEVSPACE_MAX_MCP_SESSIONS: "7" }).resources.maxMcpSessions,
  7,
);
const outputOverrideEnv = {
  ...env,
  DEVSPACE_MAX_PROCESS_OUTPUT_FILE_BYTES: "1048576",
  DEVSPACE_MAX_PROCESS_OUTPUT_STORAGE_BYTES: "8388608",
  DEVSPACE_COMPLETED_PROCESS_OUTPUT_TTL_SECONDS: "60",
};
assert.equal(loadAdminConfig(outputOverrideEnv).resources.maxProcessOutputFileBytes, 1_048_576);
assert.equal(loadAdminConfig(outputOverrideEnv).resources.maxProcessOutputStorageBytes, 8_388_608);
assert.equal(loadAdminConfig(outputOverrideEnv).resources.completedProcessOutputTtlMs, 60_000);
assert.deepEqual(
  adminConfigOverridePaths({
    ...env,
    DEVSPACE_WIDGETS: "off",
    DEVSPACE_MAX_MCP_SESSIONS: "7",
    DEVSPACE_MAX_PROCESS_OUTPUT_FILE_BYTES: "1048576",
    DEVSPACE_MAX_PROCESS_OUTPUT_STORAGE_BYTES: "8388608",
    DEVSPACE_COMPLETED_PROCESS_OUTPUT_TTL_SECONDS: "60",
    DEVSPACE_PROJECT_DOC_FALLBACK_FILENAMES: "LOCAL_RULES.md",
    DEVSPACE_USER_INSTRUCTIONS_PATH: userInstructionsPath,
  }),
  [
    "userInstructionsPath",
    "projectDocFallbackFilenames",
    "widgets",
    "resources.maxMcpSessions",
    "resources.maxProcessOutputFileBytes",
    "resources.maxProcessOutputStorageBytes",
    "resources.completedProcessOutputTtlMs",
  ],
);

const instructionsOverrideEnv = {
  ...env,
  DEVSPACE_USER_INSTRUCTIONS_PATH: userInstructionsPath,
};
const instructionsOverridden = loadAdminConfig(instructionsOverrideEnv);
assert.equal(instructionsOverridden.userInstructionsPath, userInstructionsPath);
assert.doesNotThrow(() => saveAdminConfig(instructionsOverridden, instructionsOverrideEnv));
assert.throws(
  () => saveAdminConfig({ ...instructionsOverridden, userInstructionsPath: null }, instructionsOverrideEnv),
  (error) => error instanceof AdminConfigValidationError && "userInstructionsPath" in error.fields,
);

const concurrentSnapshot = await loadAdminConfigSnapshot(env);
const concurrentResults = await Promise.allSettled([
  saveAdminConfigIfMatch({
    ...concurrentSnapshot.config,
    resources: { ...concurrentSnapshot.config.resources, maxMcpSessions: 21 },
  }, concurrentSnapshot.revision, env),
  saveAdminConfigIfMatch({
    ...concurrentSnapshot.config,
    resources: { ...concurrentSnapshot.config.resources, maxMcpSessions: 22 },
  }, concurrentSnapshot.revision, env),
]);
assert.equal(concurrentResults.filter((result) => result.status === "fulfilled").length, 1);
const rejectedConcurrent = concurrentResults.find((result) => result.status === "rejected");
assert(rejectedConcurrent?.status === "rejected");
assert(rejectedConcurrent.reason instanceof AdminConfigConflictError);

const firstSaveConfigDir = join(testDir, "first-save-config");
const firstSaveEnv = {
  DEVSPACE_CONFIG_DIR: firstSaveConfigDir,
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};
const firstSaveSnapshot = await loadAdminConfigSnapshot(firstSaveEnv);
const firstSaveResult = await saveAdminConfigIfMatch({
  ...firstSaveSnapshot.config,
  widgets: "off",
}, firstSaveSnapshot.revision, firstSaveEnv);
assert.equal(firstSaveResult.config.widgets, "off");
assert.equal(existsSync(join(firstSaveConfigDir, "config.json")), true);
assert.equal(JSON.parse(readFileSync(join(firstSaveConfigDir, "config.json"), "utf8")).widgets, "off");

const conflictConfigDir = join(testDir, "conflict-config");
mkdirSync(conflictConfigDir);
writeFileSync(join(conflictConfigDir, "auth.json"), JSON.stringify({
  ownerToken: "test-owner-token-that-is-long-enough",
}));
writeFileSync(join(conflictConfigDir, "config.json"), JSON.stringify({
  allowedRoots: [rootA],
  resources: { maxProcessSessions: 4, maxProcessSessionsPerClient: 4, maxProcessSessionsPerWorkspace: 4 },
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
assertValidationError({ ...next, userInstructionsPath: join(testDir, "missing-instructions.md") }, "userInstructionsPath");
assertValidationError({ ...next, userInstructionsPath: rootA }, "userInstructionsPath");
assertValidationError({ ...next, userInstructionsPath: "relative/AGENTS.md" }, "userInstructionsPath");
assertValidationError({
  ...next,
  projectDocFallbackFilenames: ["../AGENTS.md"],
}, "projectDocFallbackFilenames.0");
assertValidationError({
  ...next,
  resources: { ...next.resources, maxProcessSessions: 2, maxProcessSessionsPerWorkspace: 3 },
}, "resources.maxProcessSessionsPerWorkspace");
assertValidationError({
  ...next,
  resources: { ...next.resources, maxMcpSessions: 1_025 },
}, "resources.maxMcpSessions");
assertValidationError({
  ...next,
  resources: { ...next.resources, maxProcessOutputFileBytes: 4_194_305 },
}, "resources.maxProcessOutputFileBytes");
assertValidationError({
  ...next,
  resources: { ...next.resources, maxProcessOutputStorageBytes: 10 * 1024 * 1024 * 1024 + 1 },
}, "resources.maxProcessOutputStorageBytes");
assertValidationError({
  ...next,
  resources: { ...next.resources, completedProcessOutputTtlMs: 999 },
}, "resources.completedProcessOutputTtlMs");

function assertValidationError(input: unknown, field: string): void {
  assert.throws(
    () => validateAdminConfig(input),
    (error) => error instanceof AdminConfigValidationError && field in error.fields,
  );
}
