export type ToolMode = "codex" | "full" | "minimal";
export type WidgetMode = "full" | "changes" | "off";

export interface AdminResourceLimits {
  maxMcpSessions: number;
  maxProcessSessions: number;
  maxProcessSessionsPerWorkspace: number;
  maxCommandRuntimeMs: number;
  maxResidentWorkspaces: number;
  maxManagedWorktrees: number;
}

export interface AdminConfig {
  allowedRoots: string[];
  toolMode: ToolMode;
  widgets: WidgetMode;
  resources: AdminResourceLimits;
}

export interface AdminSessionResponse {
  csrfToken: string;
}

export interface AdminStatusResponse {
  admin: {
    ready: boolean;
  };
  mcp: {
    ready: boolean;
    status: number | null;
    error?: "unreachable";
  };
  publicBaseUrl?: string;
  configPath?: string;
}

export interface AdminConfigEnvelope {
  config: AdminConfig;
  overrides?: string[];
  warnings?: Record<string, string>;
}

export interface AdminConfigSavedResponse {
  config: AdminConfig;
  restartRequired: boolean;
  overrides?: string[];
  warnings?: Record<string, string>;
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
