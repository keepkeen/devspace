import type { SpawnOptions } from "node:child_process";

/**
 * Keep the worker in the caller's process group.
 *
 * On POSIX, exec_command owns that group and retains the Workspace root lease
 * until every group member exits. Creating another detached group made the
 * parent command appear finished while the agent kept modifying files.
 */
export function localAgentWorkerSpawnOptions(
  env: NodeJS.ProcessEnv = process.env,
): SpawnOptions {
  return {
    detached: false,
    stdio: "ignore",
    env,
    windowsHide: true,
  };
}

/**
 * POSIX group tracking remains valid after the short launcher exits, so it may
 * unref the worker. Windows has no equivalent group-liveness check in the
 * current runtime, so the launcher stays alive until the worker exits.
 */
export function shouldUnrefLocalAgentWorker(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32";
}
