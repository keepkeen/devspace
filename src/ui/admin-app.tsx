import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import type {
  AdminConfig,
  AdminConfigEnvelope,
  AdminConfigSavedResponse,
  AdminErrorResponse,
  AdminResourceLimits,
  AdminSessionResponse,
  AdminStatusResponse,
  AdminValidationIssue,
  ToolMode,
  WidgetMode,
} from "./admin-types.js";
import "./admin-app.css";

interface ApiFailureOptions {
  status: number;
  issues?: AdminValidationIssue[];
}

class ApiFailure extends Error {
  readonly status: number;
  readonly issues: AdminValidationIssue[];

  constructor(message: string, options: ApiFailureOptions) {
    super(message);
    this.name = "ApiFailure";
    this.status = options.status;
    this.issues = options.issues ?? [];
  }
}

type BootState =
  | { phase: "loading" }
  | {
      phase: "ready";
      csrfToken: string;
      status: AdminStatusResponse;
      config: AdminConfig;
      overrides: string[];
      warnings: Record<string, string>;
    }
  | { phase: "error"; message: string };

const resourceFields: Array<{
  key: keyof AdminResourceLimits;
  label: string;
  description: string;
  displaySeconds?: boolean;
}> = [
  {
    key: "maxMcpSessions",
    label: "MCP 会话上限",
    description: "允许同时保持的网页端 MCP 连接数。",
  },
  {
    key: "maxProcessSessions",
    label: "进程会话总上限",
    description: "所有 workspace 合计可运行的终端进程数。",
  },
  {
    key: "maxProcessSessionsPerWorkspace",
    label: "单 workspace 进程上限",
    description: "限制单个 workspace 同时占用的终端进程数。",
  },
  {
    key: "maxCommandRuntimeMs",
    label: "单条命令最长运行时间",
    description: "命令达到此时间后会被终止。",
    displaySeconds: true,
  },
  {
    key: "maxResidentWorkspaces",
    label: "驻留 workspace 上限",
    description: "内存中保留的 workspace 会话数量。",
  },
  {
    key: "maxManagedWorktrees",
    label: "托管 worktree 上限",
    description: "DevSpace 同时维护的 Git worktree 数量。",
  },
];

function AdminApp(): React.JSX.Element {
  const [boot, setBoot] = useState<BootState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const capability = readCapability();
      clearFragment();

      try {
        const session = await requestJson<AdminSessionResponse>("/api/session", {
          method: "POST",
          headers: capability
            ? { "X-DevSpace-Admin-Capability": capability }
            : undefined,
        });

        const [status, configPayload] = await Promise.all([
          requestJson<AdminStatusResponse>("/api/status"),
          requestJson<AdminConfigEnvelope>("/api/config"),
        ]);

        if (!cancelled) {
          setBoot({
            phase: "ready",
            csrfToken: session.csrfToken,
            status,
            config: configPayload.config,
            overrides: configPayload.overrides ?? [],
            warnings: configPayload.warnings ?? {},
          });
        }
      } catch (error) {
        if (!cancelled) {
          setBoot({ phase: "error", message: errorMessage(error) });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (boot.phase === "loading") {
    return <CenteredState title="正在连接 DevSpace…" detail="正在建立本地管理会话。" busy />;
  }

  if (boot.phase === "error") {
    return <CenteredState title="无法打开管理面板" detail={boot.message} tone="error" />;
  }

  return (
    <AdminForm
      initialConfig={boot.config}
      status={boot.status}
      csrfToken={boot.csrfToken}
      initialOverrides={boot.overrides}
      initialWarnings={boot.warnings}
    />
  );
}

function AdminForm({
  initialConfig,
  status,
  csrfToken,
  initialOverrides,
  initialWarnings,
}: {
  initialConfig: AdminConfig;
  status: AdminStatusResponse;
  csrfToken: string;
  initialOverrides: string[];
  initialWarnings: Record<string, string>;
}): React.JSX.Element {
  const [config, setConfig] = useState<AdminConfig>(() => cloneConfig(initialConfig));
  const [savedConfig, setSavedConfig] = useState<AdminConfig>(() => cloneConfig(initialConfig));
  const [newRoot, setNewRoot] = useState("");
  const [rootError, setRootError] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<string[]>(initialOverrides);
  const [warnings, setWarnings] = useState<Record<string, string>>(initialWarnings);
  const [saveState, setSaveState] = useState<
    | { phase: "idle" }
    | { phase: "saving" }
    | { phase: "success"; restartRequired: boolean }
    | { phase: "error"; message: string; issues: AdminValidationIssue[] }
  >({ phase: "idle" });

  const dirty = useMemo(
    () => JSON.stringify(config) !== JSON.stringify(savedConfig),
    [config, savedConfig],
  );

  function addRoot(): void {
    const path = newRoot.trim();
    if (!path) {
      setRootError("请输入目录路径。");
      return;
    }
    if (config.allowedRoots.includes(path)) {
      setRootError("这个目录已经在允许列表中。");
      return;
    }

    setConfig((current) => ({
      ...current,
      allowedRoots: [...current.allowedRoots, path],
    }));
    setNewRoot("");
    setRootError(null);
    setWarnings({});
    setSaveState({ phase: "idle" });
  }

  function removeRoot(index: number): void {
    setConfig((current) => ({
      ...current,
      allowedRoots: current.allowedRoots.filter((_, rootIndex) => rootIndex !== index),
    }));
    setWarnings({});
    setSaveState({ phase: "idle" });
  }

  function updateResource(key: keyof AdminResourceLimits, displayedValue: string, seconds: boolean): void {
    const parsed = Number(displayedValue);
    setConfig((current) => ({
      ...current,
      resources: {
        ...current.resources,
        [key]: seconds ? parsed * 1_000 : parsed,
      },
    }));
    setSaveState({ phase: "idle" });
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaveState({ phase: "saving" });

    try {
      const result = await requestJson<AdminConfigSavedResponse>("/api/config", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-DevSpace-Admin-CSRF": csrfToken,
        },
        body: JSON.stringify({ config }),
      });
      setConfig(cloneConfig(result.config));
      setSavedConfig(cloneConfig(result.config));
      setOverrides(result.overrides ?? overrides);
      setWarnings(result.warnings ?? {});
      setSaveState({ phase: "success", restartRequired: result.restartRequired });
    } catch (error) {
      setSaveState({
        phase: "error",
        message: errorMessage(error),
        issues: error instanceof ApiFailure ? error.issues : [],
      });
    }
  }

  return (
    <div className="admin-shell">
      <header className="page-header">
        <div className="brand-mark" aria-hidden="true">D</div>
        <div>
          <p className="eyebrow">LOCAL ADMIN</p>
          <h1>DevSpace 管理面板</h1>
          <p className="page-intro">管理网页端可访问的本地目录和服务运行限制。</p>
        </div>
      </header>

      <section className="status-grid" aria-label="服务信息">
        <InfoItem
          label="DevSpace 本地服务"
          value={status.mcp.ready ? "已就绪" : "未就绪"}
          tone={status.mcp.ready ? "success" : "danger"}
        />
        <InfoItem
          label="公网地址（仅显示）"
          value={status.publicBaseUrl || "未配置"}
          mono
        />
        <InfoItem label="配置文件" value={status.configPath || "未提供"} mono />
      </section>

      <form className="settings-form" onSubmit={(event) => void save(event)}>
        {overrides.length > 0 && (
          <div className="notice warning" role="status">
            <strong>部分设置由启动环境控制。</strong> 已锁定的项目不能在这里修改；请调整对应环境变量后再重启 DevSpace。
          </div>
        )}

        {Object.keys(warnings).length > 0 && (
          <div className="notice warning" role="status">
            <strong>当前配置中有需要修复的项目。</strong>
            <ul>
              {Object.entries(warnings).map(([path, message]) => (
                <li key={path}>{path}：{message}</li>
              ))}
            </ul>
          </div>
        )}

        {saveState.phase === "success" && (
          <div className="notice success" role="status">
            <strong>设置已保存。</strong>{" "}
            {saveState.restartRequired
              ? "需要重启 DevSpace 后生效；当前连接不会被自动中断。"
              : "新设置已经生效。"}
          </div>
        )}

        {saveState.phase === "error" && (
          <div className="notice error" role="alert">
            <strong>无法保存设置。</strong> {saveState.message}
            {saveState.issues.length > 0 && (
              <ul>
                {saveState.issues.map((issue, index) => (
                  <li key={`${issuePath(issue)}-${index}`}>
                    {issuePath(issue) ? `${issuePath(issue)}：` : ""}{issue.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <section className="settings-card" aria-labelledby="roots-heading">
          <div className="section-heading">
            <div>
              <h2 id="roots-heading">允许访问的目录</h2>
              <p>只有列表中的目录及其子目录能被网页端读取和修改。</p>
            </div>
            <span className="count-badge">{config.allowedRoots.length}</span>
          </div>

          <div className="root-list">
            {config.allowedRoots.length === 0 && (
              <p className="empty-list">当前没有允许访问的目录。</p>
            )}
            {config.allowedRoots.map((root, index) => (
              <div className="root-row" key={`${root}-${index}`}>
                <div className="root-path">
                  <code title={root}>{root}</code>
                  {warnings[`allowedRoots.${index}`] && (
                    <span className="field-error">目录不存在或已不可用</span>
                  )}
                </div>
                <button
                  type="button"
                  className="remove-button"
                  onClick={() => removeRoot(index)}
                  aria-label={`移除目录 ${root}`}
                  disabled={overrides.includes("allowedRoots")}
                >
                  移除
                </button>
              </div>
            ))}
          </div>

          <div className="add-root-block">
            <div className="add-root-form">
              <label htmlFor="new-root">添加目录</label>
              <div className="input-action-row">
                <input
                  id="new-root"
                  type="text"
                  value={newRoot}
                  onChange={(event) => {
                    setNewRoot(event.target.value);
                    setRootError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addRoot();
                    }
                  }}
                  placeholder="/Users/you/code/project"
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby={rootError ? "new-root-error" : "new-root-help"}
                  aria-invalid={Boolean(rootError)}
                  disabled={overrides.includes("allowedRoots")}
                />
                <button
                  type="button"
                  className="secondary-button"
                  onClick={addRoot}
                  disabled={overrides.includes("allowedRoots")}
                >添加</button>
              </div>
              <p id="new-root-help" className="field-help">请输入本机目录的绝对路径。</p>
              {rootError && <p id="new-root-error" className="field-error">{rootError}</p>}
            </div>
          </div>
        </section>

        <section className="settings-card" aria-labelledby="modes-heading">
          <div className="section-heading">
            <div>
              <h2 id="modes-heading">工具与界面</h2>
              <p>控制模型可用的工具集合，以及 ChatGPT 中显示的结果卡片。</p>
            </div>
          </div>

          <div className="field-grid two-columns">
            <SelectField<ToolMode>
              id="tool-mode"
              label="工具模式"
              value={config.toolMode}
              description="Codex 模式适合在 ChatGPT 网页端直接操作本地文件。"
              options={[
                ["codex", "Codex"],
                ["full", "完整"],
                ["minimal", "精简"],
              ]}
              onChange={(value) => {
                setConfig((current) => ({ ...current, toolMode: value }));
                setSaveState({ phase: "idle" });
              }}
              disabled={overrides.includes("toolMode")}
            />
            <SelectField<WidgetMode>
              id="widget-mode"
              label="结果卡片"
              value={config.widgets}
              description="控制聊天界面中工具调用详情和文件变更的展示。"
              options={[
                ["full", "完整显示"],
                ["changes", "仅文件变更"],
                ["off", "关闭"],
              ]}
              onChange={(value) => {
                setConfig((current) => ({ ...current, widgets: value }));
                setSaveState({ phase: "idle" });
              }}
              disabled={overrides.includes("widgets")}
            />
          </div>
        </section>

        <section className="settings-card" aria-labelledby="limits-heading">
          <div className="section-heading">
            <div>
              <h2 id="limits-heading">资源限制</h2>
              <p>防止长时间连接或多个 workspace 占用过多本机资源。</p>
            </div>
          </div>

          <div className="field-grid limits-grid">
            {resourceFields.map((field) => {
              const value = config.resources[field.key];
              return (
                <div className="field" key={field.key}>
                  <label htmlFor={field.key}>{field.label}</label>
                  <div className="number-input-wrap">
                    <input
                      id={field.key}
                      type="number"
                      min="1"
                      step="1"
                      required
                      disabled={overrides.includes(`resources.${field.key}`)}
                      value={field.displaySeconds ? value / 1_000 : value}
                      onChange={(event) => updateResource(
                        field.key,
                        event.target.value,
                        Boolean(field.displaySeconds),
                      )}
                      aria-describedby={`${field.key}-help`}
                    />
                    {field.displaySeconds && <span>秒</span>}
                  </div>
                  <p id={`${field.key}-help`} className="field-help">{field.description}</p>
                </div>
              );
            })}
          </div>
        </section>

        <div className="save-bar">
          <p aria-live="polite">
            {dirty ? "有尚未保存的修改" : "所有修改均已保存"}
          </p>
          <button
            type="submit"
            className="primary-button"
            disabled={!dirty || saveState.phase === "saving"}
          >
            {saveState.phase === "saving" ? "正在保存…" : "保存设置"}
          </button>
        </div>
      </form>
    </div>
  );
}

function InfoItem({
  label,
  value,
  mono = false,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: "success" | "danger";
}): React.JSX.Element {
  return (
    <div className="info-item">
      <span>{label}</span>
      <strong className={`${mono ? "mono" : ""} ${tone ?? ""}`.trim()} title={value}>
        {tone && <i className="status-dot" aria-hidden="true" />}
        {value}
      </strong>
    </div>
  );
}

function SelectField<T extends string>({
  id,
  label,
  value,
  description,
  options,
  onChange,
  disabled = false,
}: {
  id: string;
  label: string;
  value: T;
  description: string;
  options: Array<readonly [T, string]>;
  onChange(value: T): void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>{optionLabel}</option>
        ))}
      </select>
      <p className="field-help">{description}</p>
    </div>
  );
}

function CenteredState({
  title,
  detail,
  busy = false,
  tone = "neutral",
}: {
  title: string;
  detail: string;
  busy?: boolean;
  tone?: "neutral" | "error";
}): React.JSX.Element {
  return (
    <main className="centered-state" role={tone === "error" ? "alert" : "status"}>
      <div className={`state-icon ${tone}`} aria-hidden="true">{busy ? "" : "!"}</div>
      <h1>{title}</h1>
      <p>{detail}</p>
    </main>
  );
}

function readCapability(): string | null {
  const fragment = window.location.hash.slice(1);
  if (!fragment) return null;
  return new URLSearchParams(fragment).get("capability");
}

function clearFragment(): void {
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
  });
  const payload = await parseJson(response);

  if (!response.ok) {
    const error = payload as AdminErrorResponse | null;
    throw new ApiFailure(
      error?.error?.message ?? `请求失败（HTTP ${response.status}）。`,
      { status: response.status, issues: collectIssues(error) },
    );
  }

  return payload as T;
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiFailure("服务器返回了无法识别的响应。", { status: response.status });
  }
}

function collectIssues(error: AdminErrorResponse | null): AdminValidationIssue[] {
  const fields = error?.error?.fields ?? {};
  return Object.entries(fields).flatMap(([path, messages]) =>
    (Array.isArray(messages) ? messages : [messages]).map((message) => ({ path, message })),
  );
}

function issuePath(issue: AdminValidationIssue): string {
  if (Array.isArray(issue.path)) return issue.path.join(".");
  return issue.path ?? "";
}

function cloneConfig(config: AdminConfig): AdminConfig {
  return {
    ...config,
    allowedRoots: [...config.allowedRoots],
    resources: { ...config.resources },
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "发生了未知错误。";
}

const container = document.querySelector<HTMLElement>("#admin-app");
if (!container) throw new Error("Missing #admin-app root element.");

createRoot(container).render(<AdminApp />);
