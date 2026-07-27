export const MAX_TIMER_MS = 2_147_483_647;

/** Maximum UTF-8 file patch payload accepted by apply_patch. */
export const MAX_PATCH_UTF8_BYTES = 4 * 1024 * 1024;
/**
 * A JSON string can expand one input byte to six wire bytes (`\\u00XX`). Keep
 * enough room for the maximum patch plus the JSON-RPC envelope.
 */
export const MIN_RECOMMENDED_REQUEST_BODY_BYTES =
  MAX_PATCH_UTF8_BYTES * 6 + 64 * 1024;
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

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
  maxRequestBodyBytes: 64 * 1024 * 1024,
} as const;

export const MIN_COMMAND_RUNTIME_MS = 1_000;
