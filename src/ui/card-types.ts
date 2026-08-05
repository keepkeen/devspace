import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type HostContext = NonNullable<ReturnType<App["getHostContext"]>>;

export interface ReviewSummary {
  files: number;
  additions: number;
  removals: number;
}

export interface ReviewFile {
  path: string;
  previousPath?: string;
  type: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
  additions: number;
  removals: number;
}

export interface DiffPage {
  offsetBytes: number;
  lengthBytes: number;
  totalBytes: number;
  eof: boolean;
}

export interface ToolResultCard {
  tool: "show_changes";
  changeSource: "repository" | "apply_patch_history";
  summary: ReviewSummary;
  files: ReviewFile[];
  payload: {
    patch: string;
  };
  page: DiffPage;
}

export interface ResumableTaskCard {
  taskRef: string;
  title: string;
  updatedAt: string;
  version: number;
}

export interface ProjectCardEntry {
  projectRef: string;
  label: string;
  resumableTaskCount: number;
  tasks?: ResumableTaskCard[];
}

export interface ProjectListCard {
  tool: "list_projects";
  projects: ProjectCardEntry[];
  truncated: boolean;
  taskTrust: "untrusted";
}

export type PrivateThreadStatus =
  | "active"
  | "paused"
  | "archived"
  | "completed"
  | "closed";

export interface PrivateProjectThread {
  threadRef: string;
  projectRef: string;
  title: string;
  status: PrivateThreadStatus;
  version: number;
  checkoutKind: "checkout" | "worktree";
  updatedAt: string;
}

export type ProjectAppCard = ToolResultCard | ProjectListCard;

const MAX_DIFF_PAGE_BYTES = 32_000;
const MAX_REVIEW_FILES = 50;
const MAX_PATH_LENGTH = 4_096;
const MAX_PROJECTS = 100;
const MAX_PROJECT_LABEL_LENGTH = 512;
const MAX_PROJECT_REF_LENGTH = 128;
const MAX_TASK_REF_LENGTH = 512;
const MAX_TASK_TITLE_LENGTH = 256;
const MAX_TASKS_PER_PROJECT = 20;
const MAX_PRIVATE_THREADS = 100;
const MAX_THREAD_REF_LENGTH = 512;
const MIN_THREAD_REF_LENGTH = 16;
const MAX_THREAD_TITLE_LENGTH = 512;

export function toolResultCard(result: CallToolResult): ProjectAppCard | undefined {
  const meta = objectRecord(result._meta);
  if (meta?.tool === "list_projects") return projectListCard(result);
  if (meta?.tool !== "show_changes") return undefined;
  return showChangesCard(result);
}

function showChangesCard(result: CallToolResult): ToolResultCard | undefined {
  const meta = objectRecord(result._meta);
  const metaCard = objectRecord(meta?.card);
  const structured = objectRecord(result.structuredContent);
  const structuredDiff = objectRecord(structured?.diff);
  const metaPayload = objectRecord(metaCard?.payload);
  const metaPage = objectRecord(metaCard?.page);
  const provenance = objectRecord(structuredDiff?.provenance);
  const changeSource = metaCard?.changeSource;
  const validRepositoryProvenance =
    changeSource === "repository" &&
    provenance?.source === "repository" &&
    provenance.trust === "untrusted" &&
    provenance.authority === "none";
  const validApplyPatchProvenance =
    changeSource === "apply_patch_history" &&
    provenance?.source === "devspace" &&
    provenance.trust === "server_observed" &&
    provenance.authority === "none" &&
    provenance.scope === "successful_apply_patch_history";
  if (
    !metaCard ||
    !metaPage ||
    !structured ||
    !structuredDiff ||
    (!validRepositoryProvenance && !validApplyPatchProvenance)
  ) {
    return undefined;
  }

  const metaPatch = metaPayload?.patch;
  const structuredPatch = structuredDiff?.patch;
  if (
    typeof metaPatch !== "string" ||
    typeof structuredPatch !== "string" ||
    metaPatch !== structuredPatch
  ) {
    return undefined;
  }

  const patchBytes = new TextEncoder().encode(metaPatch).byteLength;
  if (patchBytes > MAX_DIFF_PAGE_BYTES) return undefined;

  const summary = reviewSummary(metaCard?.summary);
  const structuredSummary = reviewSummary(structured.summary);
  const files = reviewFiles(metaCard?.files);
  const page = diffPage(metaPage, patchBytes);
  if (
    !summary ||
    !structuredSummary ||
    !sameSummary(summary, structuredSummary) ||
    !files ||
    !page
  ) {
    return undefined;
  }

  return {
    tool: "show_changes",
    changeSource,
    summary,
    files,
    payload: { patch: metaPatch },
    page,
  };
}

export function isExpandableCard(card: ProjectAppCard): boolean {
  return card.tool === "show_changes" && card.payload.patch.length > 0;
}

export function parsePrivateThreadList(
  result: CallToolResult,
): PrivateProjectThread[] | undefined {
  const structured = objectRecord(result.structuredContent);
  if (
    result.isError === true ||
    structured?.ok !== true ||
    !Array.isArray(structured.threads) ||
    structured.threads.length > MAX_PRIVATE_THREADS
  ) {
    return undefined;
  }

  const threads: PrivateProjectThread[] = [];
  const threadRefs = new Set<string>();
  for (const value of structured.threads) {
    const thread = objectRecord(value);
    const threadRef = boundedString(thread?.threadRef, MAX_THREAD_REF_LENGTH);
    const projectRef = boundedString(thread?.projectRef, MAX_PROJECT_REF_LENGTH);
    const title = boundedString(thread?.title, MAX_THREAD_TITLE_LENGTH);
    const version = safePositiveInteger(thread?.version);
    const updatedAt = isoTimestamp(thread?.updatedAt);
    const status = privateThreadStatus(thread?.status);
    const checkoutKind = thread?.checkoutKind === "checkout" || thread?.checkoutKind === "worktree"
      ? thread.checkoutKind
      : undefined;
    if (
      !threadRef ||
      threadRef.length < MIN_THREAD_REF_LENGTH ||
      threadRefs.has(threadRef) ||
      !projectRef ||
      !title ||
      !status ||
      version === undefined ||
      !checkoutKind ||
      !updatedAt
    ) {
      return undefined;
    }
    threadRefs.add(threadRef);
    threads.push({
      threadRef,
      projectRef,
      title,
      status,
      version,
      checkoutKind,
      updatedAt,
    });
  }
  return threads;
}

function projectListCard(result: CallToolResult): ProjectListCard | undefined {
  const structured = objectRecord(result.structuredContent);
  if (
    !structured ||
    typeof structured.truncated !== "boolean" ||
    structured.taskTrust !== "untrusted" ||
    !Array.isArray(structured.projects) ||
    structured.projects.length > MAX_PROJECTS
  ) {
    return undefined;
  }

  const projects: ProjectCardEntry[] = [];
  const projectRefs = new Set<string>();
  const taskRefs = new Set<string>();
  for (const value of structured.projects) {
    const project = objectRecord(value);
    const projectRef = boundedString(project?.projectRef, MAX_PROJECT_REF_LENGTH);
    const label = boundedString(project?.label, MAX_PROJECT_LABEL_LENGTH);
    const resumableTaskCount = safeNonNegativeInteger(project?.resumableTaskCount);
    if (
      !project ||
      !projectRef ||
      !label ||
      projectRefs.has(projectRef) ||
      resumableTaskCount === undefined ||
      resumableTaskCount > MAX_TASKS_PER_PROJECT ||
      (project?.tasks !== undefined && !Array.isArray(project.tasks)) ||
      (Array.isArray(project?.tasks) && project.tasks.length > MAX_TASKS_PER_PROJECT)
    ) {
      return undefined;
    }
    projectRefs.add(projectRef);

    const tasks: ResumableTaskCard[] = [];
    for (const taskValue of Array.isArray(project.tasks) ? project.tasks : []) {
      const task = objectRecord(taskValue);
      const taskRef = boundedString(
        task?.taskRef,
        MAX_TASK_REF_LENGTH,
      );
      const title = boundedString(task?.title, MAX_TASK_TITLE_LENGTH);
      const updatedAt = isoTimestamp(task?.updatedAt);
      const version = safePositiveInteger(task?.version);
      if (
        !taskRef ||
        taskRefs.has(taskRef) ||
        !title ||
        !updatedAt ||
        version === undefined
      ) {
        return undefined;
      }
      taskRefs.add(taskRef);
      tasks.push({
        taskRef,
        title,
        updatedAt,
        version,
      });
    }
    if (project.tasks !== undefined && tasks.length > resumableTaskCount) return undefined;
    projects.push({
      projectRef,
      label,
      resumableTaskCount,
      ...(project.tasks === undefined ? {} : { tasks }),
    });
  }

  return {
    tool: "list_projects",
    projects,
    truncated: structured.truncated,
    taskTrust: "untrusted",
  };
}

function privateThreadStatus(value: unknown): PrivateThreadStatus | undefined {
  return value === "active" ||
      value === "paused" ||
      value === "archived" ||
      value === "completed" ||
      value === "closed"
    ? value
    : undefined;
}

function reviewSummary(value: unknown): ReviewSummary | undefined {
  const summary = objectRecord(value);
  const files = safeNonNegativeInteger(summary?.files);
  const additions = safeNonNegativeInteger(summary?.additions);
  const removals = safeNonNegativeInteger(summary?.removals);
  if (files === undefined || additions === undefined || removals === undefined) return undefined;
  return { files, additions, removals };
}

function reviewFiles(value: unknown): ReviewFile[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_REVIEW_FILES) return undefined;

  const files: ReviewFile[] = [];
  for (const valueItem of value) {
    const item = objectRecord(valueItem);
    const path = boundedPath(item?.path);
    const previousPath = item?.previousPath === undefined
      ? undefined
      : boundedPath(item.previousPath);
    const additions = safeNonNegativeInteger(item?.additions);
    const removals = safeNonNegativeInteger(item?.removals);
    const type = reviewFileType(item?.type);
    if (
      !path ||
      (item?.previousPath !== undefined && !previousPath) ||
      additions === undefined ||
      removals === undefined ||
      !type
    ) {
      return undefined;
    }

    files.push({
      path,
      ...(previousPath ? { previousPath } : {}),
      type,
      additions,
      removals,
    });
  }
  return files;
}

function diffPage(
  value: Record<string, unknown>,
  actualLengthBytes: number,
): DiffPage | undefined {
  const offsetBytes = safeNonNegativeInteger(value.offsetBytes);
  const lengthBytes = safeNonNegativeInteger(value.lengthBytes);
  const totalBytes = safeNonNegativeInteger(value.totalBytes);
  const eof = value.eof;
  if (
    offsetBytes === undefined ||
    lengthBytes === undefined ||
    totalBytes === undefined ||
    typeof eof !== "boolean" ||
    lengthBytes !== actualLengthBytes ||
    offsetBytes + lengthBytes > totalBytes ||
    eof !== (offsetBytes + lengthBytes === totalBytes)
  ) {
    return undefined;
  }
  return { offsetBytes, lengthBytes, totalBytes, eof };
}

function sameSummary(left: ReviewSummary, right: ReviewSummary): boolean {
  return left.files === right.files &&
    left.additions === right.additions &&
    left.removals === right.removals;
}

function boundedPath(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PATH_LENGTH
    ? value
    : undefined;
}

function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? value
    : undefined;
}

function reviewFileType(value: unknown): ReviewFile["type"] | undefined {
  if (
    value === "change" ||
    value === "rename-pure" ||
    value === "rename-changed" ||
    value === "new" ||
    value === "deleted"
  ) {
    return value;
  }
  return undefined;
}

function safeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
    ? value
    : undefined;
}

function safePositiveInteger(value: unknown): number | undefined {
  const parsed = safeNonNegativeInteger(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
