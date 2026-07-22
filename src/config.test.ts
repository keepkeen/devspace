import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { ensureDevspaceDefaultSkills, resolveSubagentsFlag } from "./user-config.js";

const emptyConfigDir = mkdtempSync(join(tmpdir(), "devspace-empty-config-test-"));
const baseEnv = {
  DEVSPACE_CONFIG_DIR: emptyConfigDir,
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

assert.equal(loadConfig(baseEnv).widgets, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "changes" }).widgets, "changes");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "full" }).widgets, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "off" }).widgets, "off");
assert.equal(loadConfig(baseEnv).toolMode, "codex");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "minimal" }).toolMode, "minimal");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "full" }).toolMode, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "codex" }).toolMode, "codex");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_MINIMAL_TOOLS: "0" }).toolMode, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_MINIMAL_TOOLS: "1" }).toolMode, "minimal");
assert.equal(loadConfig(baseEnv).skillsEnabled, true);
assert.equal(loadConfig(baseEnv).devspaceSkillsDir, join(emptyConfigDir, "skills"));
assert.equal(loadConfig(baseEnv).devspaceAgentsDir, join(emptyConfigDir, "agents"));
assert.equal(loadConfig(baseEnv).subagents, false);
assert.deepEqual(loadConfig(baseEnv).projectDocFallbackFilenames, []);
assert.deepEqual(
  loadConfig({
    ...baseEnv,
    DEVSPACE_PROJECT_DOC_FALLBACK_FILENAMES: "TEAM_GUIDE.md,.agents.md,TEAM_GUIDE.md",
  }).projectDocFallbackFilenames,
  ["TEAM_GUIDE.md", ".agents.md"],
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_PROJECT_DOC_FALLBACK_FILENAMES: "../AGENTS.md" }),
  /Invalid project document fallback filename/,
);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SKILLS: "0" }).skillsEnabled, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SKILLS: "1" }).skillsEnabled, true);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_SUBAGENTS: "1" }).subagents,
  true,
);
assert.equal(resolveSubagentsFlag({}, {}), undefined);
assert.equal(resolveSubagentsFlag({ subagents: true }, {}), true);
assert.equal(resolveSubagentsFlag({ subagents: true }, { DEVSPACE_SUBAGENTS: "0" }), false);
assert.equal(resolveSubagentsFlag({}, { DEVSPACE_SUBAGENTS: "1" }), true);
assert.throws(
  () => resolveSubagentsFlag({}, { DEVSPACE_SUBAGENTS: "treu" }),
  /Invalid DEVSPACE_SUBAGENTS: treu \(expected boolean\)/,
);

const seededConfigDir = mkdtempSync(join(tmpdir(), "devspace-seeded-skills-test-"));
const seededSkillPaths = ensureDevspaceDefaultSkills({ DEVSPACE_CONFIG_DIR: seededConfigDir });
assert.deepEqual(seededSkillPaths, [join(seededConfigDir, "skills", "subagent-delegation", "SKILL.md")]);
assert.equal(existsSync(seededSkillPaths[0]), true);
assert.match(readFileSync(seededSkillPaths[0], "utf8"), /name: subagent-delegation/);
assert.deepEqual(ensureDevspaceDefaultSkills({ DEVSPACE_CONFIG_DIR: seededConfigDir }), []);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "invalid" }),
  /Invalid DEVSPACE_WIDGETS: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "minimal" }),
  /Invalid DEVSPACE_WIDGETS: minimal/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "write-only" }),
  /Invalid DEVSPACE_WIDGETS: write-only/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "invalid" }),
  /Invalid DEVSPACE_TOOL_MODE: invalid/,
);

assert.deepEqual(loadConfig(baseEnv).logging, {
  level: "info",
  format: "json",
  requests: true,
  assets: false,
  toolCalls: true,
  shellCommands: false,
  trustProxy: false,
});

assert.deepEqual(loadConfig(baseEnv).resources, {
  mcpSessionIdleTimeoutMs: 1_800_000,
  mcpSessionCloseTimeoutMs: 5_000,
  cleanupIntervalMs: 300_000,
  maxMcpSessions: 64,
  maxProcessSessions: 32,
  maxProcessSessionsPerWorkspace: 8,
  maxCommandRuntimeMs: 3_600_000,
  processShutdownGraceMs: 5_000,
  httpDrainTimeoutMs: 30_000,
  workspaceIdleTtlMs: 604_800_000,
  maxResidentWorkspaces: 256,
  maxManagedWorktrees: 64,
});
assert.deepEqual(loadConfig(baseEnv).instructionScan, {
  maxDepth: 32,
  maxEntries: 100_000,
  deadlineMs: 5_000,
});
const limitedConfig = loadConfig({
  ...baseEnv,
  DEVSPACE_MAX_MCP_SESSIONS: "4",
  DEVSPACE_MAX_PROCESS_SESSIONS: "5",
  DEVSPACE_MAX_PROCESS_SESSIONS_PER_WORKSPACE: "2",
  DEVSPACE_MAX_COMMAND_RUNTIME_SECONDS: "30",
  DEVSPACE_WORKSPACE_IDLE_TTL_SECONDS: "60",
  DEVSPACE_MAX_MANAGED_WORKTREES: "3",
  DEVSPACE_INSTRUCTION_SCAN_MAX_DEPTH: "3",
  DEVSPACE_INSTRUCTION_SCAN_MAX_ENTRIES: "50",
  DEVSPACE_INSTRUCTION_SCAN_DEADLINE_MS: "25",
});
assert.equal(limitedConfig.resources.maxMcpSessions, 4);
assert.equal(limitedConfig.resources.maxProcessSessions, 5);
assert.equal(limitedConfig.resources.maxProcessSessionsPerWorkspace, 2);
assert.equal(limitedConfig.resources.maxCommandRuntimeMs, 30_000);
assert.equal(limitedConfig.resources.workspaceIdleTtlMs, 60_000);
assert.equal(limitedConfig.resources.maxManagedWorktrees, 3);
assert.deepEqual(limitedConfig.instructionScan, { maxDepth: 3, maxEntries: 50, deadlineMs: 25 });

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "silent" }).logging.level, "silent");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "error" }).logging.level, "error");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "warn" }).logging.level, "warn");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "info" }).logging.level, "info");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "debug" }).logging.level, "debug");

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "json" }).logging.format, "json");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "pretty" }).logging.format, "pretty");

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_REQUESTS: "0" }).logging.requests, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_ASSETS: "1" }).logging.assets, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_TOOL_CALLS: "0" }).logging.toolCalls, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_SHELL_COMMANDS: "1" }).logging.shellCommands, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TRUST_PROXY: "1" }).logging.trustProxy, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_ASSETS: "OFF" }).logging.assets, false);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_LOG_ASSETS: "treu" }),
  /Invalid DEVSPACE_LOG_ASSETS: treu \(expected boolean\)/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_SKILLS: "" }),
  /Invalid DEVSPACE_SKILLS:  \(expected boolean\)/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_MAX_PROCESS_SESSIONS: "0" }),
  /Invalid DEVSPACE_MAX_PROCESS_SESSIONS: 0/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_MAX_COMMAND_RUNTIME_SECONDS: "2147484" }),
  /Invalid DEVSPACE_MAX_COMMAND_RUNTIME_SECONDS: 2147484/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_INSTRUCTION_SCAN_MAX_DEPTH: "257" }),
  /Invalid DEVSPACE_INSTRUCTION_SCAN_MAX_DEPTH: 257/,
);
assert.throws(
  () => loadConfig({
    ...baseEnv,
    DEVSPACE_MAX_PROCESS_SESSIONS: "2",
    DEVSPACE_MAX_PROCESS_SESSIONS_PER_WORKSPACE: "3",
  }),
  /DEVSPACE_MAX_PROCESS_SESSIONS_PER_WORKSPACE cannot exceed DEVSPACE_MAX_PROCESS_SESSIONS/,
);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "trace" }),
  /Invalid DEVSPACE_LOG_LEVEL: trace/,
);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "color" }),
  /Invalid DEVSPACE_LOG_FORMAT: color/,
);

assert.equal(loadConfig(baseEnv).oauth.ownerToken, "test-owner-token-that-is-long-enough");
assert.deepEqual(loadConfig(baseEnv).oauth.scopes, ["devspace"]);
assert.deepEqual(loadConfig(baseEnv).oauth.allowedRedirectHosts, [
  "chatgpt.com",
  "localhost",
  "127.0.0.1",
]);
assert.equal(loadConfig(baseEnv).oauth.accessTokenTtlSeconds, 3600);
assert.equal(loadConfig(baseEnv).oauth.refreshTokenTtlSeconds, 2592000);

assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_SCOPES: "devspace,admin" }).oauth.scopes,
  ["devspace", "admin"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS: "chatgpt.com,example.com" }).oauth
    .allowedRedirectHosts,
  ["chatgpt.com", "example.com"],
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "120" }).oauth
    .accessTokenTtlSeconds,
  120,
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS: "240" }).oauth
    .refreshTokenTtlSeconds,
  240,
);

assert.throws(
  () => loadConfig({ DEVSPACE_CONFIG_DIR: emptyConfigDir, DEVSPACE_ALLOWED_ROOTS: process.cwd() }),
  /DEVSPACE_OAUTH_OWNER_TOKEN is required/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_OAUTH_OWNER_TOKEN: "too-short" }),
  /DEVSPACE_OAUTH_OWNER_TOKEN must be at least 16 characters long/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "0" }),
  /Invalid DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: 0/,
);

assert.equal(loadConfig(baseEnv).publicBaseUrl, "http://127.0.0.1:7676");
assert.deepEqual(loadConfig(baseEnv).allowedHosts, ["localhost", "127.0.0.1", "::1"]);

assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).publicBaseUrl,
  "https://abc.trycloudflare.com",
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).allowedHosts,
  ["localhost", "127.0.0.1", "::1", "abc.trycloudflare.com"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_ALLOWED_HOSTS: "*" }).allowedHosts,
  ["*"],
);

const configDir = mkdtempSync(join(tmpdir(), "devspace-config-test-"));
writeFileSync(
  join(configDir, "config.json"),
  JSON.stringify({
    port: 8787,
    allowedRoots: [process.cwd()],
    publicBaseUrl: "https://devspace.example.com",
    subagents: true,
    toolMode: "full",
    widgets: "changes",
    projectDocFallbackFilenames: ["TEAM_GUIDE.md", ".agents.md"],
    resources: {
      maxMcpSessions: 11,
      maxProcessSessions: 9,
      maxProcessSessionsPerWorkspace: 3,
      maxCommandRuntimeMs: 45_000,
      maxResidentWorkspaces: 22,
      maxManagedWorktrees: 7,
    },
  }),
);
writeFileSync(
  join(configDir, "auth.json"),
  JSON.stringify({
    ownerToken: "persisted-owner-token-long-enough",
  }),
);

const fileConfig = loadConfig({ DEVSPACE_CONFIG_DIR: configDir });
assert.equal(fileConfig.port, 8787);
assert.equal(fileConfig.oauth.ownerToken, "persisted-owner-token-long-enough");
assert.equal(fileConfig.publicBaseUrl, "https://devspace.example.com");
assert.deepEqual(fileConfig.projectDocFallbackFilenames, ["TEAM_GUIDE.md", ".agents.md"]);
assert.equal(fileConfig.subagents, true);
assert.equal(fileConfig.toolMode, "full");
assert.equal(fileConfig.widgets, "changes");
assert.equal(fileConfig.resources.maxMcpSessions, 11);
assert.equal(fileConfig.resources.maxProcessSessions, 9);
assert.equal(fileConfig.resources.maxProcessSessionsPerWorkspace, 3);
assert.equal(fileConfig.resources.maxCommandRuntimeMs, 45_000);
assert.equal(fileConfig.resources.maxResidentWorkspaces, 22);
assert.equal(fileConfig.resources.maxManagedWorktrees, 7);
assert.equal(
  loadConfig({ DEVSPACE_CONFIG_DIR: configDir, DEVSPACE_TOOL_MODE: "codex" }).toolMode,
  "codex",
);
assert.equal(
  loadConfig({ DEVSPACE_CONFIG_DIR: configDir, DEVSPACE_MINIMAL_TOOLS: "1" }).toolMode,
  "minimal",
);
assert.equal(
  loadConfig({ DEVSPACE_CONFIG_DIR: configDir, DEVSPACE_WIDGETS: "off" }).widgets,
  "off",
);
assert.equal(
  loadConfig({ DEVSPACE_CONFIG_DIR: configDir, DEVSPACE_MAX_MCP_SESSIONS: "13" }).resources
    .maxMcpSessions,
  13,
);
assert.equal(
  loadConfig({ DEVSPACE_CONFIG_DIR: configDir, DEVSPACE_MAX_COMMAND_RUNTIME_SECONDS: "90" })
    .resources.maxCommandRuntimeMs,
  90_000,
);
assert.deepEqual(fileConfig.allowedHosts, [
  "localhost",
  "127.0.0.1",
  "::1",
  "devspace.example.com",
]);

const invalidConfigDir = mkdtempSync(join(tmpdir(), "devspace-invalid-config-test-"));
writeFileSync(join(invalidConfigDir, "config.json"), JSON.stringify({ port: "7676", unknown: true }));
writeFileSync(
  join(invalidConfigDir, "auth.json"),
  JSON.stringify({ ownerToken: "persisted-owner-token-long-enough" }),
);
assert.throws(
  () => loadConfig({ DEVSPACE_CONFIG_DIR: invalidConfigDir }),
  /Unable to read .*config\.json/,
);

const invalidToolModeConfigDir = mkdtempSync(join(tmpdir(), "devspace-invalid-tool-mode-test-"));
writeFileSync(
  join(invalidToolModeConfigDir, "config.json"),
  JSON.stringify({ toolMode: "browser", allowedRoots: [process.cwd()] }),
);
writeFileSync(
  join(invalidToolModeConfigDir, "auth.json"),
  JSON.stringify({ ownerToken: "persisted-owner-token-long-enough" }),
);
assert.throws(
  () => loadConfig({ DEVSPACE_CONFIG_DIR: invalidToolModeConfigDir }),
  /Unable to read .*config\.json/,
);

const invalidResourceConfigDir = mkdtempSync(join(tmpdir(), "devspace-invalid-resource-test-"));
writeFileSync(
  join(invalidResourceConfigDir, "config.json"),
  JSON.stringify({
    allowedRoots: [process.cwd()],
    resources: { maxCommandRuntimeMs: 2_147_483_648 },
  }),
);
writeFileSync(
  join(invalidResourceConfigDir, "auth.json"),
  JSON.stringify({ ownerToken: "persisted-owner-token-long-enough" }),
);
assert.throws(
  () => loadConfig({ DEVSPACE_CONFIG_DIR: invalidResourceConfigDir }),
  /Unable to read .*config\.json/,
);
