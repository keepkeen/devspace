import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import type {
  AdminConfig,
  AdminConfigEnvelope,
  AdminConfigSavedResponse,
  AdminDiagnosticsResponse,
  AdminErrorResponse,
  AdminResourceLimits,
  AdminRestartResponse,
  AdminSessionResponse,
  AdminStatusResponse,
  AdminValidationIssue,
  WidgetMode,
} from "./admin-types.js";
import {
  AddField,
  CenteredState,
  FieldMeta,
  SectionHeading,
  SelectField,
  StatusCard,
  UsageCard,
  adminDetail,
  backendDetail,
  backendPresentation,
  formatTimestamp,
  mcpDetail,
  tunnelDetail,
  tunnelPresentation,
} from "./admin-view.js";
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
      revision: string;
      rootsRevision: string;
    }
  | { phase: "error"; message: string };

type SaveState =
  | { phase: "idle" }
  | { phase: "saving" | "restarting" }
  | { phase: "success"; restartRequired: boolean; restarted: boolean }
  | { phase: "error"; message: string; issues: AdminValidationIssue[]; configSaved: boolean; conflict?: boolean };

const resourceFields: Array<{
  key: keyof AdminResourceLimits;
  label: string;
  description: string;
  displaySeconds?: boolean;
  unit?: string;
}> = [
  { key: "maxMcpSessions", label: "MCP 会话上限", description: "同时保持的 MCP 客户端连接数。" },
  { key: "maxProcessSessions", label: "进程会话总上限", description: "所有 Project 合计可运行的终端进程数。" },
  { key: "maxProcessSessionsPerWorkspace", label: "单 Project 进程上限", description: "单个 Project 可同时占用的终端进程数。" },
  { key: "maxProcessOutputFileBytes", label: "单份进程输出上限", description: "单个进程可持久化的完整输出字节数。", unit: "字节" },
  { key: "maxProcessOutputStorageBytes", label: "进程输出存储总上限", description: "所有持久化进程输出合计可占用的字节数。", unit: "字节" },
  { key: "completedProcessOutputTtlMs", label: "已完成输出保留时间", description: "进程结束后完整输出继续保留的时间。", displaySeconds: true, unit: "秒" },
  { key: "maxCommandRuntimeMs", label: "命令最长运行时间", description: "命令达到此时间后会被终止。", displaySeconds: true, unit: "秒" },
  { key: "maxResidentWorkspaces", label: "驻留 Project 运行时上限", description: "内存中保留的 Project 运行时数量。" },
  { key: "maxRequestBodyBytes", label: "MCP 请求体上限", description: "单个 MCP JSON 请求的最大字节数；必须容纳转义后的最大 patch。", unit: "字节" },
];

const builtinInstructionFilenames = new Set([
  "AGENTS.override.md", "AGENTS.override.MD", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD",
]);

const widgetModeLabels: Record<WidgetMode, string> = { full: "完整显示", changes: "仅文件变更", off: "关闭" };

function AdminApp(): React.JSX.Element {
  const [boot, setBoot] = useState<BootState>({ phase: "loading" });
  const capabilityRef = useRef(readCapability());
  const bootingRef = useRef(false);
  const bootReadyRef = useRef(false);

  const bootstrap = useCallback(async (): Promise<void> => {
    if (bootingRef.current || bootReadyRef.current) return;
    bootingRef.current = true;
    setBoot({ phase: "loading" });
    try {
      let session: AdminSessionResponse;
      try {
        const capability = capabilityRef.current;
        session = await requestJson<AdminSessionResponse>("/api/session", {
          method: "POST",
          headers: capability ? { "X-DevSpace-Admin-Capability": capability } : undefined,
        });
        capabilityRef.current = null;
      } catch (error) {
        if (error instanceof ApiFailure) capabilityRef.current = null;
        throw error;
      }
      const [status, configPayload] = await Promise.all([
        requestJson<AdminStatusResponse>("/api/status"),
        requestJson<AdminConfigEnvelope>("/api/config"),
      ]);
      bootReadyRef.current = true;
      setBoot({
        phase: "ready",
        csrfToken: session.csrfToken,
        status,
        config: normalizeConfig(configPayload.config),
        overrides: configPayload.overrides ?? [],
        warnings: configPayload.warnings ?? {},
        revision: configPayload.revision,
        rootsRevision: configPayload.rootsRevision,
      });
    } catch (error) {
      setBoot({ phase: "error", message: errorMessage(error) });
    } finally {
      bootingRef.current = false;
    }
  }, []);

  useEffect(() => {
    clearFragment();
    void bootstrap();
    const recover = (): void => { void bootstrap(); };
    window.addEventListener("online", recover);
    return () => window.removeEventListener("online", recover);
  }, [bootstrap]);

  if (boot.phase === "loading") {
    return <CenteredState title="正在连接 DevSpace…" detail="正在建立本地管理会话。" busy />;
  }
  if (boot.phase === "error") {
    return <CenteredState title="无法打开管理面板" detail={boot.message} tone="error"><button type="button" className="secondary-button" onClick={() => void bootstrap()}>重试连接</button></CenteredState>;
  }
  return <AdminForm {...boot} initialConfig={boot.config} initialOverrides={boot.overrides} initialWarnings={boot.warnings} initialRevision={boot.revision} />;
}

function AdminForm({
  initialConfig,
  status: initialStatus,
  csrfToken,
  initialOverrides,
  initialWarnings,
  initialRevision,
  rootsRevision: initialRootsRevision,
}: {
  initialConfig: AdminConfig;
  status: AdminStatusResponse;
  csrfToken: string;
  initialOverrides: string[];
  initialWarnings: Record<string, string>;
  initialRevision: string;
  rootsRevision: string;
}): React.JSX.Element {
  const [config, setConfig] = useState(() => cloneConfig(initialConfig));
  const [savedConfig, setSavedConfig] = useState(() => cloneConfig(initialConfig));
  const [newRoot, setNewRoot] = useState("");
  const [newFilename, setNewFilename] = useState("");
  const [rootError, setRootError] = useState<string | null>(null);
  const [filenameError, setFilenameError] = useState<string | null>(null);
  const [overrides, setOverrides] = useState(initialOverrides);
  const [warnings, setWarnings] = useState(initialWarnings);
  const [savedWarnings, setSavedWarnings] = useState(initialWarnings);
  const [revision, setRevision] = useState(initialRevision);
  const [savedRootsRevision, setSavedRootsRevision] = useState(initialRootsRevision);
  const [saveState, setSaveState] = useState<SaveState>({ phase: "idle" });
  const [status, setStatus] = useState(initialStatus);
  const [statusRefresh, setStatusRefresh] = useState<"idle" | "loading" | "error">("idle");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [restartConfirmationOpen, setRestartConfirmationOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<AdminDiagnosticsResponse | null>(null);
  const [diagnosticsState, setDiagnosticsState] = useState<"loading" | "ready" | "error">("loading");
  const [revokeArmed, setRevokeArmed] = useState(false);
  const [revokeState, setRevokeState] = useState<"idle" | "working" | "success" | "error">("idle");
  const restartTriggerRef = useRef<HTMLButtonElement>(null);
  const restartDialogRef = useRef<HTMLElement>(null);

  const dirty = useMemo(
    () =>
      JSON.stringify(config) !== JSON.stringify(savedConfig) ||
      newRoot.trim().length > 0 ||
      newFilename.trim().length > 0,
    [config, savedConfig, newRoot, newFilename],
  );
  const rootsOnlyDirty = useMemo(() => {
    if (!dirty || newRoot.trim() || newFilename.trim()) return false;
    return JSON.stringify({ ...config, allowedRoots: savedConfig.allowedRoots }) === JSON.stringify(savedConfig);
  }, [config, dirty, newFilename, newRoot, savedConfig]);
  const issuesByPath = useMemo(() => {
    if (saveState.phase !== "error") return new Map<string, string[]>();
    const result = new Map<string, string[]>();
    for (const issue of saveState.issues) {
      const path = issuePath(issue);
      result.set(path, [...(result.get(path) ?? []), issue.message]);
    }
    return result;
  }, [saveState]);
  const activeRuntimeConfig = diagnostics?.diagnostics.runtimeConfig;
  const widgetConfigMismatch = Boolean(
    activeRuntimeConfig &&
    activeRuntimeConfig.widgets !== savedConfig.widgets,
  );
  const rootsPolicyMismatch = Boolean(
    activeRuntimeConfig?.allowedRootsRevision &&
    activeRuntimeConfig.allowedRootsRevision !== savedRootsRevision,
  );
  const rootsCleanupPending = (activeRuntimeConfig?.allowedRootsCleanupPending ?? 0) > 0;
  const backend = status.runtime?.backend;
  const canRestart = Boolean(backend?.managed && backend.actions?.includes("restart"));

  useEffect(() => {
    if (!dirty) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [dirty]);

  useEffect(() => {
    if (!restartConfirmationOpen) return;
    const dialog = restartDialogRef.current;
    const background = document.querySelector<HTMLElement>(".settings-form");
    if (!dialog) return;
    background?.setAttribute("inert", "");
    const focusable = [...dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )];
    focusable[0]?.focus();
    const handleDialogKeys = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setRestartConfirmationOpen(false);
        return;
      }
      if (event.key !== "Tab" || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleDialogKeys);
    return () => {
      window.removeEventListener("keydown", handleDialogKeys);
      background?.removeAttribute("inert");
      restartTriggerRef.current?.focus();
    };
  }, [restartConfirmationOpen]);

  function beginEdit(paths: string[] = []): void {
    setSaveState({ phase: "idle" });
    if (paths.length > 0) {
      setWarnings((current) => Object.fromEntries(Object.entries(current).filter(([path]) => !paths.some((prefix) => path === prefix || path.startsWith(`${prefix}.`)))));
    }
  }

  function addRoot(): void {
    const path = newRoot.trim();
    if (!path) return setRootError("请输入目录路径。");
    if (config.allowedRoots.includes(path)) return setRootError("这个目录已经在允许列表中。");
    setConfig((current) => ({ ...current, allowedRoots: [...current.allowedRoots, path] }));
    setNewRoot("");
    setRootError(null);
    beginEdit(["allowedRoots"]);
  }

  function removeRoot(index: number): void {
    if (config.allowedRoots.length <= 1) return setRootError("至少需要保留一个允许访问的目录。");
    setConfig((current) => ({ ...current, allowedRoots: current.allowedRoots.filter((_, itemIndex) => itemIndex !== index) }));
    setRootError(null);
    beginEdit(["allowedRoots"]);
  }

  function addFilename(): void {
    const filename = newFilename.trim();
    if (!filename) return setFilenameError("请输入文件名。");
    if (filename.length > 128) return setFilenameError("文件名不能超过 128 个字符。");
    if (filename.includes("/") || filename.includes("\\")) return setFilenameError("请输入文件名，不要包含目录路径。");
    if (builtinInstructionFilenames.has(filename)) return setFilenameError("这是内置说明文件名，不需要加入回退列表。");
    if (config.projectDocFallbackFilenames.length >= 16) return setFilenameError("最多可配置 16 个回退文件名。");
    if (config.projectDocFallbackFilenames.includes(filename)) return setFilenameError("这个文件名已经在回退列表中。");
    setConfig((current) => ({ ...current, projectDocFallbackFilenames: [...current.projectDocFallbackFilenames, filename] }));
    setNewFilename("");
    setFilenameError(null);
    beginEdit(["projectDocFallbackFilenames"]);
  }

  function removeFilename(index: number): void {
    setConfig((current) => ({ ...current, projectDocFallbackFilenames: current.projectDocFallbackFilenames.filter((_, itemIndex) => itemIndex !== index) }));
    beginEdit(["projectDocFallbackFilenames"]);
  }

  function updateResource(key: keyof AdminResourceLimits, displayedValue: string, seconds: boolean): void {
    const parsed = Number(displayedValue);
    setConfig((current) => ({ ...current, resources: { ...current.resources, [key]: seconds ? parsed * 1_000 : parsed } }));
    beginEdit([`resources.${key}`]);
  }

  function discardChanges(): void {
    setConfig(cloneConfig(savedConfig));
    setNewRoot("");
    setNewFilename("");
    setRootError(null);
    setFilenameError(null);
    setWarnings(savedWarnings);
    setSaveState({ phase: "idle" });
  }

  async function refreshStatus(): Promise<AdminStatusResponse | null> {
    setStatusRefresh("loading");
    try {
      const next = await requestJson<AdminStatusResponse>("/api/status");
      setStatus(next);
      setStatusRefresh("idle");
      return next;
    } catch {
      setStatusRefresh("error");
      return null;
    }
  }

  async function refreshDiagnostics(): Promise<void> {
    setDiagnosticsState("loading");
    try {
      const nextDiagnostics =
        await requestJson<AdminDiagnosticsResponse>("/api/diagnostics");
      setDiagnostics(nextDiagnostics);
      setDiagnosticsState("ready");
    } catch {
      setDiagnosticsState("error");
    }
  }

  async function reloadConfig(): Promise<void> {
    try {
      const payload = await requestJson<AdminConfigEnvelope>("/api/config");
      const normalized = normalizeConfig(payload.config);
      setConfig(cloneConfig(normalized));
      setSavedConfig(cloneConfig(normalized));
      setRevision(payload.revision);
      setSavedRootsRevision(payload.rootsRevision);
      setOverrides(payload.overrides ?? []);
      setWarnings(payload.warnings ?? {});
      setSavedWarnings(payload.warnings ?? {});
      setSaveState({ phase: "idle" });
    } catch (error) {
      setSaveState({ phase: "error", message: errorMessage(error), issues: [], configSaved: false });
    }
  }

  async function revokeAllClientsAndTokens(): Promise<void> {
    const token = diagnostics?.security.confirmationToken;
    if (!token) return;
    setRevokeState("working");
    try {
      await requestJson("/api/security/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-DevSpace-Admin-CSRF": csrfToken },
        body: JSON.stringify({
          confirmation: "revoke_all_clients_and_tokens",
          confirmationToken: token,
        }),
      });
      setRevokeArmed(false);
      setRevokeState("success");
      await refreshDiagnostics();
    } catch {
      setRevokeState("error");
    }
  }

  useEffect(() => {
    void refreshDiagnostics();
    const recover = (): void => {
      void refreshStatus();
      void refreshDiagnostics();
    };
    window.addEventListener("online", recover);
    return () => window.removeEventListener("online", recover);
  }, []);

  async function copyPublicUrl(): Promise<void> {
    if (!status.publicBaseUrl) return;
    try {
      await navigator.clipboard.writeText(status.publicBaseUrl);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1_800);
    } catch {
      setCopyState("error");
    }
  }

  async function save(restartAfterSave: boolean): Promise<void> {
    if (newRoot.trim() || newFilename.trim()) {
      if (newRoot.trim()) setRootError("请先点击“添加”，再保存设置。");
      if (newFilename.trim()) setFilenameError("请先点击“添加”，再保存设置。");
      return;
    }
    let configSaved = false;
    let restartRequested = false;
    let restartRequired = saveState.phase === "success" ? saveState.restartRequired : false;
    setSaveState({ phase: "saving" });
    try {
      if (dirty) {
        const result = await requestJson<AdminConfigSavedResponse>("/api/config", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "If-Match": `"${revision}"`,
            "X-DevSpace-Admin-CSRF": csrfToken,
          },
          body: JSON.stringify({ config }),
        });
        const normalized = normalizeConfig(result.config);
        setConfig(cloneConfig(normalized));
        setSavedConfig(cloneConfig(normalized));
        setOverrides(result.overrides ?? overrides);
        setWarnings(result.warnings ?? {});
        setSavedWarnings(result.warnings ?? {});
        setRevision(result.revision);
        setSavedRootsRevision(result.rootsRevision);
        restartRequired = result.restartRequired;
        configSaved = true;
        void refreshDiagnostics();
      }

      if (restartAfterSave) {
        const latestStatus = await refreshStatus();
        const latestBackend = latestStatus?.runtime?.backend;
        const token = latestBackend?.managed && latestBackend.actions.includes("restart")
          ? latestBackend.confirmationToken
          : undefined;
        if (!token) throw new Error("重启确认已过期，请刷新状态后重试。");
        setSaveState({ phase: "restarting" });
        await requestJson<AdminRestartResponse>("/api/runtime/backend/restart", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-DevSpace-Admin-CSRF": csrfToken },
          body: JSON.stringify({ confirmation: "restart", confirmationToken: token }),
        });
        restartRequested = true;
        if (!(await waitForBackendRecovery())) {
          throw new Error("重启请求已提交，但服务未在等待时间内恢复，请查看概览状态。");
        }
        setSaveState({ phase: "success", restartRequired: false, restarted: true });
        return;
      }
      setSaveState({ phase: "success", restartRequired, restarted: false });
    } catch (error) {
      setSaveState({
        phase: "error",
        message: errorMessage(error),
        issues: error instanceof ApiFailure ? error.issues : [],
        configSaved: configSaved || restartRequested,
        conflict: error instanceof ApiFailure && error.status === 412,
      });
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void save(false);
  }

  async function waitForBackendRecovery(): Promise<boolean> {
    for (const delayMs of [800, 1_200, 1_800, 2_500, 3_500, 5_000]) {
      await delay(delayMs);
      const next = await refreshStatus();
      if (
        next?.mcp.ready &&
        next.runtime?.backend?.state === "running" &&
        !next.runtime.backend.lastError
      ) {
        await refreshDiagnostics();
        return true;
      }
    }
    return false;
  }

  return (
    <div className="admin-shell">
      <header className="page-header">
        <div className="brand-mark" aria-hidden="true">DS</div>
        <div className="header-copy">
          <p className="eyebrow">DEVSPACE · LOCAL ADMIN</p>
          <h1>管理控制面板</h1>
          <p className="page-intro">查看连接状态，管理本机访问范围与运行限制。</p>
        </div>
        <nav className="section-nav" aria-label="设置区段">
          <a href="#overview">概览</a><a href="#runtime">运行情况</a><a href="#access">访问</a><a href="#tools">工具与说明</a><a href="#limits">限制</a>
        </nav>
      </header>

      <form className="settings-form" onSubmit={submit}>
        <section className="panel overview-panel" id="overview" aria-labelledby="overview-heading">
          <SectionHeading kicker="OVERVIEW" title="概览" description="服务、隧道与公开连接状态。">
            <button type="button" className="quiet-button" onClick={() => void refreshStatus()} disabled={statusRefresh === "loading"}>
              {statusRefresh === "loading" ? "刷新中…" : "刷新状态"}
            </button>
          </SectionHeading>
          {statusRefresh === "error" && <div className="inline-banner error" role="alert">状态刷新失败，当前仍显示上一次结果。</div>}
          <div className="health-grid">
            <StatusCard label="DevSpace 后端" {...backendPresentation(backend)} detail={backendDetail(backend)} />
            <StatusCard label="公网隧道" {...tunnelPresentation(status)} detail={tunnelDetail(status)} />
            <StatusCard label="MCP 服务" tone={status.mcp.ready ? "success" : "danger"} value={status.mcp.ready ? "已就绪" : "不可用"} detail={mcpDetail(status)} />
          </div>
          <div className="overview-details">
            <div className="detail-row public-url-row">
              <div><span>公网地址</span><strong className="mono" title={status.publicBaseUrl}>{status.publicBaseUrl || "未配置"}</strong></div>
              {status.publicBaseUrl && <div className="row-actions"><button type="button" className="text-button" onClick={() => void copyPublicUrl()}>{copyState === "copied" ? "已复制" : copyState === "error" ? "复制失败" : "复制"}</button><a className="text-button" href={status.publicBaseUrl} target="_blank" rel="noreferrer">打开</a></div>}
            </div>
            <div className="detail-row"><div><span>管理服务</span><strong>{adminDetail(status)}</strong></div></div>
            <div className="detail-row"><div><span>配置文件</span><strong className="mono" title={status.configPath}>{status.configPath || "未提供"}</strong></div></div>
          </div>
        </section>

        <section className="panel" id="runtime" aria-labelledby="runtime-heading">
          <SectionHeading kicker="RUNTIME" title="运行情况" description="当前 Project、进程、授权记录与最近失败。">
            <button type="button" className="quiet-button" onClick={() => void refreshDiagnostics()} disabled={diagnosticsState === "loading"}>
              {diagnosticsState === "loading" ? "刷新中…" : "刷新数据"}
            </button>
          </SectionHeading>
          {diagnosticsState === "error" && <div className="inline-banner error" role="alert">后端尚未提供内部诊断端点，或当前网络不可用。</div>}
          {diagnostics && <>
            {(diagnostics.diagnostics.usage?.oauth?.legacyWildcardGrants ?? 0) > 0 && <div className="inline-banner warning" role="alert">检测到 {diagnostics.diagnostics.usage?.oauth?.legacyWildcardGrants} 个遗留通配根授权。请重新执行 OAuth 授权并选择明确的项目根。</div>}
            {(diagnostics.diagnostics.observability?.audit?.auditWriteFailures ?? 0) > 0 && <div className="inline-banner warning" role="alert">安全审计持久化已失败 {diagnostics.diagnostics.observability?.audit?.auditWriteFailures} 次；最近一次为 {diagnostics.diagnostics.observability?.audit?.lastAuditWriteFailureAt ? formatTimestamp(diagnostics.diagnostics.observability.audit.lastAuditWriteFailureAt) : "未知时间"}。工具结果未受影响，但请检查本地 SQLite 状态和磁盘。</div>}
            <div className="usage-grid">
              <UsageCard label="MCP 会话" metric={diagnostics.diagnostics.usage?.mcpSessions} />
              <UsageCard label="进程会话" metric={diagnostics.diagnostics.usage?.processSessions} />
              <UsageCard label="进程输出字节" metric={diagnostics.diagnostics.usage?.processOutput} />
              <UsageCard label="驻留 Project 运行时" metric={diagnostics.diagnostics.usage?.workspaces} activeKey="resident" />
              <UsageCard label="Project 执行记录" metric={{ active: diagnostics.diagnostics.usage?.projectExecutions?.total ?? undefined }} />
              <UsageCard label="OAuth 注册" metric={{ active: diagnostics.diagnostics.usage?.oauth?.clients ?? undefined }} />
            </div>
            <div className="runtime-columns">
              <div className="subsection">
                <h3>最近失败</h3>
                {(diagnostics.diagnostics.recentFailures?.length ?? 0) > 0
                  ? <ul className="failure-list">{diagnostics.diagnostics.recentFailures?.map((failure, index) => <li key={`${failure.at ?? "failure"}-${index}`}><strong>{failure.event ?? "运行失败"}</strong><span>{[failure.category, failure.at ? formatTimestamp(failure.at) : undefined].filter(Boolean).join(" · ")}</span></li>)}</ul>
                  : <p className="empty-copy">没有最近失败记录。</p>}
              </div>
              <div className="subsection security-actions">
                <h3>诊断与安全</h3>
                <p>诊断包仅包含汇总信息，不含路径、客户端 ID、令牌或错误详情。</p>
                <div className="row-actions"><a className="secondary-button" href="/api/diagnostics/bundle" download>下载脱敏诊断包</a>{!revokeArmed && <button type="button" className="danger-button" onClick={() => { setRevokeArmed(true); setRevokeState("idle"); }}>撤销当前 ChatGPT 授权</button>}</div>
                {revokeArmed && <div className="danger-confirm" role="alert"><strong>当前 ChatGPT 授权及其令牌会立即失效。</strong><div className="row-actions"><button type="button" className="quiet-button" onClick={() => setRevokeArmed(false)} disabled={revokeState === "working"}>取消</button><button type="button" className="danger-button" onClick={() => void revokeAllClientsAndTokens()} disabled={revokeState === "working"}>{revokeState === "working" ? "正在撤销…" : "确认撤销"}</button></div></div>}
                {revokeState === "success" && <p className="field-help success" role="status">当前 ChatGPT 授权已撤销。</p>}
                {revokeState === "error" && <p className="field-error" role="alert">撤销失败；确认可能已过期，请刷新运行数据后重试。</p>}
              </div>
            </div>
          </>}
        </section>

        {overrides.length > 0 && <div className="notice warning" role="status"><strong>部分设置由环境变量控制。</strong> 锁定项会在字段旁标出来源，需要修改启动环境后重启。</div>}

        {saveState.phase === "success" && <div className="notice success" role="status"><strong>{saveState.restarted ? "重启请求已提交。" : "设置已保存。"}</strong> {!saveState.restarted && (saveState.restartRequired ? "需要重启后才能完全生效。" : "新设置已经生效。")}</div>}
        {saveState.phase === "error" && <div className="notice error" role="alert"><strong>{saveState.configSaved ? "设置已保存，但后续操作失败。" : "无法保存设置。"}</strong> {saveState.message}{saveState.conflict && <button type="button" className="text-button" onClick={() => void reloadConfig()}>放弃本地修改并载入最新配置</button>}{saveState.issues.length > 0 && <ul>{saveState.issues.map((issue, index) => <li key={`${issuePath(issue)}-${index}`}>{issuePath(issue) ? `${issuePath(issue)}：` : ""}{issue.message}</li>)}</ul>}</div>}

        <fieldset className="settings-fieldset" disabled={saveState.phase === "saving" || saveState.phase === "restarting"}>
        <section className="panel" id="access" aria-labelledby="access-heading">
          <SectionHeading kicker="ACCESS" title="访问" description="限制远程客户端可见的本机目录与项目说明文件。"><span className="count-badge">{config.allowedRoots.length}</span></SectionHeading>
          <div className="subsection">
            <div className="subsection-heading"><div><h3>允许访问的目录</h3><p>这是服务端的全局目录上限，不是单个 OAuth 授权。保存后会热加载，无需重启；授权能力还同时受 OAuth 根目录 ID 和 scopes 限制。</p></div><FieldMeta path="allowedRoots" overrides={overrides} warnings={warnings} issues={issuesByPath} /></div>
            {(rootsPolicyMismatch || rootsCleanupPending) && <div className="inline-banner warning" role="status"><strong>{rootsCleanupPending ? "目录权限已收紧，但后台清理尚未完成。" : "保存的目录权限尚未与运行中的后端一致。"}</strong> 后台会持续重试；在提示消失前，请勿依赖刚新增的目录，必要时可重启后端。</div>}
            <div className="item-list">
              {config.allowedRoots.map((root, index) => <div className="item-row" key={`${root}-${index}`}><div className="item-value"><code title={root}>{root}</code><FieldMeta path={`allowedRoots.${index}`} overrides={overrides} warnings={warnings} issues={issuesByPath} /></div><button type="button" className="remove-button" onClick={() => removeRoot(index)} aria-label={`移除目录 ${root}`} title={config.allowedRoots.length <= 1 ? "至少保留一个目录" : "会终止相关命令并清除受影响的 Project 绑定；不会删除任何项目文件"} disabled={overrides.includes("allowedRoots") || config.allowedRoots.length <= 1}>移除</button></div>)}
            </div>
            <AddField id="new-root" label="添加目录" value={newRoot} onChange={(value) => { setNewRoot(value); setRootError(null); }} onAdd={addRoot} placeholder="/Users/you/code/project" help={overrides.includes("allowedRoots") ? "DEVSPACE_ALLOWED_ROOTS 已锁定此项；请修改启动环境并重启后端。" : "请输入本机绝对路径。保存会立即扩大全局上限；现有授权仍需重新审批才能选择新增项目根。"} error={rootError} disabled={overrides.includes("allowedRoots")} />
            <p className="field-help">移除目录会终止相关命令并清除受影响的 Project 绑定，但绝不会删除项目文件。</p>
          </div>
          <div className="subsection divided">
            <div className="subsection-heading"><div><h3>用户级说明文件</h3><p>可选的单个本机说明文件，会先于项目 AGENTS.md 加载；留空不会读取 ~/.codex/AGENTS.md。保存后需重启后端。</p></div></div>
            <div className="field">
              <label htmlFor="user-instructions-path">说明文件路径</label>
              <input id="user-instructions-path" type="text" value={config.userInstructionsPath ?? ""} placeholder="~/.devspace/AGENTS.md" disabled={overrides.includes("userInstructionsPath")} aria-invalid={(issuesByPath.get("userInstructionsPath")?.length ?? 0) > 0} aria-describedby={`user-instructions-path-help${(issuesByPath.get("userInstructionsPath")?.length ?? 0) > 0 ? " user-instructions-path-errors" : ""}`} onChange={(event) => { setConfig((current) => ({ ...current, userInstructionsPath: event.target.value || null })); beginEdit(["userInstructionsPath"]); }} />
              <p id="user-instructions-path-help" className="field-help">支持 ~ 或绝对路径；文件必须已存在且可读。环境变量 DEVSPACE_USER_INSTRUCTIONS_PATH 会锁定此项。</p>
              <FieldMeta id="user-instructions-path-errors" path="userInstructionsPath" overrides={overrides} warnings={warnings} issues={issuesByPath} />
            </div>
          </div>
          <div className="subsection divided">
            <div className="subsection-heading"><div><h3>项目说明回退文件</h3><p>找不到 AGENTS.md 时，按顺序查找这些文件名；留空可关闭回退。</p></div><FieldMeta path="projectDocFallbackFilenames" overrides={overrides} warnings={warnings} issues={issuesByPath} /></div>
            {config.projectDocFallbackFilenames.length > 0 ? <div className="filename-list">{config.projectDocFallbackFilenames.map((filename, index) => <div className="filename-chip" key={`${filename}-${index}`}><span className="order-index">{index + 1}</span><code>{filename}</code><button type="button" aria-label={`移除回退文件 ${filename}`} onClick={() => removeFilename(index)} disabled={overrides.includes("projectDocFallbackFilenames")}>×</button><FieldMeta path={`projectDocFallbackFilenames.${index}`} overrides={overrides} warnings={warnings} issues={issuesByPath} /></div>)}</div> : <p className="empty-copy">未配置回退文件。</p>}
            <AddField id="new-filename" label="添加回退文件名" value={newFilename} onChange={(value) => { setNewFilename(value); setFilenameError(null); }} onAdd={addFilename} placeholder="TEAM_GUIDE.md" help="仅输入文件名，不要包含路径分隔符。" error={filenameError} disabled={overrides.includes("projectDocFallbackFilenames")} />
          </div>
        </section>

        <section className="panel" id="tools" aria-labelledby="tools-heading">
          <SectionHeading kicker="TOOLS & INSTRUCTIONS" title="工具与说明" description="控制 ChatGPT 中的结果卡片。" />
          {activeRuntimeConfig && <div className={`inline-banner ${widgetConfigMismatch ? "warning" : "neutral"}`} role="status">{widgetConfigMismatch ? <><strong>后端仍运行：结果卡片 {widgetModeLabels[activeRuntimeConfig.widgets]}；需重启。</strong></> : <>后端已运行当前保存的结果卡片配置。</>}</div>}
          <div className="field-grid">
            <SelectField<WidgetMode> id="widget-mode" label="结果卡片" value={config.widgets} description="完整显示包含 Project 选择卡和文件变更卡；仅文件变更不会显示 Project 选择卡。" options={[["full", "完整显示"], ["changes", "仅文件变更"], ["off", "关闭"]]} onChange={(value) => { setConfig((current) => ({ ...current, widgets: value })); beginEdit(["widgets"]); }} disabled={overrides.includes("widgets")} meta={<FieldMeta path="widgets" overrides={overrides} warnings={warnings} issues={issuesByPath} />} />
          </div>
        </section>

        <section className="panel" id="limits" aria-labelledby="limits-heading">
          <SectionHeading kicker="LIMITS" title="限制" description="为连接、进程和 Project 运行时设置本机资源边界。" />
          <div className="field-grid limits-grid">{resourceFields.map((field) => { const path = `resources.${field.key}`; const value = config.resources[field.key]; const invalid = (issuesByPath.get(path)?.length ?? 0) > 0; const errorId = `${field.key}-errors`; return <div className="field" key={field.key}><label htmlFor={field.key}>{field.label}</label><div className="number-input-wrap"><input id={field.key} type="number" min="1" step="1" required disabled={overrides.includes(path)} value={field.displaySeconds ? value / 1_000 : value} onChange={(event) => updateResource(field.key, event.target.value, Boolean(field.displaySeconds))} aria-invalid={invalid} aria-describedby={`${field.key}-help${invalid ? ` ${errorId}` : ""}`} />{field.unit && <span>{field.unit}</span>}</div><p id={`${field.key}-help`} className="field-help">{field.description}</p><FieldMeta id={invalid ? errorId : undefined} path={path} overrides={overrides} warnings={warnings} issues={issuesByPath} /></div>; })}</div>
        </section>
        </fieldset>

        <div className="save-bar">
          <div className="save-summary"><span className={dirty ? "dirty-dot" : "saved-dot"} aria-hidden="true" /><p aria-live="polite">{dirty ? "有尚未保存的修改" : "所有修改均已保存"}</p></div>
          <div className="save-actions"><button type="button" className="quiet-button" onClick={discardChanges} disabled={!dirty || saveState.phase === "saving" || saveState.phase === "restarting"}>放弃修改</button><button type="submit" className="secondary-button strong" disabled={!dirty || saveState.phase === "saving" || saveState.phase === "restarting"}>{saveState.phase === "saving" ? "保存中…" : "保存"}</button>{canRestart && !rootsOnlyDirty && <button ref={restartTriggerRef} type="button" className="primary-button" onClick={() => setRestartConfirmationOpen(true)} disabled={saveState.phase === "saving" || saveState.phase === "restarting"}>{saveState.phase === "restarting" ? "正在重启…" : dirty ? "保存并重启" : "重启服务"}</button>}</div>
        </div>
      </form>
      {restartConfirmationOpen && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setRestartConfirmationOpen(false);
        }}>
          <section ref={restartDialogRef} className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="restart-dialog-title" aria-describedby="restart-dialog-description">
            <p className="section-kicker">RUNTIME ACTION</p>
            <h2 id="restart-dialog-title">确认重启 DevSpace？</h2>
            <p id="restart-dialog-description">重启会断开当前 MCP 会话。若仍有 DevSpace 管理的命令在运行，后端会拒绝重启；请先等待命令结束或主动停止。管理面板会保持打开，并在服务恢复后自动更新状态。</p>
            {dirty && <div className="dialog-note">尚未保存的设置会先安全写入配置，再执行重启。</div>}
            <div className="dialog-actions">
              <button type="button" className="secondary-button" autoFocus onClick={() => setRestartConfirmationOpen(false)}>取消</button>
              <button type="button" className="danger-button" onClick={() => {
                setRestartConfirmationOpen(false);
                void save(true);
              }}>确认重启</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function readCapability(): string | null {
  const fragment = window.location.hash.slice(1);
  return fragment ? new URLSearchParams(fragment).get("capability") : null;
}

function clearFragment(): void {
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "same-origin", cache: "no-store" });
  const payload = await parseJson(response);
  if (!response.ok) {
    const error = payload as AdminErrorResponse | null;
    throw new ApiFailure(error?.error?.message ?? `请求失败（HTTP ${response.status}）。`, { status: response.status, issues: collectIssues(error) });
  }
  return payload as T;
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text) as unknown; } catch { throw new ApiFailure("服务器返回了无法识别的响应。", { status: response.status }); }
}

function collectIssues(error: AdminErrorResponse | null): AdminValidationIssue[] {
  const fields = error?.error?.fields ?? {};
  return Object.entries(fields).flatMap(([path, messages]) => (Array.isArray(messages) ? messages : [messages]).map((message) => ({ path, message })));
}

function issuePath(issue: AdminValidationIssue): string {
  return Array.isArray(issue.path) ? issue.path.join(".") : issue.path ?? "";
}

function normalizeConfig(config: AdminConfig): AdminConfig {
  return { ...config, allowedRoots: [...(config.allowedRoots ?? [])], projectDocFallbackFilenames: [...(config.projectDocFallbackFilenames ?? [])], resources: { ...config.resources } };
}

function cloneConfig(config: AdminConfig): AdminConfig {
  return normalizeConfig(config);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "发生了未知错误。";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => window.setTimeout(resolveDelay, ms));
}

const container = document.querySelector<HTMLElement>("#admin-app");
if (!container) throw new Error("Missing #admin-app root element.");
createRoot(container).render(<AdminApp />);
