import type { ReactNode } from "react";
import type {
  AdminBackendRuntime,
  AdminBackendState,
  AdminStatusResponse,
  AdminUsageMetric,
} from "./admin-types.js";

const overrideSources: Record<string, string> = {
  allowedRoots: "DEVSPACE_ALLOWED_ROOTS",
  projectDocFallbackFilenames: "DEVSPACE_PROJECT_DOC_FALLBACK_FILENAMES",
  toolMode: "DEVSPACE_TOOL_MODE",
  widgets: "DEVSPACE_WIDGETS",
  "resources.maxMcpSessions": "DEVSPACE_MAX_MCP_SESSIONS",
  "resources.maxMcpSessionsPerClient": "DEVSPACE_MAX_MCP_SESSIONS_PER_CLIENT",
  "resources.maxProcessSessions": "DEVSPACE_MAX_PROCESS_SESSIONS",
  "resources.maxProcessSessionsPerClient": "DEVSPACE_MAX_PROCESS_SESSIONS_PER_CLIENT",
  "resources.maxProcessSessionsPerWorkspace": "DEVSPACE_MAX_PROCESS_SESSIONS_PER_WORKSPACE",
  "resources.maxProcessOutputFileBytes": "DEVSPACE_MAX_PROCESS_OUTPUT_FILE_BYTES",
  "resources.maxProcessOutputStorageBytes": "DEVSPACE_MAX_PROCESS_OUTPUT_STORAGE_BYTES",
  "resources.completedProcessOutputTtlMs": "DEVSPACE_COMPLETED_PROCESS_OUTPUT_TTL_SECONDS",
  "resources.maxCommandRuntimeMs": "DEVSPACE_MAX_COMMAND_RUNTIME_SECONDS",
  "resources.maxResidentWorkspaces": "DEVSPACE_MAX_RESIDENT_WORKSPACES",
  "resources.maxActiveWorkspacesPerClient": "DEVSPACE_MAX_ACTIVE_WORKSPACES_PER_CLIENT",
  "resources.maxManagedWorktrees": "DEVSPACE_MAX_MANAGED_WORKTREES",
};

export function SectionHeading({ kicker, title, description, children }: { kicker: string; title: string; description: string; children?: ReactNode }): React.JSX.Element {
  const id = `${kicker.toLowerCase().split(/[\s&]/)[0]}-heading`;
  return <div className="section-heading"><div><p className="section-kicker">{kicker}</p><h2 id={id}>{title}</h2><p>{description}</p></div>{children && <div className="heading-action">{children}</div>}</div>;
}

export function StatusCard({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: "success" | "warning" | "danger" | "neutral" }): React.JSX.Element {
  return <div className="status-card"><span>{label}</span><strong className={tone}><i aria-hidden="true" />{value}</strong><p>{detail}</p></div>;
}

export function UsageCard({ label, metric, activeKey = "active" }: {
  label: string;
  metric: (AdminUsageMetric & { resident?: number | null }) | undefined;
  activeKey?: "active" | "resident";
}): React.JSX.Element {
  const active = metric?.[activeKey] ?? metric?.active ?? metric?.used;
  const limit = metric?.limit;
  const utilization = typeof active === "number" && typeof limit === "number" && limit > 0
    ? Math.min(100, Math.round((active / limit) * 100))
    : undefined;
  return <div className="usage-card"><span>{label}</span><strong>{typeof active === "number" ? active : "—"}{typeof limit === "number" ? ` / ${limit}` : ""}</strong><div className="usage-track" aria-label={utilization === undefined ? "使用率未知" : `使用率 ${utilization}%`}><i style={{ width: `${utilization ?? 0}%` }} /></div><small>{utilization === undefined ? "未提供配额" : `${utilization}% 已使用`}</small></div>;
}

export function AddField({ id, label, value, onChange, onAdd, placeholder, help, error, disabled }: { id: string; label: string; value: string; onChange(value: string): void; onAdd(): void; placeholder: string; help: string; error: string | null; disabled: boolean }): React.JSX.Element {
  return <div className="add-field"><label htmlFor={id}>{label}</label><div className="input-action-row"><input id={id} type="text" value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onAdd(); } }} placeholder={placeholder} autoComplete="off" spellCheck={false} aria-describedby={`${id}-${error ? "error" : "help"}`} aria-invalid={Boolean(error)} disabled={disabled} /><button type="button" className="secondary-button" onClick={onAdd} disabled={disabled}>添加</button></div><p id={`${id}-help`} className="field-help">{help}</p>{error && <p id={`${id}-error`} className="field-error">{error}</p>}</div>;
}

export function FieldMeta({ id, path, overrides, warnings, issues }: { id?: string; path: string; overrides: string[]; warnings: Record<string, string>; issues: Map<string, string[]> }): React.JSX.Element | null {
  const override = overrides.includes(path);
  const warning = warnings[path];
  const errors = issues.get(path) ?? [];
  if (!override && !warning && errors.length === 0) return null;
  return <div className="field-meta" id={id}>{override && <span className="source-label" title={`由 ${overrideSources[path] ?? "启动环境"} 控制`}>环境变量 · {overrideSources[path] ?? path}</span>}{warning && <span className="inline-warning">{warning}</span>}{errors.map((message, index) => <span className="field-error" key={`${message}-${index}`}>{message}</span>)}</div>;
}

export function SelectField<T extends string>({ id, label, value, description, options, onChange, disabled, meta }: { id: string; label: string; value: T; description: string; options: Array<readonly [T, string]>; onChange(value: T): void; disabled?: boolean; meta?: ReactNode }): React.JSX.Element {
  return <div className="field"><label htmlFor={id}>{label}</label><select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as T)}>{options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}</select><p className="field-help">{description}</p>{meta}</div>;
}

export function CenteredState({ title, detail, busy = false, tone = "neutral", children }: { title: string; detail: string; busy?: boolean; tone?: "neutral" | "error"; children?: ReactNode }): React.JSX.Element {
  return <main className="centered-state" role={tone === "error" ? "alert" : "status"}><div className={`state-icon ${tone}`} aria-hidden="true">{busy ? "" : "!"}</div><h1>{title}</h1><p>{detail}</p>{children}</main>;
}

export function backendPresentation(backend: AdminBackendRuntime | undefined): { value: string; tone: "success" | "warning" | "danger" | "neutral" } {
  const state = backend?.state;
  const labels: Record<AdminBackendState, string> = { unmanaged: "外部管理", stopped: "已停止", starting: "启动中", running: "运行中", restarting: "重启中", failed: "故障", unknown: "未知" };
  if (!state) return { value: "状态未提供", tone: "neutral" };
  return { value: labels[state], tone: state === "running" ? "success" : state === "failed" || state === "stopped" ? "danger" : state === "starting" || state === "restarting" ? "warning" : "neutral" };
}

export function backendDetail(backend: AdminBackendRuntime | undefined): string {
  if (!backend) return "当前服务未提供运行时管理信息。";
  if (backend.lastError) return backend.lastError;
  if (!backend.managed) return "服务由当前面板之外的进程管理。";
  return [backend.supervisor, backend.label].filter(Boolean).join(" · ") || "可由此面板安全重启。";
}

export function tunnelPresentation(status: AdminStatusResponse): { value: string; tone: "success" | "warning" | "danger" | "neutral" } {
  const tunnel = status.tunnel;
  if (!tunnel) return { value: status.publicBaseUrl ? "未检测" : "未配置", tone: "neutral" };
  if (!tunnel.configured) return { value: "未配置", tone: "neutral" };
  if (tunnel.ready) return { value: "可访问", tone: "success" };
  return { value: tunnel.reachable ? "响应异常" : "不可访问", tone: tunnel.reachable ? "warning" : "danger" };
}

export function tunnelDetail(status: AdminStatusResponse): string {
  const tunnel = status.tunnel;
  if (!tunnel) return status.publicBaseUrl ? "等待下一次状态检测。" : "尚未设置公网地址。";
  if (tunnel.error === "unreachable") return "公网 /readyz 无法访问。";
  if (tunnel.error === "unsafe_destination") return "已阻止指向本机或私有网络的公网探测。";
  if (tunnel.error) return tunnel.error;
  const parts = [tunnel.hostname, tunnel.status ? `HTTP ${tunnel.status}` : undefined, tunnel.latencyMs !== undefined ? `${tunnel.latencyMs} ms` : undefined];
  return parts.filter(Boolean).join(" · ") || "没有更多检测信息。";
}

export function mcpDetail(status: AdminStatusResponse): string {
  if (status.mcp.error) return status.mcp.error === "unreachable" ? "本地 MCP 端点无法访问。" : status.mcp.error;
  const parts = [status.mcp.status ? `HTTP ${status.mcp.status}` : undefined, status.mcp.latencyMs !== undefined ? `${status.mcp.latencyMs} ms` : undefined, status.mcp.checkedAt ? `检测于 ${formatTimestamp(status.mcp.checkedAt)}` : undefined];
  return parts.filter(Boolean).join(" · ") || "本地端点检测完成。";
}

export function adminDetail(status: AdminStatusResponse): string {
  const parts = [status.admin.version ? `v${status.admin.version}` : undefined, status.admin.startedAt ? `启动于 ${new Date(status.admin.startedAt).toLocaleString()}` : undefined];
  return parts.filter(Boolean).join(" · ") || (status.admin.ready ? "已就绪" : "未就绪");
}

export function formatTimestamp(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
