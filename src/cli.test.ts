import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { AuditEventStore } from "./audit-events.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { writeLocalAgentOutput } from "./local-agent-output.js";
import { MAX_LOCAL_AGENT_RESPONSE_BYTES } from "./local-agent-limits.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

for (const flag of ["-v", "--version"]) {
  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", flag], {
    encoding: "utf8",
    env: { ...process.env, DEVSPACE_CONFIG_DIR: "/tmp/devspace-cli-version-test" },
  }).trim();

  assert.equal(output, packageJson.version);
}

const configCommandDir = mkdtempSync(join(tmpdir(), "devspace-cli-config-test-"));
writeFileSync(
  join(configCommandDir, "config.json"),
  JSON.stringify({
    allowedRoots: [process.cwd()],
    publicBaseUrl: "https://devspace.example.com",
  }),
);
execFileSync(
  "node",
  ["--import", "tsx", "src/cli.ts", "config", "set", "publicBaseUrl", "null"],
  {
    encoding: "utf8",
    env: { ...process.env, DEVSPACE_CONFIG_DIR: configCommandDir },
  },
);
const updatedConfig = JSON.parse(
  readFileSync(join(configCommandDir, "config.json"), "utf8"),
) as { allowedRoots: string[]; publicBaseUrl: string | null; schemaVersion: number };
assert.deepEqual(updatedConfig.allowedRoots, [process.cwd()]);
assert.equal(updatedConfig.publicBaseUrl, null);
assert.equal(updatedConfig.schemaVersion, 2);
const visibleConfig = JSON.parse(execFileSync(
  "node",
  ["--import", "tsx", "src/cli.ts", "config", "get"],
  {
    encoding: "utf8",
    env: { ...process.env, DEVSPACE_CONFIG_DIR: configCommandDir },
  },
));
assert.equal(visibleConfig.schemaVersion, 2);
rmSync(configCommandDir, { recursive: true, force: true });

const authRoot = mkdtempSync(join(tmpdir(), "devspace-cli-auth-test-"));
try {
  const stateDir = join(authRoot, "state");
  const projectRoot = join(authRoot, "project");
  mkdirSync(projectRoot, { recursive: true });
  const oauth = new SqliteOAuthStore(stateDir);
  const clients = new SqliteOAuthClientsStore(oauth, ["chatgpt.com"]);
  const client = clients.registerClient({
    redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    client_name: "CLI principal fixture",
  });
  const principalId = oauth.ensurePrincipalForClient(client.client_id);
  const workspaces = new SqliteWorkspaceStore(stateDir);
  workspaces.createSession({
    id: "cli-auth-workspace",
    connectionPrincipalId: principalId,
    alias: "cli-primary",
    root: projectRoot,
  });
  workspaces.close();
  oauth.close();

  const authEnv = {
    ...process.env,
    DEVSPACE_CONFIG_DIR: join(authRoot, "config"),
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: "https://devspace.example.com",
    PORT: "1",
  };
  const principalOutput = execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "auth", "principals"],
    { encoding: "utf8", env: authEnv },
  );
  assert.match(principalOutput, new RegExp(principalId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.match(principalOutput, /aliases=cli-primary/);

  const dryRunClose = execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "auth", "close-orphan", principalId],
    { encoding: "utf8", env: authEnv },
  );
  assert.match(dryRunClose, /"action": "close-orphan"/u);
  assert.match(dryRunClose, /"apply": false/u);
  assert.match(dryRunClose, /Dry run only/u);

  const auditStore = new AuditEventStore(stateDir);
  try {
    auditStore.record({
      ts: "2026-07-25T00:00:00.000Z",
      level: "error",
      event: "mcp_tool_error",
      requestId: "request-cli-audit",
      tool: "grep",
      connectionRef: "conn_cli_audit",
      errorCode: "invalid_pattern",
      errorName: "InvalidSearchPatternError",
      errorFingerprint: "fingerprint_cli",
      phase: "not_started",
    });
  } finally {
    auditStore.close();
  }
  const auditOutput = JSON.parse(execFileSync(
    "node",
    [
      "--import",
      "tsx",
      "src/cli.ts",
      "audit",
      "--event",
      "mcp_tool_error",
      "--json",
    ],
    { encoding: "utf8", env: authEnv },
  )) as Array<{ timeChina?: unknown; requestId?: unknown; errorCode?: unknown }>;
  assert.equal(auditOutput[0]?.timeChina, "2026-07-25 08:00:00.000 UTC+08:00");
  assert.equal(auditOutput[0]?.requestId, "request-cli-audit");
  assert.equal(auditOutput[0]?.errorCode, "invalid_pattern");

  const reconnectOutput = execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "auth", "reconnect-code", principalId],
    { encoding: "utf8", env: authEnv },
  );
  const reconnectCode = /^Reconnect code: (reconnect-[A-Za-z0-9_-]+)$/mu.exec(reconnectOutput)?.[1];
  assert.ok(reconnectCode);

  const restored = new SqliteOAuthStore(stateDir);
  try {
    const replacement = new SqliteOAuthClientsStore(restored, ["chatgpt.com"]).registerClient({
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    });
    assert.equal(restored.consumeReconnectCode(reconnectCode, replacement.client_id).targetPrincipalId, principalId);
    assert.equal(restored.principalForClient(replacement.client_id), principalId);
  } finally {
    restored.close();
  }
} finally {
  rmSync(authRoot, { recursive: true, force: true });
}

const root = mkdtempSync(join(tmpdir(), "devspace-cli-agents-test-"));
try {
  const configDir = join(root, ".devspace");
  const stateDir = join(root, ".state");
  const projectRoot = join(root, "project");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(configDir, "agents"), { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(configDir, "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Read-only reviewer.",
      "provider: codex",
      "model: gpt-5.4",
      "thinking: high",
      "---",
      "",
      "Review only.",
      "",
    ].join("\n"),
  );
  const store = new LocalAgentStore(stateDir);
  const current = store.update(
    store.create({
      workspaceId: "ws_current",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      provider: "codex",
      model: "gpt-5.4",
      thinking: "high",
    }).id,
    { status: "idle" },
  );
  const other = store.update(
    store.create({
      workspaceId: "ws_other",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      provider: "codex",
    }).id,
    { status: "running" },
  );
  store.close();

  const agentEnv = {
    ...process.env,
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_WORKSPACE_ID: "ws_current",
    DEVSPACE_WORKSPACE_ROOT: projectRoot,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  };
  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", "agents", "ls"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: agentEnv,
  });

  assert.match(output, new RegExp(`${current.id} idle reviewer codex gpt-5\\.4 thinking=high`));
  assert.doesNotMatch(output, /profile reviewer/);
  assert.doesNotMatch(output, new RegExp(other.id));

  const fullResponse = `FULL-BEGIN\n${"x".repeat(MAX_LOCAL_AGENT_RESPONSE_BYTES + 4_096)}\nFULL-END`;
  assert.equal(writeLocalAgentOutput(stateDir, current.id, fullResponse), true);
  const shown = execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "agents", "show", current.id],
    { cwd: process.cwd(), encoding: "utf8", env: agentEnv, maxBuffer: 2 * 1024 * 1024 },
  );
  assert.match(shown, /FULL-BEGIN/u);
  assert.match(shown, /FULL-END/u);
  assert.equal(Buffer.byteLength(shown, "utf8") > MAX_LOCAL_AGENT_RESPONSE_BYTES, true);

  assert.equal(loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  }).subagents, true);
} finally {
  rmSync(root, { recursive: true, force: true });
}
