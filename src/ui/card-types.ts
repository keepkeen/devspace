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
  createdAt: string;
  updatedAt: string;
  status: "resumable";
  version: number;
}

export interface ProjectCardEntry {
  projectRef: string;
  label: string;
  tasks: ResumableTaskCard[];
}

export interface ProjectListCard {
  tool: "list_projects";
  projects: ProjectCardEntry[];
  defaultProjectRef?: string;
  truncated: boolean;
  taskTrust: "untrusted";
  taskLimits: {
    perProject: number;
    total: number;
  };
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
const MAX_TOTAL_TASKS = 100;
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
  const provenance = objectRecord(structuredDiff?.provenance);
  const changeSource = structured?.changeSource;
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
    !structured ||
    !structuredDiff ||
    structured?.ok !== true ||
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
  const page = diffPage(structuredDiff, patchBytes);
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
  const limits = objectRecord(structured?.taskLimits);
  const perProject = safePositiveInteger(limits?.perProject);
  const total = safePositiveInteger(limits?.total);
  if (
    structured?.ok !== true ||
    typeof structured.truncated !== "boolean" ||
    structured.taskTrust !== "untrusted" ||
    perProject === undefined ||
    total === undefined ||
    perProject > MAX_TASKS_PER_PROJECT ||
    total > MAX_TOTAL_TASKS ||
    !Array.isArray(structured.projects) ||
    structured.projects.length > MAX_PROJECTS
  ) {
    return undefined;
  }

  const projects: ProjectCardEntry[] = [];
  const projectRefs = new Set<string>();
  const taskRefs = new Set<string>();
  let taskCount = 0;
  for (const value of structured.projects) {
    const project = objectRecord(value);
    const projectRef = boundedString(project?.projectRef, MAX_PROJECT_REF_LENGTH);
    const label = boundedString(project?.label, MAX_PROJECT_LABEL_LENGTH);
    if (
      !projectRef ||
      !label ||
      projectRefs.has(projectRef) ||
      !Array.isArray(project?.tasks) ||
      project.tasks.length > perProject
    ) {
      return undefined;
    }
    projectRefs.add(projectRef);

    const tasks: ResumableTaskCard[] = [];
    for (const taskValue of project.tasks) {
      const task = objectRecord(taskValue);
      const taskRef = boundedString(
        task?.taskRef,
        MAX_TASK_REF_LENGTH,
      );
      const title = boundedString(task?.title, MAX_TASK_TITLE_LENGTH);
      const createdAt = isoTimestamp(task?.createdAt);
      const updatedAt = isoTimestamp(task?.updatedAt);
      const version = safePositiveInteger(task?.version);
      if (
        !taskRef ||
        taskRefs.has(taskRef) ||
        !title ||
        !createdAt ||
        !updatedAt ||
        version === undefined ||
        task?.status !== "resumable"
      ) {
        return undefined;
      }
      taskRefs.add(taskRef);
      tasks.push({
        taskRef,
        title,
        createdAt,
        updatedAt,
        status: "resumable",
        version,
      });
    }
    taskCount += tasks.length;
    if (taskCount > total) return undefined;
    projects.push({ projectRef, label, tasks });
  }

  const defaultProjectRef = structured.defaultProjectRef === undefined
    ? undefined
    : boundedString(structured.defaultProjectRef, MAX_PROJECT_REF_LENGTH);
  if (
    (structured.defaultProjectRef !== undefined && !defaultProjectRef) ||
    (defaultProjectRef !== undefined && !projectRefs.has(defaultProjectRef))
  ) {
    return undefined;
  }

  return {
    tool: "list_projects",
    projects,
    ...(defaultProjectRef ? { defaultProjectRef } : {}),
    truncated: structured.truncated,
    taskTrust: "untrusted",
    taskLimits: { perProject, total },
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
