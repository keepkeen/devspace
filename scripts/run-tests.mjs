import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const tests = [
  "src/version.test.ts",
  "src/internal-auth.test.ts",
  "src/runtime-diagnostics.test.ts",
  "src/runtime-control-plane.test.ts",
  "src/request-barrier.test.ts",
  "src/config.test.ts",
  "src/admin-config.test.ts",
  "src/admin-runtime.test.ts",
  "src/admin-server.test.ts",
  "src/ui/card-types.test.ts",
  "src/ui/patch-display.test.ts",
  "src/ui/tool-display.test.ts",
  "src/apply-patch.test.ts",
  "src/bash-prompt.test.ts",
  "src/bash-tool.test.ts",
  "src/batch-tools.test.ts",
  "src/command-policy.test.ts",
  "src/shell-command-scopes.test.ts",
  "src/process-platform.test.ts",
  "src/process-sessions.test.ts",
  "src/mcp-sessions.test.ts",
  "src/server-observability.test.ts",
  "src/server-shutdown.test.ts",
  "src/local-agent-runtime.test.ts",
  "src/local-agent-adapters.test.ts",
  "src/local-agent-availability.test.ts",
  "src/local-agent-profiles.test.ts",
  "src/local-agent-targets.test.ts",
  "src/local-agent-store.test.ts",
  "src/detached-agent-cleanup.test.ts",
  "src/roots.test.ts",
  "src/skills.test.ts",
  "src/workspace-store.test.ts",
  "src/workspaces.test.ts",
  "src/review-checkpoints.test.ts",
  "src/oauth-store.test.ts",
  "src/cli.test.ts",
];

const tsxCli = resolve("node_modules/tsx/dist/cli.mjs");
for (const test of tests) {
  const result = spawnSync(process.execPath, [tsxCli, test], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
