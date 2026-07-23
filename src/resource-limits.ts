export const MAX_TIMER_MS = 2_147_483_647;

export const RESOURCE_LIMIT_MAXIMUMS = {
  maxMcpSessions: 1_024,
  maxMcpSessionsPerClient: 1_024,
  maxProcessSessions: 256,
  maxProcessSessionsPerClient: 256,
  maxProcessSessionsPerWorkspace: 256,
  maxProcessOutputFileBytes: 1024 * 1024 * 1024,
  maxProcessOutputStorageBytes: 10 * 1024 * 1024 * 1024,
  maxResidentWorkspaces: 4_096,
  maxActiveWorkspacesPerClient: 4_096,
  maxManagedWorktrees: 1_024,
} as const;

export const MIN_COMMAND_RUNTIME_MS = 1_000;
