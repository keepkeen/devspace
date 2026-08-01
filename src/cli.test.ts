import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditEventStore } from "./audit-events.js";

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

const helpOutput = execFileSync("node", ["--import", "tsx", "src/cli.ts", "--help"], {
  encoding: "utf8",
});
assert.doesNotMatch(helpOutput, /devspace agents/u);
assert.doesNotMatch(helpOutput, /devspace auth/u);

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
execFileSync(
  "node",
  ["--import", "tsx", "src/cli.ts", "config", "set", "widgets", "changes"],
  {
    encoding: "utf8",
    env: { ...process.env, DEVSPACE_CONFIG_DIR: configCommandDir },
  },
);
const updatedConfig = JSON.parse(
  readFileSync(join(configCommandDir, "config.json"), "utf8"),
) as {
  allowedRoots: string[];
  publicBaseUrl: string | null;
  widgets: string;
  schemaVersion: number;
};
assert.deepEqual(updatedConfig.allowedRoots, [process.cwd()]);
assert.equal(updatedConfig.publicBaseUrl, null);
assert.equal(updatedConfig.widgets, "changes");
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
  const authEnv = {
    ...process.env,
    DEVSPACE_CONFIG_DIR: join(authRoot, "config"),
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: "https://devspace.example.com",
    PORT: "1",
    DEVSPACE_CONTROL_PORT: "2",
  };
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

  const auditHealth = JSON.parse(execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "audit", "health", "--json"],
    { encoding: "utf8", env: authEnv },
  )) as {
    timeChina?: unknown;
    cli?: { stateDirRef?: unknown; auditEnabled?: unknown; eventCount?: unknown };
    backend?: { reachable?: unknown; stateDirMatches?: unknown };
  };
  assert.match(String(auditHealth.timeChina), /^\d{4}-\d{2}-\d{2} .+ UTC\+08:00$/u);
  assert.match(String(auditHealth.cli?.stateDirRef), /^state_[a-f0-9]{12}$/u);
  assert.equal(auditHealth.cli?.auditEnabled, true);
  assert.equal(auditHealth.cli?.eventCount, 1);
  assert.equal(auditHealth.backend?.reachable, false);
  assert.equal(auditHealth.backend?.stateDirMatches, null);

} finally {
  rmSync(authRoot, { recursive: true, force: true });
}
