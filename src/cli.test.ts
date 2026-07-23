import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { LocalAgentStore } from "./local-agent-store.js";

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
    toolMode: "codex",
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
) as { allowedRoots: string[]; publicBaseUrl: string; toolMode: string };
assert.equal(updatedConfig.toolMode, "codex");
assert.deepEqual(updatedConfig.allowedRoots, [process.cwd()]);
assert.equal(updatedConfig.publicBaseUrl, null);
const visibleConfig = JSON.parse(execFileSync(
  "node",
  ["--import", "tsx", "src/cli.ts", "config", "get"],
  {
    encoding: "utf8",
    env: { ...process.env, DEVSPACE_CONFIG_DIR: configCommandDir },
  },
));
assert.equal("toolMode" in visibleConfig, false);
assert.throws(
  () => execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "config", "set", "toolMode", "full"],
    {
      encoding: "utf8",
      env: { ...process.env, DEVSPACE_CONFIG_DIR: configCommandDir },
      stdio: "pipe",
    },
  ),
  /Command failed/,
);
rmSync(configCommandDir, { recursive: true, force: true });

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

  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", "agents", "ls"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      DEVSPACE_CONFIG_DIR: configDir,
      DEVSPACE_ALLOWED_ROOTS: projectRoot,
      DEVSPACE_STATE_DIR: stateDir,
      DEVSPACE_WORKSPACE_ID: "ws_current",
      DEVSPACE_WORKSPACE_ROOT: projectRoot,
      DEVSPACE_SUBAGENTS: "1",
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    },
  });

  assert.match(output, new RegExp(`${current.id} idle reviewer codex gpt-5\\.4 thinking=high`));
  assert.doesNotMatch(output, /profile reviewer/);
  assert.doesNotMatch(output, new RegExp(other.id));

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
