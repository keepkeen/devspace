import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  isExpandableCard,
  parsePrivateThreadList,
  toolResultCard,
  type HostContext,
  type PrivateProjectThread,
  type PrivateThreadStatus,
  type ProjectAppCard,
  type ProjectCardEntry,
  type ProjectListCard,
  type ResumableTaskCard,
  type ToolResultCard,
} from "./card-types.js";
import { renderIcon, toolIcons } from "./icons.js";
import {
  getToolDisplay,
  getToolHeaderSummary,
  newProjectTaskMessage,
  projectThreadListCall,
  projectThreadMutationCall,
  resumeProjectTaskMessage,
  stableProjectOperationId,
  type ProjectThreadMutationAction,
} from "./tool-display.js";
import "./project-app.css";

interface MountedPayload {
  update(options: {
    card: ToolResultCard;
    hostContext?: HostContext;
  }): void;
  unmount(): void;
}

let app: App | null = null;
let connected = false;
let connectionError: string | null = null;
let hostContext: HostContext | undefined;
let card: ProjectAppCard | null = null;
let expanded = false;
let receivedUnknownResult = false;
let currentPayload: MountedPayload | null = null;
let pendingActionKey: string | null = null;
let deliveryStatus: { key: string; message: string; error: boolean } | null = null;
let privateThreads: PrivateProjectThread[] = [];
let privateThreadsLoaded = false;
let privateThreadsLoading = false;
let privateThreadStatus: { message: string; error: boolean } | null = null;
let pendingThreadActionKey: string | null = null;
let privateThreadRequestGeneration = 0;
const deliveredActionKeys = new Set<string>();
const taskOperationIds = new Map<string, string>();
const threadOperationIds = new Map<string, string>();

const maybeAppRoot = document.querySelector<HTMLElement>("#app");
if (!maybeAppRoot) throw new Error("Missing #app root element.");
const appRoot = maybeAppRoot;

void boot();

async function boot(): Promise<void> {
  render();

  app = new App(
    { name: "devspace-project-review", version: "1.0.0" },
    {},
  );

  app.ontoolresult = (result) => {
    card = toolResultCard(result) ?? null;
    resetPrivateThreadState();
    expanded = card ? isExpandableCard(card) : false;
    receivedUnknownResult = !card;
    render();
    if (card?.tool === "list_projects" && connected) void refreshPrivateThreads();
  };

  app.onhostcontextchanged = (ctx) => {
    hostContext = {
      ...hostContext,
      ...ctx,
    };
    applyHostContext();
    if (card?.tool === "show_changes" && currentPayload) {
      currentPayload.update({ card, hostContext });
    } else {
      render();
    }
  };

  app.onteardown = async () => {
    unmountPayload();
    return {};
  };

  try {
    await app.connect();
    const initialContext = app.getHostContext();
    if (initialContext) hostContext = initialContext;
    applyHostContext();
    connected = true;
  } catch (connectError) {
    connectionError = connectError instanceof Error
      ? connectError.message
      : String(connectError);
  }

  render();
  if (card?.tool === "list_projects" && connected) void refreshPrivateThreads();
}

function applyHostContext(): void {
  if (hostContext?.theme) applyDocumentTheme(hostContext.theme);
  if (hostContext?.styles?.variables) {
    applyHostStyleVariables(hostContext.styles.variables);
  }
  if (hostContext?.styles?.css?.fonts) {
    applyHostFonts(hostContext.styles.css.fonts);
  }

  const insets = hostContext?.safeAreaInsets;
  if (insets) {
    document.body.style.padding =
      `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`;
  }
}

function render(): void {
  unmountPayload();

  if (connectionError) {
    renderEmpty(connectionError, "error");
    return;
  }
  if (!connected) {
    renderEmpty("Connecting to host...");
    return;
  }
  if (!card) {
    renderEmpty(receivedUnknownResult ? "Project card unavailable." : "Waiting for Project data.");
    return;
  }

  if (card.tool === "list_projects") {
    renderProjectPicker(card);
  } else {
    renderReviewCard(card);
  }
}

function renderProjectPicker(projectCard: ProjectListCard): void {
  const display = getToolDisplay(projectCard);
  const main = element("main", { className: "shell picker-shell" });
  const section = element("section", {
    className: `tool-card ${display.tone}`,
    ariaLabel: "DevSpace Project picker",
  });
  const header = element("header", { className: "picker-header" });
  const icon = element("span", { className: "tool-icon", ariaHidden: "true" });
  icon.append(renderIcon(display.icon));
  const heading = element("div", { className: "picker-heading" });
  heading.append(
    element("h2", { className: "tool-title", text: display.title }),
    element("p", {
      className: "picker-description",
      text: "Start fresh or continue a saved task. Saved progress is historical context; files must be checked again before editing.",
    }),
  );
  header.append(icon, heading);
  section.append(header);

  const messageSupported = canSendMessage();
  if (!messageSupported) {
    section.append(element("div", {
      className: "picker-notice",
      role: "status",
      text: "This host cannot send chat messages from the card. Continue in chat and ask the model to list Projects, then start or continue the task you want.",
    }));
  }

  const projects = element("div", { className: "project-list" });
  if (projectCard.projects.length === 0) {
    projects.append(element("div", {
      className: "picker-empty",
      text: "No approved Projects are available.",
    }));
  } else {
    for (const project of projectCard.projects) {
      projects.append(renderProjectSection(project, messageSupported));
    }
  }
  section.append(projects);

  if (projectCard.truncated) {
    section.append(element("div", {
      className: "picker-notice",
      role: "status",
      text: "Only the most recently updated resumable tasks are shown.",
    }));
  }
  if (deliveryStatus) {
    section.append(element("div", {
      className: deliveryStatus.error ? "delivery-status error" : "delivery-status",
      role: deliveryStatus.error ? "alert" : "status",
      ariaLive: "polite",
      text: deliveryStatus.message,
    }));
  }

  main.append(section);
  appRoot.replaceChildren(main);
}

function renderProjectSection(
  project: ProjectCardEntry,
  messageSupported: boolean,
): HTMLElement {
  const section = element("section", {
    className: "project-section",
    ariaLabel: project.label,
  });
  const header = element("div", { className: "project-section-header" });
  header.append(element("h3", { className: "project-label", text: project.label }));

  const newActionKey = `fresh:${project.projectRef}`;
  const hasFailedNewDelivery =
    deliveryStatus?.key === newActionKey && deliveryStatus.error;
  const newButton = element("button", {
    className: "project-action primary",
    type: "button",
    text: pendingActionKey === newActionKey
      ? "Sending…"
      : deliveredActionKeys.has(newActionKey)
        ? "Sent"
        : hasFailedNewDelivery
          ? "Retry start fresh"
          : "Start fresh",
    ariaLabel: `Start a fresh task for ${project.label}`,
    disabled:
      !messageSupported ||
      pendingActionKey !== null ||
      deliveredActionKeys.has(newActionKey),
  });
  newButton.addEventListener("click", () => {
    void deliverFreshTask(project.projectRef);
  });
  header.append(newButton);
  section.append(header);

  const tasks = element("div", {
    className: "handoff-list",
    ariaLabel: `Saved tasks for ${project.label}`,
  });
  if (project.tasks.length === 0) {
    tasks.append(element("p", {
      className: "no-handoffs",
      text: "No resumable saved tasks.",
    }));
  } else {
    for (const task of project.tasks) {
      tasks.append(renderTaskRow(project, task, messageSupported));
    }
  }
  section.append(tasks);
  section.append(renderPrivateThreadControls(project));
  return section;
}

function renderPrivateThreadControls(project: ProjectCardEntry): HTMLElement {
  const controls = element("section", {
    className: "private-thread-controls",
    ariaLabel: `Private thread controls for ${project.label}`,
  });
  const header = element("div", { className: "private-thread-header" });
  header.append(element("h4", {
    className: "private-thread-heading",
    text: "Private thread controls",
  }));
  const refresh = element("button", {
    className: "thread-action",
    type: "button",
    text: privateThreadsLoading ? "Refreshing…" : "Refresh",
    disabled: privateThreadsLoading || pendingThreadActionKey !== null,
  });
  refresh.addEventListener("click", () => {
    void refreshPrivateThreads();
  });
  header.append(refresh);
  controls.append(header);

  if (privateThreadStatus) {
    controls.append(element("div", {
      className: privateThreadStatus.error
        ? "private-thread-message error"
        : "private-thread-message",
      role: privateThreadStatus.error ? "alert" : "status",
      text: privateThreadStatus.message,
    }));
  }

  if (!privateThreadsLoaded) {
    controls.append(element("p", {
      className: "private-thread-empty",
      text: privateThreadsLoading
        ? "Loading private Threads…"
        : "Private Threads have not been loaded.",
    }));
    return controls;
  }

  const projectThreads = privateThreads.filter((thread) =>
    thread.projectRef === project.projectRef
  );
  if (projectThreads.length === 0) {
    controls.append(element("p", {
      className: "private-thread-empty",
      text: "No private Threads for this Project.",
    }));
    return controls;
  }

  const list = element("div", { className: "private-thread-list" });
  for (const thread of projectThreads) list.append(renderPrivateThreadRow(thread));
  controls.append(list);
  return controls;
}

function renderPrivateThreadRow(thread: PrivateProjectThread): HTMLElement {
  const row = element("div", { className: "private-thread-row" });
  const details = element("div", { className: "private-thread-details" });
  details.append(
    element("span", { className: "private-thread-title", text: thread.title }),
    element("span", {
      className: "private-thread-meta",
      text: `${threadStatusLabel(thread.status)} · ${thread.checkoutKind} · Updated ${formatTimestamp(thread.updatedAt)} · Version ${thread.version}`,
    }),
  );
  row.append(details);

  const actions = element("div", {
    className: "private-thread-actions",
    ariaLabel: `Controls for ${thread.title}`,
  });
  for (const action of availableThreadActions(thread.status)) {
    const actionKey = threadActionKey(thread, action);
    const button = element("button", {
      className: action === "close" ? "thread-action danger" : "thread-action",
      type: "button",
      text: pendingThreadActionKey === actionKey
        ? `${threadActionLabel(action)}…`
        : threadActionLabel(action),
      disabled: privateThreadsLoading || pendingThreadActionKey !== null,
    });
    button.addEventListener("click", () => {
      if (
        action === "close" &&
        !window.confirm("Close this private Thread? A clean managed worktree may be removed.")
      ) {
        return;
      }
      void mutatePrivateThread(thread, action);
    });
    actions.append(button);
  }
  if (actions.childElementCount > 0) row.append(actions);
  return row;
}

function renderTaskRow(
  project: ProjectCardEntry,
  task: ResumableTaskCard,
  messageSupported: boolean,
): HTMLElement {
  const actionKey = `continue:${task.taskRef}`;
  const row = element("button", {
    className: "handoff-row",
    type: "button",
    ariaLabel: `Continue ${task.title} for ${project.label}, updated ${formatTimestamp(task.updatedAt)}`,
    disabled:
      !messageSupported ||
      pendingActionKey !== null ||
      deliveredActionKeys.has(actionKey),
  });
  row.addEventListener("click", () => {
    void deliverTask(project.projectRef, task.taskRef);
  });
  const details = element("span", { className: "handoff-details" });
  details.append(
    element("span", {
      className: "handoff-title",
      text: deliveredActionKeys.has(actionKey) ? "Continue request sent" : task.title,
    }),
    element("span", {
      className: "handoff-time",
      text: `Updated ${formatTimestamp(task.updatedAt)} · Version ${task.version}`,
    }),
  );
  row.append(
    details,
    element("span", {
      className: pendingActionKey === actionKey ? "handoff-state pending" : "handoff-state",
      text: pendingActionKey === actionKey ? "Sending…" : "Historical",
    }),
  );
  return row;
}

async function deliverFreshTask(projectRef: string): Promise<void> {
  const actionKey = `fresh:${projectRef}`;
  const operationId = stableProjectOperationId(
    taskOperationIds.get(actionKey),
    () => crypto.randomUUID(),
  );
  taskOperationIds.set(actionKey, operationId);
  await deliverMessage(
    actionKey,
    newProjectTaskMessage(projectRef, operationId),
    () => {
      taskOperationIds.delete(actionKey);
    },
  );
}

async function deliverTask(
  projectRef: string,
  taskRef: string,
): Promise<void> {
  const actionKey = `continue:${taskRef}`;
  const operationId = stableProjectOperationId(
    taskOperationIds.get(actionKey),
    () => crypto.randomUUID(),
  );
  taskOperationIds.set(actionKey, operationId);
  await deliverMessage(
    actionKey,
    resumeProjectTaskMessage(projectRef, taskRef, operationId),
    () => {
      taskOperationIds.delete(actionKey);
    },
  );
}

async function deliverMessage(
  actionKey: string,
  message: string,
  onDelivered?: () => void,
): Promise<void> {
  if (!app || !canSendMessage() || pendingActionKey !== null) {
    deliveryStatus = {
      key: actionKey,
      message: "Continue in chat and ask the model to start or continue this Project task.",
      error: true,
    };
    render();
    return;
  }
  pendingActionKey = actionKey;
  deliveryStatus = null;
  render();
  try {
    const result = await app.sendMessage({
      role: "user",
      content: [{ type: "text", text: message }],
    });
    if (result.isError) throw new Error("The host rejected the message.");
    onDelivered?.();
    deliveredActionKeys.add(actionKey);
    deliveryStatus = {
      key: actionKey,
      message: "Request sent to chat.",
      error: false,
    };
  } catch {
    deliveryStatus = {
      key: actionKey,
      message: "The request could not be delivered. Retry to send the same request.",
      error: true,
    };
  } finally {
    pendingActionKey = null;
    render();
  }
}

function resetPrivateThreadState(): void {
  privateThreadRequestGeneration += 1;
  privateThreads = [];
  privateThreadsLoaded = false;
  privateThreadsLoading = false;
  privateThreadStatus = null;
  pendingThreadActionKey = null;
  threadOperationIds.clear();
}

async function refreshPrivateThreads(): Promise<boolean> {
  if (
    !app ||
    !connected ||
    card?.tool !== "list_projects" ||
    privateThreadsLoading ||
    pendingThreadActionKey !== null
  ) {
    return false;
  }

  const generation = ++privateThreadRequestGeneration;
  privateThreadsLoading = true;
  privateThreadStatus = null;
  render();
  try {
    const result = await app.callServerTool(projectThreadListCall());
    if (generation !== privateThreadRequestGeneration || card?.tool !== "list_projects") {
      return false;
    }
    const parsed = parsePrivateThreadList(result);
    if (!parsed) throw new Error(serverToolErrorMessage(result, "Invalid private Thread list response."));
    privateThreads = parsed;
    privateThreadsLoaded = true;
    return true;
  } catch (error) {
    if (generation !== privateThreadRequestGeneration || card?.tool !== "list_projects") {
      return false;
    }
    privateThreadStatus = {
      message: boundedErrorMessage(error, "Private Threads could not be loaded."),
      error: true,
    };
    return false;
  } finally {
    if (generation === privateThreadRequestGeneration && card?.tool === "list_projects") {
      privateThreadsLoading = false;
      render();
    }
  }
}

async function mutatePrivateThread(
  thread: PrivateProjectThread,
  action: ProjectThreadMutationAction,
): Promise<void> {
  if (!app || !connected || pendingThreadActionKey !== null || privateThreadsLoading) return;
  const actionKey = threadActionKey(thread, action);
  const operationId = stableProjectOperationId(
    threadOperationIds.get(actionKey),
    () => crypto.randomUUID(),
  );
  threadOperationIds.set(actionKey, operationId);
  pendingThreadActionKey = actionKey;
  privateThreadStatus = null;
  render();
  try {
    const result = await app.callServerTool(projectThreadMutationCall(
      action,
      thread.threadRef,
      operationId,
      thread.version,
    ));
    if (!successfulServerMutation(result)) {
      throw new Error(serverToolErrorMessage(result, `The Thread could not be ${action}d.`));
    }
    threadOperationIds.delete(actionKey);
    pendingThreadActionKey = null;
    const refreshed = await refreshPrivateThreads();
    if (refreshed) {
      privateThreadStatus = {
        message: `Private Thread ${threadActionPastTense(action)}.`,
        error: false,
      };
    }
  } catch (error) {
    privateThreadStatus = {
      message: boundedErrorMessage(error, `The private Thread could not be ${action}d.`),
      error: true,
    };
  } finally {
    pendingThreadActionKey = null;
    render();
  }
}

function availableThreadActions(status: PrivateThreadStatus): ProjectThreadMutationAction[] {
  if (status === "active") return ["pause", "archive", "complete", "close"];
  if (status === "paused") return ["archive", "complete", "close"];
  if (status === "archived") return ["complete", "close"];
  if (status === "completed") return ["close"];
  return [];
}

function threadActionKey(
  thread: PrivateProjectThread,
  action: ProjectThreadMutationAction,
): string {
  return `${action}:${thread.threadRef}:v${thread.version}`;
}

function threadActionLabel(action: ProjectThreadMutationAction): string {
  return action[0]!.toUpperCase() + action.slice(1);
}

function threadActionPastTense(action: ProjectThreadMutationAction): string {
  if (action === "complete") return "completed";
  if (action === "close") return "closed";
  return `${action}d`;
}

function threadStatusLabel(status: PrivateThreadStatus): string {
  return status[0]!.toUpperCase() + status.slice(1);
}

function successfulServerMutation(result: CallToolResult): boolean {
  return result.isError !== true &&
    Boolean(result.structuredContent) &&
    typeof result.structuredContent === "object" &&
    result.structuredContent.ok === true;
}

function serverToolErrorMessage(result: CallToolResult, fallback: string): string {
  for (const block of result.content) {
    if (block.type === "text" && block.text.trim()) return block.text.trim().slice(0, 512);
  }
  return fallback;
}

function boundedErrorMessage(error: unknown, fallback: string): string {
  return (error instanceof Error && error.message.trim() ? error.message.trim() : fallback)
    .slice(0, 512);
}

function canSendMessage(): boolean {
  return Boolean(app?.getHostCapabilities()?.message?.text);
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  try {
    return new Intl.DateTimeFormat(hostContext?.locale, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(hostContext?.timeZone ? { timeZone: hostContext.timeZone } : {}),
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function renderReviewCard(reviewCard: ToolResultCard): void {
  const display = getToolDisplay(reviewCard);
  const expandable = isExpandableCard(reviewCard);
  const main = element("main", { className: "shell" });
  const section = element("section", { className: `tool-card ${display.tone}` });
  const header = element("button", {
    className: "tool-header",
    type: "button",
    ariaExpanded: String(expanded),
    disabled: !expandable,
  });

  if (expandable) {
    header.addEventListener("click", () => {
      expanded = !expanded;
      render();
    });
  }

  const icon = element("span", { className: "tool-icon", ariaHidden: "true" });
  icon.append(renderIcon(display.icon));
  header.append(
    icon,
    element("span", { className: "tool-title", text: display.title }),
    renderHeaderSummary(reviewCard),
    renderChevron(expanded, expandable),
  );
  section.append(header);

  if (reviewCard.changeSource === "apply_patch_history") {
    section.append(element("div", {
      className: "picker-notice",
      role: "note",
      text: "Apply-patch history selected: only successful DevSpace apply_patch requests from this execution are included; command and external edits are not.",
    }));
  } else {
    section.append(element("div", {
      className: "picker-notice",
      role: "note",
      text: "Repository diff selected: staged, unstaged, and untracked changes from the exact Project Git root are included.",
    }));
  }

  if (expanded) {
    const payload = element("div", { className: "review-payload" });
    payload.append(element("div", { className: "status", text: "Loading diff…" }));
    section.append(payload);
    void mountPayload(payload, reviewCard);
  }

  main.append(section);
  appRoot.replaceChildren(main);
}

async function mountPayload(
  container: HTMLElement,
  reviewCard: ToolResultCard,
): Promise<void> {
  try {
    const { mountReviewPayload } = await import("./review-payload.js");
    if (card !== reviewCard || !expanded || !container.isConnected) return;
    currentPayload = mountReviewPayload(container, { card: reviewCard, hostContext });
  } catch {
    if (card !== reviewCard || !expanded || !container.isConnected) return;
    container.replaceChildren(element("div", {
      className: "status",
      text: "Review preview unavailable.",
    }));
  }
}

function renderEmpty(message: string, tone: "muted" | "error" = "muted"): void {
  const main = element("main", { className: "shell" });
  main.append(element("section", { className: `empty ${tone}`, text: message }));
  appRoot.replaceChildren(main);
}

function renderHeaderSummary(reviewCard: ToolResultCard): HTMLElement {
  const summary = getToolHeaderSummary(reviewCard);
  const stats = element("span", { className: "stats" });
  stats.setAttribute("aria-label", "Diff statistics");
  stats.append(
    element("span", { className: "add", text: `+${String(summary.additions)}` }),
    element("span", { className: "remove", text: `-${String(summary.removals)}` }),
  );
  return stats;
}

function renderChevron(isExpanded: boolean, visible: boolean): HTMLElement {
  const chevron = element("span", {
    className: visible ? `chevron ${isExpanded ? "expanded" : ""}` : "chevron",
    ariaHidden: "true",
  });
  if (visible) chevron.append(renderIcon(toolIcons.chevronDown));
  return chevron;
}

function unmountPayload(): void {
  currentPayload?.unmount();
  currentPayload = null;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    className?: string;
    text?: string;
    type?: string;
    ariaHidden?: string;
    ariaExpanded?: string;
    ariaLabel?: string;
    ariaLive?: string;
    role?: string;
    disabled?: boolean;
  } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.type !== undefined && "type" in node) node.setAttribute("type", options.type);
  if (options.ariaHidden !== undefined) node.setAttribute("aria-hidden", options.ariaHidden);
  if (options.ariaExpanded !== undefined) node.setAttribute("aria-expanded", options.ariaExpanded);
  if (options.ariaLabel !== undefined) node.setAttribute("aria-label", options.ariaLabel);
  if (options.ariaLive !== undefined) node.setAttribute("aria-live", options.ariaLive);
  if (options.role !== undefined) node.setAttribute("role", options.role);
  if (options.disabled !== undefined && "disabled" in node) {
    (node as HTMLButtonElement).disabled = options.disabled;
  }
  return node;
}
