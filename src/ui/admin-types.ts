export type WidgetMode = "full" | "changes" | "off";

export interface AdminResourceLimits {
  maxMcpSessions: number;
  maxProcessSessions: number;
  maxProcessSessionsPerWorkspace: number;
  maxProcessOutputFileBytes: number;
  maxProcessOutputStorageBytes: number;
  completedProcessOutputTtlMs: number;
  maxCommandRuntimeMs: number;
  maxResidentWorkspaces: number;
  maxRequestBodyBytes: number;
}

export interface AdminConfig {
  allowedRoots: string[];
  userInstructionsPath: string | null;
  projectDocFallbackFilenames: string[];
  widgets: WidgetMode;
  resources: AdminResourceLimits;
}

export interface AdminSessionResponse {
  csrfToken: string;
}

export type AdminBackendState =
  | "unmanaged"
  | "stopped"
  | "starting"
  | "running"
  | "restarting"
  | "failed"
  | "unknown";

export interface AdminBackendRuntime {
  managed: boolean;
  state: AdminBackendState;
  supervisor?: "launchd" | string;
  label?: string;
  actions: Array<"restart">;
  confirmationToken?: string;
  confirmationExpiresAt?: string;
  lastError?: string;
}

export interface AdminStatusResponse {
  admin: {
    ready: boolean;
    version?: string;
    startedAt?: string;
  };
  mcp: {
    ready: boolean;
    status: number | null;
    error?: "unreachable" | string;
    latencyMs?: number;
    checkedAt?: string;
  };
  tunnel?: {
    configured: boolean;
    reachable: boolean;
    ready: boolean;
    status: number | null;
    error?: "unreachable" | "unsafe_destination" | string;
    latencyMs?: number;
    hostname?: string;
  };
  runtime?: {
    backend?: AdminBackendRuntime;
  };
  publicBaseUrl?: string;
  configPath?: string;
}

export interface AdminConfigEnvelope {
  config: AdminConfig;
  revision: string;
  rootsRevision: string;
  overrides?: string[];
  warnings?: Record<string, string>;
}

export interface AdminConfigSavedResponse {
  config: AdminConfig;
  revision: string;
  restartRequired: boolean;
  rootsRevision: string;
  rootsChanged?: boolean;
  rootsReloaded?: boolean;
  overrides?: string[];
  warnings?: Record<string, string>;
}

export interface AdminRestartResponse {
  operation: {
    id: string;
    target: "backend";
    action: "restart";
    state: "accepted";
    requestedAt: string;
  };
}

export interface AdminValidationIssue {
  path?: string | Array<string | number>;
  message: string;
}

export interface AdminErrorResponse {
  error?: {
    code?: string;
    message?: string;
    fields?: Record<string, string | string[]>;
  };
}

export interface AdminUsageMetric {
  active?: number;
  used?: number;
  limit?: number;
  utilization?: number;
}

export interface AdminRecentFailure {
  at?: string;
  category?: string;
  event?: string;
}

export interface AdminDiagnostics {
  generatedAt?: string;
  version?: string;
  generation?: string;
  uptimeSeconds?: number | null;
  runtimeConfig?: {
    widgets: WidgetMode;
    allowedRootsRevision?: string;
    allowedRootsCleanupPending?: number;
    maxRequestBodyBytes?: number;
  };
  usage?: {
    mcpSessions?: AdminUsageMetric & {
      reserved?: number | null;
      stateful?: number | null;
      statelessRequests?: number | null;
    };
    processSessions?: AdminUsageMetric;
    processOutput?: AdminUsageMetric & { outputs?: number | null; activeOutputs?: number | null; droppedBytes?: number | null };
    workspaces?: AdminUsageMetric & { resident?: number | null; closing?: number | null };
    oauth?: {
      clients?: number | null;
      accessTokens?: number | null;
      refreshTokens?: number | null;
      expiredRecords?: number | null;
      legacyWildcardGrants?: number | null;
    };
    projectExecutions?: {
      total?: number | null;
      provisioning?: number | null;
      active?: number | null;
      revoked?: number | null;
      quarantined?: number | null;
      closed?: number | null;
    };
  };
  observability?: {
    audit?: {
      auditWriteFailures?: number;
      lastAuditWriteFailureAt?: string;
    };
  };
  recentFailures?: AdminRecentFailure[];
  [key: string]: unknown;
}

export interface AdminDiagnosticsResponse {
  diagnostics: AdminDiagnostics;
  security: {
    confirmationToken: string;
    confirmationExpiresAt: string;
  };
}
